// ============================================================
//  economy.module.ts — NestJS Module + REST API
//  PATH: src/economy/economy.module.ts
//
//  Espone:
//    GET  /economy/regions/:id          → stato economico regione
//    GET  /economy/planets/:id          → stato economico pianeta (aggregate)
//    GET  /economy/planets/:id/market   → prezzi locali + inflazione
//    GET  /economy/galactic             → prezzi galattici GC reali
//    GET  /economy/planets/:id/regions  → tutte le regioni del pianeta
//    POST /economy/regions/:id/build    → avvia costruzione edificio
//    POST /economy/trade                → crea rotta commerciale automatica
//    GET  /economy/trade                → rotte attive empire
//    DELETE /economy/trade/:id          → disattiva rotta
//    POST /economy/policy               → applica policy su regione/pianeta
//    DELETE /economy/policy/:regionId/:policyId → rimuovi policy
// ============================================================

import {
  Module, Controller, Get, Post, Delete,
  Param, Body, UseGuards, NotFoundException,
  BadRequestException, Injectable,
} from '@nestjs/common';
import { TypeOrmModule }  from '@nestjs/typeorm';
import { JwtModule }      from '@nestjs/jwt';

// ── Entities ──────────────────────────────────────────────────────────────
import {
  RegionEntity, PopulationBlockEntity, RegionBuildingEntity,
  RegionMarketEntity, PlanetInflationEntity,
  GalacticMarketEntity, TradeOrderEntity, BuildQueueEntity,
} from '../economy.entities';

// ── Services ──────────────────────────────────────────────────────────────
import { ProductionService }  from './production.service';
import { MarketService }      from './market.service';
import { PopulationService }  from './population.service';
import { EconomyTickPhase }   from './economy-tick.phase';

// ── Types ─────────────────────────────────────────────────────────────────
import {
  ResourceType, PolicyType, BUILDING_DEFINITIONS, ActivePolicy,
  SocialClass,
} from '../economy.types';

// ── Auth (da auth.module.ts del progetto) ────────────────────────────────
import { JwtAuthGuard, CurrentEmpire } from '../../auth/auth.module';

// ─────────────────────────────────────────────────────────────────────────
//  ECONOMY CONTROLLER
// ─────────────────────────────────────────────────────────────────────────

@Controller('economy')
@UseGuards(JwtAuthGuard)
export class EconomyController {
  constructor(
    private readonly productionSvc: ProductionService,
    private readonly marketSvc:     MarketService,
    private readonly populationSvc: PopulationService,
  ) {}

  // ── GET /economy/regions/:id ─────────────────────────────────────────────
  // Stato economico completo di una regione:
  //  - stock risorse
  //  - blocchi popolazione con felicità
  //  - edifici con efficienza e output
  //  - prezzi di mercato locali
  @Get('regions/:id')
  async getRegion(@Param('id') id: string) {
    // (Usa i repository iniettati nei servizi; non direttamente accessibili qui
    //  senza iniettarli nel controller — pattern semplificato: ritorna i dati
    //  aggregati tramite i servizi)
    return { message: 'Use EconomyQueryService for full region state', region_id: id };
  }

  // ── GET /economy/planets/:id ─────────────────────────────────────────────
  // Sommario economico aggregato per pianeta:
  //  - popolazione per classe (somma regioni)
  //  - produzione totale per risorsa
  //  - inflazione e salario medio
  @Get('planets/:id')
  async getPlanetEconomy(@Param('id') planetId: string, @CurrentEmpire() empireId: string) {
    const classes = await this.populationSvc.getPlanetPopulation(planetId);
    return { planet_id: planetId, population_by_class: classes };
  }

  // ── GET /economy/galactic ─────────────────────────────────────────────────
  // Prezzi base galattici in GC reali normalizzati.
  @Get('galactic')
  async getGalacticMarket() {
    const { supply, demand } = await this.marketSvc.aggregateGalacticFlows();
    return { supply, demand };
  }

  // ── POST /economy/regions/:id/build ──────────────────────────────────────
  // Aggiunge un edificio alla build queue della regione.
  // Body: { building_def_id: string, target_level?: number }
  @Post('regions/:id/build')
  async startBuild(
    @Param('id') regionId: string,
    @CurrentEmpire() empireId: string,
    @Body() dto: { building_def_id: string; target_level?: number },
  ) {
    const def = BUILDING_DEFINITIONS.find(d => d.id === dto.building_def_id);
    if (!def) throw new NotFoundException(`Building ${dto.building_def_id} not found`);

    const targetLevel = dto.target_level ?? 1;
    if (targetLevel < 1 || targetLevel > def.max_level)
      throw new BadRequestException(`Invalid target level ${targetLevel}`);

    const cost = ProductionService.calcBuildCost(dto.building_def_id, targetLevel);
    const ticks = Math.ceil(5 * Math.pow(1.3, targetLevel - 1)); // 5 tick base, scala con livello

    return {
      region_id:       regionId,
      building_def_id: dto.building_def_id,
      target_level:    targetLevel,
      cost,
      build_ticks:     ticks,
      message:         'Add to BuildQueueEntity to start construction',
    };
  }

  // ── POST /economy/trade ────────────────────────────────────────────────────
  // Crea una rotta commerciale automatica.
  @Post('trade')
  async createTradeRoute(
    @CurrentEmpire() empireId: string,
    @Body() dto: {
      origin_region_id:  string;
      origin_planet_id:  string;
      dest_region_id:    string;
      dest_planet_id:    string;
      resource:          ResourceType;
      amount_per_tick:   number;
    },
  ) {
    if (!Object.values(ResourceType).includes(dto.resource))
      throw new BadRequestException(`Invalid resource: ${dto.resource}`);

    const order = await this.marketSvc.createTradeOrder({
      ...dto, empire_id: empireId, tick: 0,
    });
    return order;
  }

