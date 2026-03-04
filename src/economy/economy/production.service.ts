// ============================================================
//  production.service.ts — GDD sezioni 4, 5
//  PATH: src/economy/production.service.ts
// ============================================================
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository }   from '@nestjs/typeorm';
import { Repository }         from 'typeorm';

import {
  RegionEntity, PopulationBlockEntity,
  RegionBuildingEntity, RegionMarketEntity,
} from '../economy.entities';
import {
  ResourceType, SocialClass, SOCIAL_CLASS_CONFIG,
  WorkSlotType, WORK_EFFICIENCY, BUILDING_DEFINITIONS,
  PolicyType, GALACTIC_BASE_PRICES,
} from '../economy.types';

// ── Costanti produzione ────────────────────────────────────────────────────
// Produzione = OutputBase × LevelScale × EfficWorkers × PolicyMod × FatStabilità
// FatStabilità = Stabilità / 100
const LEVEL_SCALE = (level: number, perLevel: number) =>
  Math.pow(perLevel, level - 1);

// Efficienza lavoratori per slot: media ponderata delle efficienze delle classi assegnate
function calcWorkerEfficiency(
  assignedWorkers: Record<string, number>,
  happiness: Record<string, number>,  // { SocialClass: avgHappiness }
): number {
  let totalWorkers = 0;
  let weightedEff  = 0;

  for (const [key, count] of Object.entries(assignedWorkers)) {
    if (count <= 0) continue;
    const [slotType, cls] = key.split(':') as [WorkSlotType, SocialClass];
    const eff = WORK_EFFICIENCY[cls]?.[slotType] ?? 0;
    const h   = (happiness[cls] ?? 50) / 100;
    weightedEff  += eff * h * count;
    totalWorkers += count;
  }

  return totalWorkers > 0 ? weightedEff / totalWorkers : 0;
}

@Injectable()
export class ProductionService {
  private readonly logger = new Logger(ProductionService.name);

  constructor(
    @InjectRepository(RegionEntity)
    private readonly regionRepo: Repository<RegionEntity>,
    @InjectRepository(RegionBuildingEntity)
    private readonly buildingRepo: Repository<RegionBuildingEntity>,
    @InjectRepository(PopulationBlockEntity)
    private readonly popRepo: Repository<PopulationBlockEntity>,
    @InjectRepository(RegionMarketEntity)
    private readonly marketRepo: Repository<RegionMarketEntity>,
  ) {}

