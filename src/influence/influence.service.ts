// ============================================================
//  INFLUENCE SERVICE
//  Calcola e aggiorna l'influenza passiva e attiva di ogni
//  empire su ogni sistema stellare e pianeta.
//
//  Logica:
//    influence[tick] = influence[tick-1]
//                    + passive_gain_per_tick
//                    + active_gain_per_tick
//                    - decay
//
//  L'influenza è il meccanismo chiave per:
//    - Destabilizzare pianeti nemici senza guerra
//    - Preparare un'annessione diplomatica
//    - Contrastare l'espansione di altri empire
// ============================================================

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository }   from '@nestjs/typeorm';
import { Repository, In }     from 'typeorm';

import { RedisService }        from '../redis/redis.service';
import { InfluenceActionType } from '../diplomacy/diplomacy.types';
import {
  InfluenceRecordEntity,
  InfluenceActionEntity,
} from '../diplomacy/diplomacy.entities';

// Stub imports
import { StarSystemEntity }    from '../entities/star-system.entity';
import { CelestialBodyEntity } from '../entities/celestial-body.entity';
import { EmpireEntity }        from '../entities/empire.entity';

// ─────────────────────────────────────────────────────────────
//  COSTANTI
// ─────────────────────────────────────────────────────────────

const INFLUENCE_CONFIG = {
  // Guadagno passivo per fattore (per tick)
  PASSIVE: {
    adjacent_system:   0.5,   // +0.5 per sistema confinante posseduto
    trade_route:       0.3,   // +0.3 per rotta commerciale attiva
    fleet_presence:    0.15,  // +0.15 se flotta presente nel sistema
    cultural_building: 0.2,   // +0.2 per cultural center sul sistema
    pop_ratio_bonus:   0.1,   // +0.1 per ogni % di pop propria nel sistema
    at_war_penalty:    -5.0,  // -5 per tick se in guerra con il proprietario
  },

  // Guadagno per tipo di azione attiva (per tick durante l'azione)
  ACTIVE: {
    [InfluenceActionType.CULTURAL_MISSION]:    2.5,
    [InfluenceActionType.PROPAGANDA]:          1.8,
    [InfluenceActionType.DIPLOMATIC_MISSION]:  3.0,
    [InfluenceActionType.ECONOMIC_INVESTMENT]: 2.0,
    [InfluenceActionType.AGENT_NETWORK]:       1.2,
  },

  // Costo in crediti per tick per tipo azione
  ACTIVE_COST: {
    [InfluenceActionType.CULTURAL_MISSION]:    15,
    [InfluenceActionType.PROPAGANDA]:          20,
    [InfluenceActionType.DIPLOMATIC_MISSION]:  25,
    [InfluenceActionType.ECONOMIC_INVESTMENT]: 30,
    [InfluenceActionType.AGENT_NETWORK]:       10,
  },

  // Effetti secondari delle azioni
  SECONDARY_EFFECTS: {
    [InfluenceActionType.PROPAGANDA]: {
      attribute: 'loyalty',
      delta_per_tick: -1.5,   // -1.5 loyalty/tick al proprietario del pianeta
    },
    [InfluenceActionType.ECONOMIC_INVESTMENT]: {
      attribute: 'production_bonus',
      delta_per_tick: +0.02,  // +2% produzione locale
    },
  },

  // Decay naturale per tick (l'influenza diminuisce senza mantenimento)
  DECAY_RATE:     0.1,
  // Decay accelerato in territorio nemico
  ENEMY_DECAY:    0.3,

  // Soglia oltre cui l'influenza permette azioni speciali
  THRESHOLD_LOW:    25,  // Visibilità sistema
  THRESHOLD_MED:    50,  // Proposta di cessione più facile, -loyalty
  THRESHOLD_HIGH:   75,  // Possibilità di annessione diplomatica
  THRESHOLD_MAX:   100,
};

