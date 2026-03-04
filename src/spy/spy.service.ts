// ============================================================
//  SPY SERVICE
//  Gestisce operazioni di spionaggio: preparazione, risoluzione,
//  effetti e incidenti diplomatici.
//
//  Flusso di una spy op:
//    1. Player richiede operazione (REST API)
//    2. Service valida e crea SpyOperationEntity (PREPARING)
//    3. Dopo `prep_ticks` tick → status diventa ACTIVE
//    4. Dopo `duration_ticks` tick → tick engine risolve l'operazione
//    5. Outcome: SUCCESS | FAILURE | EXPOSED
//    6. Se EXPOSED → incidente diplomatico → -trust verso target
// ============================================================

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository }       from 'typeorm';

import { RedisService }      from '../redis/redis.service';
import { ResourceType }      from '../common/game.types';
import {
  SpyOperationType, SpyOperationStatus, SpyOperationResult,
  TrustModifierSource,
} from '../diplomacy/diplomacy.types';
import { SpyOperationEntity } from '../diplomacy/diplomacy.entities';
import { DiplomacyService }   from '../diplomacy/diplomacy.service';

// Stub imports
import { CelestialBodyEntity } from '../entities/celestial-body.entity';
import { FleetEntity }         from '../entities/fleet.entity';
import { EmpireEntity }        from '../entities/empire.entity';

// ─────────────────────────────────────────────────────────────
//  CONFIGURAZIONE OPERAZIONI
// ─────────────────────────────────────────────────────────────

interface SpyOpConfig {
  prep_ticks:          number;   // Tick di preparazione prima di partire
  duration_ticks:      number;   // Tick per completare l'operazione
  base_success_chance: number;   // 0.0–1.0
  base_exposure_chance: number;  // 0.0–1.0 (se fallisce)
  base_cost_credits:   number;
  description:         string;
}

const SPY_OP_CONFIG: Record<SpyOperationType, SpyOpConfig> = {
  [SpyOperationType.GATHER_INTELLIGENCE]: {
    prep_ticks: 5, duration_ticks: 10,
    base_success_chance: 0.85, base_exposure_chance: 0.05,
    base_cost_credits: 50,
    description: 'Raccoglie informazioni su flotte, pianeti e risorse del target.',
  },
  [SpyOperationType.PLANT_AGENT]: {
    prep_ticks: 10, duration_ticks: 20,
    base_success_chance: 0.65, base_exposure_chance: 0.15,
    base_cost_credits: 150,
    description: 'Pianta un agente permanente. Fornisce intelligence continua.',
  },
  [SpyOperationType.SABOTAGE_BUILDING]: {
    prep_ticks: 8, duration_ticks: 5,
    base_success_chance: 0.55, base_exposure_chance: 0.30,
    base_cost_credits: 200,
    description: 'Danneggia o distrugge un edificio sul pianeta target.',
  },
  [SpyOperationType.SABOTAGE_FLEET]: {
    prep_ticks: 10, duration_ticks: 5,
    base_success_chance: 0.50, base_exposure_chance: 0.35,
    base_cost_credits: 250,
    description: 'Riduce la potenza e i punti scafo di una flotta nemica.',
  },
  [SpyOperationType.STEAL_TECHNOLOGY]: {
    prep_ticks: 15, duration_ticks: 10,
    base_success_chance: 0.45, base_exposure_chance: 0.25,
    base_cost_credits: 400,
    description: 'Tenta di copiare una tecnologia non posseduta dal target.',
  },
  [SpyOperationType.INCITE_REBELLION]: {
    prep_ticks: 12, duration_ticks: 8,
    base_success_chance: 0.40, base_exposure_chance: 0.40,
    base_cost_credits: 300,
    description: 'Foraggia dissidenti locali. -loyalty significativa se ha successo.',
  },
  [SpyOperationType.ASSASSINATE_LEADER]: {
    prep_ticks: 20, duration_ticks: 5,
    base_success_chance: 0.30, base_exposure_chance: 0.50,
    base_cost_credits: 600,
    description: 'Elimina un leader/governatore. Effetto devastante, rischio altissimo.',
  },
  [SpyOperationType.COUNTER_INTELLIGENCE]: {
    prep_ticks: 5, duration_ticks: 0,   // Continuo, non si risolve
    base_success_chance: 1.0, base_exposure_chance: 0.0,
    base_cost_credits: 100,
    description: 'Attività difensiva: riduce le probabilità di successo delle spy op nemiche.',
  },
};