  // ═══════════════════════════════════════════════════════════
  //  PRODUZIONE EDIFICI — GDD 5.3
  //
  //  Produzione = OutputBase × LevelScale × EfficLavoratori × ModPolicy × FatStab
  //  Efficienza = PercentualeClasse × (Felicità / 100)
  //  FatStabilità = Stabilità / 100
  //
  //  L'edificio consuma prima i propri input (risorse richieste).
  //  Se gli input non sono disponibili nel deposito → efficienza ridotta.
  // ═══════════════════════════════════════════════════════════
  async processBuildingProduction(
    region: RegionEntity,
    tick:   number,
  ): Promise<RegionProductionResult> {
    const buildings = await this.buildingRepo.find({
      where: { region_id: region.id, is_active: true },
    });
    const blocks = await this.popRepo.find({ where: { region_id: region.id } });

    // Mappa felicità per classe
    const happiness: Record<string, number> = {};
    for (const b of blocks) happiness[b.social_class] = b.happiness;

    const totalProduced: Partial<Record<ResourceType, number>> = {};
    const totalConsumed: Partial<Record<ResourceType, number>> = {};
    const stock = { ...(region.state_stock as Record<ResourceType, number>) };

    const stabilityFactor = region.stability / 100;

    for (const building of buildings) {
      const def = BUILDING_DEFINITIONS.find(d => d.id === building.building_def_id);
      if (!def || building.damage >= 100) continue;

      const levelScale      = LEVEL_SCALE(building.level, def.output_per_level);
      const damageFactor    = 1 - building.damage / 100;
      const workerEff       = calcWorkerEfficiency(building.assigned_workers, happiness);
      const policyMod       = this.calcPolicyMod(building, region);

      const efficiency = workerEff * stabilityFactor * damageFactor * policyMod;
      building.last_efficiency = Math.max(0, Math.min(1, efficiency));

      // ── Consuma input dell'edificio ─────────────────────────
      let inputSatisfied = 1.0;
      for (const [res, amount] of Object.entries(def.consumes)) {
        const needed  = (amount as number) * building.level;
        const available = stock[res as ResourceType] ?? 0;
        const ratio   = available > 0 ? Math.min(1, available / needed) : 0;
        inputSatisfied = Math.min(inputSatisfied, ratio);

        // Preleva dal deposito
        const consumed = Math.min(available, needed);
        stock[res as ResourceType] = Math.max(0, available - consumed);
        totalConsumed[res as ResourceType] = (totalConsumed[res as ResourceType] ?? 0) + consumed;
      }

      // ── Produce output ──────────────────────────────────────
      const finalEff = building.last_efficiency * inputSatisfied;
      const output: Partial<Record<ResourceType, number>> = {};

      for (const [res, base] of Object.entries(def.base_output)) {
        const amount = (base as number) * levelScale * finalEff;
        if (amount > 0) {
          output[res as ResourceType] = amount;
          totalProduced[res as ResourceType] = (totalProduced[res as ResourceType] ?? 0) + amount;
          stock[res as ResourceType] = (stock[res as ResourceType] ?? 0) + amount;
        }
      }

      // Edificio HOUSING: aggiorna capacità abitativa
      if (def.category === 'HOUSING') {
        const housingBonus = 50 * building.level * damageFactor;
        region.housing_capacity = (region.housing_capacity ?? 0) + housingBonus;
      }

      building.last_output = output;
      await this.buildingRepo.save(building);
    }

    // Aggiorna stock regione
    region.state_stock = stock as any;
    region.last_updated_tick = tick;
    await this.regionRepo.save(region);

    return { produced: totalProduced, consumed: totalConsumed, stock };
  }

  // ═══════════════════════════════════════════════════════════
  //  CONSUMI CLASSI SOCIALI — GDD 3.3
  //
  //  Ogni blocco consuma: cibo × rate, beni × rate, acqua × rate.
  //  La distribuzione è proporzionale: se le risorse sono scarse,
  //  tutti ricevono meno (non "chi arriva prima").
  //
  //  Restituisce quanto ciascun blocco ha effettivamente ricevuto
  //  (usato poi da PopulationService.calculateHappiness).
  // ═══════════════════════════════════════════════════════════
  async processSocialConsumption(
    region: RegionEntity,
    blocks: PopulationBlockEntity[],
    tick:   number,
  ): Promise<SocialConsumptionResult> {
    const stock = { ...(region.state_stock as Record<ResourceType, number>) };

    // Calcola domanda totale per risorsa
    const totalDemand: Partial<Record<ResourceType, number>> = {};
    for (const block of blocks) {
      const cfg = SOCIAL_CLASS_CONFIG[block.social_class];
      const add = (r: ResourceType, rate: number) => {
        totalDemand[r] = (totalDemand[r] ?? 0) + rate * block.count;
      };
      add(ResourceType.FOOD,  cfg.food_rate);
      add(ResourceType.GOODS, cfg.goods_rate);
      add(ResourceType.WATER, cfg.water_rate);
    }

    // Fattore di soddisfazione globale per risorsa (min(offerta, domanda) / domanda)
    const globalSatFactor: Partial<Record<ResourceType, number>> = {};
    for (const [res, demand] of Object.entries(totalDemand)) {
      const available = stock[res as ResourceType] ?? 0;
      globalSatFactor[res as ResourceType] = demand > 0
        ? Math.min(1, available / (demand as number))
        : 1;
    }

    // Distribuisce proporzionalmente
    const consumed: Record<string, Partial<Record<ResourceType, number>>> = {};
    const totalConsumed: Partial<Record<ResourceType, number>> = {};

    for (const block of blocks) {
      const cfg = SOCIAL_CLASS_CONFIG[block.social_class];
      consumed[block.id] = {};

      const consume = (r: ResourceType, rate: number) => {
        const requested = rate * block.count;
        const actual    = requested * (globalSatFactor[r] ?? 1);
        consumed[block.id][r] = actual;
        totalConsumed[r] = (totalConsumed[r] ?? 0) + actual;
        stock[r] = Math.max(0, (stock[r] ?? 0) - actual);
      };

      if (cfg.food_rate  > 0) consume(ResourceType.FOOD,  cfg.food_rate);
      if (cfg.goods_rate > 0) consume(ResourceType.GOODS, cfg.goods_rate);
      if (cfg.water_rate > 0) consume(ResourceType.WATER, cfg.water_rate);
    }

    region.state_stock = stock as any;
    region.last_updated_tick = tick;
    await this.regionRepo.save(region);

    return { consumed_by_block: consumed, total_consumed: totalConsumed, demand: totalDemand };
  }