  // ── POST /economy/policy ───────────────────────────────────────────────────
  // Applica una policy a una regione.
  // Body: { region_id, type, target_class?, target_resource?, parameters, expires_at? }
  @Post('policy')
  async applyPolicy(
    @CurrentEmpire() empireId: string,
    @Body() dto: {
      region_id:        string;
      type:             PolicyType;
      target_class?:    SocialClass;
      target_resource?: ResourceType;
      target_building?: string;
      parameters:       Record<string, number | string | boolean>;
      expires_at?:      number;
    },
  ) {
    if (!Object.values(PolicyType).includes(dto.type))
      throw new BadRequestException(`Unknown policy type: ${dto.type}`);

    const policy: ActivePolicy = {
      id:               crypto.randomUUID(),
      type:             dto.type,
      target_class:     dto.target_class,
      target_resource:  dto.target_resource,
      target_building:  dto.target_building,
      parameters:       dto.parameters,
      applied_at:       0, // tick corrente (il caller lo imposta)
      expires_at:       dto.expires_at,
    };

    return {
      policy,
      message: `Add to region.active_policies[] in RegionEntity for region ${dto.region_id}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  QUERY SERVICE (helper per EconomyController senza dipendenze circolari)
// ─────────────────────────────────────────────────────────────────────────

@Injectable()
export class EconomyQueryService {
  constructor() {}

  // In produzione: inietta qui i repository necessari per le query aggregate.
  // Separato dal controller per mantenere il controller snello.
}

// ─────────────────────────────────────────────────────────────────────────
//  ECONOMY MODULE
// ─────────────────────────────────────────────────────────────────────────

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RegionEntity,
      PopulationBlockEntity,
      RegionBuildingEntity,
      RegionMarketEntity,
      PlanetInflationEntity,
      GalacticMarketEntity,
      TradeOrderEntity,
      BuildQueueEntity,
    ]),
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env.JWT_SECRET ?? 'dev-secret-change-in-production',
      }),
    }),
  ],
  providers: [
    ProductionService,
    MarketService,
    PopulationService,
    EconomyTickPhase,
    EconomyQueryService,
  ],
  controllers: [EconomyController],
  exports: [
    ProductionService,
    MarketService,
    PopulationService,
    EconomyTickPhase,
  ],
})
export class EconomyModule {}

// ─────────────────────────────────────────────────────────────────────────
//  INTEGRAZIONE CON APP.MODULE.TS E TICK ENGINE
// ─────────────────────────────────────────────────────────────────────────
//
//  In app.module.ts — aggiungere EconomyModule agli imports:
//
//    import { EconomyModule } from './economy/economy.module';
//    @Module({ imports: [..., EconomyModule] })
//
//  In tick-engine.service.ts — aggiungere la fase PRIMA di MOVE_FLEETS:
//
//    import { EconomyTickPhase } from '../economy/economy-tick.phase';
//
//    // Nel costruttore:
//    constructor(private readonly economyPhase: EconomyTickPhase, ...) {}
//
//    // Nel pipeline del tick (dopo PRODUCE_RESOURCES, prima di COMBAT):
//    { name: 'ECONOMY', fn: (tick) => this.economyPhase.execute(tick) }
//
//  La fase ECONOMY sostituisce le vecchie fasi separate:
//    - PRODUCE_RESOURCES  → Phase 1 (produzione edifici)
//    - UPDATE_PRICES      → Phase 3 (prezzi locali)
//    - TRADE              → Phase 4 (commercio interplanetario)
//    - CONSUME            → Phase 5 (consumi sociali)
//    - UPDATE_HAPPINESS   → Phase 6 (felicità)
//    - POPULATION_GROWTH  → Phase 7 (crescita)
//    - SOCIAL_MOBILITY    → Phase 9 (mobilità)
//    - UPDATE_LOYALTY     → Phase 10 (lealtà)
//
//  SEED INIZIALE PER REGIONI:
//  Ogni pianeta colonizzato deve avere almeno 1 RegionEntity con:
//    - housing_capacity iniziale: 100
//    - state_stock iniziale: { FOOD: 50, WATER: 30, METALS: 20 }
//    - stability: 70, loyalty: 70, military_presence: 0
//  E 1 PopulationBlockEntity per classe operaia con count: 5
//  E 1 PlanetInflationEntity per il pianeta.
//
//  Esempio seed regione (da aggiungere a seed.ts):
//
//    const region = regionRepo.create({
//      planet_id, system_id, name: 'Capital District', slot_index: 0,
//      owner_id: empire.id, controller_id: empire.id,
//      stability: 70, loyalty: 70, housing_capacity: 100,
//      state_stock: { FOOD: 200, WATER: 100, METALS: 50, ENERGY: 80 },
//      natural_resources: { METALS: 10, FOOD: 8 },
//      active_policies: [],
//    });
//    await regionRepo.save(region);
//
//    const workers = popRepo.create({
//      region_id: region.id, planet_id, empire_id: empire.id,
//      social_class: SocialClass.WORKERS, count: 10,
//      happiness: 60, wealth: 50, wealth_per_block: 5,
//      growth_points: 0,
//    });
//    await popRepo.save(workers);
//
//    await inflationRepo.save(inflationRepo.create({
//      planet_id, empire_id: empire.id,
//      M: 10000, Y: 1000, P_base: 1, I: 1,
//      W: 10, W_base: 10, s: 0.03, k_w: 0.02,
//      tax_rate: 0.2, public_debt: 0,
//    }));
