import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RedisService }  from '../redis/redis.service';
import { TICK_CONSTANTS, TickDelta } from '../common/game.types';

import {
  MoveFleetsPhase,
  ProduceResourcesPhase,
  TransferResourcesPhase,
  UpdatePopulationPhase,
  UpdateLoyaltyPhase,
  CheckRebellionsPhase,
  ResolveCombatPhase,
  UpdateWormholesPhase,
  ProcessEventsPhase,
  UpdateResearchPhase,
  NotifyPlayersPhase,
  PersistStatePhase,
} from './phases/all-phases';

// ─────────────────────────────────────────────────────────────
//  TICK ENGINE SERVICE
//
//  Orchestratore principale del loop di gioco.
//  Esegue le 12 fasi in sequenza ogni TICK_INTERVAL_MS millisecondi.
//
//  Design:
//  - Un singolo intervallo Node.js (non cron) garantisce timing preciso
//  - Lock Redis previene doppie esecuzioni in cluster
//  - Ogni fase riceve il `delta` accumulato e vi appende le sue modifiche
//  - Il delta finale viene notificato ai client in fase 11 e persistito in fase 12
//
//  Scalabilità:
//  - In produzione, una sola istanza esegue il tick (leader election via Redis lock)
//  - Le altre istanze rimangono in hot-standby
//  - I WebSocket gateway su tutte le istanze ricevono i delta da Redis pub/sub
// ─────────────────────────────────────────────────────────────

