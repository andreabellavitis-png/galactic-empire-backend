// ============================================================
//  CONTROL ENTITIES — TypeORM / PostgreSQL
// ============================================================

import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn, Index,
} from 'typeorm';

import type { DelegationAgreementTerms } from './control.types';
import {
  ControllableEntityType, ControllableStatus,
  DelegationStatus,
  RevocationRequest, TaxFlowSnapshot,
  ControlAction, InfluenceEntry,
} from './control.types';

// ─────────────────────────────────────────────────────────────
//  CONTROLLABLE ENTITY OWNERSHIP
//
//  Tabella che traccia ownership + controller di OGNI elemento
//  del gioco. È il registro ufficiale di chi possiede/controlla cosa.
//
//  Le entity specifiche (CelestialBodyEntity, FleetEntity, ecc.)
//  NON duplicano owner_id/controller_id: li leggono da qui
//  tramite JOIN o cache Redis.
//
//  Questo approccio rende il sistema modulare: aggiungere un nuovo
//  tipo di entità controllabile non richiede modifiche al modello.
// ─────────────────────────────────────────────────────────────

@Entity('entity_ownership')
@Index(['owner_id'])
@Index(['controller_id'])
@Index(['entity_id'], { unique: true })
export class EntityOwnershipEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Riferimento all'elemento (pianeta, flotta, sistema, ecc.)
  @Column()
  entity_id: string;

  @Column()
  entity_type: ControllableEntityType;

  // ── Proprietà e controllo ──
  @Column({ nullable: true })
  owner_id: string | null;

  @Column({ nullable: true })
  controller_id: string | null;

  // ID della delega attiva che giustifica controller ≠ owner
  // null se non c'è delega (owner = controller, o occupazione forzata)
  @Column({ nullable: true })
  active_delegation_id: string | null;

  // Stato dell'elemento dal punto di vista del controllo
  @Column({ default: ControllableStatus.UNINHABITED })
  @Index()
  status: ControllableStatus;

  // Mappa influenza { empire_id → 0–100 }
  @Column({ type: 'jsonb', default: [] })
  influence_map: InfluenceEntry[];

  // Storico degli ultimi N trasferimenti di proprietà/controllo (audit trail)
  @Column({ type: 'jsonb', default: [] })
  ownership_history: OwnershipHistoryEntry[];

  // Tick dell'ultimo aggiornamento
  @Column({ type: 'int', default: 0 })
  last_updated_tick: number;

  @UpdateDateColumn()
  updated_at: Date;
}

export interface OwnershipHistoryEntry {
  tick:         number;
  event_type:   'OWNER_CHANGED' | 'CONTROLLER_CHANGED' | 'DELEGATION_STARTED' | 'DELEGATION_ENDED';
  from_empire:  string | null;
  to_empire:    string | null;
  reason:       string;
}

// ─────────────────────────────────────────────────────────────
//  DELEGATION AGREEMENT
//
//  Accordo bilaterale tra owner e controller.
//  Contiene i termini completi: permessi, tasse, rinnovo, revoca.
// ─────────────────────────────────────────────────────────────

@Entity('delegation_agreements')
@Index(['owner_id'])
@Index(['controller_id'])
@Index(['entity_id'])
export class DelegationAgreementEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Elemento delegato
  @Column()
  entity_id: string;

  @Column()
  entity_type: ControllableEntityType;

  // Parti
  @Column()
  owner_id: string;

  @Column()
  controller_id: string;

  // Termini completi dell'accordo (permessi, tasse, rinnovo, breach)
  @Column({ type: 'jsonb' })
  // @ts-ignore isolatedModules false positive — jsonb column
  terms: DelegationAgreementTerms;

  // Stato
  @Column({ default: DelegationStatus.ACTIVE })
  @Index()
  status: DelegationStatus;

  // Ciclo di vita
  @Column({ type: 'int' })
  started_at_tick: number;

  // null = nessuna scadenza automatica
  @Column({ type: 'int', nullable: true })
  expires_at_tick: number | null;

  // Tick della finestra di rinnovo (expires_at - notice_ticks)
  @Column({ type: 'int', nullable: true })
  renewal_window_opens_at: number | null;

  // Richiesta di revoca in corso (se presente)
  @Column({ type: 'jsonb', nullable: true })
  pending_revocation: RevocationRequest | null;

  // Richiesta di rinnovo in corso
  @Column({ type: 'jsonb', nullable: true })
  pending_renewal: PendingRenewal | null;

  // Snapshot del flusso fiscale dell'ultimo tick
  @Column({ type: 'jsonb', nullable: true })
  last_tax_flow: TaxFlowSnapshot | null;

  // Contatore violazioni (ogni breach incrementa; 3 breach → broken automatico)
  @Column({ type: 'int', default: 0 })
  breach_count: number;

  // Proposta da cui è originata questa delega (se da accordo diplomatico)
  @Column({ nullable: true })
  origin_proposal_id: string | null;

  // ID della delega che questa sostituisce (per rinnovi con modifiche)
  @Column({ nullable: true })
  supersedes_delegation_id: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}

export interface PendingRenewal {
  proposed_by:      string;   // empire_id
  proposed_at_tick: number;
  new_terms?:       Partial<DelegationAgreementTerms>;
  status:           'PENDING' | 'ACCEPTED' | 'REJECTED';
  expires_at_tick:  number;
}

// ─────────────────────────────────────────────────────────────
//  APPROVAL REQUEST
//
//  Quando un'azione del controller richiede esplicita approvazione
//  del proprietario (es. attaccare da una base altrui).
// ─────────────────────────────────────────────────────────────

@Entity('approval_requests')
@Index(['delegation_id'])
@Index(['owner_id'])
@Index(['controller_id'])
export class ApprovalRequestEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  delegation_id: string;

  @Column()
  entity_id: string;

  @Column()
  owner_id: string;

  @Column()
  controller_id: string;

  @Column()
  action: ControlAction;

  // Contesto dell'azione (es. { fleet_id, target_system_id })
  @Column({ type: 'jsonb', default: {} })
  context: Record<string, any>;

  @Column({ default: 'PENDING' })
  @Index()
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

  @Column({ type: 'int' })
  created_at_tick: number;

  // Default: scade in 10 tick se nessuna risposta
  @Column({ type: 'int' })
  expires_at_tick: number;

  @Column({ type: 'text', nullable: true })
  owner_response: string | null;

  @CreateDateColumn()
  created_at: Date;
}

// ─────────────────────────────────────────────────────────────
//  TAX FLOW LOG
//
//  Log dei flussi fiscali per audit e dispute.
//  Un record per delega per tick.
// ─────────────────────────────────────────────────────────────

@Entity('tax_flow_log')
@Index(['delegation_id'])
@Index(['tick'])
export class TaxFlowLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  delegation_id: string;

  @Column()
  entity_id: string;

  @Column()
  owner_id: string;

  @Column()
  controller_id: string;

  @Column({ type: 'int' })
  tick: number;

  // Risorse prodotte dall'entità
  @Column({ type: 'jsonb', default: {} })
  produced: Record<string, number>;

  // Quota andata al proprietario
  @Column({ type: 'jsonb', default: {} })
  owner_share: Record<string, number>;

  // Quota rimasta al controllore
  @Column({ type: 'jsonb', default: {} })
  controller_share: Record<string, number>;

  // Ammanco (minimo garantito non rispettato)
  @Column({ type: 'jsonb', default: {} })
  shortfall: Record<string, number>;

  // Il controllore ha rispettato il minimo garantito?
  @Column({ default: true })
  minimum_met: boolean;

  @CreateDateColumn()
  created_at: Date;
}
