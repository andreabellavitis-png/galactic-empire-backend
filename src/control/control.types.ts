// ============================================================
//  CONTROL SYSTEM TYPES
//
//  Modello fondamentale:
//    owner_id     = chi possiede legalmente l'elemento
//    controller_id = chi lo gestisce operativamente (può coincidere)
//
//  La delega di controllo è un accordo bilaterale con termini
//  espliciti: tasse, permessi militari, accesso edifici, durata.
//
//  Gerarchia di risoluzione permessi (dal più alto al più basso):
//    1. OWNER ha sempre tutti i diritti sul proprio elemento
//    2. CONTROLLER ha i diritti definiti nella DelegationPermissions
//    3. THIRD_PARTY può avere diritti specifici (es. transito)
// ============================================================

import { ResourceType } from '../common/game.types';

// ─────────────────────────────────────────────────────────────
//  ENTITÀ CONTROLLABILI
// ─────────────────────────────────────────────────────────────

/**
 * Ogni elemento del gioco che può essere posseduto e/o controllato
 * implementa questa interfaccia base.
 * Corrisponde alla `ControllableEntity` del GDD originale.
 */
export interface Controllable {
  id:            string;
  entity_type:   ControllableEntityType;
  name:          string;

  // Proprietà e controllo
  owner_id:      string | null;      // Chi possiede legalmente
  controller_id: string | null;      // Chi gestisce operativamente

  // ID della delega attiva (se controller ≠ owner)
  active_delegation_id: string | null;

  // Influenza per fazione (mappa empire_id → 0–100)
  influence_map: InfluenceEntry[];

  // Stato
  status: ControllableStatus;
}

export enum ControllableEntityType {
  STAR_SYSTEM    = 'STAR_SYSTEM',
  PLANET         = 'PLANET',
  MOON           = 'MOON',
  ASTEROID_BELT  = 'ASTEROID_BELT',
  SPACE_STATION  = 'SPACE_STATION',
  FLEET          = 'FLEET',
  GROUND_ARMY    = 'GROUND_ARMY',
  REGION         = 'REGION',         // Sotto-area di un pianeta (futuro)
}

export enum ControllableStatus {
  STABLE      = 'STABLE',
  UNSTABLE    = 'UNSTABLE',
  REBELLION   = 'REBELLION',
  OCCUPIED    = 'OCCUPIED',         // controller ≠ owner (forzato, non delegato)
  DELEGATED   = 'DELEGATED',        // controller ≠ owner (accordo volontario)
  CONTESTED   = 'CONTESTED',        // combattimento in corso
  UNINHABITED = 'UNINHABITED',
}

export interface InfluenceEntry {
  empire_id: string;
  value:     number;   // 0–100
}

// ─────────────────────────────────────────────────────────────
//  DELEGATION PERMISSIONS
//  Definisce esattamente cosa può fare il controllore.
// ─────────────────────────────────────────────────────────────

/**
 * I permessi sono organizzati in 4 categorie:
 *   - Military:   cosa può fare militarmente nel/con l'elemento
 *   - Economic:   accesso alle risorse e agli edifici
 *   - Political:  costruzione, espansione, sub-delega
 *   - Admin:      gestione della popolazione e delle leggi
 */
export interface DelegationPermissions {
  // ── MILITARE ──
  military: {
    can_defend:           boolean;  // Può usare l'elemento per difesa
    can_attack_from:      boolean;  // Può usare come base per attacchi
    can_station_fleets:   boolean;  // Può tenere flotte proprie
    can_transit:          boolean;  // Le sue flotte possono transitare
    can_recruit_armies:   boolean;  // Può reclutare armate terrestri
    max_fleet_size:       number | null;  // null = nessun limite
  };

  // ── ECONOMICO ──
  economic: {
    can_extract_resources:    boolean;  // Può estrarre risorse
    can_build_structures:     boolean;  // Può costruire edifici/moduli
    can_access_buildings:     AllowList; // 'ALL' | 'NONE' | string[] (building types)
    can_use_trade_routes:     boolean;  // Può creare rotte commerciali
    can_collect_income:       boolean;  // Incassa parte del reddito (vs. solo tasse)
  };

