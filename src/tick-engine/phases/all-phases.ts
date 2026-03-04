import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';

import { RedisService } from '../../redis/redis.service';
import {
  BodyStatus, FleetStatus, TravelMethod, WormholeStatus, ResourceType,
  EventType, ResourceStock, TickDelta, FleetDelta, PlanetDelta, WormholeDelta,
  EventNotification, EmpireResourceDelta, CombatResult,
  TICK_CONSTANTS, emptyStock, addStock, clampStock,
} from '../../common/game.types';

// ─── TypeORM Entities (stub di struttura; i decorator @Column ecc.
//     vanno aggiunti nelle entity class vere) ────────────────────

import { FleetEntity }         from '../../entities/fleet.entity';
import { CelestialBodyEntity } from '../../entities/celestial-body.entity';
import { WormholeEntity }      from '../../entities/wormhole.entity';
import { EmpireEntity }        from '../../entities/empire.entity';
import { TradeRouteEntity }    from '../../entities/trade-route.entity';
import { GameEventEntity }     from '../../entities/game-event.entity';
import { StarSystemEntity }    from '../../entities/star-system.entity';
import { GameEventDelta }      from '../../common/game.types';

// ─────────────────────────────────────────────────────────────
//  PHASE 1 — MOVE FLEETS
// ─────────────────────────────────────────────────────────────

@Injectable()
export class MoveFleetsPhase {
  private readonly logger = new Logger(MoveFleetsPhase.name);

  constructor(
    @InjectRepository(FleetEntity)
    private readonly fleetRepo: Repository<FleetEntity>,
    private readonly redis: RedisService,
  ) {}

  async execute(tick: number, delta: TickDelta): Promise<void> {
    // Carica tutte le flotte in movimento (MOVING o IN_WORMHOLE)
    const movingFleets = await this.fleetRepo.find({
      where: [
        { status: FleetStatus.MOVING },
        { status: FleetStatus.IN_WORMHOLE },
      ],
    });

    for (const fleet of movingFleets) {
      if (!fleet.travel_state) continue;

      const ts = fleet.travel_state;

      // Avanzamento progress: da 0.0 a 1.0 lungo il viaggio
      const totalTicks = ts.arrival_tick - ts.departure_tick;
      const elapsed    = tick - ts.departure_tick;
      ts.progress = Math.min(1.0, elapsed / totalTicks);

      // Calo supply durante il viaggio
      fleet.supply_level = Math.max(0, fleet.supply_level - 1);

      // Morale cala se supply basso
      if (fleet.supply_level < 20) {
        fleet.morale = Math.max(0, fleet.morale - TICK_CONSTANTS.LOW_SUPPLY_MORALE_PENALTY);
      }

      // ── Arrivo ──
      if (ts.progress >= 1.0) {
        // Gestione rischio wormhole
        if (ts.method === TravelMethod.WORMHOLE && ts.wormhole_id) {
          await this.handleWormholeArrival(fleet, ts.wormhole_id, delta);
        }

        // Aggiorna posizione
        fleet.current_system_id = ts.dest_system;
        fleet.travel_state      = null;
        fleet.status            = FleetStatus.IDLE;

        // Aggiorna set Redis del sistema
        await this.redis.removeFromSet(`system:${ts.origin_system}:fleets`, fleet.id);
        await this.redis.addToSet(`system:${ts.dest_system}:fleets`, fleet.id);

        this.logger.debug(`Fleet ${fleet.id} arrived at system ${ts.dest_system}`);
      } else {
        fleet.travel_state = ts;
      }

      await this.fleetRepo.save(fleet);

      delta.fleets!.push({
        fleet_id:  fleet.id,
        empire_id: fleet.empire_id,
        status:    fleet.status,
        system_id: fleet.current_system_id ?? undefined,
        progress:  ts.progress < 1.0 ? ts.progress : undefined,
        supply:    fleet.supply_level,
        location: fleet.current_system_id ?? '',
        morale:    fleet.morale,
      } as FleetDelta);
    }
  }

