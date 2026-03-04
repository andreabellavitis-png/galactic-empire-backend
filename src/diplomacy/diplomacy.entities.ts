// ============================================================
//  DIPLOMACY ENTITIES — TypeORM / PostgreSQL
// ============================================================

import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn, Index, ManyToOne,
} from 'typeorm';

import type { SpyOperationResult } from './diplomacy.types';

import {
  DiplomacyStatus, TreatyType, TreatyStatus, TreatyTerm,
  ProposalType, ProposalStatus, CasusBelli, WarGoal,
  SpyOperationType, SpyOperationStatus,
  InfluenceActionType, InfluenceEntry, TrustModifier,
  VassalTerms, TerritoryDealTerms, WarDeclarationTerms,
} from './diplomacy.types';

// ─────────────────────────────────────────────────────────────
//  DIPLOMATIC RELATION
//  Una riga per coppia di empire (A < B alfabeticamente).
//  Contiene trust, status corrente e modificatori attivi.
// ─────────────────────────────────────────────────────────────

@Entity('diplomatic_relations')
@Index(['empire_a', 'empire_b'], { unique: true })
export class DiplomaticRelationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Sempre empire_a < empire_b (ordinati) per unicità
  @Column()
  @Index()
  empire_a: string;

  @Column()
  @Index()
  empire_b: string;

  @Column({ default: DiplomacyStatus.NEUTRAL })
  status: DiplomacyStatus;

  // Trust da A verso B e da B verso A (asimmetrico)
  @Column({ type: 'float', default: 0 })
  trust_a_to_b: number;   // -100 → +100

  @Column({ type: 'float', default: 0 })
  trust_b_to_a: number;

  // Modificatori trust temporanei (es. trattato rotto, spia esposta)
  @Column({ type: 'jsonb', default: [] })
  trust_modifiers_a: TrustModifier[];

  @Column({ type: 'jsonb', default: [] })
  trust_modifiers_b: TrustModifier[];

  // IDs dei trattati attivi tra i due empire
  @Column({ type: 'jsonb', default: [] })
  active_treaty_ids: string[];

  // IDs delle guerre attive
  @Column({ type: 'jsonb', default: [] })
  active_war_ids: string[];

  // Tick dell'ultima azione diplomatica (proposta, dichiarazione, ecc.)
  @Column({ type: 'int', default: 0 })
  last_action_tick: number;

  @UpdateDateColumn()
  updated_at: Date;
}

// ─────────────────────────────────────────────────────────────
//  DIPLOMATIC PROPOSAL
//  Proposta inviata da un empire a un altro, con scadenza.
// ─────────────────────────────────────────────────────────────

@Entity('diplomatic_proposals')
export class DiplomaticProposalEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  from_empire_id: string;

  @Column()
  @Index()
  to_empire_id: string;

  @Column()
  type: ProposalType;

  @Column({ default: ProposalStatus.PENDING })
  @Index()
  status: ProposalStatus;

  // Dati specifici per tipo (treaty terms, territory deal, war declaration, ecc.)
  @Column({ type: 'jsonb' })
  payload: Record<string, any>;

  // Messaggio libero allegato alla proposta
  @Column({ type: 'text', nullable: true })
  message: string;

  // Tick in cui la proposta scade automaticamente (default: +50 tick)
  @Column({ type: 'int' })
  expires_at_tick: number;

  // Tick in cui è stata creata
  @Column({ type: 'int' })
  created_at_tick: number;

  // Risposta del destinatario
  @Column({ type: 'text', nullable: true })
  response_message: string;

  @Column({ nullable: true })
  responded_at: Date;

  @CreateDateColumn()
  created_at: Date;
}

// ─────────────────────────────────────────────────────────────
//  TREATY
//  Accordo vincolante tra due o più empire.
// ─────────────────────────────────────────────────────────────