@Injectable()
export class TickEngineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TickEngineService.name);

  private intervalHandle: NodeJS.Timeout | null = null;
  private isRunning      = false;
  private currentTick    = 0;

  /** Statistiche dell'ultimo tick (debug/monitoring) */
  private lastTickStats: TickStats = {
    tick:           0,
    duration_ms:    0,
    phases:         {},
    entities_changed: 0,
    timestamp:      Date.now(),
  };

  constructor(
    private readonly config: ConfigService,
    private readonly redis:  RedisService,

    // ── Phases ──
    private readonly moveFleetsPhase:         MoveFleetsPhase,
    private readonly produceResourcesPhase:   ProduceResourcesPhase,
    private readonly transferResourcesPhase:  TransferResourcesPhase,
    private readonly updatePopulationPhase:   UpdatePopulationPhase,
    private readonly updateLoyaltyPhase:      UpdateLoyaltyPhase,
    private readonly checkRebellionsPhase:    CheckRebellionsPhase,
    private readonly resolveCombatPhase:      ResolveCombatPhase,
    private readonly updateWormholesPhase:    UpdateWormholesPhase,
    private readonly processEventsPhase:      ProcessEventsPhase,
    private readonly updateResearchPhase:     UpdateResearchPhase,
    private readonly notifyPlayersPhase:      NotifyPlayersPhase,
    private readonly persistStatePhase:       PersistStatePhase,
  ) {}

  // ─── Lifecycle ────────────────────────────────────────────

  async onModuleInit() {
    this.currentTick = await this.redis.getCurrentTick();
    this.logger.log(`TickEngine starting — current tick: ${this.currentTick}`);
    this.start();
  }

  onModuleDestroy() {
    this.stop();
  }

  // ─── Start / Stop ─────────────────────────────────────────

  start(): void {
    if (this.intervalHandle) return;

    const intervalMs = this.config.get<number>(
      'TICK_INTERVAL_MS',
      TICK_CONSTANTS.TICK_INTERVAL_MS,
    );

    this.logger.log(`TickEngine started — interval: ${intervalMs}ms`);

    this.intervalHandle = setInterval(() => {
      void this.runTick();
    }, intervalMs);

    // Prima esecuzione immediata (utile per restart server)
    void this.runTick();
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.log('TickEngine stopped');
    }
  }

  // ─── Main tick execution ──────────────────────────────────

  /**
   * Esecuzione di un singolo tick.
   * Protetta da:
   *   1. Guard locale (`isRunning`) per evitare sovrapposizione sullo stesso processo
   *   2. Lock Redis per evitare sovrapposizione in cluster multi-istanza
   */
  async runTick(): Promise<void> {
    // Guard locale
    if (this.isRunning) {
      this.logger.warn('Tick skipped — previous tick still running');
      return;
    }
    this.isRunning = true;

    const tickStart = Date.now();

    // Incrementa tick su Redis (atomico) e acquisisce il lock
    const tick = await this.redis.incrementTick();
    const lockAcquired = await this.redis.acquireTickLock(tick);

    if (!lockAcquired) {
      this.logger.warn(`Tick ${tick} skipped — lock held by another instance`);
      this.isRunning = false;
      return;
    }

    this.currentTick = tick;
    const phaseStats: Record<string, number> = {};
    let entitiesChanged = 0;

    // ── Inizializza delta accumulato ──
    const delta: TickDelta = {
      tick,
      timestamp:       Date.now(),
      fleets:          [],
      planets:         [],
      wormholes:       [],
      events:          [],
      empireResources: [],
      combatResults:   [],
    };

    // ─────────────────────────────────────────────────────────
    //  LE 12 FASI IN SEQUENZA
    // ─────────────────────────────────────────────────────────

    const phases: Array<{ name: string; fn: () => Promise<void> }> = [
      { name: 'MOVE_FLEETS',          fn: () => this.moveFleetsPhase.execute(tick, delta) },
      { name: 'PRODUCE_RESOURCES',    fn: () => this.produceResourcesPhase.execute(tick, delta) },
      { name: 'TRANSFER_RESOURCES',   fn: () => this.transferResourcesPhase.execute(tick, delta) },
      { name: 'UPDATE_POPULATION',    fn: () => this.updatePopulationPhase.execute(tick, delta) },
      { name: 'UPDATE_LOYALTY',       fn: () => this.updateLoyaltyPhase.execute(tick, delta) },
      { name: 'CHECK_REBELLIONS',     fn: () => this.checkRebellionsPhase.execute(tick, delta) },
      { name: 'RESOLVE_COMBAT',       fn: () => this.resolveCombatPhase.execute(tick, delta) },
      { name: 'UPDATE_WORMHOLES',     fn: () => this.updateWormholesPhase.execute(tick, delta) },
      { name: 'PROCESS_EVENTS',       fn: () => this.processEventsPhase.execute(tick, delta) },
      { name: 'UPDATE_RESEARCH',      fn: () => this.updateResearchPhase.execute(tick, delta) },
      { name: 'NOTIFY_PLAYERS',       fn: () => this.notifyPlayersPhase.execute(tick, delta) },
      { name: 'PERSIST_STATE',        fn: () => this.persistStatePhase.execute(tick, delta) },
    ];

    for (const phase of phases) {
      const t0 = Date.now();
      try {
        await phase.fn();
        phaseStats[phase.name] = Date.now() - t0;
      } catch (err) {
        // Una fase che fallisce non blocca le successive
        // Il delta parziale viene comunque propagato
        this.logger.error(`Phase ${phase.name} FAILED at tick ${tick}`, err);
        phaseStats[phase.name] = -(Date.now() - t0); // negativo = errore
      }
    }

    // Conta entità cambiate per monitoring
    entitiesChanged =
      (delta.fleets?.length ?? 0) +   // fleets field optional in TickDelta
      ((delta as any).planets?.length ?? 0) +
      ((delta as any).wormholes?.length ?? 0) +
      (delta.events?.length ?? 0);

    // ── Aggiorna statistiche ──
    this.lastTickStats = {
      tick,
      duration_ms:      Date.now() - tickStart,
      phases:           phaseStats,
      entities_changed: entitiesChanged,
      timestamp:        Date.now(),
    };

    // Log ogni 10 tick
    if (tick % 10 === 0) {
      this.logger.log(
        `Tick ${tick} completed in ${this.lastTickStats.duration_ms}ms` +
        ` | entities changed: ${entitiesChanged}` +
        ` | phases: ${Object.entries(phaseStats).map(([k, v]) => `${k}=${v}ms`).join(', ')}`,
      );
    }

    // Rilascia lock
    await this.redis.releaseTickLock();
    this.isRunning = false;
  }

  // ─── Admin / Monitoring ────────────────────────────────────

  getStatus(): TickEngineStatus {
    return {
      is_running:     !!this.intervalHandle,
      current_tick:   this.currentTick,
      last_tick_stats: this.lastTickStats,
      interval_ms:    this.config.get<number>('TICK_INTERVAL_MS', TICK_CONSTANTS.TICK_INTERVAL_MS),
    };
  }

  /** Forza un tick manuale (utile per testing/admin) */
  async forceTickNow(): Promise<TickStats> {
    await this.runTick();
    return this.lastTickStats;
  }
}

// ─────────────────────────────────────────────────────────────
//  TYPES locali
// ─────────────────────────────────────────────────────────────

interface TickStats {
  tick:             number;
  duration_ms:      number;
  phases:           Record<string, number>;
  entities_changed: number;
  timestamp:        number;
}

interface TickEngineStatus {
  is_running:      boolean;
  current_tick:    number;
  last_tick_stats: TickStats;
  interval_ms:     number;
}