// ─────────────────────────────────────────────────────────────
//  SERVICE
// ─────────────────────────────────────────────────────────────

@Injectable()
export class SpyService {
  private readonly logger = new Logger(SpyService.name);

  constructor(
    @InjectRepository(SpyOperationEntity)
    private readonly spyRepo:   Repository<SpyOperationEntity>,
    @InjectRepository(CelestialBodyEntity)
    private readonly bodyRepo:  Repository<CelestialBodyEntity>,
    @InjectRepository(FleetEntity)
    private readonly fleetRepo: Repository<FleetEntity>,
    @InjectRepository(EmpireEntity)
    private readonly empireRepo: Repository<EmpireEntity>,
    private readonly diplomacyService: DiplomacyService,
    private readonly redis: RedisService,
  ) {}

  // ─── Avvio operazione ─────────────────────────────────────

  async launchOperation(dto: {
    attacker_empire_id:  string;
    target_empire_id:    string;
    type:                SpyOperationType;
    target_entity_id?:   string;
    target_entity_type?: string;
    agents_assigned?:    number;
    current_tick:        number;
  }): Promise<SpyOperationEntity> {
    const {
      attacker_empire_id, target_empire_id, type,
      target_entity_id, target_entity_type,
      agents_assigned = 1, current_tick,
    } = dto;

    const cfg = SPY_OP_CONFIG[type];

    // Verifica crediti
    const canAfford = await this.deductCost(attacker_empire_id, cfg.base_cost_credits);
    if (!canAfford) {
      throw new BadRequestException(`Not enough credits. Required: ${cfg.base_cost_credits}`);
    }

    // Recupera counter-intelligence del target (riduce success chance)
    const counterIntel = await this.getCounterIntelLevel(target_empire_id);

    // Calcola probabilità finali
    const techBonus    = await this.getSpyTechBonus(attacker_empire_id);
    const agentMult    = 1 + (agents_assigned - 1) * 0.1;  // +10% per agente aggiuntivo

    const successProb  = Math.max(0.05, Math.min(0.95,
      cfg.base_success_chance * agentMult * (1 - counterIntel * 0.3) + techBonus,
    ));
    const exposureProb = Math.min(0.90,
      cfg.base_exposure_chance * (1 + counterIntel * 0.5),
    );

    const op = this.spyRepo.create({
      attacker_empire_id,
      target_empire_id,
      type,
      target_entity_id,
      target_entity_type,
      status:              SpyOperationStatus.PREPARING,
      ready_at_tick:       current_tick + cfg.prep_ticks,
      resolves_at_tick:    current_tick + cfg.prep_ticks + cfg.duration_ticks,
      success_probability: successProb,
      exposure_probability: exposureProb,
      cost_credits:        cfg.base_cost_credits,
      agents_assigned,
    });

    await this.spyRepo.save(op);
    this.logger.log(`Spy op launched: ${type} by ${attacker_empire_id} on ${target_empire_id}`);
    return op;
  }

  // ─── Tick resolution ──────────────────────────────────────

  /**
   * Chiamato dal DiplomacyTickPhase ogni tick.
   * Risolve le operazioni che hanno raggiunto il loro resolves_at_tick.
   */
  async resolveReadyOperations(tick: number): Promise<SpyResolutionSummary[]> {
    const summaries: SpyResolutionSummary[] = [];

    // Attiva op in PREPARING che sono pronte
    const toActivate = await this.spyRepo.find({
      where: { status: SpyOperationStatus.PREPARING },
    });
    for (const op of toActivate) {
      if (tick >= op.ready_at_tick) {
        op.status = SpyOperationStatus.ACTIVE;
        await this.spyRepo.save(op);
      }
    }

    // Risolvi op ACTIVE che sono scadute
    const toResolve = await this.spyRepo.find({
      where: { status: SpyOperationStatus.ACTIVE },
    });
    for (const op of toResolve) {
      // COUNTER_INTELLIGENCE è continua — non si risolve
      if (op.type === SpyOperationType.COUNTER_INTELLIGENCE) continue;
      if (tick < op.resolves_at_tick) continue;

      const summary = await this.resolveOperation(op, tick);
      summaries.push(summary);
    }

    return summaries;
  }