  // ── POLITICO ──
  political: {
    can_colonize:             boolean;  // Può colonizzare pianeti non abitati nel sistema
    can_sub_delegate:         boolean;  // Può delegare il controllo a terzi
    can_modify_laws:          boolean;  // Può cambiare politiche locali
    requires_owner_approval:  string[]; // Azioni che richiedono approvazione esplicita
  };
}

export type AllowList = 'ALL' | 'NONE' | string[];

/**
 * Template di permessi predefiniti, usati come punto di partenza
 * per accordi comuni.
 */
export const PERMISSION_PRESETS: Record<string, DelegationPermissions> = {

  // Piena gestione — come se fosse proprietario
  FULL_CONTROL: {
    military: {
      can_defend: true, can_attack_from: true, can_station_fleets: true,
      can_transit: true, can_recruit_armies: true, max_fleet_size: null,
    },
    economic: {
      can_extract_resources: true, can_build_structures: true,
      can_access_buildings: 'ALL', can_use_trade_routes: true,
      can_collect_income: true,
    },
    political: {
      can_colonize: true, can_sub_delegate: false,
      can_modify_laws: true, requires_owner_approval: [],
    },
  },

  // Gestione militare: il controllore difende per conto del proprietario
  MILITARY_ONLY: {
    military: {
      can_defend: true, can_attack_from: true, can_station_fleets: true,
      can_transit: true, can_recruit_armies: true, max_fleet_size: null,
    },
    economic: {
      can_extract_resources: false, can_build_structures: false,
      can_access_buildings: 'NONE', can_use_trade_routes: false,
      can_collect_income: false,
    },
    political: {
      can_colonize: false, can_sub_delegate: false,
      can_modify_laws: false, requires_owner_approval: ['attack_from'],
    },
  },

  // Gestione economica: il controllore estrae e gestisce la produzione
  ECONOMIC_ONLY: {
    military: {
      can_defend: false, can_attack_from: false, can_station_fleets: false,
      can_transit: true, can_recruit_armies: false, max_fleet_size: 0,
    },
    economic: {
      can_extract_resources: true, can_build_structures: true,
      can_access_buildings: 'ALL', can_use_trade_routes: true,
      can_collect_income: true,
    },
    political: {
      can_colonize: false, can_sub_delegate: false,
      can_modify_laws: false, requires_owner_approval: ['build_structures'],
    },
  },

  // Solo transito: le flotte possono passare, nient'altro
  TRANSIT_RIGHTS: {
    military: {
      can_defend: false, can_attack_from: false, can_station_fleets: false,
      can_transit: true, can_recruit_armies: false, max_fleet_size: 0,
    },
    economic: {
      can_extract_resources: false, can_build_structures: false,
      can_access_buildings: 'NONE', can_use_trade_routes: false,
      can_collect_income: false,
    },
    political: {
      can_colonize: false, can_sub_delegate: false,
      can_modify_laws: false, requires_owner_approval: [],
    },
  },

  // Protettorato: il "protettore" gestisce la difesa, il proprietario incassa
  PROTECTORATE: {
    military: {
      can_defend: true, can_attack_from: false, can_station_fleets: true,
      can_transit: true, can_recruit_armies: true, max_fleet_size: null,
    },
    economic: {
      can_extract_resources: false, can_build_structures: false,
      can_access_buildings: ['SPACEPORT', 'STARBASE'], can_use_trade_routes: true,
      can_collect_income: false,
    },
    political: {
      can_colonize: false, can_sub_delegate: false,
      can_modify_laws: false, requires_owner_approval: ['recruit_armies'],
    },
  },

  // Vassallaggio completo: il signore gestisce quasi tutto
  VASSAL_FULL: {
    military: {
      can_defend: true, can_attack_from: true, can_station_fleets: true,
      can_transit: true, can_recruit_armies: true, max_fleet_size: null,
    },
    economic: {
      can_extract_resources: true, can_build_structures: true,
      can_access_buildings: 'ALL', can_use_trade_routes: true,
      can_collect_income: false, // Il reddito va al proprietario meno le tasse
    },
    political: {
      can_colonize: true, can_sub_delegate: false,
      can_modify_laws: false, requires_owner_approval: ['colonize', 'declare_war'],
    },
  },
};

