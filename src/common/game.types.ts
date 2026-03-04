// ============================================================
//  game.types.ts — Tipi e costanti condivisi tra tutti i moduli
//  PATH: src/common/game.types.ts
// ============================================================

// ── Costanti tick ─────────────────────────────────────────────
export const TICK_CONSTANTS = {
  // Timing
  INTERVAL_MS:          60_000,
  TICK_INTERVAL_MS:     60_000,   // alias per retrocompatibilità
  DEV_INTERVAL_MS:      10_000,
  MAX_TICK_DURATION_MS: 30_000,

  // Fasi
  PHASES: [
    'DELEGATION', 'PRODUCE_RESOURCES', 'UPDATE_PRICES', 'TRADE',
    'CONSUME', 'UPDATE_HAPPINESS', 'POPULATION_GROWTH', 'SOCIAL_MOBILITY',
    'UPDATE_LOYALTY', 'MOVE_FLEETS', 'COMBAT', 'UPDATE_DIPLOMACY',
  ] as const,

  // Flotte
  LOW_SUPPLY_MORALE_PENALTY:    2,   // morale persa per tick senza rifornimenti
  COMBAT_EXP_PER_TICK:          1,   // esperienza guadagnata per tick in combattimento

  // Pianeti / Lealtà
  LOYALTY_REBELLION_THRESHOLD:  20,  // loyalty < 20 → rischio ribellione
  LOYALTY_UNSTABLE_THRESHOLD:   40,  // loyalty < 40 → instabilità
  REBELLION_BASE_PROBABILITY:   0.05,

  // Popolazione
  POPULATION_GROWTH_BASE:       0.02,

  // Wormhole
  WORMHOLE_RISK_DAMAGE_PERCENT:    0.05,
  WORMHOLE_REOPEN_CHANCE_DEFAULT:  0.1,
  WORMHOLE_STABILITY_DECAY_DEFAULT: 2,
  WORMHOLE_COLLAPSE_THRESHOLD:     0,

  // Ricerca
  RESEARCH_COST_PER_LEVEL:     100,
};

// ── Risorse ────────────────────────────────────────────────────
export enum ResourceType {
  WATER           = 'WATER',
  FOOD            = 'FOOD',
  BIOMASS         = 'BIOMASS',
  METALS          = 'METALS',
  RARE_METALS     = 'RARE_METALS',
  ENERGY          = 'ENERGY',
  GAS             = 'GAS',
  GOODS           = 'GOODS',
  INDUSTRIAL_GOODS= 'INDUSTRIAL_GOODS',
  CREDITS         = 'CREDITS',
  RESEARCH        = 'RESEARCH',
}

export type ResourceStock = Partial<Record<ResourceType, number>>;

export function emptyStock(): ResourceStock { return {}; }

export function addStock(a: ResourceStock, b: ResourceStock): ResourceStock {
  const r: ResourceStock = { ...a };
  for (const [k, v] of Object.entries(b))
    r[k as ResourceType] = (r[k as ResourceType] ?? 0) + (v ?? 0);
  return r;
}

export function clampStock(s: ResourceStock, min = 0): ResourceStock {
  const r: ResourceStock = {};
  for (const [k, v] of Object.entries(s))
    r[k as ResourceType] = Math.max(min, v ?? 0);
  return r;
}

// ── Enums entity ───────────────────────────────────────────────
export enum BodyStatus {
  STABLE     = 'STABLE',
  UNSTABLE   = 'UNSTABLE',
  OCCUPIED   = 'OCCUPIED',
  REBELLING  = 'REBELLION'
}

export enum FleetStatus {
  IDLE       = 'IDLE',
  MOVING     = 'MOVING',
  IN_WORMHOLE = 'IN_WORMHOLE',
  IN_COMBAT  = 'IN_COMBAT',
  RETREATING = 'RETREATING',
  DESTROYED  = 'DESTROYED',
}

