// ============================================================
//  EMPIRE / SYSTEMS / FLEETS — API Controllers + Modules
// ============================================================

import {
  Controller, Get, Post, Patch, Param, Body,
  UseGuards, NotFoundException, Module as Mod,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In }   from 'typeorm';
import { TypeOrmModule }    from '@nestjs/typeorm';
import { JwtModule }        from '@nestjs/jwt';

import { JwtAuthGuard }    from '../auth/auth.module';
import { CurrentEmpire }   from '../auth/auth.module';
import { EmpireEntity }    from '../entities/empire.entity';
import { StarSystemEntity } from '../entities/star-system.entity';
import { CelestialBodyEntity } from '../entities/celestial-body.entity';
import { FleetEntity, HyperlaneEntity } from '../entities/other-entities';
import { RedisService }    from '../redis/redis.service';

// ─────────────────────────────────────────────────────────────
//  EMPIRE CONTROLLER
// ─────────────────────────────────────────────────────────────

@Controller('empires')
@UseGuards(JwtAuthGuard)
export class EmpireController {
  constructor(
    @InjectRepository(EmpireEntity)
    private readonly empireRepo: Repository<EmpireEntity>,
    @InjectRepository(CelestialBodyEntity)
    private readonly bodyRepo: Repository<CelestialBodyEntity>,
    @InjectRepository(FleetEntity)
    private readonly fleetRepo: Repository<FleetEntity>,
    private readonly redis: RedisService,
  ) {}

  /** GET /empires/me — Stato completo del tuo impero */
  @Get('me')
  async getMyEmpire(@CurrentEmpire() empireId: string) {
    const empire = await this.empireRepo.findOneBy({ id: empireId });
    if (!empire) throw new NotFoundException('Empire not found');

    // Risorse aggiornate da Redis (più fresche del DB)
    const resources = await this.redis.getJson(`empire:${empireId}:resources`)
      ?? empire.resource_pool;

    const planets = await this.bodyRepo.find({
      where: { owner_id: empireId },
      select: ['id', 'name', 'system_id', 'type', 'population', 'status', 'loyalty'],
    });

    const fleets = await this.fleetRepo.find({
      where: { empire_id: empireId },
      select: ['id', 'name', 'status', 'current_system_id', 'total_firepower', 'total_ships'],
    });

    const tick = await this.redis.getCurrentTick();

    return {
      ...empire,
      resource_pool: resources,
      planets,
      fleets,
      current_tick: tick,
    };
  }

  /** GET /empires/:id — Profilo pubblico di un altro impero */
  @Get(':id')
  async getEmpire(@Param('id') id: string) {
    const empire = await this.empireRepo.findOneBy({ id });
    if (!empire) throw new NotFoundException();
    // Ritorna solo info pubbliche
    return {
      id:            empire.id,
      name:          empire.name,
      color:         empire.color,
      tech_level:    empire.tech_level,
      victory_points: empire.victory_points,
    };
  }

  /** GET /empires — Lista tutti gli empire (per diplomazia) */
  @Get()
  async listEmpires() {
    return this.empireRepo.find({
      select: ['id', 'name', 'color', 'tech_level', 'victory_points'],
    });
  }
}

// ─────────────────────────────────────────────────────────────
//  SYSTEMS CONTROLLER
// ─────────────────────────────────────────────────────────────

@Controller('systems')
@UseGuards(JwtAuthGuard)
export class SystemsController {
  constructor(
    @InjectRepository(StarSystemEntity)
    private readonly systemRepo: Repository<StarSystemEntity>,
    @InjectRepository(CelestialBodyEntity)
    private readonly bodyRepo: Repository<CelestialBodyEntity>,
    @InjectRepository(FleetEntity)
    private readonly fleetRepo: Repository<FleetEntity>,
    @InjectRepository(HyperlaneEntity)
    private readonly hyperlaneRepo: Repository<HyperlaneEntity>,
    private readonly redis: RedisService,
  ) {}

  /** GET /systems — Lista tutti i sistemi (per mappa galattica) */
  @Get()
  async listSystems(@CurrentEmpire() empireId: string) {
    const systems = await this.systemRepo.find({
      select: ['id', 'name', 'coordinates', 'owner_id', 'status', 'hyperlane_ids'],
    });
    return systems;
  }

  /** GET /systems/:id — Dettaglio sistema con pianeti e flotte */
  @Get(':id')
  async getSystem(
    @Param('id') id: string,
    @CurrentEmpire() empireId: string,
  ) {
    const system = await this.systemRepo.findOneBy({ id });
    if (!system) throw new NotFoundException('System not found');

    const bodies = await this.bodyRepo.find({
      where: { system_id: id },
    });

    // Flotte nel sistema (da Redis per dati freschi)
    const fleetIds = await this.redis.getSet(`system:${id}:fleets`);
    let fleets: any[] = [];
    if (fleetIds.length > 0) {
      fleets = await this.fleetRepo.find({ where: { id: In(fleetIds) } });
    }

    // Iperlane collegate
    const hyperlanes = await this.hyperlaneRepo.find({
      where: [{ system_a: id }, { system_b: id }],
    });

    return {
      ...system,
      bodies,
      fleets,
      hyperlanes,
    };
  }

  /** GET /systems/:id/planets — Solo pianeti del sistema */
  @Get(':id/planets')
  async getSystemPlanets(@Param('id') id: string) {
    return this.bodyRepo.find({ where: { system_id: id } });
  }
}

// ─────────────────────────────────────────────────────────────
//  PLANETS CONTROLLER
// ─────────────────────────────────────────────────────────────

@Controller('planets')
@UseGuards(JwtAuthGuard)
export class PlanetsController {
  constructor(
    @InjectRepository(CelestialBodyEntity)
    private readonly bodyRepo: Repository<CelestialBodyEntity>,
  ) {}