  private async resolveOperation(
    op: SpyOperationEntity, tick: number,
  ): Promise<SpyResolutionSummary> {
    const roll = Math.random();
    const success = roll <= op.success_probability;
    const exposed = !success && Math.random() <= op.exposure_probability;

    let result: SpyOperationResult;

    if (success) {
      result = await this.applySuccessEffect(op, tick);
      op.status = SpyOperationStatus.SUCCESS;
    } else if (exposed) {
      result = {
        status:               SpyOperationStatus.EXPOSED,
        description:          `Operazione ${op.type} scoperta dal controspionaggio nemico.`,
        diplomatic_incident:  true,
        agent_lost:           true,
      };
      op.status = SpyOperationStatus.EXPOSED;

      // Incidente diplomatico → -trust
      await this.diplomacyService.applyTrustModifier(
        op.target_empire_id, op.attacker_empire_id,
        TrustModifierSource.SPY_EXPOSED, tick,
      );

      this.logger.warn(`Spy op EXPOSED: ${op.type} by ${op.attacker_empire_id} on ${op.target_empire_id}`);
    } else {
      result = {
        status:       SpyOperationStatus.FAILURE,
        description:  `Operazione ${op.type} fallita senza conseguenze.`,
        diplomatic_incident: false,
        agent_lost:   false,
      };
      op.status = SpyOperationStatus.FAILURE;
    }

    op.result = result;
    await this.spyRepo.save(op);

    return {
      operation_id:        op.id,
      type:                op.type,
      attacker_empire_id:  op.attacker_empire_id,
      target_empire_id:    op.target_empire_id,
      result,
    };
  }

  // ─── Effetti per tipo ─────────────────────────────────────

  private async applySuccessEffect(
    op: SpyOperationEntity, tick: number,
  ): Promise<SpyOperationResult> {
    switch (op.type) {

      case SpyOperationType.GATHER_INTELLIGENCE: {
        const intel = await this.gatherIntelligence(op.target_empire_id);
        return {
          status: SpyOperationStatus.SUCCESS,
          description: 'Intelligence raccolta con successo.',
          effect: { type: 'INTELLIGENCE', target_id: op.target_empire_id, value: 1 },
          diplomatic_incident: false,
          agent_lost: false,
          ...(intel as any),
        };
      }

      case SpyOperationType.SABOTAGE_BUILDING: {
        if (!op.target_entity_id) break;
        const body = await this.bodyRepo.findOneBy({ id: op.target_entity_id });
        if (body) {
          // Rimuove l'ultimo edificio della lista (stub — in produzione si specificherebbe)
          const removed = body.building_ids.pop();
          await this.bodyRepo.save(body);
          return {
            status: SpyOperationStatus.SUCCESS,
            description: `Edificio ${removed ?? 'sconosciuto'} sabotato su ${body.name}.`,
            effect: { type: 'BUILDING_DESTROYED', target_id: body.id, value: 1 },
            diplomatic_incident: false,
            agent_lost: false,
          };
        }
        break;
      }

      case SpyOperationType.SABOTAGE_FLEET: {
        if (!op.target_entity_id) break;
        const fleet = await this.fleetRepo.findOneBy({ id: op.target_entity_id });
        if (fleet) {
          const dmg = 0.20;  // -20% hull e shields
          fleet.total_hull    = Math.max(1, Math.floor(fleet.total_hull    * (1 - dmg)));
          fleet.total_shields = Math.max(0, Math.floor(fleet.total_shields * (1 - dmg)));
          await this.fleetRepo.save(fleet);
          return {
            status: SpyOperationStatus.SUCCESS,
            description: `Flotta ${fleet.name} sabotata. -20% hull e scudi.`,
            effect: { type: 'FLEET_DAMAGED', target_id: fleet.id, value: dmg },
            diplomatic_incident: false,
            agent_lost: false,
          };
        }
        break;
      }

      case SpyOperationType.INCITE_REBELLION: {
        if (!op.target_entity_id) break;
        const body = await this.bodyRepo.findOneBy({ id: op.target_entity_id });
        if (body) {
          const loyaltyDrop = 15 + Math.floor(Math.random() * 20);  // -15 a -35
          body.loyalty = Math.max(0, body.loyalty - loyaltyDrop);
          await this.bodyRepo.save(body);
          return {
            status: SpyOperationStatus.SUCCESS,
            description: `Propaganda riuscita su ${body.name}. -${loyaltyDrop} loyalty.`,
            effect: { type: 'LOYALTY_DROP', target_id: body.id, value: -loyaltyDrop },
            diplomatic_incident: false,
            agent_lost: false,
          };
        }
        break;
      }

      case SpyOperationType.STEAL_TECHNOLOGY: {
        const attacker = await this.empireRepo.findOneBy({ id: op.attacker_empire_id });
        const target   = await this.empireRepo.findOneBy({ id: op.target_empire_id });
        if (attacker && target && target.tech_level > attacker.tech_level) {
          attacker.accumulated_research += 500;  // Bonus ricerca rubata
          await this.empireRepo.save(attacker);
          return {
            status: SpyOperationStatus.SUCCESS,
            description: `Tecnologia trafugata. +500 punti ricerca.`,
            effect: { type: 'RESEARCH_STOLEN', target_id: op.attacker_empire_id, value: 500 },
            diplomatic_incident: false,
            agent_lost: false,
          };
        }
        break;
      }

      case SpyOperationType.ASSASSINATE_LEADER: {
        // In questa versione: -30 morale su tutti i pianeti dell'empire target
        const bodies = await this.bodyRepo.find({
          where: { owner_id: op.target_empire_id },
          take: 10,
        });
        for (const b of bodies) {
          b.morale = Math.max(0, b.morale - 30);
          await this.bodyRepo.save(b);
        }
        return {
          status: SpyOperationStatus.SUCCESS,
          description: `Leader eliminato. Crisi di leadership nel target. -30 morale su tutti i pianeti.`,
          effect: { type: 'LEADER_ELIMINATED', target_id: op.target_empire_id, value: -30 },
          diplomatic_incident: false,
          agent_lost: false,
        };
      }
    }

    // Fallback
    return {
      status: SpyOperationStatus.SUCCESS,
      description: 'Operazione completata.',
      diplomatic_incident: false,
      agent_lost: false,
    };
  }

