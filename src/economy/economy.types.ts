// ============================================================
//  ECONOMY TYPES
//  Sistema economico completo basato sul GDD.
//
//  Unità atomica: REGIONE (non pianeta).
//  Moneta: Crediti Galattici (GC) normalizzati.
//    - Ogni transazione inter-planetaria usa GC reali.
//    - I prezzi locali sono GC × indice inflazione locale.
//    - Il giocatore vede sempre "X GC" indipendentemente
//      dall'inflazione del pianeta di destinazione.
// ============================================================

// ─────────────────────────────────────────────────────────────
//  RISORSE (sezione 4.1 GDD)
// ─────────────────────────────────────────────────────────────

export enum ResourceType {
  // Biologiche
  WATER      = 'WATER',
  FOOD       = 'FOOD',
  BIOMASS    = 'BIOMASS',

  // Minerali
  METALS     = 'METALS',
  RARE_METALS = 'RARE_METALS',

  // Energia
  ENERGY     = 'ENERGY',
  GAS        = 'GAS',

  // Manufatti
  GOODS      = 'GOODS',        // "Beni di consumo" richiesti da borghesia/oligarchia
  INDUSTRIAL_GOODS = 'INDUSTRIAL_GOODS',

  // Valuta
  CREDITS    = 'CREDITS',      // Crediti galattici (GC) — moneta unica
}

export type ResourceStock = Partial<Record<ResourceType, number>>;

/** Prezzi base galattici (GC puri, usati come ancora per l'inflazione locale) */
export const GALACTIC_BASE_PRICES: Record<ResourceType, number> = {
  [ResourceType.WATER]:            2,
  [ResourceType.FOOD]:             5,
  [ResourceType.BIOMASS]:          3,
  [ResourceType.METALS]:          10,
  [ResourceType.RARE_METALS]:     50,
  [ResourceType.ENERGY]:           8,
  [ResourceType.GAS]:              6,
  [ResourceType.GOODS]:           15,
  [ResourceType.INDUSTRIAL_GOODS]: 20,
  [ResourceType.CREDITS]:          1,
};

// ─────────────────────────────────────────────────────────────
//  CLASSI SOCIALI (sezione 3.3 GDD)
// ─────────────────────────────────────────────────────────────

export enum SocialClass {
  SLAVES       = 'SLAVES',
  UNEMPLOYED   = 'UNEMPLOYED',   // Non nel GDD originale, ma richiesto dal design
  WORKERS      = 'WORKERS',      // Classe operaia
  BOURGEOISIE  = 'BOURGEOISIE',  // Borghesia
  OLIGARCHY    = 'OLIGARCHY',
}

/**
 * Consumi e caratteristiche per classe sociale.
 * "rate" = unità consumate ogni tick
 * "weight" = peso sulla formula felicità (0–1)
 */
export interface SocialClassConfig {
  food_rate:      number;
  food_weight:    number;
  goods_rate:     number;
  goods_weight:   number;
  water_rate:     number;
  water_weight:   number;
  housing_space:  number;          // Unità spazio abitativo occupate per blocco
  base_wealth_multiplier: number;  // Moltiplicatore sulla soglia ricchezza
  happiness_base: number;          // Felicità base senza soddisfazione
}

