// ============================================================
//  DIPLOMACY SERVICE
//  Logica core: propose, accept, reject, declare war, peace.
//  Chiamato sia dall'API REST (azioni giocatore) sia dal TickPhase.
// ============================================================

import {
  Injectable, Logger, BadRequestException,
  NotFoundException, ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';

import { RedisService }  from '../redis/redis.service';
import { ResourceType, ResourceStock, emptyStock } from '../common/game.types';

import {
  DiplomacyStatus, TreatyType, TreatyStatus,
  ProposalType, ProposalStatus, CasusBelli,
  TrustModifierSource, TreatyTermType,
  DiplomacyDelta, ProposalNotification, TreatyUpdate, WarUpdate,
  TrustChangeNotification,
} from './diplomacy.types';

import {
  DiplomaticRelationEntity, DiplomaticProposalEntity,
  TreatyEntity, WarEntity, VassalAgreementEntity,
} from './diplomacy.entities';

// Stub import — usa le entity del modulo core
import { EmpireEntity }        from '../entities/empire.entity';
import { CelestialBodyEntity } from '../entities/celestial-body.entity';
import { StarSystemEntity }    from '../entities/star-system.entity';

// ─────────────────────────────────────────────────────────────
//  TRUST MODIFIERS BASELINE PER EVENTO
// ─────────────────────────────────────────────────────────────

const TRUST_EVENTS: Record<TrustModifierSource, number> = {
  [TrustModifierSource.TREATY_RESPECTED]:  +2,   // Per tick in cui termini rispettati
  [TrustModifierSource.TREATY_BROKEN]:     -30,
  [TrustModifierSource.WAR_DECLARED]:      -40,
  [TrustModifierSource.SPY_EXPOSED]:       -20,
  [TrustModifierSource.TERRITORY_GIFTED]:  +15,
  [TrustModifierSource.TERRITORY_TAKEN]:   -15,
  [TrustModifierSource.TRIBUTE_PAID]:      +1,
  [TrustModifierSource.DEFENSE_HONORED]:   +20,
  [TrustModifierSource.DEFENSE_IGNORED]:   -25,
  [TrustModifierSource.DIPLOMATIC_GIFT]:   +8,
};

/** Tick di scadenza default per le proposte */
const PROPOSAL_DEFAULT_TTL = 50;

/** Tempo minimo di preavviso (in tick) per revocare trattati */
const TREATY_MIN_NOTICE: Record<TreatyType, number> = {
  [TreatyType.NON_AGGRESSION]:   20,
  [TreatyType.ALLIANCE]:         40,
  [TreatyType.MILITARY_ACCESS]:  10,
  [TreatyType.TRADE_AGREEMENT]:  15,
  [TreatyType.RESOURCE_SHARING]: 15,
  [TreatyType.MUTUAL_DEFENSE]:   40,
  [TreatyType.VASSALAGE]:        60,
  [TreatyType.BORDER_AGREEMENT]: 10,
  [TreatyType.JOINT_WAR]:        0,
};

// ─────────────────────────────────────────────────────────────
//  SERVICE
// ─────────────────────────────────────────────────────────────

@Injectable()
export class DiplomacyService {
  private readonly logger = new Logger(DiplomacyService.name);

  constructor(
    @InjectRepository(DiplomaticRelationEntity)
    private readonly relationRepo:  Repository<DiplomaticRelationEntity>,
    @InjectRepository(DiplomaticProposalEntity)
    private readonly proposalRepo:  Repository<DiplomaticProposalEntity>,
    @InjectRepository(TreatyEntity)
    private readonly treatyRepo:    Repository<TreatyEntity>,
    @InjectRepository(WarEntity)
    private readonly warRepo:       Repository<WarEntity>,
    @InjectRepository(VassalAgreementEntity)
    private readonly vassalRepo:    Repository<VassalAgreementEntity>,
    @InjectRepository(EmpireEntity)
    private readonly empireRepo:    Repository<EmpireEntity>,
    @InjectRepository(CelestialBodyEntity)
    private readonly bodyRepo:      Repository<CelestialBodyEntity>,
    @InjectRepository(StarSystemEntity)
    private readonly systemRepo:    Repository<StarSystemEntity>,
    private readonly redis:         RedisService,
    private readonly dataSource:    DataSource,
  ) {}

  // ─── Helpers ─────────────────────────────────────────────

  /**
   * Recupera (o crea) la relazione diplomatica tra due empire.
   * Normalizza sempre empire_a < empire_b per unicità.
   */
  async getOrCreateRelation(
    empireA: string, empireB: string,
  ): Promise<DiplomaticRelationEntity> {
    const [a, b] = [empireA, empireB].sort();
    let rel = await this.relationRepo.findOneBy({ empire_a: a, empire_b: b });
    if (!rel) {
      rel = this.relationRepo.create({ empire_a: a, empire_b: b });
      await this.relationRepo.save(rel);
    }
    return rel;
  }

  /**
   * Modifica il trust di A verso B (non simmetrico).
   * Clampato a -100 / +100.
   */
  async applyTrustModifier(
    fromEmpire: string, toEmpire: string,
    source: TrustModifierSource, tick: number,
    customValue?: number,
  ): Promise<void> {
    const rel = await this.getOrCreateRelation(fromEmpire, toEmpire);
    const delta = customValue ?? TRUST_EVENTS[source];

    const isA = rel.empire_a === fromEmpire;
    if (isA) {
      rel.trust_a_to_b = Math.max(-100, Math.min(100, rel.trust_a_to_b + delta));
    } else {
      rel.trust_b_to_a = Math.max(-100, Math.min(100, rel.trust_b_to_a + delta));
    }
    await this.relationRepo.save(rel);
  }

  async getRelationStatus(
    empireA: string, empireB: string,
  ): Promise<DiplomacyStatus> {
    const rel = await this.getOrCreateRelation(empireA, empireB);
    return rel.status;
  }

  // ─── PROPOSALS ────────────────────────────────────────────

  /**
   * Invia una proposta diplomatica.
   * Validazioni: non puoi proporre trattati durante una guerra attiva
   * (a meno che non sia una peace offer).
   */
  async sendProposal(dto: {
    from_empire_id: string;
    to_empire_id:   string;
    type:           ProposalType;
    payload:        Record<string, any>;
    message?:       string;
    current_tick:   number;
  }): Promise<DiplomaticProposalEntity> {
    const { from_empire_id, to_empire_id, type, payload, message, current_tick } = dto;

    if (from_empire_id === to_empire_id) {
      throw new BadRequestException('Cannot send a proposal to yourself');
    }

    const rel = await this.getOrCreateRelation(from_empire_id, to_empire_id);

    // Blocca trattati se in guerra (eccetto peace offer)
    if (rel.status === DiplomacyStatus.WAR && type !== ProposalType.PEACE_OFFER) {
      throw new ForbiddenException('Cannot send diplomatic proposals during war. Send a peace offer first.');
    }

    // Blocca duplicati: già c'è una proposta pending dello stesso tipo
    const existing = await this.proposalRepo.findOne({
      where: {
        from_empire_id,
        to_empire_id,
        type,
        status: ProposalStatus.PENDING,
      },
    });
    if (existing) {
      throw new BadRequestException(`A pending proposal of type ${type} already exists`);
    }

    const proposal = this.proposalRepo.create({
      from_empire_id,
      to_empire_id,
      type,
      status:         ProposalStatus.PENDING,
      payload,
      message,
      expires_at_tick: current_tick + PROPOSAL_DEFAULT_TTL,
      created_at_tick: current_tick,
    });

    await this.proposalRepo.save(proposal);
    this.logger.log(`Proposal sent: ${type} from ${from_empire_id} to ${to_empire_id}`);

    // Notifica via Redis → WebSocket Gateway
    await this.redis.publishEmpireDelta(to_empire_id, {
      tick: current_tick,
      proposals: [{
        proposal_id: proposal.id,
        type,
        from_empire: from_empire_id,
        to_empire:   to_empire_id,
        status:      ProposalStatus.PENDING,
        expires_at:  proposal.expires_at_tick,
        summary:     message ?? `Nuova proposta: ${type}`,
      }],
    });

    return proposal;
  }

  /**
   * Accetta una proposta. Esegue le azioni necessarie in base al tipo.
   */
  async acceptProposal(dto: {
    proposal_id:  string;
    empire_id:    string;   // Chi sta accettando (deve essere to_empire)
    current_tick: number;
    response_message?: string;
  }): Promise<void> {
    const { proposal_id, empire_id, current_tick, response_message } = dto;

    const proposal = await this.proposalRepo.findOneBy({ id: proposal_id });
    if (!proposal) throw new NotFoundException('Proposal not found');
    if (proposal.to_empire_id !== empire_id) {
      throw new ForbiddenException('You are not the recipient of this proposal');
    }
    if (proposal.status !== ProposalStatus.PENDING) {
      throw new BadRequestException(`Proposal is already ${proposal.status}`);
    }
    if (proposal.expires_at_tick < current_tick) {
      throw new BadRequestException('Proposal has expired');
    }

    await this.dataSource.transaction(async (manager) => {
      proposal.status           = ProposalStatus.ACCEPTED;
      proposal.response_message = response_message ?? '';
      proposal.responded_at     = new Date();
      await manager.save(DiplomaticProposalEntity, proposal);

      // Esegui l'azione in base al tipo
      switch (proposal.type) {
        case ProposalType.TREATY:
          await this.activateTreaty(proposal, current_tick, manager);
          break;
        case ProposalType.WAR_DECLARATION:
          // Non si accetta una dichiarazione di guerra; ma può usarsi
          // per guerra congiunta (un alleato si unisce)
          break;
        case ProposalType.TERRITORY_DEAL:
          await this.executeTerritoryTransfer(proposal, current_tick, manager);
          break;
        case ProposalType.VASSAL_OFFER:
          await this.activateVassalAgreement(proposal, current_tick, manager);
          break;
        case ProposalType.PEACE_OFFER:
          await this.executePeace(proposal, current_tick, manager);
          break;
      }

      // Aggiorna trust positivamente
      await this.applyTrustModifier(
        proposal.from_empire_id, proposal.to_empire_id,
        TrustModifierSource.TREATY_RESPECTED, current_tick, +5,
      );
    });

    this.logger.log(`Proposal ${proposal_id} accepted by ${empire_id}`);
  }

  /**
   * Rifiuta una proposta.
   */
  async rejectProposal(dto: {
    proposal_id:  string;
    empire_id:    string;
    current_tick: number;
    response_message?: string;
  }): Promise<void> {
    const { proposal_id, empire_id, current_tick, response_message } = dto;
    const proposal = await this.proposalRepo.findOneBy({ id: proposal_id });

    if (!proposal) throw new NotFoundException('Proposal not found');
    if (proposal.to_empire_id !== empire_id) {
      throw new ForbiddenException('You are not the recipient of this proposal');
    }
    if (proposal.status !== ProposalStatus.PENDING) {
      throw new BadRequestException(`Proposal is already ${proposal.status}`);
    }

    proposal.status           = ProposalStatus.REJECTED;
    proposal.response_message = response_message ?? '';
    proposal.responded_at     = new Date();
    await this.proposalRepo.save(proposal);

    // Lieve penalità trust (rifiutare non è neutrale)
    await this.applyTrustModifier(
      proposal.to_empire_id, proposal.from_empire_id,
      TrustModifierSource.DIPLOMATIC_GIFT, current_tick, -3,
    );

    this.logger.log(`Proposal ${proposal_id} rejected by ${empire_id}`);
  }

  // ─── TRATTATI ─────────────────────────────────────────────

  private async activateTreaty(
    proposal: DiplomaticProposalEntity,
    tick:     number,
    manager:  any,
  ): Promise<void> {
    const p = proposal.payload as { treaty_type: TreatyType; terms: any[]; duration_ticks?: number };

    const treaty = manager.create(TreatyEntity, {
      type:              p.treaty_type,
      status:            TreatyStatus.ACTIVE,
      party_ids:         [proposal.from_empire_id, proposal.to_empire_id],
      terms:             p.terms ?? [],
      signed_at_tick:    tick,
      expires_at_tick:   p.duration_ticks ? tick + p.duration_ticks : null,
      min_notice_ticks:  TREATY_MIN_NOTICE[p.treaty_type] ?? 20,
      breach_trust_penalty: this.getTreatyBreachPenalty(p.treaty_type),
      origin_proposal_id: proposal.id,
    });
    await manager.save(TreatyEntity, treaty);

    // Aggiorna relazione diplomatica
    const rel = await this.getOrCreateRelation(
      proposal.from_empire_id, proposal.to_empire_id,
    );
    rel.active_treaty_ids = [...rel.active_treaty_ids, treaty.id];

    // Aggiorna status relazione in base al tipo di trattato
    const newStatus = this.treatyTypeToStatus(p.treaty_type, rel.status);
    if (newStatus) rel.status = newStatus;

    await manager.save(DiplomaticRelationEntity, rel);

    // Esegui termini immediati (CEDE_PLANET, LUMP_SUM, ecc.)
    for (const term of treaty.terms) {
      if (term.type === TreatyTermType.CEDE_PLANET && term.value.planet_id) {
        await this.transferPlanetOwnership(
          term.value.planet_id, term.from_empire, term.to_empire, tick, manager,
        );
      }
      if (term.type === TreatyTermType.CEDE_SYSTEM && term.value.system_id) {
        await this.transferSystemOwnership(
          term.value.system_id, term.from_empire, term.to_empire, tick, manager,
        );
      }
    }

    this.logger.log(`Treaty ${treaty.type} activated between ${proposal.from_empire_id} and ${proposal.to_empire_id}`);
  }

  /**
   * Revoca unilaterale di un trattato (con preavviso).
   * Il trattato non termina immediatamente: rimane attivo per min_notice_ticks.
   */
  async cancelTreaty(dto: {
    treaty_id:    string;
    empire_id:    string;
    current_tick: number;
  }): Promise<{ effective_at_tick: number }> {
    const { treaty_id, empire_id, current_tick } = dto;
    const treaty = await this.treatyRepo.findOneBy({ id: treaty_id });

    if (!treaty) throw new NotFoundException('Treaty not found');
    if (!treaty.party_ids.includes(empire_id)) {
      throw new ForbiddenException('You are not a party of this treaty');
    }
    if (treaty.status !== TreatyStatus.ACTIVE) {
      throw new BadRequestException(`Treaty is already ${treaty.status}`);
    }

    const effectiveAt = current_tick + treaty.min_notice_ticks;
    treaty.expires_at_tick = effectiveAt;
    await this.treatyRepo.save(treaty);

    this.logger.log(`Treaty ${treaty_id} cancellation notice by ${empire_id}. Effective at tick ${effectiveAt}`);
    return { effective_at_tick: effectiveAt };
  }

  // ─── GUERRA ───────────────────────────────────────────────

  /**
   * Dichiarazione di guerra.
   * Viola automaticamente tutti i trattati NON_AGGRESSION e ALLIANCE con il target.
   */
  async declareWar(dto: {
    attacker_id:  string;
    defender_id:  string;
    casus_belli:  CasusBelli;
    war_goals?:   any[];
    current_tick: number;
  }): Promise<WarEntity> {
    const { attacker_id, defender_id, casus_belli, war_goals, current_tick } = dto;

    if (attacker_id === defender_id) {
      throw new BadRequestException('Cannot declare war on yourself');
    }

    const rel = await this.getOrCreateRelation(attacker_id, defender_id);
    if (rel.status === DiplomacyStatus.WAR) {
      throw new BadRequestException('Already at war with this empire');
    }

    const war = await this.dataSource.transaction(async (manager) => {
      // Crea entità guerra
      const w = manager.create(WarEntity, {
        attacker_id,
        defender_id,
        casus_belli,
        war_goals:       war_goals ?? [],
        started_at_tick: current_tick,
        is_active:       true,
      });
      await manager.save(WarEntity, w);

      // Aggiorna relazione → WAR
      rel.status       = DiplomacyStatus.WAR;
      rel.active_war_ids = [...rel.active_war_ids, w.id];
      await manager.save(DiplomaticRelationEntity, rel);

      // Viola i trattati incompatibili con la guerra
      await this.breachIncompatibleTreaties(
        attacker_id, defender_id, current_tick, manager,
      );

      return w;
    });

    // Trust penalty (asimmetrica: l'aggressore paga il prezzo politico)
    await this.applyTrustModifier(
      defender_id, attacker_id,
      TrustModifierSource.WAR_DECLARED, current_tick,
    );

    // Se il casus belli è debole → tutti gli empire neutrali perdono trust verso l'aggressore
    if (casus_belli === CasusBelli.EXPANSION) {
      await this.applyGlobalAggression(attacker_id, current_tick, -10);
    }

    this.logger.warn(`WAR DECLARED: ${attacker_id} → ${defender_id} (${casus_belli})`);

    // Notifica entrambi gli empire
    const warPayload: WarUpdate = {
      war_id:          war.id,
      attacker_id,
      defender_id,
      casus_belli,
      started_at_tick: current_tick,
      is_new:          true,
    };
    await this.redis.publishEmpireDelta(defender_id, { tick: current_tick, wars: [warPayload] });
    await this.redis.publishEmpireDelta(attacker_id, { tick: current_tick, wars: [warPayload] });

    return war;
  }

  /**
   * Offerta di pace durante una guerra attiva.
   * Crea una proposta di tipo PEACE_OFFER con i termini concordati.
   */
  async offerPeace(dto: {
    from_empire_id: string;
    to_empire_id:   string;
    war_id:         string;
    terms:          any;
    message?:       string;
    current_tick:   number;
  }): Promise<DiplomaticProposalEntity> {
    const war = await this.warRepo.findOneBy({ id: dto.war_id });
    if (!war || !war.is_active) throw new NotFoundException('Active war not found');
    if (war.attacker_id !== dto.from_empire_id && war.defender_id !== dto.from_empire_id) {
      throw new ForbiddenException('You are not a party in this war');
    }

    return this.sendProposal({
      from_empire_id: dto.from_empire_id,
      to_empire_id:   dto.to_empire_id,
      type:           ProposalType.PEACE_OFFER,
      payload:        { war_id: dto.war_id, terms: dto.terms },
      message:        dto.message,
      current_tick:   dto.current_tick,
    });
  }

  private async executePeace(
    proposal: DiplomaticProposalEntity,
    tick:     number,
    manager:  any,
  ): Promise<void> {
    const { war_id, terms } = proposal.payload;
    const war = await this.warRepo.findOneBy({ id: war_id });
    if (!war) return;

    war.is_active     = false;
    war.ended_at_tick = tick;
    war.outcome       = 'WHITE_PEACE';
    await manager.save(WarEntity, war);

    // Ripristina relazione diplomatica
    const rel = await this.getOrCreateRelation(war.attacker_id, war.defender_id);
    rel.status       = DiplomacyStatus.NEUTRAL;
    rel.active_war_ids = rel.active_war_ids.filter(id => id !== war_id);
    await manager.save(DiplomaticRelationEntity, rel);

    // Se nei termini ci sono cessioni di territorio
    if (terms?.planet_ids?.length) {
      for (const pid of terms.planet_ids) {
        await this.transferPlanetOwnership(
          pid, terms.from_empire, terms.to_empire, tick, manager,
        );
      }
    }

    // Lieve bonus trust post-pace
    await this.applyTrustModifier(
      war.attacker_id, war.defender_id, TrustModifierSource.TREATY_RESPECTED, tick, +10,
    );
    await this.applyTrustModifier(
      war.defender_id, war.attacker_id, TrustModifierSource.TREATY_RESPECTED, tick, +10,
    );

    this.logger.log(`Peace concluded: ${war.attacker_id} ↔ ${war.defender_id}`);
  }

  // ─── VASSALLAGGIO ─────────────────────────────────────────

  private async activateVassalAgreement(
    proposal: DiplomaticProposalEntity,
    tick:     number,
    manager:  any,
  ): Promise<void> {
    const v = proposal.payload as {
      overlord_id: string;
      vassal_id:   string;
      tribute_type: string;
      tribute_amount: number;
      protection: boolean;
      autonomy: number;
      duration_ticks?: number;
    };

    const vassal = manager.create(VassalAgreementEntity, {
      overlord_id:    v.overlord_id,
      vassal_id:      v.vassal_id,
      tribute_type:   v.tribute_type,
      tribute_amount: v.tribute_amount,
      protection:     v.protection,
      autonomy:       v.autonomy,
      started_at_tick: tick,
      ends_at_tick:   v.duration_ticks ? tick + v.duration_ticks : null,
      origin_treaty_id: proposal.id,
    });
    await manager.save(VassalAgreementEntity, vassal);

    // Aggiorna relazioni diplomatiche
    const relO = await this.getOrCreateRelation(v.overlord_id, v.vassal_id);
    const isOA = relO.empire_a === v.overlord_id;
    if (isOA) {
      relO.status = DiplomacyStatus.OVERLORD;
    } else {
      relO.status = DiplomacyStatus.VASSAL;
    }
    await manager.save(DiplomaticRelationEntity, relO);

    this.logger.log(`Vassal agreement: ${v.overlord_id} → ${v.vassal_id}`);
  }

  // ─── TERRITORIO ───────────────────────────────────────────

  private async executeTerritoryTransfer(
    proposal: DiplomaticProposalEntity,
    tick:     number,
    manager:  any,
  ): Promise<void> {
    const deal = proposal.payload as {
      from_empire: string;
      to_empire:   string;
      planet_ids:  string[];
      system_ids:  string[];
      price_credits: number;
    };

    for (const pid of (deal.planet_ids ?? [])) {
      await this.transferPlanetOwnership(
        pid, deal.from_empire, deal.to_empire, tick, manager,
      );
    }
    for (const sid of (deal.system_ids ?? [])) {
      await this.transferSystemOwnership(
        sid, deal.from_empire, deal.to_empire, tick, manager,
      );
    }

    // Trasferimento crediti
    if (deal.price_credits > 0) {
      const buyerPool  = await this.redis.getJson<ResourceStock>(`empire:${deal.to_empire}:resources`);
      const sellerPool = await this.redis.getJson<ResourceStock>(`empire:${deal.from_empire}:resources`);
      if (buyerPool && sellerPool) {
        buyerPool[ResourceType.CREDITS]  = (buyerPool[ResourceType.CREDITS] ?? 0) - deal.price_credits;
        sellerPool[ResourceType.CREDITS] = (sellerPool[ResourceType.CREDITS] ?? 0) + deal.price_credits;
        await this.redis.setJson(`empire:${deal.to_empire}:resources`, buyerPool);
        await this.redis.setJson(`empire:${deal.from_empire}:resources`, sellerPool);
      }
    }

    await this.applyTrustModifier(
      deal.to_empire, deal.from_empire,
      TrustModifierSource.TERRITORY_GIFTED, tick,
    );
  }

  private async transferPlanetOwnership(
    planetId:  string,
    fromEmpire: string,
    toEmpire:  string,
    tick:      number,
    manager:   any,
  ): Promise<void> {
    const body = await this.bodyRepo.findOneBy({ id: planetId });
    if (!body || body.owner_id !== fromEmpire) return;

    body.owner_id      = toEmpire;
    body.controller_id = toEmpire;
    body.loyalty       = 30;  // Lealtà iniziale bassa con nuovo proprietario
    await manager.save(CelestialBodyEntity, body);

    this.logger.log(`Planet ${planetId} transferred: ${fromEmpire} → ${toEmpire}`);
  }

  private async transferSystemOwnership(
    systemId:  string,
    fromEmpire: string,
    toEmpire:  string,
    tick:      number,
    manager:   any,
  ): Promise<void> {
    const system = await this.systemRepo.findOneBy({ id: systemId });
    if (!system || system.owner_id !== fromEmpire) return;

    system.owner_id      = toEmpire;
    system.controller_id = toEmpire;
    await manager.save(StarSystemEntity, system);

    // Trasferisci anche tutti i pianeti del sistema
    const bodies = await this.bodyRepo.find({ where: { system_id: systemId } });
    for (const body of bodies) {
      if (body.owner_id === fromEmpire) {
        body.owner_id      = toEmpire;
        body.controller_id = toEmpire;
        body.loyalty       = 25;
        await manager.save(CelestialBodyEntity, body);
      }
    }

    this.logger.log(`System ${systemId} transferred: ${fromEmpire} → ${toEmpire}`);
  }

  // ─── VIOLAZIONI TRATTATI ──────────────────────────────────

  /**
   * Quando viene dichiarata guerra, viola tutti i trattati incompatibili.
   * NON_AGGRESSION e ALLIANCE con il target vengono rotti.
   * Tutti i cofirmatari di trattati MUTUAL_DEFENSE vengono notificati.
   */
  private async breachIncompatibleTreaties(
    attacker: string, defender: string, tick: number, manager: any,
  ): Promise<void> {
    const rel = await this.getOrCreateRelation(attacker, defender);
    const incompatible = [
      TreatyType.NON_AGGRESSION, TreatyType.ALLIANCE, TreatyType.MUTUAL_DEFENSE,
    ];

    for (const tid of rel.active_treaty_ids) {
      const treaty = await this.treatyRepo.findOneBy({ id: tid });
      if (!treaty || !incompatible.includes(treaty.type)) continue;

      treaty.status            = TreatyStatus.BROKEN;
      treaty.broken_by_empire_id = attacker;
      treaty.broken_at_tick    = tick;
      await manager.save(TreatyEntity, treaty);

      // Penalità trust
      await this.applyTrustModifier(
        defender, attacker, TrustModifierSource.TREATY_BROKEN, tick,
      );

      // Avvisa i cofirmatari di MUTUAL_DEFENSE che devono scegliere se intervenire
      if (treaty.type === TreatyType.MUTUAL_DEFENSE) {
        const allies = treaty.party_ids.filter(id => id !== attacker && id !== defender);
        for (const ally of allies) {
          await this.redis.publishEmpireDelta(ally, {
            tick,
            events: [{
              type: 'MUTUAL_DEFENSE_TRIGGERED',
              description: `Il tuo alleato ${defender} è stato attaccato da ${attacker}. Sei obbligato a intervenire.`,
              empire_ids: [ally],
              choices: [
                { id: 'HONOR', label: 'Onora il patto → entra in guerra' },
                { id: 'IGNORE', label: 'Ignora → -trust con tutti gli alleati' },
              ],
            }],
          });
        }
      }
    }

    // Rimuovi gli ID dalla relazione
    rel.active_treaty_ids = [];
    await manager.save(DiplomaticRelationEntity, rel);
  }

  /** Penalizza il trust di tutti gli empire verso un aggressore impopolare */
  private async applyGlobalAggression(
    aggressorId: string, tick: number, penalty: number,
  ): Promise<void> {
    const allEmpires = await this.empireRepo.find({ select: ['id'] });
    for (const e of allEmpires) {
      if (e.id === aggressorId) continue;
      await this.applyTrustModifier(
        e.id, aggressorId, TrustModifierSource.WAR_DECLARED, tick, penalty,
      );
    }
  }

  // ─── Utils ────────────────────────────────────────────────

  private treatyTypeToStatus(
    type:    TreatyType,
    current: DiplomacyStatus,
  ): DiplomacyStatus | null {
    switch (type) {
      case TreatyType.ALLIANCE:       return DiplomacyStatus.ALLIANCE;
      case TreatyType.NON_AGGRESSION: return DiplomacyStatus.NON_AGGRESSION;
      case TreatyType.TRADE_AGREEMENT:return DiplomacyStatus.TRADE_PACT;
      case TreatyType.VASSALAGE:      return DiplomacyStatus.ALLIANCE; // overlap con OVERLORD/VASSAL
      default:                        return null;
    }
  }

  private getTreatyBreachPenalty(type: TreatyType): number {
    const penalties: Partial<Record<TreatyType, number>> = {
      [TreatyType.ALLIANCE]:       -50,
      [TreatyType.MUTUAL_DEFENSE]: -45,
      [TreatyType.VASSALAGE]:      -35,
      [TreatyType.NON_AGGRESSION]: -25,
      [TreatyType.TRADE_AGREEMENT]:-15,
    };
    return penalties[type] ?? -20;
  }

  // ─── READ Queries ─────────────────────────────────────────

  async getPendingProposals(empireId: string): Promise<DiplomaticProposalEntity[]> {
    return this.proposalRepo.find({
      where: [
        { to_empire_id: empireId, status: ProposalStatus.PENDING },
        { from_empire_id: empireId, status: ProposalStatus.PENDING },
      ],
      order: { created_at: 'DESC' },
    });
  }

  async getActiveTreaties(empireId: string): Promise<TreatyEntity[]> {
    return this.treatyRepo
      .createQueryBuilder('t')
      .where(':eid = ANY(t.party_ids)', { eid: empireId })
      .andWhere('t.status = :status', { status: TreatyStatus.ACTIVE })
      .getMany();
  }

  async getActiveWars(empireId: string): Promise<WarEntity[]> {
    return this.warRepo.find({
      where: [
        { attacker_id: empireId, is_active: true },
        { defender_id: empireId, is_active: true },
      ],
    });
  }

  async getAllRelations(empireId: string): Promise<DiplomaticRelationEntity[]> {
    return this.relationRepo.find({
      where: [
        { empire_a: empireId },
        { empire_b: empireId },
      ],
    });
  }
}
