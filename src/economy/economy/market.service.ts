// ============================================================
//  market.service.ts — GDD sezioni 4.3, 4.5, 4.6
//  PATH: src/economy/market.service.ts
//
//  Responsabilità per tick:
//    1. Prezzi locali: Prezzo = Base × I × (1 + k×(D−O)/(O+1))
//    2. Inflazione per-pianeta: I = I + (M/Y − I) × s
//    3. Commercio automatico interplanetario
//    4. Prezzi base galattici (GC normalizzati)
//
//  NOTA CREDITI GALATTICI:
//    - Ogni pianeta ha il proprio indice inflazione I.
//    - Il prezzo locale (nominale) = GC_base × I × fattore_D_O.
//    - Il commercio inter-pianeta usa GC_base (reali, normalizzati).
//    - Il giocatore vede sempre il valore in GC reali.
// ============================================================

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository }   from '@nestjs/typeorm';
import { Repository, In }     from 'typeorm';

import {
  RegionMarketEntity, GalacticMarketEntity,
  TradeOrderEntity, PlanetInflationEntity, RegionEntity,
} from '../economy.entities';
import {
  ResourceType, GALACTIC_BASE_PRICES, MARKET_CONFIG,
  INFLATION_DEFAULTS, PolicyType,
} from '../economy.types';

@Injectable()
export class MarketService {
  private readonly logger = new Logger(MarketService.name);

  constructor(
    @InjectRepository(RegionMarketEntity)
    private readonly marketRepo: Repository<RegionMarketEntity>,
    @InjectRepository(GalacticMarketEntity)
    private readonly galacticRepo: Repository<GalacticMarketEntity>,
    @InjectRepository(TradeOrderEntity)
    private readonly tradeRepo: Repository<TradeOrderEntity>,
    @InjectRepository(PlanetInflationEntity)
    private readonly inflationRepo: Repository<PlanetInflationEntity>,
    @InjectRepository(RegionEntity)
    private readonly regionRepo: Repository<RegionEntity>,
  ) {}

  // ═══════════════════════════════════════════════════════════
  //  PREZZI LOCALI — GDD 4.3
  //
  //  Prezzo_locale(R) = PrezzoBaseGal(R) × I_pianeta
  //                   × (1 + k × (Domanda − Offerta) / (Offerta + 1))
  //
  //  Clampato a [base × MIN_PRICE_MULT, base × MAX_PRICE_MULT].
  //  Se il prezzo è fisso da policy PRICE_FIX, viene ignorata la formula.
  // ═══════════════════════════════════════════════════════════
  async updateRegionPrices(
    market:    RegionMarketEntity,
    inflation: PlanetInflationEntity,
    galactic:  GalacticMarketEntity,
    tick:      number,
  ): Promise<void> {
    const prices: Record<string, number> = {};

    for (const res of Object.values(ResourceType)) {
      if (res === ResourceType.CREDITS) continue;

      // Prezzo fisso da policy
      if (market.fixed_prices[res] != null) {
        prices[res] = market.fixed_prices[res]!;
        continue;
      }

      const baseGC  = galactic.base_prices[res] ?? GALACTIC_BASE_PRICES[res as ResourceType];
      const supply  = market.supply[res]  ?? 0;
      const demand  = market.demand[res]  ?? 0;

      // Componente domanda/offerta
      const doFactor = 1 + MARKET_CONFIG.K_VOLATILITY * (demand - supply) / (supply + 1);

      // Prezzo nominale = base_GC × inflazione × D/O
      const localPrice = baseGC * inflation.I * doFactor;

      // Clamp
      const minP = baseGC * MARKET_CONFIG.MIN_PRICE_MULT;
      const maxP = baseGC * MARKET_CONFIG.MAX_PRICE_MULT;
      prices[res] = Math.max(minP, Math.min(maxP, localPrice));
    }

    // Aggiorna storico (ultimi 10 tick)
    const history = market.price_history ?? [];
    history.push({ tick, prices: { ...prices } });
    if (history.length > 10) history.shift();

    market.prices          = prices;
    market.price_history   = history;
    market.last_updated_tick = tick;
    await this.marketRepo.save(market);
  }

