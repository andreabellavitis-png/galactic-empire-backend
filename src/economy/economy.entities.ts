// ============================================================
//  ECONOMY ENTITIES — TypeORM / PostgreSQL
//
//  Gerarchia:
//    Planet (1) → Region (N) → PopulationBlock (N × SocialClass)
//                             → RegionBuilding (N)
//                             → RegionMarket (1)
//    Planet (1) → PlanetInflation (1)
//    Galaxy     → GalacticMarket (1, singleton)
// ============================================================

import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn, Index,
} from 'typeorm';

import {
  SocialClass, ResourceType, BuildingCategory,
  ActivePolicy, RegionMarketState, PlanetInflationState,
} from './economy.types';

// ─────────────────────────────────────────────────────────────
//  REGIONE
//  Unità atomica dell'economia (sezione 2.4 GDD).
//  Un pianeta terra-like ha minimo 12 regioni.
// ─────────────────────────────────────────────────────────────

@Entity('regions')
@Index(['planet_id'])
@Index(['owner_id'])
export class RegionEntity {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column() planet_id: string;
  @Column() system_id: string;
  @Column() name: string;

  // Posizione sulla superficie (slot 0–N, usato dal renderer)
  @Column({ type: 'int', default: 0 }) slot_index: number;

  // ── Proprietà e controllo ──
  @Column({ nullable: true }) @Index() owner_id: string | null;
  @Column({ nullable: true }) controller_id: string | null;
  @Column({ nullable: true }) active_delegation_id: string | null;

  // ── Risorse naturali della regione ──
  // (queste sono le caratteristiche intrinseche, non lo stock)
  @Column({ type: 'jsonb', default: {} }) natural_resources: Partial<Record<ResourceType, number>>;
  @Column({ type: 'float', default: 0 }) biomass_base: number;
  @Column({ type: 'float', default: 0 }) water_base: number;

  // ── Stato ──
  @Column({ type: 'float', default: 50 }) stability: number;   // 0–100
  @Column({ type: 'float', default: 50 }) loyalty: number;     // 0–100
  @Column({ type: 'float', default: 0  }) military_presence: number; // bonus lealtà

  // ── Capacità abitativa totale (somma edifici housing) ──
  @Column({ type: 'float', default: 100 }) housing_capacity: number;

  // ── Deposito statale della regione (ResourceStock) ──
  @Column({ type: 'jsonb', default: {} }) state_stock: Partial<Record<ResourceType, number>>;

  // ── Policy attive su questa regione ──
  @Column({ type: 'jsonb', default: [] }) active_policies: ActivePolicy[];

  // ── Dati tick precedente (per calcoli delta) ──
  @Column({ type: 'jsonb', nullable: true }) last_tick_summary: RegionTickSummary | null;

  @Column({ type: 'int', default: 0 }) last_updated_tick: number;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}

export interface RegionTickSummary {
  tick:         number;
  production:   Partial<Record<ResourceType, number>>;
  consumption:  Partial<Record<ResourceType, number>>;
  happiness:    Partial<Record<SocialClass, number>>;
  loyalty:      number;
  stability:    number;
}

// ─────────────────────────────────────────────────────────────
//  BLOCCO POPOLAZIONE
//  Un record per (regione, classe_sociale).
//  "count" = numero di blocchi popolazione.
//  Ogni blocco rappresenta una unità demografica discreta
//  (il valore demografico reale è [DA DEFINIRE] nel GDD).
// ─────────────────────────────────────────────────────────────

@Entity('population_blocks')
@Index(['region_id'])
@Index(['planet_id'])
@Index(['social_class'])
export class PopulationBlockEntity {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column() region_id: string;
  @Column() planet_id: string;
  @Column() empire_id: string;

  @Column() social_class: SocialClass;

  // Numero di blocchi di questa classe in questa regione
  @Column({ type: 'int', default: 0 }) count: number;

  // ── Crescita (sezione 3.2 GDD) ──
  // Punti crescita accumulati. Quando ≥ 100 → nuovo blocco.
  @Column({ type: 'float', default: 0 }) growth_points: number;

  // ── Ricchezza (per mobilità sociale e felicità) ──
  @Column({ type: 'float', default: 0 }) wealth: number;
  @Column({ type: 'float', default: 0 }) wealth_per_block: number;

  // ── Felicità corrente ──
  @Column({ type: 'float', default: 50 }) happiness: number;

  // ── Soddisfazione per risorsa (snapshot ultimo tick) ──
  // { FOOD: 0.9, GOODS: 0.7, WATER: 1.0 }
  @Column({ type: 'jsonb', default: {} }) satisfaction: Record<ResourceType, number>;