// ─────────────────────────────────────────────────────────────
//  TASSAZIONE
// ─────────────────────────────────────────────────────────────

/**
 * Definisce come vengono divise le risorse prodotte dall'elemento
 * tra proprietario e controllore.
 */
export interface TaxTerms {
  // Aliquota per risorsa (0.0 = tutto al controllore, 1.0 = tutto al proprietario)
  rates: Partial<Record<ResourceType, number>>;

  // Percentuale flat applicata a tutte le risorse non specificate
  default_rate: number;       // 0.0–1.0

  // Il proprietario può richiedere un minimo garantito per tick
  minimum_guaranteed: Partial<Record<ResourceType, number>>;

  // Direzione del pagamento
  // OWNER_TAXES_CONTROLLER = il proprietario trattiene X% dalla produzione
  // CONTROLLER_PAYS_OWNER  = il controllore paga X% come tributo fisso
  mode: 'OWNER_TAXES_CONTROLLER' | 'CONTROLLER_PAYS_OWNER';
}

/**
 * Snapshot del flusso fiscale calcolato per tick.
 * Aggiornato dal DelegationTickPhase ogni tick.
 */
export interface TaxFlowSnapshot {
  delegation_id:    string;
  tick:             number;
  produced:         Partial<Record<ResourceType, number>>;  // Produzione lorda
  owner_share:      Partial<Record<ResourceType, number>>;  // Quota proprietario
  controller_share: Partial<Record<ResourceType, number>>;  // Quota controllore
  shortfall:        Partial<Record<ResourceType, number>>;  // Debito se minimo non rispettato
}

// ─────────────────────────────────────────────────────────────
//  RINNOVO E REVOCA
// ─────────────────────────────────────────────────────────────

export enum DelegationStatus {
  ACTIVE             = 'ACTIVE',
  PENDING_RENEWAL    = 'PENDING_RENEWAL',   // Scadenza imminente, in rinnovo
  PENDING_REVOCATION = 'PENDING_REVOCATION',// Revoca richiesta, in attesa di consenso
  EXPIRED            = 'EXPIRED',
  REVOKED            = 'REVOKED',           // Terminata per accordo
  BROKEN             = 'BROKEN',            // Terminata per violazione
  SUPERSEDED         = 'SUPERSEDED',        // Sostituita da una nuova delega
}

export interface RenewalTerms {
  // Tick prima della scadenza in cui scatta la finestra di rinnovo
  notice_ticks:        number;
  // Auto-rinnova senza rinegoziazione se entrambi sono d'accordo
  auto_renew:          boolean;
  // Se nessuno risponde nella finestra → rinnovo automatico o scadenza
  default_on_silence:  'RENEW' | 'EXPIRE';
  // Modifiche proposte al rinnovo (se vuoto = stessi termini)
  proposed_changes?:   Partial<DelegationAgreementTerms>;
}

export interface RevocationRequest {
  requested_by:   string;     // empire_id di chi chiede la revoca
  reason?:        string;
  requested_at:   number;     // tick
  // Tick in cui la revoca diventa effettiva se accettata
  effective_at:   number;
  // Compensazione offerta per la revoca anticipata
  compensation?:  Partial<Record<ResourceType, number>>;
  status:         'PENDING' | 'ACCEPTED' | 'REJECTED';
  responded_at?:  number;
}

// ─────────────────────────────────────────────────────────────
//  DELEGATION AGREEMENT
//  Il contratto completo tra proprietario e controllore.
// ─────────────────────────────────────────────────────────────

export interface DelegationAgreementTerms {
  duration_ticks?:  number;   // null = permanente
  permissions:    DelegationPermissions;
  tax_terms:      TaxTerms;
  renewal_terms:  RenewalTerms;
  // Condizioni che, se violate, attivano una revoca automatica
  breach_conditions: BreachCondition[];
  // Note testuali libere (flavor/roleplay)
  notes?:         string;
}

export interface BreachCondition {
  type:       BreachConditionType;
  threshold?: number;
  resource?:  ResourceType;
  // Se true → revoca immediata; se false → notifica e 10 tick per rimediare
  immediate:  boolean;
}