  private async handleWormholeArrival(
    fleet: FleetEntity,
    wormholeId: string,
    delta: TickDelta,
  ): Promise<void> {
    const wh = await this.redis.getJson<WormholeEntity>(`wormhole:${wormholeId}:state`);
    if (!wh) return;

    if (wh.status === WormholeStatus.UNSTABLE) {
      // Danno alla flotta proporzionale al rischio
      const dmgPct = TICK_CONSTANTS.WORMHOLE_RISK_DAMAGE_PERCENT * (wh.risk_level / 100);
      fleet.total_hull = Math.max(1, Math.floor(fleet.total_hull * (1 - dmgPct)));
      fleet.total_shields = Math.max(0, Math.floor(fleet.total_shields * (1 - dmgPct)));
      this.logger.warn(
        `Fleet ${fleet.id} took ${(dmgPct * 100).toFixed(1)}% damage traversing unstable wormhole ${wormholeId}`,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  PHASE 2 — PRODUCE RESOURCES
// ─────────────────────────────────────────────────────────────

@Injectable()
export class ProduceResourcesPhase {
  constructor(
    @InjectRepository(CelestialBodyEntity)
    private readonly bodyRepo: Repository<CelestialBodyEntity>,
    private readonly redis: RedisService,
  ) {}

  async execute(tick: number, delta: TickDelta): Promise<void> {
    // Prende solo pianeti/lune colonizzati
    const bodies = await this.bodyRepo.find({
      where: { status: In([BodyStatus.STABLE, BodyStatus.UNSTABLE, BodyStatus.OCCUPIED]) },
    });

    const empireTotals: Map<string, Partial<ResourceStock>> = new Map();

    for (const body of bodies) {
      if (!body.owner_id || !body.resource_flow) continue;

      // Calcola surplus netto: production - consumption
      const production   = body.resource_flow.production ?? {};
      const consumption  = body.resource_flow.consumption ?? {};
      const surplus: Partial<ResourceStock> = {};

      for (const res of Object.values(ResourceType)) {
        const prod = (production[res] ?? 0);
        const cons = (consumption[res] ?? 0);
        const net  = prod - cons;

        // Penalità produttività su pianeta instabile o occupato
        const stabilityMult =
          body.status === BodyStatus.UNSTABLE ? 0.6 :
          body.status === BodyStatus.OCCUPIED ? 0.3 : 1.0;

        surplus[res] = net * stabilityMult;
      }

      // Accumula per empire
      const prev = empireTotals.get(body.owner_id) ?? {};
      const merged: Partial<ResourceStock> = { ...prev };
      for (const res of Object.values(ResourceType)) {
        merged[res] = (merged[res] ?? 0) + (surplus[res] ?? 0);
      }
      empireTotals.set(body.owner_id, merged);

      // Aggiorna stock locale del pianeta (buffer per trade routes)
      const localStock: ResourceStock = clampStock(
        addStock(body.resource_stock ?? emptyStock(), surplus),
      );
      body.resource_stock = localStock;
      await this.bodyRepo.save(body);
    }

    // Aggiorna empire resource pools su Redis (flush su DB in fase 12)
    for (const [empireId, flow] of empireTotals) {
      const poolKey   = `empire:${empireId}:resources`;
      const poolCache = await this.redis.getJson<ResourceStock>(poolKey) ?? emptyStock();
      const updated   = clampStock(addStock(poolCache, flow));
      await this.redis.setJson(poolKey, updated);

    delta.empireResources!.push({
      empire_id: empireId,
      produced: flow,         // oppure separa production/consumption se li hai
      consumed: {},
      net: flow,
    });
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  PHASE 3 — TRANSFER RESOURCES (Trade Routes)
// ─────────────────────────────────────────────────────────────

@Injectable()
export class TransferResourcesPhase {
  constructor(
    @InjectRepository(TradeRouteEntity)
    private readonly tradeRouteRepo: Repository<TradeRouteEntity>,
    @InjectRepository(CelestialBodyEntity)
    private readonly bodyRepo: Repository<CelestialBodyEntity>,
  ) {}

  async execute(tick: number, delta: TickDelta): Promise<void> {
    const activeRoutes = await this.tradeRouteRepo.find({
      where: { is_active: true },
    });

    for (const route of activeRoutes) {
      const origin = await this.bodyRepo.findOneBy({ id: route.origin_id });
      const dest   = await this.bodyRepo.findOneBy({ id: route.dest_id });

      if (!origin || !dest) continue;

      // Calcola quantità effettiva tenendo conto dell'efficienza
      const available = (origin.resource_stock?.[route.resource_type] ?? 0);
      const requested = route.amount_per_tick * route.efficiency;
      const transferred = Math.min(available, requested);

      if (transferred <= 0) continue;

      // Scala dal pianeta origine
      origin.resource_stock![route.resource_type] -= transferred;
      // Aggiungi al pianeta destinazione
      dest.resource_stock![route.resource_type] = (dest.resource_stock![route.resource_type] ?? 0) + transferred;

      route.last_transfer_tick = tick;

      await this.bodyRepo.save([origin, dest]);
      await this.tradeRouteRepo.save(route);
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  PHASE 4 — UPDATE POPULATION
// ─────────────────────────────────────────────────────────────

@Injectable()
export class UpdatePopulationPhase {
  constructor(
    @InjectRepository(CelestialBodyEntity)
    private readonly bodyRepo: Repository<CelestialBodyEntity>,
  ) {}

  async execute(tick: number, delta: TickDelta): Promise<void> {
    const colonized = await this.bodyRepo.find({
      where: { status: In([BodyStatus.STABLE, BodyStatus.UNSTABLE, BodyStatus.OCCUPIED]) },
    });

    for (const body of colonized) {
      if (!body.population || body.population === 0) continue;

      // Crescita base modulata da morale e disponibilità cibo
      const foodSurplus  = body.resource_flow?.surplus?.[ResourceType.FOOD] ?? 0;
      const foodMult     = foodSurplus >= 0 ? 1.0 : 0.5;  // carestia → crescita dimezzata
      const moraleMult   = (body.morale ?? 50) / 100;

      const growthRate   = TICK_CONSTANTS.POPULATION_GROWTH_BASE * foodMult * moraleMult;
      const delta_pop    = Math.floor(body.population * growthRate);

      body.population = Math.min(body.population + delta_pop, body.population_max ?? Infinity);

      // Carestia grave → calo popolazione
      if (foodSurplus < -100) {
        const starvation = Math.floor(body.population * 0.001);
        body.population  = Math.max(0, body.population - starvation);
      }

      await this.bodyRepo.save(body);

      delta.planets!.push({
        planet_id:  body.id,
        population: { total: body.population } as Record<string,number>,
      } as PlanetDelta);
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  PHASE 5 — UPDATE LOYALTY
// ─────────────────────────────────────────────────────────────

@Injectable()
export class UpdateLoyaltyPhase {
  constructor(
    @InjectRepository(CelestialBodyEntity)
    private readonly bodyRepo: Repository<CelestialBodyEntity>,
    @InjectRepository(EmpireEntity)
    private readonly empireRepo: Repository<EmpireEntity>,
  ) {}

  async execute(tick: number, delta: TickDelta): Promise<void> {
    const bodies = await this.bodyRepo.find({
      where: { status: In([BodyStatus.STABLE, BodyStatus.UNSTABLE, BodyStatus.OCCUPIED, BodyStatus.REBELLING]) },
    });

    for (const body of bodies) {
      if (!body.owner_id) continue;

      const empire = await this.empireRepo.findOneBy({ id: body.owner_id });
      const govt   = empire?.government;

      // Loyalty base del governo (default 0)
      let loyaltyDelta = govt?.modifiers?.loyalty_base ?? 0;

      // Occupazione straniera → forte penalità
      if (body.owner_id !== body.controller_id) {
        loyaltyDelta -= 4;
      }

      // Cibo scarso → penalità morale/loyalty
      const foodSurplus = body.resource_flow?.surplus?.[ResourceType.FOOD] ?? 0;
      if (foodSurplus < 0)  loyaltyDelta -= 2;
      if (foodSurplus > 50) loyaltyDelta += 1;

      // Supply armata di presidio → bonus stabilità
      const garrisonBonus = (body.army_ids?.length ?? 0) > 0 ? 1 : 0;
      loyaltyDelta += garrisonBonus;

      // Cultural center buildings (bonus loyalty caricato da edifici)
      loyaltyDelta += body.loyalty_building_bonus ?? 0;

      // Ribellione attiva → loyalty crolla
      if (body.status === BodyStatus.REBELLING) {
        loyaltyDelta -= 8;
      }

      body.loyalty = Math.max(0, Math.min(100, (body.loyalty ?? 50) + loyaltyDelta));

      // Morale segue loyalty con inerzia (media pesata)
      body.morale = Math.round(
        (body.morale ?? 50) * 0.85 + body.loyalty * 0.15,
      );

      // Aggiorna stability = media di loyalty e morale
      body.stability = Math.round((body.loyalty + body.morale) / 2);

      // Aggiorna status in base alla loyalty
      if (body.status !== BodyStatus.REBELLING) {
        if (body.loyalty < TICK_CONSTANTS.LOYALTY_REBELLION_THRESHOLD) {
          body.status = BodyStatus.UNSTABLE; // → sarà gestito in fase 6
        } else if (body.loyalty < TICK_CONSTANTS.LOYALTY_UNSTABLE_THRESHOLD) {
          body.status = BodyStatus.UNSTABLE;
        } else if (body.owner_id !== body.controller_id) {
          body.status = BodyStatus.OCCUPIED;
        } else {
          body.status = BodyStatus.STABLE;
        }
      }

      await this.bodyRepo.save(body);

      delta.planets!.push({
        planet_id: body.id,
        loyalty:   body.loyalty,
        morale:    body.morale,
        stability: body.stability,
        status:    body.status,
      } as PlanetDelta);
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  PHASE 6 — CHECK REBELLIONS
// ─────────────────────────────────────────────────────────────

@Injectable()
export class CheckRebellionsPhase {
  private readonly logger = new Logger(CheckRebellionsPhase.name);

  constructor(
    @InjectRepository(CelestialBodyEntity)
    private readonly bodyRepo: Repository<CelestialBodyEntity>,
    @InjectRepository(GameEventEntity)
    private readonly eventRepo: Repository<GameEventEntity>,
  ) {}

  async execute(tick: number, delta: TickDelta): Promise<void> {
    // Pianeti instabili con loyalty critica
    const atRisk = await this.bodyRepo.find({
      where: { status: BodyStatus.UNSTABLE },
    });

    for (const body of atRisk) {
      if ((body.loyalty ?? 50) >= TICK_CONSTANTS.LOYALTY_REBELLION_THRESHOLD) continue;

      // Probabilità ribellione aumenta quanto più la loyalty è bassa
      const loyaltyFactor = 1 - body.loyalty / TICK_CONSTANTS.LOYALTY_REBELLION_THRESHOLD;
      const probability   = TICK_CONSTANTS.REBELLION_BASE_PROBABILITY * loyaltyFactor;

      if (Math.random() > probability) continue;

      // ── RIBELLIONE SCATTATA ──
      body.status = BodyStatus.REBELLING;

      // Il controller passa a null (ribelli)
      const prevController = body.controller_id;
      body.controller_id   = null as any;

      await this.bodyRepo.save(body);

      // Crea evento di gioco
      const event = this.eventRepo.create({
        type:               EventType.REBELLION,
        title:              `Ribellione su ${body.name}`,
        description:        `La popolazione di ${body.name} si è ribellata. Loyaltà crollata a ${body.loyalty}.`,
        affected_empire_ids: [body.owner_id],
        affected_body_ids:  [body.id],
        triggered_at:       tick,
        duration:           undefined,
        requires_player_action: true,
        player_choices: [
          { id: 'SUPPRESS', label: 'Sopprimi militarmente (-20 loyalty, +stabilità immediata)' },
          { id: 'NEGOTIATE', label: 'Negozia concessioni (-risorse, +loyalty nel tempo)' },
          { id: 'IGNORE', label: 'Ignora (rischio espansione ribellione)' },
        ],
      });
      await this.eventRepo.save(event);

      this.logger.warn(`REBELLION on ${body.name} (owner: ${body.owner_id}, loyalty: ${body.loyalty})`);

      delta.planets!.push({
        planet_id: body.id,
        loyalty:   body.loyalty,
        status:    BodyStatus.REBELLING,
      } as PlanetDelta);

      delta.events!.push({
        id: event.id,                     // obbligatorio
        event_id: event.id,               // opzionale, alias retrocompatibilità
        type: event.type,
        title: event.title,
        description: event.description,
        message: event.description,       // obbligatorio
        tick: tick,                       // usa il parametro tick della funzione
        empire_ids: [body.owner_id],      // o wh.discovered_by se è un wormhole
        choices: event.player_choices,    // opzionale
      } as GameEventDelta);
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  PHASE 7 — RESOLVE COMBAT
// ─────────────────────────────────────────────────────────────

@Injectable()
export class ResolveCombatPhase {
  private readonly logger = new Logger(ResolveCombatPhase.name);

  constructor(
    @InjectRepository(FleetEntity)
    private readonly fleetRepo: Repository<FleetEntity>,
    @InjectRepository(StarSystemEntity)
    private readonly systemRepo: Repository<StarSystemEntity>,
    private readonly redis: RedisService,
  ) {}

  async execute(tick: number, delta: TickDelta): Promise<void> {
    // Trova sistemi con flotte di empire diverse (potenziale combattimento)
    const contestedSystems = await this.systemRepo.find({
      where: { status: 'CONTESTED' },
    });

    for (const system of contestedSystems) {
      const fleetIds = await this.redis.getSet(`system:${system.id}:fleets`);
      if (fleetIds.length < 2) continue;

      const fleets = await this.fleetRepo.find({
        where: { id: In(fleetIds), status: FleetStatus.IN_COMBAT },
      });

      // Raggruppa per empire
      const byEmpire = new Map<string, FleetEntity[]>();
      for (const f of fleets) {
        const arr = byEmpire.get(f.empire_id) ?? [];
        arr.push(f);
        byEmpire.set(f.empire_id, arr);
      }

      const empires = [...byEmpire.keys()];
      if (empires.length < 2) continue;

      // Combattimento semplificato: confronto firepower con casualità
      // (sostituire con sistema granulare in una fase successiva)
      for (let i = 0; i < empires.length - 1; i++) {
        for (let j = i + 1; j < empires.length; j++) {
          await this.resolveBattle(
            system.id,
            empires[i], byEmpire.get(empires[i])!,
            empires[j], byEmpire.get(empires[j])!,
            tick, delta,
          );
        }
      }
    }
  }

  private async resolveBattle(
    systemId: string,
    empireA: string, fleetsA: FleetEntity[],
    empireB: string, fleetsB: FleetEntity[],
    tick: number,
    delta: TickDelta,
  ): Promise<void> {
    // Calcola potere totale con componente casuale ±15%
    const powerA = fleetsA.reduce((s, f) => s + f.total_firepower, 0);
    const powerB = fleetsB.reduce((s, f) => s + f.total_firepower, 0);

    const rollA  = powerA * (0.85 + Math.random() * 0.30);
    const rollB  = powerB * (0.85 + Math.random() * 0.30);

    // Perdite proporzionali al danno subito (non letale in 1 tick)
    const lossRateA = Math.min(0.25, rollB / (powerA * 10));
    const lossRateB = Math.min(0.25, rollA / (powerB * 10));

    let lossesA = 0, lossesB = 0;

    for (const fleet of fleetsA) {
      const hullDmg = Math.floor(fleet.total_hull * lossRateA);
      fleet.total_hull    = Math.max(0, fleet.total_hull - hullDmg);
      fleet.total_shields = Math.max(0, fleet.total_shields - Math.floor(fleet.total_shields * lossRateA * 1.5));
      fleet.experience    = Math.min(100, fleet.experience + TICK_CONSTANTS.COMBAT_EXP_PER_TICK);

      // Flotta distrutta se hull <= 0
      if (fleet.total_hull <= 0) {
        fleet.status   = FleetStatus.RETREATING;
        lossesA       += fleet.total_ships;
      }
      await this.fleetRepo.save(fleet);
    }

    for (const fleet of fleetsB) {
      const hullDmg = Math.floor(fleet.total_hull * lossRateB);
      fleet.total_hull    = Math.max(0, fleet.total_hull - hullDmg);
      fleet.total_shields = Math.max(0, fleet.total_shields - Math.floor(fleet.total_shields * lossRateB * 1.5));
      fleet.experience    = Math.min(100, fleet.experience + TICK_CONSTANTS.COMBAT_EXP_PER_TICK);

      if (fleet.total_hull <= 0) {
        fleet.status = FleetStatus.RETREATING;
        lossesB     += fleet.total_ships;
      }
      await this.fleetRepo.save(fleet);
    }

    const outcome: CombatResult['outcome'] =
      lossesA > lossesB ? 'DEFENDER_WIN' :
      lossesB > lossesA ? 'ATTACKER_WIN' : 'ONGOING';

    delta.combatResults!.push({
      system_id:       systemId,
      attacker_id:     empireA,
      defender_id:     empireB,
      outcome,
      attacker_losses: lossesA,
      defender_losses: lossesB,
    });

    this.logger.log(`Combat in ${systemId}: A=${empireA}(${powerA.toFixed(0)}) vs B=${empireB}(${powerB.toFixed(0)}) → ${outcome}`);
  }
}

// ─────────────────────────────────────────────────────────────
//  PHASE 8 — UPDATE WORMHOLES
// ─────────────────────────────────────────────────────────────

@Injectable()
export class UpdateWormholesPhase {
  private readonly logger = new Logger(UpdateWormholesPhase.name);

  constructor(
    @InjectRepository(WormholeEntity)
    private readonly wormholeRepo: Repository<WormholeEntity>,
    @InjectRepository(GameEventEntity)
    private readonly eventRepo: Repository<GameEventEntity>,
  ) {}

  async execute(tick: number, delta: TickDelta): Promise<void> {
    const wormholes = await this.wormholeRepo.find();

    for (const wh of wormholes) {
      let changed = false;

      if (wh.status === WormholeStatus.COLLAPSED) {
        // Tentativo di riapertura
        if (Math.random() < (wh.reopen_chance ?? TICK_CONSTANTS.WORMHOLE_REOPEN_CHANCE_DEFAULT)) {
          wh.status    = WormholeStatus.UNSTABLE;
          wh.stability = 20; // parte instabile
          changed      = true;
          this.logger.log(`Wormhole ${wh.id} reopened!`);

          // Evento di scoperta per empire nei sistemi collegati
          const event = this.eventRepo.create({
            type:  EventType.WORMHOLE_DISCOVERY,
            title: `Wormhole riaperto: ${wh.name ?? wh.id}`,
            description: `Un wormhole collassato si è riaperto, collegando due sistemi lontani. Instabile: attraversarlo è rischioso.`,
            affected_empire_ids: wh.discovered_by ?? [],
            triggered_at: tick,
            requires_player_action: false,
          });
          await this.eventRepo.save(event);

          delta.events!.push({
            id: event.id,                     // obbligatorio
            type: EventType.WORMHOLE_DISCOVERY,
            title: event.title,
            description: event.description,
            empire_ids: wh.discovered_by ?? [],
            message: event.description,       // puoi mappare su message se vuoi
            tick: tick,                  // o la variabile tick corrente
            choices: event.player_choices,    // se vuoi mantenerle
          } as GameEventDelta);
        }
      } else if (wh.status !== WormholeStatus.UNKNOWN) {
        // Decadimento stabilità ogni tick
        const decay = wh.stability_decay ?? TICK_CONSTANTS.WORMHOLE_STABILITY_DECAY_DEFAULT;
        wh.stability = Math.max(0, wh.stability - decay);

        // Aggiorna status in base alla stability
        const prevStatus = wh.status;
        if (wh.stability <= TICK_CONSTANTS.WORMHOLE_COLLAPSE_THRESHOLD) {
          wh.status  = WormholeStatus.COLLAPSED;
          changed    = true;
          this.logger.warn(`Wormhole ${wh.id} COLLAPSED (stability=${wh.stability.toFixed(1)})`);

          // Flotte in transito → danno catastrofico (gestito in Phase 1 del prossimo tick)
          const event = this.eventRepo.create({
            type:  EventType.WORMHOLE_COLLAPSE,
            title: `Wormhole collassato: ${wh.name ?? wh.id}`,
            description: `Il wormhole ha raggiunto stabilità critica ed è collassato. Le flotte in transito hanno subito danni gravi.`,
            affected_empire_ids: wh.discovered_by ?? [],
            triggered_at: tick,
            requires_player_action: false,
          });
          await this.eventRepo.save(event);

          delta.events!.push({
            id: event.id,                     // obbligatorio
            type: EventType.WORMHOLE_DISCOVERY,
            title: event.title,
            description: event.description,
            empire_ids: wh.discovered_by ?? [],
            message: event.description,       // puoi mappare su message se vuoi
            tick: tick,                  // o la variabile tick corrente
            choices: event.player_choices,    // se vuoi mantenerle
          } as GameEventDelta);
        } else if (wh.stability < 30 && prevStatus === WormholeStatus.STABLE) {
          wh.status = WormholeStatus.UNSTABLE;
          changed   = true;
        } else if (wh.stability >= 30 && prevStatus === WormholeStatus.UNSTABLE) {
          wh.status = WormholeStatus.STABLE;
          changed   = true;
        }
      }

      if (changed) {
        await this.wormholeRepo.save(wh);
        delta.wormholes!.push({
          wormhole_id: wh.id,
          status:      wh.status,
          stability:   wh.stability,
        } as WormholeDelta);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  PHASE 9 — PROCESS EVENTS
// ─────────────────────────────────────────────────────────────

@Injectable()
export class ProcessEventsPhase {
  constructor(
    @InjectRepository(GameEventEntity)
    private readonly eventRepo: Repository<GameEventEntity>,
    @InjectRepository(EmpireEntity)
    private readonly empireRepo: Repository<EmpireEntity>,
  ) {}

  async execute(tick: number, delta: TickDelta): Promise<void> {
    // Trova eventi attivi che scadono questo tick
    const expiring = await this.eventRepo
      .createQueryBuilder('event')
      .where('event.ends_at = :tick', { tick })
      .andWhere('event.is_active = true')
      .getMany();

    for (const event of expiring) {
      event.is_active = false;
      await this.eventRepo.save(event);
    }

    // ── Genera eventi casuali ──
    await this.maybeSpawnRandomEvent(tick, delta);
  }

  private async maybeSpawnRandomEvent(tick: number, delta: TickDelta): Promise<void> {
    // 0.5% di probabilità per tick di generare un GOLDEN_AGE su un empire random
    if (Math.random() > 0.005) return;

    const empires = await this.empireRepo.find({ take: 10 });
    if (!empires.length) return;

    const target = empires[Math.floor(Math.random() * empires.length)];

    const event = this.eventRepo.create({
      type:        EventType.GOLDEN_AGE,
      title:       `Età d'oro per ${target.name}`,
      description: `Un periodo di prosperità e innovazione inizia nell'impero. +20% produzione per 50 tick.`,
      affected_empire_ids: [target.id],
      triggered_at: tick,
      duration:     50,
      ends_at:      tick + 50,
      requires_player_action: false,
    });
    await this.eventRepo.save(event);

    delta.events!.push({
      id: event.id,                     // obbligatorio
      type: EventType.WORMHOLE_DISCOVERY,
      title: event.title,
      description: event.description,
      empire_ids: [target.id],
      message: event.description,       // puoi mappare su message se vuoi
      tick: tick,                  // o la variabile tick corrente
      choices: event.player_choices,    // se vuoi mantenerle
    } as GameEventDelta);
  }
}

// ─────────────────────────────────────────────────────────────
//  PHASE 10 — UPDATE RESEARCH
// ─────────────────────────────────────────────────────────────

@Injectable()
export class UpdateResearchPhase {
  constructor(
    @InjectRepository(EmpireEntity)
    private readonly empireRepo: Repository<EmpireEntity>,
    private readonly redis: RedisService,
  ) {}

  async execute(tick: number, delta: TickDelta): Promise<void> {
    const empires = await this.empireRepo.find();

    for (const empire of empires) {
      const pool = await this.redis.getJson<ResourceStock>(`empire:${empire.id}:resources`);
      if (!pool) continue;

      const researchPoints = pool[ResourceType.RESEARCH] ?? 0;
      if (researchPoints <= 0) continue;

      // Consuma punti ricerca per avanzare nella coda
      const queue = empire.research_queue ?? [];
      if (queue.length === 0) continue;

      empire.accumulated_research = (empire.accumulated_research ?? 0) + researchPoints;

      // Se ha accumulato abbastanza → completa la ricerca corrente
      if (empire.accumulated_research >= TICK_CONSTANTS.RESEARCH_COST_PER_LEVEL) {
        empire.accumulated_research -= TICK_CONSTANTS.RESEARCH_COST_PER_LEVEL;
        empire.tech_level           = Math.min(10, (empire.tech_level ?? 0) + 1);
        empire.research_queue        = queue.slice(1); // rimuove il primo elemento
      }

      // Azzera i punti ricerca dal pool (non si accumula, si converte)
      pool[ResourceType.RESEARCH] = 0;
      await this.redis.setJson(`empire:${empire.id}:resources`, pool);
      await this.empireRepo.save(empire);
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  PHASE 11 — NOTIFY PLAYERS (WebSocket pub via Redis)
// ─────────────────────────────────────────────────────────────

@Injectable()
export class NotifyPlayersPhase {
  private readonly logger = new Logger(NotifyPlayersPhase.name);

  constructor(
    private readonly redis: RedisService,
    @InjectRepository(EmpireEntity)
    private readonly empireRepo: Repository<EmpireEntity>,
  ) {}

  async execute(tick: number, delta: TickDelta): Promise<void> {
    // Pubblica delta globale (per tutti)
    await this.redis.publishGlobalEvent({
      tick,
      wormholes:     delta.wormholes,
      combatResults: delta.combatResults,
      events:        delta.events?.filter(e => (e.empire_ids?.length ?? 1) === 0),
    });

    // Per ogni empire, costruisce e pubblica un delta personalizzato
    // (solo i dati che riguardano quell'empire)
    const empires = await this.empireRepo.find({ select: ['id'] });

    for (const empire of empires) {
      const empireDelta: TickDelta = {
        tick,
        timestamp: Date.now(),
        fleets: delta.fleets?.filter(f => f.empire_id === empire.id),
        planets: delta.planets,    // tutti i pianeti → il client filtra
        wormholes: delta.wormholes,
        events: delta.events?.filter(e => (e.empire_ids?.includes(empire.id) ?? e.empire_id === empire.id)),
        empireResources: delta.empireResources?.filter(r => r.empire_id === empire.id),
        combatResults: delta.combatResults,
      };

      await this.redis.publishEmpireDelta(
        empire.id,
        empireDelta as unknown as Record<string, unknown>
      );
    }

    this.logger.debug(`Tick ${tick} notified to ${empires.length} empires`);
  }
}

// ─────────────────────────────────────────────────────────────
//  PHASE 12 — PERSIST STATE
// ─────────────────────────────────────────────────────────────

@Injectable()
export class PersistStatePhase {
  private readonly logger = new Logger(PersistStatePhase.name);

  constructor(
    @InjectRepository(EmpireEntity)
    private readonly empireRepo: Repository<EmpireEntity>,
    private readonly redis: RedisService,
    private readonly dataSource: DataSource,
  ) {}

  async execute(tick: number, delta: TickDelta): Promise<void> {
    // Flush dei ResourcePool da Redis → PostgreSQL
    const empires = await this.empireRepo.find();

    // Usa una singola transazione per tutto il flush
    await this.dataSource.transaction(async (manager) => {
      for (const empire of empires) {
        const poolKey = `empire:${empire.id}:resources`;
        const pool    = await this.redis.getJson<ResourceStock>(poolKey);
        if (!pool) continue;

        empire.resource_pool = pool;
        empire.updated_at    = new Date();
        await manager.save(EmpireEntity, empire);
      }
    });

    // Invalida tutte le cache che potrebbero essere stale dopo il tick
    await this.redis.invalidatePattern('empire:*:resources:stale');

    this.logger.debug(`Tick ${tick} persisted. Empires flushed: ${empires.length}`);
  }
}