  // ═══════════════════════════════════════════════════════════
  //  INFLAZIONE — GDD 4.6
  //
  //  Ordine di calcolo per tick:
  //    1. Y = Pop × Produttività × Stabilità
  //    2. P = M / Y
  //    3. I_teo = P / P_base
  //    4. I(t+1) = I(t) + (I_teo − I(t)) × s   ← smussatura
  //    5. Salari: W(t+1) = W(t) + (W_base × I − W(t)) × k_w
  //    6. Tasse: T = aliquota × (W_totale + Profitti)
  //    7. DebitoReale = D / I
  // ═══════════════════════════════════════════════════════════
  async updateInflation(
    inf:         PlanetInflationEntity,
    population:  number,
    productivity: number,
    stability:   number,
    profitsTotal: number,
    newMoney:    number,   // Moneta stampata questo tick (policy PRINT_MONEY)
    tick:        number,
  ): Promise<InflationUpdateResult> {
    // 1. Produzione reale
    inf.Y = Math.max(1, population * productivity * (stability / 100));

    // 2. Aggiorna moneta in circolazione
    inf.M = Math.max(1, inf.M + newMoney);
    inf.money_printed_this_tick = newMoney;

    // 3. Livello prezzi teorico
    const P_teo = inf.M / inf.Y;

    // 4. Inflazione teorica
    const I_teo = P_teo / inf.P_base;

    // 5. Smussatura inflazione
    const I_prev = inf.I;
    inf.I = inf.I + (I_teo - inf.I) * inf.s;
    inf.I = Math.max(0.1, Math.min(10, inf.I));  // Clamp: deflazione/iperinflazione estrema

    // 6. Adeguamento salari (più lento dell'inflazione)
    inf.W = inf.W + (inf.W_base * inf.I - inf.W) * inf.k_w;

    // 7. Entrate fiscali
    const wageTotal   = inf.W * population;
    inf.tax_revenue_last_tick = inf.tax_rate * (wageTotal + profitsTotal);

    // 8. Debito reale
    const debtReal = inf.public_debt / inf.I;

    // Storico (ultimi 20 tick)
    const hist = inf.inflation_history ?? [];
    hist.push({ tick, I: inf.I });
    if (hist.length > 20) hist.shift();
    inf.inflation_history    = hist;
    inf.last_updated_tick    = tick;

    await this.inflationRepo.save(inf);

    return {
      I_prev, I_new: inf.I, M: inf.M, Y: inf.Y,
      wage: inf.W, tax_revenue: inf.tax_revenue_last_tick,
      debt_real: debtReal,
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  COMMERCIO AUTOMATICO INTERPLANETARIO — GDD 4.5
  //
  //  Condizione profittabilità:
  //    PrezzoDestinazione_GC − PrezzoOrigine_GC > CostoTrasporto_GC
  //
  //  Nota: tutti i prezzi sono in GC reali (non nominali).
  //  Conversione: GC_reali = Prezzo_nominale / I_pianeta
  //
  //  Volume = min(OffertaOrigine, DomandaDest, CapacitàCargo)
  // ═══════════════════════════════════════════════════════════
  async processAutoTrade(
    galactic: GalacticMarketEntity,
    tick:     number,
  ): Promise<TradeFlowResult[]> {
    const orders = await this.tradeRepo.find({ where: { is_active: true } });
    const flows: TradeFlowResult[] = [];

    for (const order of orders) {
      // Recupera mercati e inflazioni di origine e destinazione
      const [originMarket, destMarket] = await Promise.all([
        this.marketRepo.findOneBy({ region_id: order.origin_region_id }),
        this.marketRepo.findOneBy({ region_id: order.dest_region_id }),
      ]);
      const [originInf, destInf] = await Promise.all([
        this.inflationRepo.findOneBy({ planet_id: order.origin_planet_id }),
        this.inflationRepo.findOneBy({ planet_id: order.dest_planet_id }),
      ]);

      if (!originMarket || !destMarket || !originInf || !destInf) continue;

      const res = order.resource;

      // Converti prezzi nominali → GC reali
      const priceOriginGC = (originMarket.prices[res] ?? 0) / originInf.I;
      const priceDestGC   = (destMarket.prices[res]   ?? 0) / destInf.I;

      // Rivaluta costo trasporto ogni 5 tick
      if (tick % 5 === 0) {
        order.fuel_cost_gc = this.calcFuelCost(order.origin_planet_id, order.dest_planet_id);
        await this.tradeRepo.save(order);
      }

      // Verifica profittabilità
      const profit = priceDestGC - priceOriginGC - order.fuel_cost_gc;
      if (profit <= 0) {
        order.unprofitable_ticks++;
        if (order.unprofitable_ticks >= 5) {
          order.is_active = false;
          this.logger.debug(`Trade order ${order.id} auto-stopped (unprofitable for 5 ticks)`);
        }
        await this.tradeRepo.save(order);
        continue;
      }

      order.unprofitable_ticks = 0;

      // Volume trasferito
      const originStock = (await this.regionRepo.findOneBy({ id: order.origin_region_id }))?.state_stock as any ?? {};
      const available   = originStock[res] ?? 0;
      const volume      = Math.min(order.amount_per_tick, available);
      if (volume <= 0) continue;

      // Esegui trasferimento
      await this.executeTransfer(order.origin_region_id, order.dest_region_id, res, volume);

      order.last_profit_gc = profit * volume;
      await this.tradeRepo.save(order);

      flows.push({
        order_id:    order.id,
        resource:    res,
        volume,
        origin:      order.origin_region_id,
        destination: order.dest_region_id,
        value_gc:    priceOriginGC * volume,
        profit_gc:   order.last_profit_gc,
      });
    }

    return flows;
  }

  // ═══════════════════════════════════════════════════════════
  //  PREZZI BASE GALATTICI — GDD 4.6 (dinamico opzionale)
  //
  //  PrezzoTeo_R  = BaseStorico_R × (1 + k × (D/O − 1))
  //  PrezzoBase_R(t+1) = PrezzoBase_R(t) + (Teo − Base) × s_gal
  // ═══════════════════════════════════════════════════════════
  async updateGalacticPrices(
    galacticSupply: Partial<Record<ResourceType, number>>,
    galacticDemand: Partial<Record<ResourceType, number>>,
    tick:           number,
  ): Promise<GalacticMarketEntity> {
    let galactic = await this.galacticRepo.findOne({ where: {} });
    if (!galactic) {
      galactic = this.galacticRepo.create({
        base_prices:    { ...GALACTIC_BASE_PRICES },
        galactic_supply: {},
        galactic_demand: {},
        price_history:  [],
        last_updated_tick: tick,
      });
    }

    galactic.galactic_supply = galacticSupply as Record<string, number>;
    galactic.galactic_demand = galacticDemand as Record<string, number>;

    const newPrices: Record<string, number> = {};
    for (const res of Object.values(ResourceType)) {
      if (res === ResourceType.CREDITS) { newPrices[res] = 1; continue; }

      const baseHistoric = GALACTIC_BASE_PRICES[res as ResourceType];
      const supply       = galacticSupply[res as ResourceType] ?? 1;
      const demand       = galacticDemand[res as ResourceType] ?? 1;

      const ratio  = demand / Math.max(1, supply);
      const priceTeo = baseHistoric * (1 + MARKET_CONFIG.K_GAL * (ratio - 1));
      const current  = galactic.base_prices[res] ?? baseHistoric;

      newPrices[res] = Math.max(
        baseHistoric * MARKET_CONFIG.MIN_PRICE_MULT,
        Math.min(
          baseHistoric * MARKET_CONFIG.MAX_PRICE_MULT,
          current + (priceTeo - current) * MARKET_CONFIG.S_GAL,
        ),
      );
    }

    // Storico (ultimi 50 tick)
    const hist = galactic.price_history ?? [];
    hist.push({ tick, prices: newPrices });
    if (hist.length > 50) hist.shift();

    galactic.base_prices      = newPrices;
    galactic.price_history    = hist;
    galactic.last_updated_tick = tick;
    await this.galacticRepo.save(galactic);
    return galactic;
  }

  // ═══════════════════════════════════════════════════════════
  //  AGGREGA OFFERTA/DOMANDA GALATTICA
  //
  //  Somma produzione e domanda di tutte le regioni dell'universo.
  //  Usato prima di updateGalacticPrices().
  // ═══════════════════════════════════════════════════════════
  async aggregateGalacticFlows(): Promise<{
    supply: Partial<Record<ResourceType, number>>;
    demand: Partial<Record<ResourceType, number>>;
  }> {
    const markets = await this.marketRepo.find();
    const supply: Partial<Record<ResourceType, number>> = {};
    const demand: Partial<Record<ResourceType, number>> = {};

    for (const m of markets) {
      for (const [res, val] of Object.entries(m.supply)) {
        supply[res as ResourceType] = (supply[res as ResourceType] ?? 0) + (val as number);
      }
      for (const [res, val] of Object.entries(m.demand)) {
        demand[res as ResourceType] = (demand[res as ResourceType] ?? 0) + (val as number);
      }
    }
    return { supply, demand };
  }

  // ─── Helper: costo trasporto in GC reali ─────────────────────────────────
  // In produzione: calcolare distanza vera tra pianeti.
  // Qui: formula placeholder basata su ID per test.
  private calcFuelCost(originPlanetId: string, destPlanetId: string): number {
    // TODO: rimpiazza con vera distanza dal StarSystemEntity
    // Fuel = distanza_ly × 0.5 + base_cost(2)
    return 5; // Placeholder
  }

  // ─── Trasferisce risorse tra depositi di due regioni ─────────────────────
  private async executeTransfer(
    originId: string, destId: string,
    resource: ResourceType, volume: number,
  ): Promise<void> {
    const [origin, dest] = await Promise.all([
      this.regionRepo.findOneBy({ id: originId }),
      this.regionRepo.findOneBy({ id: destId }),
    ]);
    if (!origin || !dest) return;

    const oStock = origin.state_stock as Record<ResourceType, number>;
    const dStock = dest.state_stock   as Record<ResourceType, number>;

    oStock[resource] = Math.max(0, (oStock[resource] ?? 0) - volume);
    dStock[resource] = (dStock[resource] ?? 0) + volume;

    origin.state_stock = oStock as any;
    dest.state_stock   = dStock as any;
    await this.regionRepo.save([origin, dest]);
  }

  // ─── Crea ordine di commercio automatico ─────────────────────────────────
  async createTradeOrder(dto: {
    empire_id:        string;
    origin_region_id: string;
    origin_planet_id: string;
    dest_region_id:   string;
    dest_planet_id:   string;
    resource:         ResourceType;
    amount_per_tick:  number;
    tick:             number;
  }): Promise<TradeOrderEntity> {
    const fuelCost = this.calcFuelCost(dto.origin_planet_id, dto.dest_planet_id);
    const order    = this.tradeRepo.create({
      ...dto,
      fuel_cost_gc:      fuelCost,
      is_active:         true,
      unprofitable_ticks: 0,
      last_profit_gc:    0,
      created_at_tick:   dto.tick,
    });
    return this.tradeRepo.save(order);
  }

  // ─── Recupera o crea inflazione per un pianeta ────────────────────────────
  async getOrCreateInflation(planetId: string, empireId: string): Promise<PlanetInflationEntity> {
    let inf = await this.inflationRepo.findOneBy({ planet_id: planetId });
    if (!inf) {
      inf = this.inflationRepo.create({
        planet_id:  planetId,
        empire_id:  empireId,
        M:          INFLATION_DEFAULTS.M_INITIAL,
        Y:          1000,
        P_base:     INFLATION_DEFAULTS.P_BASE,
        I:          INFLATION_DEFAULTS.I_INITIAL,
        W:          INFLATION_DEFAULTS.W_BASE,
        W_base:     INFLATION_DEFAULTS.W_BASE,
        s:          INFLATION_DEFAULTS.S_SMOOTH,
        k_w:        INFLATION_DEFAULTS.K_W_ADJUST,
        tax_rate:   INFLATION_DEFAULTS.TAX_RATE,
        public_debt: 0,
        money_printed_this_tick: 0,
        inflation_history: [],
        last_updated_tick: 0,
      });
      await this.inflationRepo.save(inf);
    }
    return inf;
  }
}

export interface InflationUpdateResult {
  I_prev:       number;
  I_new:        number;
  M:            number;
  Y:            number;
  wage:         number;
  tax_revenue:  number;
  debt_real:    number;
}

export interface TradeFlowResult {
  order_id:    string;
  resource:    ResourceType;
  volume:      number;
  origin:      string;
  destination: string;
  value_gc:    number;
  profit_gc:   number;
}