@Entity('treaties')
export class TreatyEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  type: TreatyType;

  @Column({ default: TreatyStatus.ACTIVE })
  @Index()
  status: TreatyStatus;

  // Empire firmatari (sempre 2 nel primo rilascio, estendibile)
  @Column({ type: 'jsonb' })
  party_ids: string[];

  // Termini del trattato
  @Column({ type: 'jsonb', default: [] })
  terms: TreatyTerm[];

  // Tick di firma
  @Column({ type: 'int' })
  signed_at_tick: number;

  // Tick di scadenza (null = indefinito finché non revocato)
  @Column({ type: 'int', nullable: true })
  expires_at_tick: number;

  // Minimo preavviso per revoca unilaterale (tick)
  @Column({ type: 'int', default: 20 })
  min_notice_ticks: number;

  // Chi ha violato il trattato (null se rispettato)
  @Column({ nullable: true })
  broken_by_empire_id: string;

  @Column({ type: 'int', nullable: true })
  broken_at_tick: number;

  // Penalità trust per violazione (configurabile per tipo)
  @Column({ type: 'float', default: -25 })
  breach_trust_penalty: number;

  // ID della proposta da cui è nato questo trattato
  @Column({ nullable: true })
  origin_proposal_id: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}

// ─────────────────────────────────────────────────────────────
//  WAR
//  Stato di guerra tra due o più empire.
// ─────────────────────────────────────────────────────────────

@Entity('wars')
export class WarEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Aggressore
  @Column()
  @Index()
  attacker_id: string;

  // Difensore
  @Column()
  @Index()
  defender_id: string;

  @Column()
  casus_belli: CasusBelli;

  // Obiettivi di guerra dichiarati dall'aggressore
  @Column({ type: 'jsonb', default: [] })
  war_goals: WarGoal[];

  // Alleati coinvolti (empire IDs)
  @Column({ type: 'jsonb', default: [] })
  attacker_allies: string[];

  @Column({ type: 'jsonb', default: [] })
  defender_allies: string[];

  // Metriche di guerra (aggiornate ogni tick)
  @Column({ type: 'int', default: 0 })
  attacker_war_score: number;   // 0–100, determinato da conquiste e battaglie

  @Column({ type: 'int', default: 0 })
  defender_war_score: number;

  // Flotte e pianeti persi/conquistati (per calcolo war score)
  @Column({ type: 'jsonb', default: { fleets_destroyed: 0, planets_occupied: 0 } })
  attacker_stats: { fleets_destroyed: number; planets_occupied: number };

  @Column({ type: 'jsonb', default: { fleets_destroyed: 0, planets_occupied: 0 } })
  defender_stats: { fleets_destroyed: number; planets_occupied: number };

  @Column({ type: 'int' })
  started_at_tick: number;

  @Column({ type: 'int', nullable: true })
  ended_at_tick: number;

  @Column({ default: true })
  is_active: boolean;

  // Come è finita la guerra
  @Column({ nullable: true })
  outcome: WarOutcome;

  // ID del trattato di pace che ha chiuso la guerra
  @Column({ nullable: true })
  peace_treaty_id: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}

export type WarOutcome =
  | 'ATTACKER_VICTORY'
  | 'DEFENDER_VICTORY'
  | 'WHITE_PEACE'        // Nessun vincitore
  | 'CAPITULATION';      // Resa totale di un lato

// ─────────────────────────────────────────────────────────────
//  SPY OPERATION
//  Operazione di spionaggio inviata da un empire verso un target.
// ─────────────────────────────────────────────────────────────