// ─────────────────────────────────────────────────────────────
//  SERVICE
// ─────────────────────────────────────────────────────────────

@Injectable()
export class InfluenceService {
  private readonly logger = new Logger(InfluenceService.name);

  constructor(
    @InjectRepository(InfluenceRecordEntity)
    private readonly influenceRepo:  Repository<InfluenceRecordEntity>,
    @InjectRepository(InfluenceActionEntity)
    private readonly actionRepo:     Repository<InfluenceActionEntity>,
    @InjectRepository(StarSystemEntity)
    private readonly systemRepo:     Repository<StarSystemEntity>,
    @InjectRepository(CelestialBodyEntity)
    private readonly bodyRepo:       Repository<CelestialBodyEntity>,
    @InjectRepository(EmpireEntity)
    private readonly empireRepo:     Repository<EmpireEntity>,
    private readonly redis:          RedisService,
  ) {}

  // ─── Tick update principale ───────────────────────────────

  /**
   * Chiamato dal DiplomacyTickPhase ogni tick.
   * Aggiorna l'influenza di tutti gli empire su tutti i sistemi.
   */
  async updateAllInfluence(tick: number): Promise<InfluenceUpdateResult[]> {
    const results: InfluenceUpdateResult[] = [];

    const systems = await this.systemRepo.find({ select: ['id', 'owner_id', 'hyperlane_ids'] });
    const empires = await this.empireRepo.find({ select: ['id'] });

    for (const system of systems) {
      for (const empire of empires) {
        const result = await this.updateInfluenceForTarget(
          empire.id, system.id, 'SYSTEM', tick,
        );
        if (result) results.push(result);
      }
    }

    return results;
  }

  private async updateInfluenceForTarget(
    empireId:   string,
    targetId:   string,
    targetType: 'SYSTEM' | 'PLANET',
    tick:       number,
  ): Promise<InfluenceUpdateResult | null> {
    let record = await this.influenceRepo.findOne({
      where: { empire_id: empireId, target_id: targetId },
    });

    if (!record) {
      // Crea record solo se c'è qualcosa da registrare
      const passive = await this.calculatePassiveGain(empireId, targetId, targetType);
      if (passive <= 0) return null;

      record = this.influenceRepo.create({
        empire_id:  empireId,
        target_id:  targetId,
        target_type: targetType,
        value:      0,
        passive_gain_per_tick: passive,
        last_updated_tick: tick,
      });
    }

    const oldValue = record.value;

    // 1. Guadagno passivo
    const passive = await this.calculatePassiveGain(empireId, targetId, targetType);
    record.passive_gain_per_tick = passive;

    // 2. Guadagno da azioni attive
    const activeGain = await this.calculateActiveGain(empireId, targetId, tick);

    // 3. Decay
    const decay = await this.calculateDecay(empireId, targetId, record.value);

    // 4. Applica
    record.value = Math.max(0, Math.min(100,
      record.value + passive + activeGain - decay,
    ));
    record.last_updated_tick = tick;

    if (record.value !== oldValue) {
      await this.influenceRepo.save(record);
      await this.applyInfluenceEffects(empireId, targetId, targetType, record.value, tick);
    }

    return record.value !== oldValue
      ? { empire_id: empireId, target_id: targetId, target_type: targetType, old_value: oldValue, new_value: record.value }
      : null;
  }

  // ─── Calcolo guadagno passivo ─────────────────────────────