  /** GET /planets/:id */
  @Get(':id')
  async getPlanet(@Param('id') id: string) {
    const body = await this.bodyRepo.findOneBy({ id });
    if (!body) throw new NotFoundException('Planet not found');
    return body;
  }

  /** POST /planets/:id/colonize — Colonizza un pianeta non abitato */
  @Post(':id/colonize')
  async colonize(
    @Param('id') id: string,
    @CurrentEmpire() empireId: string,
  ) {
    const body = await this.bodyRepo.findOneBy({ id });
    if (!body) throw new NotFoundException();
    if (body.status !== 'UNINHABITED') {
      throw new NotFoundException('Planet already colonized');
    }
    // Nota: in produzione verificare che ci sia una colony ship nel sistema
    body.owner_id      = empireId;
    body.controller_id = empireId;
    body.status        = 'STABLE';
    body.population    = 1000;
    body.population_max = Math.floor(body.habitability * 1000);
    body.loyalty       = 80;
    body.morale        = 70;
    body.colonized_at  = new Date();
    await this.bodyRepo.save(body);
    return body;
  }
}

// ─────────────────────────────────────────────────────────────
//  FLEETS CONTROLLER
// ─────────────────────────────────────────────────────────────

@Controller('fleets')
@UseGuards(JwtAuthGuard)
export class FleetsController {
  constructor(
    @InjectRepository(FleetEntity)
    private readonly fleetRepo: Repository<FleetEntity>,
    @InjectRepository(StarSystemEntity)
    private readonly systemRepo: Repository<StarSystemEntity>,
    @InjectRepository(HyperlaneEntity)
    private readonly hyperlaneRepo: Repository<HyperlaneEntity>,
    private readonly redis: RedisService,
  ) {}

  /** GET /fleets — Tutte le flotte dell'empire */
  @Get()
  async getMyFleets(@CurrentEmpire() empireId: string) {
    return this.fleetRepo.find({ where: { empire_id: empireId } });
  }

  /** GET /fleets/:id */
  @Get(':id')
  async getFleet(
    @Param('id') id: string,
    @CurrentEmpire() empireId: string,
  ) {
    const fleet = await this.fleetRepo.findOneBy({ id, empire_id: empireId });
    if (!fleet) throw new NotFoundException();
    return fleet;
  }

  /**
   * POST /fleets/:id/move
   * Ordina a una flotta di spostarsi verso un sistema.
   * Body: { destination_system_id }
   */
  @Post(':id/move')
  async moveFleet(
    @Param('id') id: string,
    @CurrentEmpire() empireId: string,
    @Body() dto: { destination_system_id: string },
  ) {
    const fleet = await this.fleetRepo.findOneBy({ id, empire_id: empireId });
    if (!fleet) throw new NotFoundException('Fleet not found');
    if (fleet.status !== 'IDLE') {
      throw new NotFoundException(`Fleet is ${fleet.status}, cannot move`);
    }

    const dest = await this.systemRepo.findOneBy({ id: dto.destination_system_id });
    if (!dest) throw new NotFoundException('Destination system not found');

    const tick = await this.redis.getCurrentTick();

    // Calcola ticks di viaggio (distanza euclidea / velocità)
    const origin = await this.systemRepo.findOneBy({ id: fleet.current_system_id });
    let travelTicks = 10; // default
    if (origin) {
      const dx = dest.coordinates.x - origin.coordinates.x;
      const dy = dest.coordinates.y - origin.coordinates.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      travelTicks = Math.max(3, Math.ceil(dist / (fleet.total_speed || 1)));
    }

    fleet.status = 'MOVING';
    fleet.travel_state = {
      method:         'HYPERSPACE',
      origin_system:  fleet.current_system_id,
      dest_system:    dto.destination_system_id,
      departure_tick: tick,
      arrival_tick:   tick + travelTicks,
      progress:       0,
    };

    await this.fleetRepo.save(fleet);

    return {
      fleet_id:       fleet.id,
      destination:    dto.destination_system_id,
      departure_tick: tick,
      arrival_tick:   tick + travelTicks,
      travel_ticks:   travelTicks,
    };
  }

  /**
   * POST /fleets/create
   * Crea una nuova flotta nel sistema indicato.
   * Body: { name, system_id, ships: number }
   */
  @Post('create')
  async createFleet(
    @CurrentEmpire() empireId: string,
    @Body() dto: { name: string; system_id: string; ships?: number },
  ) {
    const ships = dto.ships ?? 5;
    const fleet = this.fleetRepo.create({
      name:              dto.name,
      empire_id:         empireId,
      current_system_id: dto.system_id,
      status:            'IDLE',
      total_ships:       ships,
      total_firepower:   ships * 10,
      total_hull:        ships * 100,
      total_shields:     ships * 50,
      total_speed:       1.5,
      supply_level:      100,
      morale:            80,
    });
    await this.fleetRepo.save(fleet);
    await this.redis.addToSet(`system:${dto.system_id}:fleets`, fleet.id);
    return fleet;
  }
}

// ─────────────────────────────────────────────────────────────
//  GAME MODULE (raggruppa tutte le API di gioco)
// ─────────────────────────────────────────────────────────────

@Mod({
  imports: [
    TypeOrmModule.forFeature([
      EmpireEntity, StarSystemEntity, CelestialBodyEntity,
      FleetEntity, HyperlaneEntity,
    ]),
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env.JWT_SECRET ?? 'dev-secret-change-in-production',
      }),
    }),
  ],
  providers:   [RedisService],
  controllers: [EmpireController, SystemsController, PlanetsController, FleetsController],
})
export class GameModule {}