export const SOCIAL_CLASS_CONFIG: Record<SocialClass, SocialClassConfig> = {
  [SocialClass.SLAVES]: {
    food_rate: 1, food_weight: 0.6,
    goods_rate: 0, goods_weight: 0,
    water_rate: 0.5, water_weight: 0.2,
    housing_space: 0.5,
    base_wealth_multiplier: 0,
    happiness_base: 10,          // Schiavi partono già scontenti
  },
  [SocialClass.UNEMPLOYED]: {
    food_rate: 0.6, food_weight: 0.5,   // Consumo ridotto rispetto agli operai
    goods_rate: 0.2, goods_weight: 0.2,
    water_rate: 0.4, water_weight: 0.2,
    housing_space: 1,
    base_wealth_multiplier: 0.05,
    happiness_base: 20,          // Forte malus base per disoccupazione
  },
  [SocialClass.WORKERS]: {
    food_rate: 1, food_weight: 0.6,
    goods_rate: 0.5, goods_weight: 0.3,
    water_rate: 0.6, water_weight: 0.15,
    housing_space: 1,
    base_wealth_multiplier: 0.1,
    happiness_base: 50,
  },
  [SocialClass.BOURGEOISIE]: {
    food_rate: 1, food_weight: 0.5,
    goods_rate: 1, goods_weight: 0.4,
    water_rate: 0.8, water_weight: 0.1,
    housing_space: 2,
    base_wealth_multiplier: 1.0,
    happiness_base: 55,
  },
  [SocialClass.OLIGARCHY]: {
    food_rate: 1, food_weight: 0.3,
    goods_rate: 3, goods_weight: 0.2,
    water_rate: 1, water_weight: 0.05,
    housing_space: 10,
    base_wealth_multiplier: 10.0,
    happiness_base: 60,
  },
};

// ─────────────────────────────────────────────────────────────
//  TIPO EDIFICIO (sezione 5.2 GDD)
// ─────────────────────────────────────────────────────────────

export enum BuildingCategory {
  AGRICULTURAL = 'AGRICULTURAL',
  INDUSTRIAL   = 'INDUSTRIAL',
  COMMERCIAL   = 'COMMERCIAL',
  MILITARY     = 'MILITARY',
  POLITICAL    = 'POLITICAL',
  HOUSING      = 'HOUSING',
  RESEARCH     = 'RESEARCH',
}

export enum WorkSlotType {
  PRODUCTION     = 'PRODUCTION',      // Schiavi OK, tutti OK
  SPECIALIZATION = 'SPECIALIZATION',  // Schiavi NO, operai 70%, oligarchi 70%
  MANAGEMENT     = 'MANAGEMENT',      // Schiavi NO, operai 50%, borghesi OK, oligarchi OK
}

/**
 * Efficienza di una classe sociale per tipo di ruolo lavorativo.
 * Sezione 5.5 del GDD.
 */
export const WORK_EFFICIENCY: Record<SocialClass, Record<WorkSlotType, number>> = {
  [SocialClass.SLAVES]: {
    [WorkSlotType.PRODUCTION]:     1.0,
    [WorkSlotType.SPECIALIZATION]: 0.0,   // Non possono
    [WorkSlotType.MANAGEMENT]:     0.0,
  },
  [SocialClass.UNEMPLOYED]: {
    [WorkSlotType.PRODUCTION]:     0.0,   // Non lavorano
    [WorkSlotType.SPECIALIZATION]: 0.0,
    [WorkSlotType.MANAGEMENT]:     0.0,
  },
  [SocialClass.WORKERS]: {
    [WorkSlotType.PRODUCTION]:     1.0,
    [WorkSlotType.SPECIALIZATION]: 0.7,
    [WorkSlotType.MANAGEMENT]:     0.5,
  },
  [SocialClass.BOURGEOISIE]: {
    [WorkSlotType.PRODUCTION]:     0.7,
    [WorkSlotType.SPECIALIZATION]: 1.0,
    [WorkSlotType.MANAGEMENT]:     1.0,
  },
  [SocialClass.OLIGARCHY]: {
    [WorkSlotType.PRODUCTION]:     0.3,
    [WorkSlotType.SPECIALIZATION]: 0.7,
    [WorkSlotType.MANAGEMENT]:     1.0,
  },
};

// ─────────────────────────────────────────────────────────────
//  DEFINIZIONI EDIFICI
// ─────────────────────────────────────────────────────────────

export interface BuildingDefinition {
  id:          string;
  name:        string;
  category:    BuildingCategory;
  base_cost:   ResourceStock;      // Costo livello 1
  cost_scale:  number;             // Esponente crescita costo (default 1.15)
  base_output: ResourceStock;      // Output base al livello 1 per tick
  consumes:    ResourceStock;      // Input richiesti per funzionare
  work_slots:  WorkSlotDefinition[];
  max_level:   number;
  output_per_level: number;        // Moltiplicatore output per ogni livello aggiuntivo
  description: string;
}