export enum BreachConditionType {
  TAX_NOT_PAID          = 'TAX_NOT_PAID',       // Tassa non pagata per N tick
  UNAUTHORIZED_ATTACK   = 'UNAUTHORIZED_ATTACK', // Attacco senza permesso
  FLEET_LIMIT_EXCEEDED  = 'FLEET_LIMIT_EXCEEDED',// Superato max_fleet_size
  UNAUTHORIZED_BUILD    = 'UNAUTHORIZED_BUILD',  // Costruzione non permessa
  LOYALTY_BELOW         = 'LOYALTY_BELOW',       // Loyalty < soglia (mal gestito)
}

// ─────────────────────────────────────────────────────────────
//  PERMISSION CHECK — usato dai servizi per validare azioni
// ─────────────────────────────────────────────────────────────

export enum ControlAction {
  // Militare
  STATION_FLEET         = 'STATION_FLEET',
  ATTACK_FROM           = 'ATTACK_FROM',
  DEFEND                = 'DEFEND',
  TRANSIT_FLEET         = 'TRANSIT_FLEET',
  RECRUIT_ARMY          = 'RECRUIT_ARMY',

  // Economico
  EXTRACT_RESOURCES     = 'EXTRACT_RESOURCES',
  BUILD_STRUCTURE       = 'BUILD_STRUCTURE',
  ACCESS_BUILDING       = 'ACCESS_BUILDING',
  CREATE_TRADE_ROUTE    = 'CREATE_TRADE_ROUTE',
  COLLECT_INCOME        = 'COLLECT_INCOME',

  // Politico
  COLONIZE              = 'COLONIZE',
  MODIFY_LAWS           = 'MODIFY_LAWS',
  SUB_DELEGATE          = 'SUB_DELEGATE',
  TRANSFER_OWNERSHIP    = 'TRANSFER_OWNERSHIP',
}

export interface PermissionCheckResult {
  allowed:     boolean;
  reason?:     string;           // Se negato, perché
  requires_approval?: boolean;   // Se true, l'azione è permessa ma richiede approvazione owner
  approval_request_id?: string;  // ID della richiesta di approvazione creata
}

// ─────────────────────────────────────────────────────────────
//  APPROVAL REQUEST
//  Quando un'azione richiede approvazione esplicita del proprietario.
// ─────────────────────────────────────────────────────────────

export interface ApprovalRequest {
  id:           string;
  delegation_id: string;
  requested_by:  string;    // controller empire_id
  entity_id:     string;    // elemento su cui si vuole agire
  action:        ControlAction;
  context:       Record<string, any>;  // es. { fleet_id, target_system }
  status:        'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  created_at:    number;    // tick
  expires_at:    number;    // tick
}

// ─────────────────────────────────────────────────────────────
//  DELTA (WebSocket notification)
// ─────────────────────────────────────────────────────────────

export interface ControlDelta {
  tick:      number;
  timestamp: string;

  delegation_changes?:   DelegationChange[];
  tax_flows?:            TaxFlowSnapshot[];
  approval_requests?:    ApprovalRequest[];
  ownership_transfers?:  OwnershipTransferEvent[];
  breach_events?:        BreachEvent[];
}

export interface DelegationChange {
  delegation_id: string;
  entity_id:     string;
  entity_type:   ControllableEntityType;
  owner_id:      string;
  controller_id: string;
  status:        DelegationStatus;
  change_type:   'CREATED' | 'MODIFIED' | 'EXPIRED' | 'REVOKED' | 'RENEWED';
}

export interface OwnershipTransferEvent {
  entity_id:    string;
  entity_type:  ControllableEntityType;
  from_empire:  string;
  to_empire:    string;
  reason:       'TREATY' | 'PURCHASE' | 'CONQUEST' | 'DELEGATION_CONVERTED';
}

export interface BreachEvent {
  delegation_id: string;
  entity_id:     string;
  breacher_id:   string;
  condition:     BreachConditionType;
  description:   string;
  auto_revoked:  boolean;
}

// ── Missing type referenced in control.service ────────────
export interface OwnershipHistoryEntry {
  timestamp_tick: number;
  previous_owner: string | null;
  new_owner:      string;
  reason:         string;
}