  // ─── Intelligence gathering ───────────────────────────────

  private async gatherIntelligence(targetEmpireId: string): Promise<object> {
    // Raccoglie dati pubblici e semi-nascosti del target
    const empire  = await this.empireRepo.findOneBy({ id: targetEmpireId });
    const planets = await this.bodyRepo.find({
      where: { owner_id: targetEmpireId },
      take: 20,
      select: ['id', 'name', 'population', 'status', 'loyalty'],
    });

    return {
      intel_snapshot: {
        empire_name:  empire?.name,
        tech_level:   empire?.tech_level,
        planets_count: planets.length,
        planets,   // Inviato solo all'attacker via WebSocket
      },
    };
  }

  // ─── Helpers ──────────────────────────────────────────────

  private async getCounterIntelLevel(empireId: string): Promise<number> {
    // 0.0–1.0: normalizzato. 1 operazione COUNTER_INTEL = 0.3
    const ops = await this.spyRepo.count({
      where: {
        attacker_empire_id: empireId,
        type:   SpyOperationType.COUNTER_INTELLIGENCE,
        status: SpyOperationStatus.ACTIVE,
      },
    });
    return Math.min(1.0, ops * 0.3);
  }

  private async getSpyTechBonus(empireId: string): Promise<number> {
    const empire = await this.empireRepo.findOneBy({ id: empireId });
    // Ogni tech level oltre il 2 dà +2% successo
    return Math.max(0, ((empire?.tech_level ?? 0) - 2) * 0.02);
  }

  private async deductCost(empireId: string, cost: number): Promise<boolean> {
    const pool = await this.redis.getJson<Record<string, number>>(`empire:${empireId}:resources`);
    if (!pool) return false;
    if ((pool[ResourceType.CREDITS] ?? 0) < cost) return false;
    pool[ResourceType.CREDITS] -= cost;
    await this.redis.setJson(`empire:${empireId}:resources`, pool);
    return true;
  }

  // ─── Queries ──────────────────────────────────────────────

  async getActiveOperations(empireId: string): Promise<SpyOperationEntity[]> {
    return this.spyRepo.find({
      where: [
        { attacker_empire_id: empireId, status: SpyOperationStatus.PREPARING },
        { attacker_empire_id: empireId, status: SpyOperationStatus.ACTIVE },
      ],
    });
  }
}

export interface SpyResolutionSummary {
  operation_id:       string;
  type:               SpyOperationType;
  attacker_empire_id: string;
  target_empire_id:   string;
  result:             SpyOperationResult;
}