export interface WorkSlotDefinition {
  type:        WorkSlotType;
  slots:       number;             // Numero di lavoratori richiesti
  allowed:     SocialClass[];      // Classi che possono occupare il ruolo
}

/** Catalogo edifici */
export const BUILDING_DEFINITIONS: BuildingDefinition[] = [
  // ── AGRICOLI ──
  {
    id: 'FARM', name: 'Fattoria', category: BuildingCategory.AGRICULTURAL,
    base_cost: { [ResourceType.METALS]: 50, [ResourceType.CREDITS]: 200 },
    cost_scale: 1.15, max_level: 10, output_per_level: 1.2,
    base_output: { [ResourceType.FOOD]: 20 },
    consumes:   { [ResourceType.WATER]: 5, [ResourceType.ENERGY]: 2 },
    work_slots: [
      { type: WorkSlotType.PRODUCTION, slots: 4, allowed: [SocialClass.SLAVES, SocialClass.WORKERS] },
    ],
    description: 'Produce cibo. Richiede acqua ed energia.',
  },
  {
    id: 'HYDRO_PLANT', name: 'Impianto Idrico', category: BuildingCategory.AGRICULTURAL,
    base_cost: { [ResourceType.METALS]: 80, [ResourceType.CREDITS]: 350 },
    cost_scale: 1.15, max_level: 8, output_per_level: 1.2,
    base_output: { [ResourceType.WATER]: 30 },
    consumes:   { [ResourceType.ENERGY]: 5 },
    work_slots: [
      { type: WorkSlotType.PRODUCTION, slots: 2, allowed: [SocialClass.SLAVES, SocialClass.WORKERS] },
      { type: WorkSlotType.SPECIALIZATION, slots: 1, allowed: [SocialClass.WORKERS, SocialClass.BOURGEOISIE] },
    ],
    description: 'Estrae e purifica acqua.',
  },

  // ── INDUSTRIALI ──
  {
    id: 'MINE', name: 'Miniera', category: BuildingCategory.INDUSTRIAL,
    base_cost: { [ResourceType.METALS]: 100, [ResourceType.CREDITS]: 500 },
    cost_scale: 1.15, max_level: 10, output_per_level: 1.2,
    base_output: { [ResourceType.METALS]: 15 },
    consumes:   { [ResourceType.ENERGY]: 8 },
    work_slots: [
      { type: WorkSlotType.PRODUCTION, slots: 6, allowed: [SocialClass.SLAVES, SocialClass.WORKERS] },
    ],
    description: 'Estrae metalli.',
  },
  {
    id: 'RARE_MINE', name: 'Miniera di Terre Rare', category: BuildingCategory.INDUSTRIAL,
    base_cost: { [ResourceType.METALS]: 200, [ResourceType.CREDITS]: 1500 },
    cost_scale: 1.18, max_level: 8, output_per_level: 1.25,
    base_output: { [ResourceType.RARE_METALS]: 5 },
    consumes:   { [ResourceType.ENERGY]: 12, [ResourceType.METALS]: 2 },
    work_slots: [
      { type: WorkSlotType.PRODUCTION, slots: 4, allowed: [SocialClass.SLAVES, SocialClass.WORKERS] },
      { type: WorkSlotType.SPECIALIZATION, slots: 2, allowed: [SocialClass.WORKERS, SocialClass.BOURGEOISIE] },
    ],
    description: 'Estrae terre rare.',
  },
  {
    id: 'FACTORY', name: 'Fabbrica', category: BuildingCategory.INDUSTRIAL,
    base_cost: { [ResourceType.METALS]: 150, [ResourceType.CREDITS]: 800 },
    cost_scale: 1.15, max_level: 10, output_per_level: 1.2,
    base_output: { [ResourceType.GOODS]: 10, [ResourceType.INDUSTRIAL_GOODS]: 5 },
    consumes:   { [ResourceType.METALS]: 5, [ResourceType.ENERGY]: 10 },
    work_slots: [
      { type: WorkSlotType.PRODUCTION, slots: 4, allowed: [SocialClass.SLAVES, SocialClass.WORKERS] },
      { type: WorkSlotType.SPECIALIZATION, slots: 2, allowed: [SocialClass.WORKERS, SocialClass.BOURGEOISIE] },
    ],
    description: 'Produce beni di consumo e beni industriali.',
  },
  {
    id: 'POWER_PLANT', name: 'Centrale Energetica', category: BuildingCategory.INDUSTRIAL,
    base_cost: { [ResourceType.METALS]: 120, [ResourceType.CREDITS]: 600 },
    cost_scale: 1.15, max_level: 10, output_per_level: 1.2,
    base_output: { [ResourceType.ENERGY]: 40 },
    consumes:   { [ResourceType.GAS]: 8 },
    work_slots: [
      { type: WorkSlotType.PRODUCTION, slots: 2, allowed: [SocialClass.WORKERS] },
      { type: WorkSlotType.SPECIALIZATION, slots: 2, allowed: [SocialClass.WORKERS, SocialClass.BOURGEOISIE] },
    ],
    description: 'Genera energia da gas.',
  },

  // ── COMMERCIALI ──
  {
    id: 'MARKET', name: 'Mercato', category: BuildingCategory.COMMERCIAL,
    base_cost: { [ResourceType.CREDITS]: 1000, [ResourceType.INDUSTRIAL_GOODS]: 20 },
    cost_scale: 1.2, max_level: 5, output_per_level: 1.3,
    base_output: { [ResourceType.CREDITS]: 30 },  // Genera crediti da transazioni
    consumes:   {},
    work_slots: [
      { type: WorkSlotType.MANAGEMENT, slots: 2, allowed: [SocialClass.BOURGEOISIE] },
      { type: WorkSlotType.SPECIALIZATION, slots: 3, allowed: [SocialClass.WORKERS, SocialClass.BOURGEOISIE] },
    ],
    description: 'Hub commerciale. Genera crediti e riduce i costi di transazione.',
  },
  {
    id: 'SPACEPORT', name: 'Spazioporto', category: BuildingCategory.COMMERCIAL,
    base_cost: { [ResourceType.METALS]: 500, [ResourceType.RARE_METALS]: 50, [ResourceType.CREDITS]: 5000 },
    cost_scale: 1.2, max_level: 5, output_per_level: 1.3,
    base_output: {},
    consumes:   { [ResourceType.ENERGY]: 20 },
    work_slots: [
      { type: WorkSlotType.MANAGEMENT, slots: 3, allowed: [SocialClass.BOURGEOISIE, SocialClass.OLIGARCHY] },
      { type: WorkSlotType.SPECIALIZATION, slots: 5, allowed: [SocialClass.WORKERS, SocialClass.BOURGEOISIE] },
    ],
    description: 'Abilita rotte commerciali interplanetarie. Più livelli = più capacità cargo.',
  },

  // ── ALLOGGI ──
  {
    id: 'HOUSING', name: 'Complesso Residenziale', category: BuildingCategory.HOUSING,
    base_cost: { [ResourceType.METALS]: 80, [ResourceType.GOODS]: 20, [ResourceType.CREDITS]: 400 },
    cost_scale: 1.15, max_level: 10, output_per_level: 1.3,
    base_output: {},   // Capacità abitativa fornita via campo housing_capacity
    consumes:   { [ResourceType.ENERGY]: 3 },
    work_slots: [],    // Nessun lavoratore richiesto
    description: 'Fornisce spazio abitativo. Riduce il malus sovrappopolamento.',
  },

  // ── POLITICI ──
  {
    id: 'ADMIN_CENTER', name: 'Centro Amministrativo', category: BuildingCategory.POLITICAL,
    base_cost: { [ResourceType.INDUSTRIAL_GOODS]: 50, [ResourceType.CREDITS]: 3000 },
    cost_scale: 1.2, max_level: 5, output_per_level: 1.2,
    base_output: {},
    consumes:   { [ResourceType.ENERGY]: 10, [ResourceType.GOODS]: 5 },
    work_slots: [
      { type: WorkSlotType.MANAGEMENT, slots: 5, allowed: [SocialClass.OLIGARCHY, SocialClass.BOURGEOISIE] },
    ],
    description: 'Aumenta stabilità e lealtà della regione. Richiede oligarchi o borghesi.',
  },

  // ── MILITARI ──
  {
    id: 'BARRACKS', name: 'Caserma', category: BuildingCategory.MILITARY,
    base_cost: { [ResourceType.METALS]: 200, [ResourceType.CREDITS]: 1000 },
    cost_scale: 1.15, max_level: 5, output_per_level: 1.2,
    base_output: {},
    consumes:   { [ResourceType.FOOD]: 10, [ResourceType.ENERGY]: 5 },
    work_slots: [
      { type: WorkSlotType.MANAGEMENT, slots: 2, allowed: [SocialClass.OLIGARCHY] },
      { type: WorkSlotType.PRODUCTION, slots: 8, allowed: [SocialClass.WORKERS, SocialClass.SLAVES] },
    ],
    description: 'Addestra armate terrestri. Aumenta presenza militare (bonus lealtà).',
  },
];

