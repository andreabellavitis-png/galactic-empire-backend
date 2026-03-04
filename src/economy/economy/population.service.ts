// ============================================================
//  population.service.ts — GDD sez. 3.2, 3.4, 3.5
//  PATH: src/economy/population.service.ts
// ============================================================
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  SocialClass, SOCIAL_CLASS_CONFIG, ResourceType, PolicyType,
  WEALTH_THRESHOLDS, MobilityResult, BUILDING_DEFINITIONS,
} from '../economy.types';
import { RegionEntity, PopulationBlockEntity, RegionBuildingEntity } from '../economy.entities';

const GROWTH_BASE = 2.0;
const GROWTH_PTS  = 100;
const L_SPEED     = 0.05;
const OPP_MALUS   = 15;

@Injectable()
export class PopulationService {
  constructor(
    @InjectRepository(PopulationBlockEntity)
    private readonly popRepo: Repository<PopulationBlockEntity>,
    @InjectRepository(RegionEntity)
    private readonly regionRepo: Repository<RegionEntity>,
    @InjectRepository(RegionBuildingEntity)
    private readonly buildingRepo: Repository<RegionBuildingEntity>,
  ) {}

  // ═══════════════════════════════════════════════════════════
  //  FELICITÀ — GDD 3.5
  //
  //  Felicità = base + (100−base) × Σ(sat_R × peso_R) + policy − malus
  //  Soddisfazione_R = min(1, risorsa_ricevuta / risorsa_richiesta)
  //  Malus_sovra     = 20 × (pop × housing_space / capacity − 1)
  // ═══════════════════════════════════════════════════════════
  calculateHappiness(
    block:    PopulationBlockEntity,
    consumed: Partial<Record<ResourceType, number>>,
    region:   RegionEntity,
    totalPop: number,
  ): number {
    const cfg = SOCIAL_CLASS_CONFIG[block.social_class];

    const sat = (r: ResourceType, rate: number): number =>
      rate > 0 ? Math.min(1, (consumed[r] ?? 0) / (rate * block.count)) : 1;

    const satF = sat(ResourceType.FOOD,  cfg.food_rate);
    const satG = sat(ResourceType.GOODS, cfg.goods_rate);
    const satW = sat(ResourceType.WATER, cfg.water_rate);

    let h = cfg.happiness_base
      + (100 - cfg.happiness_base)
      * (satF * cfg.food_weight + satG * cfg.goods_weight + satW * cfg.water_weight);

    // Malus sovrappopolamento
    if (region.housing_capacity > 0) {
      const ratio = (block.count * cfg.housing_space) / region.housing_capacity;
      if (ratio > 1) h -= 20 * (ratio - 1);
    }

    // Malus fisso disoccupati
    if (block.social_class === SocialClass.UNEMPLOYED) h -= 25;

    // Modificatori policy
    for (const p of region.active_policies) {
      if (p.target_class && p.target_class !== block.social_class) continue;
      if (p.type === PolicyType.FORCED_LABOR && block.social_class === SocialClass.SLAVES) h -= 15;
      if (p.type === PolicyType.SUBSIDY) h += 5;
      if (p.type === PolicyType.WEALTH_REDISTRIBUTION) {
        const lower = [SocialClass.WORKERS, SocialClass.UNEMPLOYED, SocialClass.SLAVES];
        h += lower.includes(block.social_class) ? 8
           : block.social_class === SocialClass.OLIGARCHY ? -20 : 0;
      }
      if (p.type === PolicyType.CLASS_RIGHTS) h += (p.parameters.happiness_mod as number) ?? 0;
    }

    block.satisfaction = {
      [ResourceType.FOOD]: satF, [ResourceType.GOODS]: satG, [ResourceType.WATER]: satW,
    } as Record<ResourceType, number>;

    return (block.happiness = Math.max(0, Math.min(100, h)));
  }

  // ═══════════════════════════════════════════════════════════
  //  CRESCITA POPOLAZIONE — GDD 3.2
  //
  //  CrescitaTick = BaseGrowth × (FatFelicità + FatCibo) × FatSpazio
  //  FatFelicità  = (H − 50) / 50
  //  FatCibo      = (min(1, cibo/richiesto) − 0.5) × 2
  //  FatSpazio    = min(1, Capacità / Popolazione)
  //  PuntiCrescita ≥ 100 → +1 blocco; ≤ −100 → −1 blocco
  // ═══════════════════════════════════════════════════════════
  async processGrowth(
    block:       PopulationBlockEntity,
    happiness:   number,
    foodSat:     number,
    spaceFactor: number,
    tick:        number,
  ): Promise<number> {
    if (block.social_class === SocialClass.SLAVES) return 0;

    const g = GROWTH_BASE
      * ((happiness - 50) / 50 + (Math.min(1, foodSat) - 0.5) * 2)
      * spaceFactor;

    block.growth_points = Math.max(-50,
      block.growth_points + Math.max(-2, Math.min(4, g)),
    );

    let delta = 0;
    while (block.growth_points >= GROWTH_PTS) {
      block.growth_points -= GROWTH_PTS; block.count++; delta++;
    }
    while (block.growth_points <= -GROWTH_PTS && block.count > 0) {
      block.growth_points += GROWTH_PTS; block.count = Math.max(0, block.count - 1); delta--;
    }

    block.last_updated_tick = tick;
    await this.popRepo.save(block);
    return delta;
  }

