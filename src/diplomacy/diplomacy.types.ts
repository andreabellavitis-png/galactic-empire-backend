// ============================================================
//  DIPLOMACY TYPES
//  Tutti i tipi specifici del sistema diplomatico.
//  Estende game.types.ts senza modificarlo.
// ============================================================

import { ResourceStock, ResourceType } from '../common/game.types';

// ─────────────────────────────────────────────────────────────
//  RELAZIONI E STATI
// ─────────────────────────────────────────────────────────────

export enum DiplomacyStatus {
  WAR            = 'WAR',
  HOSTILE        = 'HOSTILE',
  NEUTRAL        = 'NEUTRAL',
  TRADE_PACT     = 'TRADE_PACT',
  NON_AGGRESSION = 'NON_AGGRESSION',
  ALLIANCE       = 'ALLIANCE',
  VASSAL         = 'VASSAL',     // Questo empire è vassallo dell'altro
  OVERLORD       = 'OVERLORD',   // Questo empire è signore dell'altro
}

/** Ranking ordinale della relazione (usato per confronti) */
export const DIPLOMACY_RANK: Record<DiplomacyStatus, number> = {
  [DiplomacyStatus.WAR]:            0,
  [DiplomacyStatus.HOSTILE]:        1,
  [DiplomacyStatus.NEUTRAL]:        2,
  [DiplomacyStatus.TRADE_PACT]:     3,
  [DiplomacyStatus.NON_AGGRESSION]: 4,
  [DiplomacyStatus.ALLIANCE]:       5,
  [DiplomacyStatus.VASSAL]:         3,
  [DiplomacyStatus.OVERLORD]:       3,
};

// ─────────────────────────────────────────────────────────────
//  TRATTATI
// ─────────────────────────────────────────────────────────────

export enum TreatyType {
  NON_AGGRESSION    = 'NON_AGGRESSION',
  ALLIANCE          = 'ALLIANCE',           // Difesa reciproca + condivisione visibilità
  MILITARY_ACCESS   = 'MILITARY_ACCESS',    // Permesso transito flotte
  TRADE_AGREEMENT   = 'TRADE_AGREEMENT',    // Bonus commercio + rotte condivise
  RESOURCE_SHARING  = 'RESOURCE_SHARING',   // Trasferimento periodico risorse
  MUTUAL_DEFENSE    = 'MUTUAL_DEFENSE',     // Entra in guerra se alleato attaccato
  VASSALAGE         = 'VASSALAGE',          // Protezione in cambio di tributo
  BORDER_AGREEMENT  = 'BORDER_AGREEMENT',   // Riconosce i confini attuali
  JOINT_WAR         = 'JOINT_WAR',          // Alleanza bellica contro un terzo
}

/**
 * Un singolo termine di un trattato.
 * Può essere un obbligo continuo (ogni tick) o un vincolo comportamentale.
 */
export interface TreatyTerm {
  id:          string;
  type:        TreatyTermType;
  from_empire: string;             // Chi deve rispettare il termine
  to_empire:   string | 'ALL';     // Verso chi (o tutti i firmatari)
  value:       TreatyTermValue;
}

export enum TreatyTermType {
  // Obblighi periodici (ogni tick)
  PAY_CREDITS       = 'PAY_CREDITS',        // Paga X crediti per tick
  TRANSFER_RESOURCE = 'TRANSFER_RESOURCE',  // Trasferisci X unità di risorsa
  SHARE_RESEARCH    = 'SHARE_RESEARCH',     // Condividi % research output

  // Vincoli comportamentali (verificati on-action)
  NO_ATTACK         = 'NO_ATTACK',          // Non attaccare sistemi dell'altro
  NO_SPY            = 'NO_SPY',             // Non fare operazioni spionaggio
  FLEET_PASSAGE     = 'FLEET_PASSAGE',      // Permetti transito flotte
  NO_COLONIZE       = 'NO_COLONIZE',        // Non colonizzare sistemi in zona
  DEFENSE_PACT      = 'DEFENSE_PACT',       // Entra in guerra se attaccato

  // Trasferimenti una-tantum (all'attivazione)
  CEDE_PLANET       = 'CEDE_PLANET',        // Cedi un pianeta
  CEDE_SYSTEM       = 'CEDE_SYSTEM',        // Cedi un sistema
  LUMP_SUM_CREDITS  = 'LUMP_SUM_CREDITS',   // Pagamento immediato
}

export interface TreatyTermValue {
  amount?:       number;
  resource_type?: ResourceType;
  planet_id?:    string;
  system_id?:    string;
  percentage?:   number;   // 0–100
}

export enum TreatyStatus {
  ACTIVE    = 'ACTIVE',
  EXPIRED   = 'EXPIRED',
  BROKEN    = 'BROKEN',    // Violato da uno dei firmatari
  CANCELLED = 'CANCELLED', // Revocato consensualmente
}