// ─────────────────────────────────────────────────────────────
//  POLICY
// ─────────────────────────────────────────────────────────────

export enum PolicyType {
  // Economiche
  PRICE_FIX          = 'PRICE_FIX',          // Fissa prezzo di una risorsa
  TRADE_EMBARGO      = 'TRADE_EMBARGO',       // Blocca import/export
  NATIONALIZE        = 'NATIONALIZE',         // Stato incassa i guadagni
  CREATE_CORPORATION = 'CREATE_CORPORATION',  // Crea corporazione per edificio/settore
  FORCED_LABOR       = 'FORCED_LABOR',        // Lavori forzati schiavi: +prod, -felicità
  SUBSIDY            = 'SUBSIDY',             // Sussidio statale per risorsa

  // Sociali
  CLASS_RIGHTS       = 'CLASS_RIGHTS',        // Modifica diritti di una classe
  WEALTH_REDISTRIBUTION = 'WEALTH_REDISTRIBUTION', // Redistribuisce ricchezza
  CONSCRIPTION       = 'CONSCRIPTION',        // Coscrizione militare

  // Fiscali
  TAX_RATE           = 'TAX_RATE',            // Aliquota fiscale
  PRINT_MONEY        = 'PRINT_MONEY',         // Stampa moneta
}