  // ═══════════════════════════════════════════════════════════
  //  MOBILITÀ SOCIALE — GDD 3.4
  //
  //  P_promozione    = (wealth / soglia_su)   × (H / 100) × PolicyFactor  [max 5%]
  //  P_retrocessione = (1 − H / 100) × (soglia_keep / max(1, wealth))    [max 3%]
  //
  //  soglia_classe = wealthPerCapita × WEALTH_THRESHOLDS[classe]
  // ═══════════════════════════════════════════════════════════
  async processMobility(regionId: string, tick: number): Promise<MobilityResult[]> {
    const blocks  = await this.popRepo.find({ where: { region_id: regionId } });
    const region  = await this.regionRepo.findOneBy({ id: regionId });
    if (!region || !blocks.length) return [];

    const totalPop    = blocks.reduce((s, b) => s + b.count, 0);
    const totalWealth = blocks.reduce((s, b) => s + (b.wealth ?? 0), 0);
    const wpc         = totalPop > 0 ? totalWealth / totalPop : 0;

    const map = new Map(blocks.map(b => [b.social_class, b]));
    const ord = [
      SocialClass.SLAVES, SocialClass.UNEMPLOYED, SocialClass.WORKERS,
      SocialClass.BOURGEOISIE, SocialClass.OLIGARCHY,
    ];
    const results: MobilityResult[] = [];

    for (let i = 0; i < ord.length; i++) {
      const block = map.get(ord[i]);
      if (!block || block.count === 0) continue;

      const wealth    = block.wealth_per_block;
      const happiness = block.happiness;
      const threshUp   = i < ord.length - 1 ? wpc * WEALTH_THRESHOLDS[ord[i + 1]] : Infinity;
      const threshKeep = wpc * (WEALTH_THRESHOLDS[ord[i]] ?? 0.05);

      let pf = 1.0;
      for (const p of region.active_policies)
        if (p.type === PolicyType.CLASS_RIGHTS && p.target_class === ord[i])
          pf *= (p.parameters.mobility_factor as number) ?? 1;

      // Promozione
      if (i < ord.length - 1 && threshUp > 0 && threshUp !== Infinity) {
        const n = Math.floor(block.count * Math.min(0.05,
          (wealth / threshUp) * (happiness / 100) * pf));
        if (n > 0) {
          await this._moveBlocks(block, ord[i + 1], n, map, region, tick);
          results.push({ from_class: ord[i], to_class: ord[i + 1], blocks: n, reason: 'promotion' });
        }
      }

      // Retrocessione (solo classi i > 1: operai, borghesi, oligarchi)
      if (i > 1 && threshKeep > 0) {
        const n = Math.floor(block.count * Math.min(0.03,
          (1 - happiness / 100) * (threshKeep / Math.max(1, wealth))));
        if (n > 0) {
          await this._moveBlocks(block, ord[i - 1], n, map, region, tick);
          results.push({ from_class: ord[i], to_class: ord[i - 1], blocks: n, reason: 'demotion' });
        }
      }
    }
    return results;
  }

  private async _moveBlocks(
    from: PopulationBlockEntity, toCls: SocialClass, count: number,
    map: Map<SocialClass, PopulationBlockEntity>, region: RegionEntity, tick: number,
  ): Promise<void> {
    from.count = Math.max(0, from.count - count);
    await this.popRepo.save(from);
    let to = map.get(toCls);
    if (!to) {
      to = this.popRepo.create({
        region_id: region.id, planet_id: from.planet_id, empire_id: from.empire_id,
        social_class: toCls, count,
        happiness: SOCIAL_CLASS_CONFIG[toCls].happiness_base,
        wealth: 0, wealth_per_block: 0, growth_points: 0, last_updated_tick: tick,
      });
      map.set(toCls, to);
    } else { to.count += count; }
    await this.popRepo.save(to);
  }