// ─────────────────────────────────────────────────────────────
//  PROPOSTE DIPLOMATICHE
// ─────────────────────────────────────────────────────────────

export enum ProposalType {
  TREATY          = 'TREATY',
  TERRITORY_DEAL  = 'TERRITORY_DEAL',  // Cessione/acquisto pianeta o sistema
  WAR_DECLARATION = 'WAR_DECLARATION',
  VASSAL_OFFER    = 'VASSAL_OFFER',
  PEACE_OFFER     = 'PEACE_OFFER',     // Offerta di pace durante guerra
  EMBARGO         = 'EMBARGO',         // Proposta di embargo congiunto
}

export enum ProposalStatus {
  PENDING  = 'PENDING',   // In attesa di risposta
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
  EXPIRED  = 'EXPIRED',   // Scaduta senza risposta
  RETRACTED = 'RETRACTED', // Ritirata dal mittente
}

/** Contenuto di una proposta di cessione/acquisto territorio */
export interface TerritoryDealTerms {
  from_empire: string;         // Chi cede
  to_empire:   string;         // Chi riceve
  planet_ids:  string[];       // Pianeti ceduti
  system_ids:  string[];       // Sistemi ceduti
  price_credits: number;       // Compensazione in crediti
  resources?:  Partial<ResourceStock>;  // Compensazione aggiuntiva
}

/** Casus belli per dichiarazione di guerra */
export enum CasusBelli {
  TERRITORIAL_CLAIM  = 'TERRITORIAL_CLAIM',   // Rivendico territori occupati
  BROKEN_TREATY      = 'BROKEN_TREATY',        // Trattato violato
  AGGRESSION         = 'AGGRESSION',           // Risposta ad attacco subito
  LIBERATION         = 'LIBERATION',           // Libero pianeti dalla tirannia
  EXPANSION          = 'EXPANSION',            // Guerra di conquista (penalità diplomatica)
  VASSAL_REVOLT      = 'VASSAL_REVOLT',        // Vassallo si ribella
  JOINT_WAR          = 'JOINT_WAR',            // Guerra congiunta con alleato
}

export interface WarDeclarationTerms {
  casus_belli:       CasusBelli;
  target_empire_id:  string;
  justification?:    string;       // Testo libero del giocatore
  war_goals:         WarGoal[];    // Obiettivi dichiarati
  allies:            string[];     // Empire IDs coinvolti (war coalitions)
}

export interface WarGoal {
  type:       WarGoalType;
  target_id:  string;    // system_id o planet_id
}

export enum WarGoalType {
  OCCUPY_SYSTEM  = 'OCCUPY_SYSTEM',
  OCCUPY_PLANET  = 'OCCUPY_PLANET',
  FORCE_TRIBUTE  = 'FORCE_TRIBUTE',
  VASSAL_DEMAND  = 'VASSAL_DEMAND',
  CAPITULATION   = 'CAPITULATION',  // Resa totale
}

export interface VassalTerms {
  overlord_id:     string;
  vassal_id:       string;
  tribute_type:    ResourceType;
  tribute_amount:  number;          // Per tick
  protection:      boolean;         // L'overlord si impegna a difendere
  autonomy:        number;          // 0–100: 100=quasi indipendente, 0=puppet
  duration_ticks?: number;          // null = indefinito
}

// ─────────────────────────────────────────────────────────────
//  SPIONAGGIO
// ─────────────────────────────────────────────────────────────

export enum SpyOperationType {
  SABOTAGE_BUILDING   = 'SABOTAGE_BUILDING',   // Distrugge/danneggia edificio
  SABOTAGE_FLEET      = 'SABOTAGE_FLEET',       // Riduce efficienza/hp flotta
  STEAL_TECHNOLOGY    = 'STEAL_TECHNOLOGY',     // Copia tech non posseduta
  INCITE_REBELLION    = 'INCITE_REBELLION',     // -loyalty su pianeta target
  ASSASSINATE_LEADER  = 'ASSASSINATE_LEADER',  // Elimina generale/governatore
  GATHER_INTELLIGENCE = 'GATHER_INTELLIGENCE', // Rivela dati nascosti
  PLANT_AGENT         = 'PLANT_AGENT',          // Agente permanente (info continue)
  COUNTER_INTELLIGENCE = 'COUNTER_INTELLIGENCE', // Protegge da spie nemiche
}

export enum SpyOperationStatus {
  PREPARING  = 'PREPARING',  // In preparazione (X tick)
  ACTIVE     = 'ACTIVE',     // In corso
  SUCCESS    = 'SUCCESS',
  FAILURE    = 'FAILURE',    // Fallita senza conseguenze
  EXPOSED    = 'EXPOSED',    // Fallita + spia catturata/uccisa → incidente diplomatico
}

