// ============================================================
//  economy-tick.phase.ts — Orchestratore tick economico
//  PATH: src/economy/economy-tick.phase.ts
//
//  Ordine esecuzione (GDD sezione 8):
//    1.  Produzione edifici per regione
//    2.  Calcolo domanda totale classi sociali
//    3.  Aggiornamento prezzi locali
//    4.  Commercio automatico interplanetario
//    5.  Consumi classi sociali (distribuzione risorse)
//    6.  Aggiornamento felicità per blocco
//    7.  Crescita popolazione
//    8.  Assegnazione lavoratori per prossimo tick
//    9.  Mobilità sociale
//   10.  Aggiornamento lealtà
//   11.  Completamento costruzioni
//   12.  Inflazione per-pianeta (GDD 4.6)
//   13.  Prezzi base galattici
// ============================================================

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository }   from '@nestjs/typeorm';
import { Repository }         from 'typeorm';

import { ProductionService } from './production.service';
import { MarketService }     from './market.service';
import { PopulationService } from './population.service';

import {
  RegionEntity, PopulationBlockEntity,
  RegionMarketEntity, PlanetInflationEntity,
  GalacticMarketEntity, BuildQueueEntity, RegionBuildingEntity,
} from '../economy.entities';
import {
  ResourceType, SocialClass, SOCIAL_CLASS_CONFIG,
  BUILDING_DEFINITIONS, GALACTIC_BASE_PRICES,
} from '../economy.types';

// Risultato completo del tick economico per il WebSocket delta
export interface EconomyTickResult {
  tick:              number;
  regions_processed: number;
  planets_processed: number;
  trade_flows:       number;
  mobility_events:   number;
  inflation_updates: InflationSummary[];
  galactic_prices:   Record<string, number>;
}

interface InflationSummary {
  planet_id: string;
  I_prev:    number;
  I_new:     number;
  M:         number;
}

@Injectable()
export class EconomyTickPhase {
  private readonly logger = new Logger(EconomyTickPhase.name);

  constructor(
    private readonly production: ProductionService,
    private readonly market:     MarketService,
    private readonly population: PopulationService,
    @InjectRepository(RegionEntity)
    private readonly regionRepo:   Repository<RegionEntity>,
    @InjectRepository(RegionMarketEntity)
    private readonly marketRepo:   Repository<RegionMarketEntity>,
    @InjectRepository(PlanetInflationEntity)
    private readonly inflationRepo: Repository<PlanetInflationEntity>,
    @InjectRepository(GalacticMarketEntity)
    private readonly galacticRepo:  Repository<GalacticMarketEntity>,
    @InjectRepository(BuildQueueEntity)
    private readonly buildQueueRepo: Repository<BuildQueueEntity>,
    @InjectRepository(RegionBuildingEntity)
    private readonly buildingRepo:   Repository<RegionBuildingEntity>,
  ) {}