export interface ActivePolicy {
  id:           string;
  type:         PolicyType;
  target_class?: SocialClass;
  target_resource?: ResourceType;
  target_building?: string;
  parameters:   Record<string, number | string | boolean>;
  applied_at:   number;   // tick
  expires_at?:  number;   // tick (null = permanente)
}

// ─────────────────────────────────────────────────────────────
//  INFLAZIONE (sezione 4.6 GDD)
// ─────────────────────────────────────────────────────────────

export interface PlanetInflationState {
  planet_id:      string;
  M:              number;   // Moneta totale in circolazione
  Y:              number;   // Produzione reale totale
  P_base:         number;   // Livello prezzi iniziale (1.0)
  I:              number;   // Indice inflazione corrente
  W:              number;   // Salario medio nominale corrente
  W_base:         number;   // Salario base iniziale
  tax_rate:       number;   // Aliquota fiscale (0–1)
  public_debt:    number;   // Debito pubblico nominale
  s:              number;   // Fattore smussatura (0.02–0.05)
  k_w:            number;   // Velocità adeguamento salari (0.01–0.03)
}

/** Costanti inflazione default */
export const INFLATION_DEFAULTS = {
  M_INITIAL:    10_000,
  P_BASE:       1.0,
  I_INITIAL:    1.0,
  W_BASE:       10,
  S_SMOOTH:     0.03,
  K_W_ADJUST:   0.02,
  TAX_RATE:     0.2,
};

// ─────────────────────────────────────────────────────────────
//  MERCATO (sezione 4.3 GDD)
// ─────────────────────────────────────────────────────────────