export enum TravelMethod {
  HYPERSPACE = 'HYPERSPACE',
  WORMHOLE   = 'WORMHOLE',
}

export enum WormholeStatus {
  STABLE    = 'STABLE',
  UNSTABLE  = 'UNSTABLE',
  COLLAPSED = 'COLLAPSED',
  UNKNOWN = 'UNKNOWN'
}

export enum EventType {
  COMBAT          = 'COMBAT',
  REBELLION       = 'REBELLION',
  COLONY_FOUNDED  = 'COLONY_FOUNDED',
  WORMHOLE_EVENT  = 'WORMHOLE_EVENT',
  TREATY_SIGNED   = 'TREATY_SIGNED',
  RESEARCH_DONE   = 'RESEARCH_DONE',
  FLEET_DESTROYED = 'FLEET_DESTROYED',
  TRADE_EMBARGO   = 'TRADE_EMBARGO',
  GENERIC         = 'GENERIC',
  WORMHOLE_DISCOVERY = 'WORMHOLE_DISCOVERY',
  WORMHOLE_COLLAPSE  = 'WORMHOLE_COLLAPSE',
  GOLDEN_AGE         = 'GOLDEN_AGE',
}

// ── TickDelta — struttura inviata al frontend ogni tick ────────
export interface TickDelta {
  tick:             number;
  timestamp:        number;        // Date.now()
  phase?:           string;
  empires?:          EmpireDelta[];
  systems?:          SystemDelta[];
  events:           GameEventDelta[];
  combat?:           CombatDelta[];
  // Campi estesi usati dai servizi interni
  fleets?:          FleetDelta[];
  planets?:         PlanetDelta[];
  wormholes?:       WormholeDelta[];
  empireResources?: EmpireResourceDelta[];
  combatResults?:   CombatResult[];
}

export interface EmpireDelta {
  empire_id:    string;
  resources:    ResourceStock;
  planets_delta: PlanetDelta[];
}

export interface EmpireResourceDelta {
  empire_id: string;
  produced:  ResourceStock;
  consumed:  ResourceStock;
  net:       ResourceStock;
}

export interface PlanetDelta {
  planet_id:   string;
  loyalty?:    number;
  stability?:  number;
  population?: Record<string, number>;  // social_class → count
  status?:     BodyStatus;
}

export interface WormholeDelta {
  wormhole_id: string;
  status:      WormholeStatus | string;
  stability?:  number;
}

export interface SystemDelta {
  system_id: string;
  fleets:    FleetDelta[];
}

export interface FleetDelta {
  fleet_id:   string;
  empire_id:  string;
  status:     FleetStatus | string;
  location:   string;    // system_id corrente
  eta_tick?:  number;
  supply?:    number;
  morale?:    number;
  progress?:  number;
}

export interface GameEventDelta {
  id:          string;
  type:        EventType | string;
  message:     string;
  empire_id?:  string;     // singolo destinatario
  empire_ids?: string[];   // più destinatari (o [] = broadcast)
  event_id?:   string;     // alias di id per retrocompatibilità
  description: string;
  tick: number;
  title: string; 
  choices?: any[];
}

export interface CombatDelta {
  attacker_id: string;
  defender_id: string;
  system_id:   string;
  outcome: 'ATTACKER_WIN' | 'DEFENDER_WIN' | 'DRAW' | 'ONGOING';
  losses:      Record<string, number>;
}

export interface CombatResult {
  attacker_id: string;
  defender_id: string;
  system_id: string;
  outcome: 'ATTACKER_WIN' | 'DEFENDER_WIN' | 'DRAW' | 'ONGOING';
  attacker_losses: number;
  defender_losses: number;
}

export interface EventNotification {
  event_id:  string;
  type:      EventType | string;
  message:   string;
  empire_id: string;
  tick:      number;
}

// ── API helpers ────────────────────────────────────────────────
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page:  number;
  limit: number;
}