@Entity('spy_operations')
export class SpyOperationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  attacker_empire_id: string;

  @Column()
  @Index()
  target_empire_id: string;

  @Column()
  type: SpyOperationType;

  // Target specifico (pianeta, edificio, flotta, leader)
  @Column({ nullable: true })
  target_entity_id: string;

  @Column({ nullable: true })
  target_entity_type: string;

  @Column({ default: SpyOperationStatus.PREPARING })
  @Index()
  status: SpyOperationStatus;

  // Tick in cui l'operazione parte (dopo fase preparazione)
  @Column({ type: 'int' })
  ready_at_tick: number;

  // Tick in cui si risolve
  @Column({ type: 'int' })
  resolves_at_tick: number;

  // Probabilità di successo calcolata (0.0–1.0)
  @Column({ type: 'float' })
  success_probability: number;

  // Probabilità di essere scoperti se fallisce (0.0–1.0)
  @Column({ type: 'float' })
  exposure_probability: number;

  // Risultato (popolato dopo risoluzione)
  // @ts-ignore isolatedModules false positive — jsonb column
  @Column({ type: 'jsonb', nullable: true })
  result: SpyOperationResult;

  // Costo in crediti dell'operazione
  @Column({ type: 'float' })
  cost_credits: number;

  // "Agenti" investiti (futuro: agenti come entità separate)
  @Column({ type: 'int', default: 1 })
  agents_assigned: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}

// ─────────────────────────────────────────────────────────────
//  INFLUENCE RECORD
//  Livello di influenza di ogni empire su ogni sistema/pianeta.
//  Una riga per coppia (empire_id, target_id).
// ─────────────────────────────────────────────────────────────

@Entity('influence_records')
@Index(['empire_id', 'target_id'], { unique: true })
export class InfluenceRecordEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  empire_id: string;

  // ID del sistema stellare o del pianeta
  @Column()
  @Index()
  target_id: string;

  @Column()
  target_type: 'SYSTEM' | 'PLANET';

  // Valore influenza 0–100
  @Column({ type: 'float', default: 0 })
  value: number;

  // Influenza passiva per tick (calcolata da PassiveInfluenceFactors)
  @Column({ type: 'float', default: 0 })
  passive_gain_per_tick: number;

  // Ultimo aggiornamento
  @Column({ type: 'int', default: 0 })
  last_updated_tick: number;

  @UpdateDateColumn()
  updated_at: Date;
}

// ─────────────────────────────────────────────────────────────
//  INFLUENCE ACTION
//  Azione attiva per aumentare/ridurre influenza.
// ─────────────────────────────────────────────────────────────

@Entity('influence_actions')
export class InfluenceActionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  empire_id: string;

  @Column()
  target_id: string;   // system_id o planet_id

  @Column()
  target_type: 'SYSTEM' | 'PLANET';

  @Column()
  action_type: InfluenceActionType;

  // Influenza guadagnata per tick durante l'azione
  @Column({ type: 'float' })
  influence_per_tick: number;

  // Effetto secondario (es. PROPAGANDA riduce loyalty)
  @Column({ type: 'jsonb', nullable: true })
  secondary_effect: Record<string, any>;

  // Costo mantenimento per tick
  @Column({ type: 'float', default: 0 })
  cost_per_tick: number;

  @Column({ type: 'int' })
  started_at_tick: number;

  // null = continua finché non annullata
  @Column({ type: 'int', nullable: true })
  ends_at_tick: number;

  @Column({ default: true })
  is_active: boolean;

  @CreateDateColumn()
  created_at: Date;
}

// ─────────────────────────────────────────────────────────────
//  VASSAL AGREEMENT
//  Accordo di vassallaggio (può derivare da trattato o da conquista).
// ─────────────────────────────────────────────────────────────

@Entity('vassal_agreements')
export class VassalAgreementEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  overlord_id: string;

  @Column()
  @Index()
  vassal_id: string;

  @Column()
  tribute_type: string;   // ResourceType

  @Column({ type: 'float' })
  tribute_amount: number;  // Per tick

  @Column({ default: true })
  protection: boolean;

  // 0 = puppet totale, 100 = quasi autonomo
  @Column({ type: 'int', default: 50 })
  autonomy: number;

  @Column({ type: 'int' })
  started_at_tick: number;

  @Column({ type: 'int', nullable: true })
  ends_at_tick: number;

  @Column({ default: true })
  is_active: boolean;

  // Il vassallo può tentare di liberarsi se war_score alto
  @Column({ type: 'int', default: 0 })
  liberation_war_score: number;

  // ID trattato originale
  @Column({ nullable: true })
  origin_treaty_id: string;

  @CreateDateColumn()
  created_at: Date;
}