  // ═══════════════════════════════════════════════════════════
  //  EXECUTE — punto di ingresso chiamato dal TickEngine
  // ═══════════════════════════════════════════════════════════
  async execute(tick: number): Promise<EconomyTickResult> {
    this.logger.debug(`[Tick ${tick}] Economy phase start`);
    const start = Date.now();

    // Carica tutte le regioni attive (con owner, quindi colonizzate)
    const regions = await this.regionRepo.find({
      where: { owner_id: undefined }, // tutte
    });
    const activeRegions = regions.filter(r => r.owner_id !== null);

    // Mappa planet_id → lista regioni (per aggregazione planetaria)
    const byPlanet = new Map<string, RegionEntity[]>();
    for (const region of activeRegions) {
      if (!byPlanet.has(region.planet_id)) byPlanet.set(region.planet_id, []);
      byPlanet.get(region.planet_id)!.push(region);
    }

    // Mercato galattico (singleton)
    let galactic = await this.galacticRepo.findOne({ where: {} });
    if (!galactic) {
      galactic = await this.market.updateGalacticPrices({}, {}, tick);
    }

    // ── Accumulatori per aggregati planetari/galattici ─────────────────────
    const galacticSupply: Partial<Record<ResourceType, number>> = {};
    const galacticDemand: Partial<Record<ResourceType, number>> = {};
    let tradeFlows     = 0;
    let mobilityEvents = 0;
    const inflationUpdates: InflationSummary[] = [];

    // ─────────────────────────────────────────────────────────────────────
    //  LOOP PRINCIPALE PER REGIONE
    //  Esegue fasi 1–10 per ogni regione, raccoglie aggregati planetari.
    // ─────────────────────────────────────────────────────────────────────
    for (const region of activeRegions) {
      try {
        // ── FASE 1: Produzione edifici ─────────────────────────
        const { produced, consumed: buildingConsumed } =
          await this.production.processBuildingProduction(region, tick);

        // ── FASE 2: Domanda classi sociali ─────────────────────
        const blocks = await this.population.getRegionBlocks(region.id);

        const socialDemand: Partial<Record<ResourceType, number>> = {};
        for (const block of blocks) {
          const cfg = SOCIAL_CLASS_CONFIG[block.social_class];
          const add = (r: ResourceType, rate: number) => {
            socialDemand[r] = (socialDemand[r] ?? 0) + rate * block.count;
          };
          add(ResourceType.FOOD,  cfg.food_rate);
          add(ResourceType.GOODS, cfg.goods_rate);
          add(ResourceType.WATER, cfg.water_rate);
        }

        // Domanda totale = sociale + edifici (input già consumati)
        const totalDemand: Partial<Record<ResourceType, number>> = { ...socialDemand };

        // ── FASE 3: Aggiornamento prezzi locali ────────────────
        const inflation = await this.market.getOrCreateInflation(region.planet_id, region.owner_id!);
        let regionMarket = await this.marketRepo.findOneBy({ region_id: region.id });
        if (!regionMarket) {
          regionMarket = this.marketRepo.create({
            region_id: region.id, planet_id: region.planet_id,
            prices: {}, fixed_prices: {}, supply: {}, demand: {},
            price_history: [], embargo_map: {},
            last_updated_tick: tick,
          });
        }

        // Aggiorna supply/demand nel mercato di regione
        await this.production.updateRegionMarketSupplyDemand(region, produced, totalDemand, tick);
        regionMarket = await this.marketRepo.findOneBy({ region_id: region.id })!;

        await this.market.updateRegionPrices(regionMarket!, inflation, galactic, tick);

        // Accumula per galattico
        for (const [r, v] of Object.entries(produced)) {
          galacticSupply[r as ResourceType] = (galacticSupply[r as ResourceType] ?? 0) + (v as number);
        }
        for (const [r, v] of Object.entries(totalDemand)) {
          galacticDemand[r as ResourceType] = (galacticDemand[r as ResourceType] ?? 0) + (v as number);
        }

        // ── FASE 5: Consumi classi sociali ────────────────────
        const { consumed_by_block } =
          await this.production.processSocialConsumption(region, blocks, tick);

        // ── FASE 6: Aggiornamento felicità ─────────────────────
        // Ricarica regione aggiornata (housing capacity cambiata)
        const freshRegion = await this.regionRepo.findOneBy({ id: region.id }) ?? region;
        const totalPop    = blocks.reduce((s, b) => s + b.count, 0);

        for (const block of blocks) {
          const consumed = consumed_by_block[block.id] ?? {};
          this.population.calculateHappiness(block, consumed, freshRegion, totalPop);
        }

        // ── FASE 7: Crescita popolazione ────────────────────────
        const spaceFactor = totalPop > 0 && freshRegion.housing_capacity > 0
          ? Math.min(1, freshRegion.housing_capacity / totalPop)
          : 1;

        for (const block of blocks) {
          const foodConsumed = consumed_by_block[block.id]?.[ResourceType.FOOD] ?? 0;
          const foodRequired = SOCIAL_CLASS_CONFIG[block.social_class].food_rate * block.count;
          const foodSat      = foodRequired > 0 ? foodConsumed / foodRequired : 1;
          await this.population.processGrowth(block, block.happiness, foodSat, spaceFactor, tick);
        }

        // ── FASE 8: Assegnazione lavoratori (per prossimo tick) ─
        await this.population.assignWorkers(region.id, tick);

        // ── FASE 9: Mobilità sociale ────────────────────────────
        const mobilityResults = await this.population.processMobility(region.id, tick);
        mobilityEvents += mobilityResults.length;

        // ── FASE 10: Aggiornamento lealtà ──────────────────────
        const freshBlocks = await this.population.getRegionBlocks(region.id);
        await this.population.updateLoyalty(freshRegion, freshBlocks, tick);

      } catch (err) {
        this.logger.error(`Error processing region ${region.id}: ${err}`);
      }
    }

    // ── FASE 4: Commercio automatico interplanetario ───────────────────────
    const flows = await this.market.processAutoTrade(galactic, tick);
    tradeFlows  = flows.length;

    // ── FASE 11: Completamento costruzioni ────────────────────────────────
    await this.processBuildQueue(tick);

    // ── FASE 12: Inflazione per-pianeta ───────────────────────────────────
    for (const [planetId, planetRegions] of byPlanet.entries()) {
      try {
        const inf = await this.inflationRepo.findOneBy({ planet_id: planetId });
        if (!inf) continue;

        // Totali planetari per calcolo inflazione
        const population = planetRegions
          .flatMap(r => [])  // popolazione caricata dalla map
          .reduce((s: number) => s, 0);

        // Calcola totali reali da tutte le regioni del pianeta
        let totalPop   = 0;
        let totalProfit = 0;
        for (const r of planetRegions) {
          const blocks = await this.population.getRegionBlocks(r.id);
          totalPop    += blocks.reduce((s, b) => s + b.count, 0);
          totalProfit += blocks
            .filter(b => [SocialClass.BOURGEOISIE, SocialClass.OLIGARCHY].includes(b.social_class))
            .reduce((s, b) => s + b.wealth_per_block * b.count, 0);
        }

        const avgStability = planetRegions.reduce((s, r) => s + r.stability, 0) / planetRegions.length;
        const I_prev       = inf.I;

        const result = await this.market.updateInflation(
          inf, totalPop, 1.0 /* productivity */, avgStability,
          totalProfit, inf.money_printed_this_tick, tick,
        );

        inflationUpdates.push({ planet_id: planetId, I_prev, I_new: result.I_new, M: result.M });
      } catch (err) {
        this.logger.error(`Error updating inflation for planet ${planetId}: ${err}`);
      }
    }

    // ── FASE 13: Prezzi galattici ─────────────────────────────────────────
    const updatedGalactic = await this.market.updateGalacticPrices(galacticSupply, galacticDemand, tick);

    const elapsed = Date.now() - start;
    this.logger.log(
      `[Tick ${tick}] Economy done in ${elapsed}ms — ` +
      `regions=${activeRegions.length} trade=${tradeFlows} mobility=${mobilityEvents}`
    );

    return {
      tick,
      regions_processed: activeRegions.length,
      planets_processed: byPlanet.size,
      trade_flows:       tradeFlows,
      mobility_events:   mobilityEvents,
      inflation_updates: inflationUpdates,
      galactic_prices:   updatedGalactic.base_prices,
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  BUILD QUEUE — Completa le costruzioni in coda
  //
  //  Ogni tick decrementa build_ticks_remaining.
  //  Quando raggiunge 0 → crea/aggiorna il RegionBuilding.
  // ═══════════════════════════════════════════════════════════
  private async processBuildQueue(tick: number): Promise<void> {
    const queue = await this.buildQueueRepo.find({
      where: { status: 'IN_PROGRESS' },
    });

    for (const item of queue) {
      item.build_ticks_remaining--;

      if (item.build_ticks_remaining <= 0) {
        // Costruzione completata
        let building = await this.buildingRepo.findOne({
          where: { id: item.existing_building_id ?? '' },
        });

        if (!building) {
          const def = BUILDING_DEFINITIONS.find(d => d.id === item.building_def_id);
          building  = this.buildingRepo.create({
            region_id:        item.region_id,
            planet_id:        item.planet_id,
            owner_id:         item.empire_id,
            building_def_id:  item.building_def_id,
            category:         def?.category ?? 'INDUSTRIAL' as any,
            level:            item.target_level,
            max_level:        def?.max_level ?? 10,
            damage:           0,
            assigned_workers: {},
            last_output:      {},
            last_efficiency:  0,
            is_active:        true,
            is_nationalized:  false,
            corporation_id:   null,
            built_at_tick:    tick,
          });
        } else {
          building.level = item.target_level;
        }

        await this.buildingRepo.save(building);
        item.status = 'COMPLETED';
        this.logger.debug(`Build complete: ${item.building_def_id} lv${item.target_level} in region ${item.region_id}`);
      }

      await this.buildQueueRepo.save(item);
    }

    // Avanza gli item QUEUED → IN_PROGRESS se non c'è già uno IN_PROGRESS per quella regione
    const queued = await this.buildQueueRepo.find({ where: { status: 'QUEUED' } });
    const inProgressRegions = new Set(queue.map(q => q.region_id));

    for (const item of queued) {
      if (inProgressRegions.has(item.region_id)) continue;
      item.status = 'IN_PROGRESS';
      inProgressRegions.add(item.region_id);
      await this.buildQueueRepo.save(item);
    }
  }
}