  // ── Lavoratori assegnati ad edifici ──
  // { building_id: count_workers }
  @Column({ type: 'jsonb', default: {} }) work_assignments: Record<string, number>;

  // Blocchi disponibili per lavoro (count - assegnati)
  @Column({ type: 'int', default: 0 }) available_workers: number;

  @Column({ type: 'int', default: 0 }) last_updated_tick: number;
  @UpdateDateColumn() updated_at: Date;
}

// ─────────────────────────────────────────────────────────────
//  EDIFICIO DI REGIONE
//  Istanza di un BuildingDefinition in una regione specifica.
// ─────────────────────────────────────────────────────────────

@Entity('region_buildings')
@Index(['region_id'])
@Index(['planet_id'])
@Index(['owner_id'])
export class RegionBuildingEntity {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column() region_id: string;
  @Column() planet_id: string;
  @Column() owner_id: string;          // Chi possiede l'edificio (può ≠ owner regione)

  @Column() building_def_id: string;   // FK verso BUILDING_DEFINITIONS
  @Column() category: BuildingCategory;

  @Column({ type: 'int', default: 1 }) level: number;
  @Column({ type: 'int', default: 0 }) max_level: number;

  // Danni (0 = intatto, 100 = distrutto)
  @Column({ type: 'float', default: 0 }) damage: number;

  // ── Lavoratori assegnati per slot-type ──
  // { PRODUCTION: 3, SPECIALIZATION: 1 }
  @Column({ type: 'jsonb', default: {} }) assigned_workers: Record<string, number>;

  // ── Output ultimo tick (snapshot) ──
  @Column({ type: 'jsonb', default: {} }) last_output: Partial<Record<ResourceType, number>>;

  // ── Efficienza calcolata ultimo tick (0–1) ──
  @Column({ type: 'float', default: 0 }) last_efficiency: number;

  // Se false → edificio spento (no produzione, no consumo)
  @Column({ default: true }) is_active: boolean;

  // ── Nazionalizzato? (policy NATIONALIZE) ──
  @Column({ default: false }) is_nationalized: boolean;

  // ── Corporazione assegnata (policy CREATE_CORPORATION) ──
  @Column({ nullable: true }) corporation_id: string | null;

  @Column({ type: 'int', default: 0 }) built_at_tick: number;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}

// ─────────────────────────────────────────────────────────────
//  MERCATO DI REGIONE
//  Ogni regione ha il suo mercato locale.
//  I prezzi sono in GC nominali (GC × inflazione pianeta).
// ─────────────────────────────────────────────────────────────

@Entity('region_markets')
@Index(['region_id'], { unique: true })
@Index(['planet_id'])
export class RegionMarketEntity {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column({ unique: true }) region_id: string;
  @Column() planet_id: string;

  // Prezzi locali correnti (GC nominali = GC_reali × I_pianeta)
  @Column({ type: 'jsonb', default: {} }) prices: Record<string, number>;

  // Prezzi bloccati da policy PRICE_FIX (null = prezzo libero)
  @Column({ type: 'jsonb', default: {} }) fixed_prices: Record<string, number | null>;

  // Offerta e domanda calcolate nell'ultimo tick
  @Column({ type: 'jsonb', default: {} }) supply: Record<string, number>;
  @Column({ type: 'jsonb', default: {} }) demand: Record<string, number>;

  // Storico ultimi 10 tick (per trend UI)
  @Column({ type: 'jsonb', default: [] }) price_history: PriceHistoryEntry[];

  // Embargo attivi: { empire_id: { import: bool, export: bool } }
  @Column({ type: 'jsonb', default: {} }) embargo_map: Record<string, { import: boolean; export: boolean }>;

  @Column({ type: 'int', default: 0 }) last_updated_tick: number;
  @UpdateDateColumn() updated_at: Date;
}

export interface PriceHistoryEntry {
  tick:   number;
  prices: Record<string, number>;
}

// ─────────────────────────────────────────────────────────────
//  INFLAZIONE DI PIANETA
//  Una riga per pianeta. Contiene tutto lo stato dell'equazione
//  quantitativa della moneta (sezione 4.6 GDD).
// ─────────────────────────────────────────────────────────────

@Entity('planet_inflation')
@Index(['planet_id'], { unique: true })
export class PlanetInflationEntity {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column({ unique: true }) planet_id: string;
  @Column() empire_id: string;

  // Equazione quantitativa: P = M / Y → I = P / P_base
  @Column({ type: 'float', default: 10000 }) M: number;    // Moneta in circolazione
  @Column({ type: 'float', default: 1000  }) Y: number;    // Produzione reale
  @Column({ type: 'float', default: 1.0   }) P_base: number;
  @Column({ type: 'float', default: 1.0   }) I: number;    // Indice inflazione corrente