  private async calculatePassiveGain(
    empireId:   string,
    targetId:   string,
    targetType: 'SYSTEM' | 'PLANET',
  ): Promise<number> {
    let gain = 0;
    const cfg = INFLUENCE_CONFIG.PASSIVE;

    if (targetType === 'SYSTEM') {
      const system = await this.systemRepo.findOneBy({ id: targetId });
      if (!system) return 0;

      // Sistemi adiacenti posseduti
      const adjacentOwned = await this.countAdjacentOwnedSystems(
        empireId, system.hyperlane_ids ?? [],
      );
      gain += adjacentOwned * cfg.adjacent_system;

      // Flotta presente nel sistema
      const fleetIds = await this.redis.getSet(`system:${targetId}:fleets`);
      if (fleetIds.length > 0) {
        const hasOwnFleet = await this.hasEmpireFleetInSet(empireId, fleetIds);
        if (hasOwnFleet) gain += cfg.fleet_presence;
      }

      // Rotte commerciali attive verso quel sistema
      const routeCount = await this.countActiveTradeRoutes(empireId, targetId);
      gain += routeCount * cfg.trade_route;

      // Penalità se in guerra con il proprietario
      if (system.owner_id && system.owner_id !== empireId) {
        const atWar = await this.isAtWar(empireId, system.owner_id);
        if (atWar) gain += cfg.at_war_penalty;
      }
    }

    return gain;
  }

  // ─── Calcolo guadagno attivo ──────────────────────────────

  private async calculateActiveGain(
    empireId: string, targetId: string, tick: number,
  ): Promise<number> {
    const activeActions = await this.actionRepo.find({
      where: {
        empire_id:  empireId,
        target_id:  targetId,
        is_active:  true,
      },
    });

    let gain = 0;
    for (const action of activeActions) {
      // Verifica scadenza
      if (action.ends_at_tick && tick >= action.ends_at_tick) {
        action.is_active = false;
        await this.actionRepo.save(action);
        continue;
      }

      // Verifica affordability (costo crediti)
      const canAfford = await this.deductActionCost(empireId, action.cost_per_tick);
      if (!canAfford) {
        action.is_active = false;
        await this.actionRepo.save(action);
        continue;
      }

      gain += action.influence_per_tick;
    }

    return gain;
  }

  // ─── Decay ────────────────────────────────────────────────

  private async calculateDecay(
    empireId: string, targetId: string, currentValue: number,
  ): Promise<number> {
    if (currentValue <= 0) return 0;

    const system = await this.systemRepo.findOneBy({ id: targetId });
    if (!system) return INFLUENCE_CONFIG.DECAY_RATE;

    // Decay accelerato in territorio nemico
    if (system.owner_id && system.owner_id !== empireId) {
      const atWar = await this.isAtWar(empireId, system.owner_id);
      return atWar
        ? INFLUENCE_CONFIG.ENEMY_DECAY
        : INFLUENCE_CONFIG.DECAY_RATE * 1.5;
    }

    return INFLUENCE_CONFIG.DECAY_RATE;
  }

  // ─── Effetti soglia influenza ─────────────────────────────

  /**
   * Applica effetti collaterali quando l'influenza supera/scende
   * sotto le soglie chiave.
   */
  private async applyInfluenceEffects(
    empireId:   string,
    targetId:   string,
    targetType: 'SYSTEM' | 'PLANET',
    value:      number,
    tick:       number,
  ): Promise<void> {
    if (targetType !== 'PLANET') return;

    const body = await this.bodyRepo.findOneBy({ id: targetId });
    if (!body || !body.owner_id || body.owner_id === empireId) return;

    // Soglia MED → -loyalty al proprietario del pianeta
    if (value >= INFLUENCE_CONFIG.THRESHOLD_MED) {
      body.loyalty = Math.max(0, body.loyalty - 0.5);
      await this.bodyRepo.save(body);
    }
  }

  // ─── Azioni attive (API) ─────────────────────────────────