export interface RegionMarketState {
  region_id: string;
  prices:    Record<ResourceType, number>;  // Prezzi locali (in GC nominali × I)
  supply:    Record<ResourceType, number>;  // Offerta locale (produzione + stock)
  demand:    Record<ResourceType, number>;  // Domanda locale (consumi + richieste edifici)
  stock:     Record<ResourceType, number>;  // Scorte nel deposito statale
}

export interface GalacticMarketState {
  tick:                  number;
  base_prices:           Record<ResourceType, number>; // GC normalizzati
  galactic_supply:       Record<ResourceType, number>;
  galactic_demand:       Record<ResourceType, number>;
  price_index:           Record<ResourceType, number>; // Rapporto D/O
}

/** Coefficienti mercato */
export const MARKET_CONFIG = {
  K_VOLATILITY:  0.5,    // Coefficiente volatilità prezzi locali
  K_GAL:         0.3,    // Coefficiente aggiustamento prezzi galattici
  S_GAL:         0.05,   // Smussatura aggiornamento prezzi galattici
  MAX_PRICE_MULT: 5.0,   // Prezzo massimo = base × 5
  MIN_PRICE_MULT: 0.1,   // Prezzo minimo = base × 0.1
};

// ─────────────────────────────────────────────────────────────
//  MOBILITÀ SOCIALE (sezione 3.4 GDD)
// ─────────────────────────────────────────────────────────────

export interface MobilityResult {
  from_class:   SocialClass;
  to_class:     SocialClass;
  blocks:       number;
  reason:       string;
}

/** Soglia ricchezza per promozione/retrocessione */
export const WEALTH_THRESHOLDS: Record<SocialClass, number> = {
  [SocialClass.SLAVES]:      0,
  [SocialClass.UNEMPLOYED]:  50,
  [SocialClass.WORKERS]:     0.1,   // moltiplicatore su (ricchezza totale / pop)
  [SocialClass.BOURGEOISIE]: 1.0,
  [SocialClass.OLIGARCHY]:  10.0,
};

// ─────────────────────────────────────────────────────────────
//  COMMERCIO INTERPLANETARIO (sezione 4.5 GDD)
// ─────────────────────────────────────────────────────────────

export interface TradeRoute {
  id:             string;
  origin_region:  string;
  dest_region:    string;
  resource:       ResourceType;
  amount_per_tick: number;
  fuel_cost_gc:   number;    // Costo trasporto in GC reali
  profit_gc:      number;    // Profitto atteso in GC reali
  is_active:      boolean;
  empire_id:      string;
}

/** Calcolo profittabilità rotta */
export function isTradeRouteProfitable(
  price_origin: number,   // GC normalizzati
  price_dest:   number,
  fuel_cost:    number,
): boolean {
  return price_dest - price_origin > fuel_cost;
}

// ─────────────────────────────────────────────────────────────
//  TICK DELTA ECONOMIA
// ─────────────────────────────────────────────────────────────

export interface EconomyDelta {
  tick:     number;
  regions:  RegionEconomyUpdate[];
  galactic_market: GalacticMarketState;
  trade_flows: TradeFlowRecord[];
  social_mobility: MobilityResult[];
  inflation_updates: InflationUpdate[];
}

export interface RegionEconomyUpdate {
  region_id:     string;
  planet_id:     string;
  production:    ResourceStock;
  consumption:   ResourceStock;
  surplus:       ResourceStock;
  happiness:     Record<SocialClass, number>;
  loyalty:       number;
  stability:     number;
  population_delta: Record<SocialClass, number>;
  market_prices: Record<ResourceType, number>;
}

export interface TradeFlowRecord {
  route_id:    string;
  resource:    ResourceType;
  amount:      number;
  origin:      string;
  destination: string;
  value_gc:    number;   // Valore in GC reali
}

export interface InflationUpdate {
  planet_id:   string;
  I_prev:      number;
  I_new:       number;
  M:           number;
  Y:           number;
  wage:        number;
}