  // ═══════════════════════════════════════════════════════════
  //  LEALTÀ — GDD 3.5
  //
  //  L_target = 0.5×AvgH + 0.3×Stabilità + 0.2×MilBonus − OppMalus
  //  L(t+1)   = L(t) + (target − L(t)) × 0.05
  // ═══════════════════════════════════════════════════════════
  async updateLoyalty(region: RegionEntity, blocks: PopulationBlockEntity[], tick: number): Promise<number> {
    const total = blocks.reduce((s, b) => s + b.count, 0);
    const avgH  = total > 0 ? blocks.reduce((s, b) => s + b.happiness * b.count, 0) / total : 50;

    let opp = 0;
    for (const p of region.active_policies)
      if (p.type === PolicyType.FORCED_LABOR) opp += OPP_MALUS;

    const mil    = Math.min(20, region.military_presence * 2);
    const target = Math.max(0, Math.min(100,
      0.5 * avgH + 0.3 * region.stability + 0.2 * mil - opp));

    region.loyalty = Math.max(0, Math.min(100,
      region.loyalty + (target - region.loyalty) * L_SPEED));

    // Stabilità: degrada con bassa lealtà, recupera con alta
    if (region.loyalty < 30)      region.stability = Math.max(0,   region.stability - 0.4);
    else if (region.loyalty > 70) region.stability = Math.min(100, region.stability + 0.1);
    else                          region.stability = Math.max(0,   region.stability - 0.05);

    region.last_updated_tick = tick;
    await this.regionRepo.save(region);
    return region.loyalty;
  }

  // ═══════════════════════════════════════════════════════════
  //  ASSEGNAZIONE LAVORATORI
  //
  //  Priorità slot: PRODUCTION → SPECIALIZATION → MANAGEMENT
  //  Slot richiesti scalano con livello edificio × 1.3^(L-1)
  //  Lavoratori rimanenti non-schiavi → blocco UNEMPLOYED
  // ═══════════════════════════════════════════════════════════
  async assignWorkers(regionId: string, tick: number): Promise<{ employed: number; unemployed: number }> {
    const buildings = await this.buildingRepo.find({ where: { region_id: regionId, is_active: true } });
    const blocks    = await this.popRepo.find({ where: { region_id: regionId } });

    const avail: Record<string, number> = {};
    for (const b of blocks)
      if (b.social_class !== SocialClass.UNEMPLOYED) avail[b.social_class] = b.count;

    let emp = 0;
    for (const bldg of buildings) {
      const def = BUILDING_DEFINITIONS.find(d => d.id === bldg.building_def_id);
      if (!def) continue;
      bldg.assigned_workers = {};
      for (const slot of def.work_slots) {
        const req = Math.ceil(slot.slots * (1 + (bldg.level - 1) * 0.3));
        let filled = 0;
        for (const cls of slot.allowed) {
          if (!avail[cls]) continue;
          const n = Math.min(avail[cls], req - filled);
          const k = `${slot.type}:${cls}`;
          bldg.assigned_workers[k] = (bldg.assigned_workers[k] ?? 0) + n;
          avail[cls] -= n; filled += n; emp += n;
          if (filled >= req) break;
        }
      }
    }
    await this.buildingRepo.save(buildings);

    // Disoccupati = non-schiavi rimasti senza lavoro
    const uCount = Object.entries(avail)
      .filter(([c]) => c !== SocialClass.SLAVES)
      .reduce((s, [, v]) => s + v, 0);

    let uBlock = blocks.find(b => b.social_class === SocialClass.UNEMPLOYED);
    if (!uBlock && uCount > 0 && blocks.length > 0) {
      uBlock = this.popRepo.create({
        region_id: regionId, planet_id: blocks[0].planet_id,
        empire_id: blocks[0].empire_id,
        social_class: SocialClass.UNEMPLOYED, count: uCount,
        happiness: 25, wealth: 0, wealth_per_block: 0, growth_points: 0,
        last_updated_tick: tick,
      });
    } else if (uBlock) {
      uBlock.count = uCount; uBlock.last_updated_tick = tick;
    }
    if (uBlock) await this.popRepo.save(uBlock);
    return { employed: emp, unemployed: uCount };
  }

  async getRegionBlocks(regionId: string): Promise<PopulationBlockEntity[]> {
    return this.popRepo.find({ where: { region_id: regionId } });
  }

  // ─── Metodo aggiuntivo usato dall'EconomyController ───────────────────
  async getPlanetPopulation(planetId: string): Promise<Record<SocialClass, number>> {
    const { InjectRepository } = require('@nestjs/typeorm');
    // Usa il popRepo già iniettato
    const blocks = await this.popRepo.find({ where: { planet_id: planetId } });
    const result: Record<string, number> = {};
    for (const b of blocks) {
      result[b.social_class] = (result[b.social_class] ?? 0) + b.count;
    }
    return result as Record<SocialClass, number>;
  }
}