  // ═══════════════════════════════════════════════════════════
  //  AGGIORNAMENTO DOMANDA/OFFERTA MERCATO — GDD 4.3
  //
  //  Offerta  = produzione tick corrente + surplus deposito
  //  Domanda  = consumo classi + consumo edifici (input)
  //
  //  Usato dal MarketService per calcolare i prezzi.
  // ═══════════════════════════════════════════════════════════
  async updateRegionMarketSupplyDemand(
    region:   RegionEntity,
    produced: Partial<Record<ResourceType, number>>,
    demand:   Partial<Record<ResourceType, number>>,
    tick:     number,
  ): Promise<void> {
    let market = await this.marketRepo.findOneBy({ region_id: region.id });
    if (!market) {
      market = this.marketRepo.create({
        region_id: region.id,
        planet_id: region.planet_id,
        prices:       {},
        fixed_prices: {},
        supply:       {},
        demand:       {},
        price_history: [],
        embargo_map:  {},
        last_updated_tick: tick,
      });
    }

    // Offerta = produzione + stock (ma con peso ridotto per lo stock)
    const stock = region.state_stock as Record<ResourceType, number>;
    const supply: Record<string, number> = {};
    for (const r of Object.values(ResourceType)) {
      const prod  = produced[r as ResourceType] ?? 0;
      const stk   = (stock[r as ResourceType] ?? 0) * 0.1; // lo stock vale 10% dell'offerta
      supply[r]   = prod + stk;
    }

    market.supply = supply;
    market.demand = demand as Record<string, number>;
    market.last_updated_tick = tick;
    await this.marketRepo.save(market);
  }

  // ─── Helper privato: modificatore policy sulla produzione ─────────────────
  private calcPolicyMod(building: RegionBuildingEntity, region: RegionEntity): number {
    let mod = 1.0;
    for (const p of region.active_policies) {
      if (p.type === PolicyType.FORCED_LABOR) {
        // Schiavi producono di più ma con più ribellione (gestita altrove)
        mod *= 1.2;
      }
      if (p.type === PolicyType.NATIONALIZE && p.target_building === building.building_def_id) {
        mod *= 1.05; // Lieve bonus produttività statale
      }
    }
    return mod;
  }

  // ─── Calcola build cost per livello ───────────────────────────────────────
  // Costo livello N = Base × costScale^(N-1) — GDD 5.1
  static calcBuildCost(
    defId: string,
    targetLevel: number,
  ): Partial<Record<ResourceType, number>> {
    const def = BUILDING_DEFINITIONS.find(d => d.id === defId);
    if (!def) return {};
    const scale = Math.pow(def.cost_scale, targetLevel - 1);
    const cost: Partial<Record<ResourceType, number>> = {};
    for (const [res, base] of Object.entries(def.base_cost)) {
      cost[res as ResourceType] = Math.round((base as number) * scale);
    }
    return cost;
  }
}

export interface RegionProductionResult {
  produced: Partial<Record<ResourceType, number>>;
  consumed: Partial<Record<ResourceType, number>>;
  stock:    Partial<Record<ResourceType, number>>;
}

export interface SocialConsumptionResult {
  consumed_by_block: Record<string, Partial<Record<ResourceType, number>>>;
  total_consumed:    Partial<Record<ResourceType, number>>;
  demand:            Partial<Record<ResourceType, number>>;
}