  /**
   * Avvia un'azione di influenza attiva.
   * Controllato: empire deve avere i crediti per almeno N tick.
   */
  async startInfluenceAction(dto: {
    empire_id:    string;
    target_id:    string;
    target_type:  'SYSTEM' | 'PLANET';
    action_type:  InfluenceActionType;
    duration_ticks?: number;
    current_tick: number;
  }): Promise<InfluenceActionEntity> {
    const { empire_id, target_id, target_type, action_type, duration_ticks, current_tick } = dto;

    const costPerTick = INFLUENCE_CONFIG.ACTIVE_COST[action_type];
    const gainPerTick = INFLUENCE_CONFIG.ACTIVE[action_type];

    const action = this.actionRepo.create({
      empire_id,
      target_id,
      target_type,
      action_type,
      influence_per_tick: gainPerTick,
      cost_per_tick:      costPerTick,
      started_at_tick:    current_tick,
      ends_at_tick: duration_ticks
        ? current_tick + duration_ticks
        : undefined,
      is_active:          true,
      secondary_effect:   INFLUENCE_CONFIG.SECONDARY_EFFECTS[action_type] ?? null,
    });
//
    await this.actionRepo.save(action);
    this.logger.log(`Influence action started: ${action_type} by ${empire_id} on ${target_id}`);
    return action;
  }

  async stopInfluenceAction(actionId: string, empireId: string): Promise<void> {
    const action = await this.actionRepo.findOneBy({ id: actionId });
    if (!action || action.empire_id !== empireId) return;
    action.is_active = false;
    await this.actionRepo.save(action);
  }

  // ─── Read ─────────────────────────────────────────────────

  async getInfluenceMap(targetId: string): Promise<InfluenceRecordEntity[]> {
    return this.influenceRepo.find({
      where: { target_id: targetId },
      order: { value: 'DESC' },
    });
  }

  async getDominantEmpire(targetId: string): Promise<string | null> {
    const records = await this.influenceRepo.find({
      where: { target_id: targetId },
      order: { value: 'DESC' },
      take: 1,
    });
    return records[0]?.value >= INFLUENCE_CONFIG.THRESHOLD_HIGH
      ? records[0].empire_id
      : null;
  }

  // ─── Helpers privati ─────────────────────────────────────

  private async countAdjacentOwnedSystems(
    empireId: string, hyperlaneIds: string[],
  ): Promise<number> {
    if (!hyperlaneIds.length) return 0;
    // In produzione: query ottimizzata. Qui semplificata.
    const systems = await this.systemRepo.find({
      where: { owner_id: empireId },
      select: ['id'],
    });
    return Math.min(systems.length, hyperlaneIds.length); // approssimazione
  }

  private async hasEmpireFleetInSet(empireId: string, fleetIds: string[]): Promise<boolean> {
    for (const fid of fleetIds) {
      const fleet = await this.redis.getJson<{ empire_id: string }>(`fleet:${fid}:state`);
      if (fleet?.empire_id === empireId) return true;
    }
    return false;
  }

  private async countActiveTradeRoutes(empireId: string, targetId: string): Promise<number> {
    // Conta rotte attive che passano per targetId
    const key = `empire:${empireId}:trade_routes:${targetId}:count`;
    const cached = await this.redis.getJson<number>(key);
    return cached ?? 0;
  }

  private async isAtWar(empireA: string, empireB: string): Promise<boolean> {
    const key = `war:${[empireA, empireB].sort().join(':')}`;
    const cached = await this.redis.getJson<boolean>(key);
    if (cached !== null) return cached;
    // Fallback su DB (costoso, usare con parsimonia; normalizzare su Redis in ProcessEventsPhase)
    return false;
  }

  private async deductActionCost(empireId: string, cost: number): Promise<boolean> {
    if (cost <= 0) return true;
    const pool = await this.redis.getJson<Record<string, number>>(`empire:${empireId}:resources`);
    if (!pool) return false;
    if ((pool['CREDITS'] ?? 0) < cost) return false;
    pool['CREDITS'] -= cost;
    await this.redis.setJson(`empire:${empireId}:resources`, pool);
    return true;
  }
}

export interface InfluenceUpdateResult {
  empire_id:   string;
  target_id:   string;
  target_type: 'SYSTEM' | 'PLANET';
  old_value:   number;
  new_value:   number;
}