  // Salari
  @Column({ type: 'float', default: 10 }) W: number;       // Salario medio nominale
  @Column({ type: 'float', default: 10 }) W_base: number;  // Salario base iniziale

  // Parametri di smussatura
  @Column({ type: 'float', default: 0.03 }) s: number;     // Smussatura inflazione
  @Column({ type: 'float', default: 0.02 }) k_w: number;   // Velocità adeguamento salari

  // Fiscalità
  @Column({ type: 'float', default: 0.2 }) tax_rate: number;
  @Column({ type: 'float', default: 0 })   tax_revenue_last_tick: number;
  @Column({ type: 'float', default: 0 })   public_debt: number;

  // Moneta stampata questo tick (da policy PRINT_MONEY)
  @Column({ type: 'float', default: 0 }) money_printed_this_tick: number;

  // Storico inflazione (ultimi 20 tick)
  @Column({ type: 'jsonb', default: [] }) inflation_history: { tick: number; I: number }[];

  @Column({ type: 'int', default: 0 }) last_updated_tick: number;
  @UpdateDateColumn() updated_at: Date;
}

// ─────────────────────────────────────────────────────────────
//  MERCATO GALATTICO
//  Singleton — prezzi di riferimento in GC reali normalizzati.
//  Il "prezzo galattico" è il valore reale di scambio tra pianeti.
// ─────────────────────────────────────────────────────────────

@Entity('galactic_market')
export class GalacticMarketEntity {
  @PrimaryGeneratedColumn('uuid') id: string;

  // Prezzi base in GC reali (aggiornati ogni tick)
  @Column({ type: 'jsonb', default: {} }) base_prices: Record<string, number>;

  // Offerta e domanda galattiche aggregate
  @Column({ type: 'jsonb', default: {} }) galactic_supply: Record<string, number>;
  @Column({ type: 'jsonb', default: {} }) galactic_demand: Record<string, number>;

  // Storico prezzi galattici (ultimi 50 tick)
  @Column({ type: 'jsonb', default: [] }) price_history: { tick: number; prices: Record<string, number> }[];

  @Column({ type: 'int', default: 0 }) last_updated_tick: number;
  @UpdateDateColumn() updated_at: Date;
}

// ─────────────────────────────────────────────────────────────
//  ORDINE DI COMMERCIO INTERPLANETARIO
// ─────────────────────────────────────────────────────────────

@Entity('trade_orders')
@Index(['empire_id'])
@Index(['origin_region_id'])
@Index(['dest_region_id'])
export class TradeOrderEntity {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column() empire_id: string;
  @Column() origin_region_id: string;
  @Column() origin_planet_id: string;
  @Column() dest_region_id: string;
  @Column() dest_planet_id: string;

  @Column() resource: ResourceType;
  @Column({ type: 'float' }) amount_per_tick: number;

  // Costo trasporto in GC reali (calcolato alla creazione, rivalutato ogni 5 tick)
  @Column({ type: 'float', default: 0 }) fuel_cost_gc: number;

  // Nave cargo assegnata (null = automatico)
  @Column({ nullable: true }) transport_fleet_id: string | null;

  @Column({ default: true }) is_active: boolean;

  // Profitto dell'ultimo tick in GC reali
  @Column({ type: 'float', default: 0 }) last_profit_gc: number;

  // Ticks consecutivi non profittevoli (auto-stop dopo 5)
  @Column({ type: 'int', default: 0 }) unprofitable_ticks: number;

  @Column({ type: 'int', default: 0 }) created_at_tick: number;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}

// ─────────────────────────────────────────────────────────────
//  BUILD QUEUE (coda costruzioni)
// ─────────────────────────────────────────────────────────────

@Entity('build_queue')
@Index(['region_id'])
@Index(['empire_id'])
export class BuildQueueEntity {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column() region_id: string;
  @Column() planet_id: string;
  @Column() empire_id: string;

  @Column() building_def_id: string;
  @Column({ nullable: true }) existing_building_id: string | null;  // null = nuova costruzione

  @Column({ type: 'int', default: 1 }) target_level: number;

  // Risorse già pagate
  @Column({ type: 'jsonb', default: {} }) paid: Partial<Record<ResourceType, number>>;
  // Risorse totali necessarie
  @Column({ type: 'jsonb', default: {} }) cost: Partial<Record<ResourceType, number>>;

  // Tick stimato di completamento
  @Column({ type: 'int', default: 0 }) estimated_completion_tick: number;
  @Column({ type: 'int', default: 0 }) build_ticks_remaining: number;

  @Column({ default: 'QUEUED' }) status: 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  @Column({ type: 'int', default: 0 }) created_at_tick: number;
  @CreateDateColumn() created_at: Date;
}