export interface SpyOperationResult {
  status:          SpyOperationStatus;
  description:     string;
  effect?:         SpyEffect;
  diplomatic_incident?: boolean;  // Se EXPOSED → -trust con target
  agent_lost:      boolean;
}

export interface SpyEffect {
  type:      string;
  target_id: string;
  value:     number;
}

// ─────────────────────────────────────────────────────────────
//  INFLUENZA
// ─────────────────────────────────────────────────────────────

export interface InfluenceEntry {
  empire_id: string;
  value:     number;   // 0–100
}

export enum InfluenceActionType {
  CULTURAL_MISSION    = 'CULTURAL_MISSION',    // Spendi crediti per +influence
  PROPAGANDA          = 'PROPAGANDA',          // Riduce loyalty locale al proprietario
  DIPLOMATIC_MISSION  = 'DIPLOMATIC_MISSION',  // +trust + influence combinati
  ECONOMIC_INVESTMENT = 'ECONOMIC_INVESTMENT', // +influence + produzione locale
  AGENT_NETWORK       = 'AGENT_NETWORK',       // Influenza passiva continua
}

/** Fattori che contribuiscono all'influenza passiva per tick */
export interface PassiveInfluenceFactors {
  adjacent_systems_owned: number;  // +0.5 per sistema confinante
  trade_routes_active:    number;  // +0.3 per rotta commerciale
  population_ratio:       number;  // +X se pop tua in quel sistema > media
  cultural_buildings:     number;  // +0.2 per cultural center
  fleet_presence:         number;  // +0.1 per tick con flotta nel sistema
  at_war_penalty:         number;  // -5 se in guerra con il proprietario
}

// ─────────────────────────────────────────────────────────────
//  TRUST E RELAZIONI
// ─────────────────────────────────────────────────────────────

/**
 * Trust: -100 (nemico acerrimo) → +100 (alleato fidato).
 * Si aggiorna ogni tick in base alle azioni e ai trattati rispettati.
 */
export interface TrustModifier {
  source:      TrustModifierSource;
  value:       number;        // Delta applicato (positivo o negativo)
  description: string;
  expires_at?: number;        // Tick di scadenza (null = permanente)
}

export enum TrustModifierSource {
  TREATY_RESPECTED   = 'TREATY_RESPECTED',
  TREATY_BROKEN      = 'TREATY_BROKEN',
  WAR_DECLARED       = 'WAR_DECLARED',
  SPY_EXPOSED        = 'SPY_EXPOSED',
  TERRITORY_GIFTED   = 'TERRITORY_GIFTED',
  TERRITORY_TAKEN    = 'TERRITORY_TAKEN',
  TRIBUTE_PAID       = 'TRIBUTE_PAID',
  DEFENSE_HONORED    = 'DEFENSE_HONORED',
  DEFENSE_IGNORED    = 'DEFENSE_IGNORED',   // Non sei intervenuto in difesa alleato
  DIPLOMATIC_GIFT    = 'DIPLOMATIC_GIFT',
}

// ─────────────────────────────────────────────────────────────
//  DELTA DIPLOMATICO (WebSocket)
// ─────────────────────────────────────────────────────────────

export interface DiplomacyDelta {
  tick:       number;
  timestamp:  string;

  proposals?:  ProposalNotification[];
  treaties?:   TreatyUpdate[];
  wars?:       WarUpdate[];
  spy_results?: SpyResultNotification[];
  trust_changes?: TrustChangeNotification[];
  influence_updates?: InfluenceUpdate[];
}

export interface ProposalNotification {
  proposal_id: string;
  type:        ProposalType;
  from_empire: string;
  to_empire:   string;
  status:      ProposalStatus;
  expires_at:  number;
  summary:     string;
}

export interface TreatyUpdate {
  treaty_id:  string;
  type:       TreatyType;
  status:     TreatyStatus;
  parties:    string[];
  broken_by?: string;
}

export interface WarUpdate {
  war_id:           string;
  attacker_id:      string;
  defender_id:      string;
  casus_belli:      CasusBelli;
  started_at_tick:  number;
  is_new:           boolean;
}

export interface SpyResultNotification {
  operation_id: string;
  type:         SpyOperationType;
  status:       SpyOperationStatus;
  description:  string;
  empire_id:    string;   // A chi appartiene questa notifica
}

export interface TrustChangeNotification {
  from_empire: string;
  to_empire:   string;
  old_trust:   number;
  new_trust:   number;
  reason:      TrustModifierSource;
}

export interface InfluenceUpdate {
  system_id:  string;
  planet_id?: string;
  empire_id:  string;
  old_value:  number;
  new_value:  number;
}
