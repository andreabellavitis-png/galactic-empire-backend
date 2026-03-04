// ============================================================
//  CONTROL SERVICE
//
//  Il servizio centrale del sistema ownership/controllo.
//  È il punto di verità per ogni domanda del tipo:
//    "Chi possiede X?"
//    "Chi controlla X?"
//    "Empire Y può fare azione Z su elemento X?"
//
//  Tutti gli altri servizi (diplomacy, tick phases, fleet movement,
//  combat) devono passare da qui prima di eseguire azioni su
//  elementi controllabili.
// ============================================================

import {
  Injectable, Logger, BadRequestException,
  NotFoundException, ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';

import { RedisService }   from '../redis/redis.service';
import { ResourceType, ResourceStock, emptyStock } from '../common/game.types';

import {
  ControllableEntityType, ControllableStatus,
  DelegationAgreementTerms, DelegationStatus,
  ControlAction, PermissionCheckResult,
  AllowList, TaxTerms, TaxFlowSnapshot,
  OwnershipHistoryEntry, BreachConditionType,
  PERMISSION_PRESETS, RevocationRequest,
  ControlDelta, DelegationChange, BreachEvent,
} from './control.types';

import {
  EntityOwnershipEntity, DelegationAgreementEntity,
  ApprovalRequestEntity, TaxFlowLogEntity,
  PendingRenewal,
} from './control.entities';

// ─────────────────────────────────────────────────────────────
//  CACHE KEYS (Redis)
//
//  ownership:{entity_id}           → EntityOwnershipSnapshot (breve TTL)
//  delegation:{delegation_id}      → DelegationAgreementEntity (media TTL)
//  entity:owner:{entity_id}        → owner_id string
//  entity:controller:{entity_id}   → controller_id string
// ─────────────────────────────────────────────────────────────

const CACHE_TTL = {
  OWNERSHIP:   60,   // 60 secondi
  DELEGATION:  120,
};

// ─────────────────────────────────────────────────────────────
//  SERVICE
// ─────────────────────────────────────────────────────────────

@Injectable()
export class ControlService {
  private readonly logger = new Logger(ControlService.name);

  constructor(
    @InjectRepository(EntityOwnershipEntity)
    private readonly ownershipRepo:   Repository<EntityOwnershipEntity>,
    @InjectRepository(DelegationAgreementEntity)
    private readonly delegationRepo:  Repository<DelegationAgreementEntity>,
    @InjectRepository(ApprovalRequestEntity)
    private readonly approvalRepo:    Repository<ApprovalRequestEntity>,
    @InjectRepository(TaxFlowLogEntity)
    private readonly taxLogRepo:      Repository<TaxFlowLogEntity>,
    private readonly redis:           RedisService,
    private readonly dataSource:      DataSource,
  ) {}

  // ─────────────────────────────────────────────────────────
  //  SEZIONE 1 — REGISTRAZIONE E TRASFERIMENTO OWNERSHIP
  // ─────────────────────────────────────────────────────────

  /**
   * Registra un nuovo elemento nel sistema di controllo.
   * Chiamato quando un pianeta viene colonizzato, una flotta creata, ecc.
   */
  async registerEntity(dto: {
    entity_id:   string;
    entity_type: ControllableEntityType;
    owner_id:    string;
    status?:     ControllableStatus;
    tick:        number;
  }): Promise<EntityOwnershipEntity> {
    const existing = await this.ownershipRepo.findOneBy({ entity_id: dto.entity_id });
    if (existing) return existing; // Idempotente

    const record = this.ownershipRepo.create({
      entity_id:    dto.entity_id,
      entity_type:  dto.entity_type,
      owner_id:     dto.owner_id,
      controller_id: dto.owner_id,  // All'inizio owner = controller
      status:       dto.status ?? ControllableStatus.STABLE,
      ownership_history: [{
        tick:       dto.tick,
        event_type: 'OWNER_CHANGED',
        from_empire: null,
        to_empire:  dto.owner_id,
        reason:     'initial_registration',
      }],
      last_updated_tick: dto.tick,
    });

    await this.ownershipRepo.save(record);
    await this.invalidateOwnershipCache(dto.entity_id);
    return record;
  }

  /**
   * Trasferimento definitivo di proprietà (non controllo).
   * Usato per: cessione diplomatica, conquista, acquisto.
   *
   * Regola: il trasferimento di proprietà NON azzera automaticamente
   * le deleghe attive. Il nuovo proprietario eredita le deleghe
   * esistenti e può avviare revoca consensuale.
   */
  async transferOwnership(dto: {
    entity_id:   string;
    from_empire: string;
    to_empire:   string;
    reason:      string;
    tick:        number;
  }): Promise<EntityOwnershipEntity> {
    const record = await this.getOwnershipRecord(dto.entity_id);

    if (record.owner_id !== dto.from_empire) {
      throw new ForbiddenException(
        `${dto.from_empire} does not own entity ${dto.entity_id}`,
      );
    }

    const previousOwner = record.owner_id;
    record.owner_id = dto.to_empire;

    // Se non c'è delega attiva, il controller cambia anch'esso
    if (!record.active_delegation_id) {
      record.controller_id = dto.to_empire;
      record.status        = ControllableStatus.STABLE;
    } else {
      // C'è una delega attiva: il nuovo proprietario è legalmente proprietario
      // ma il controller rimane invariato fino a revoca consensuale.
      // Lo status diventa DELEGATED per riflettere la situazione.
      record.status = ControllableStatus.DELEGATED;
    }

    // Aggiungi al log storico
    record.ownership_history = [
      ...record.ownership_history.slice(-19),  // Mantieni ultimi 20
      {
        tick:        dto.tick,
        event_type:  'OWNER_CHANGED',
        from_empire: previousOwner,
        to_empire:   dto.to_empire,
        reason:      dto.reason,
      },
    ];
    record.last_updated_tick = dto.tick;

    await this.ownershipRepo.save(record);
    await this.invalidateOwnershipCache(dto.entity_id);

    this.logger.log(
      `Ownership transfer: ${dto.entity_id} → ${dto.from_empire} → ${dto.to_empire} (${dto.reason})`,
    );

    return record;
  }

  // ─────────────────────────────────────────────────────────
  //  SEZIONE 2 — DELEGHE
  // ─────────────────────────────────────────────────────────

  /**
   * Crea una nuova delega di controllo.
   * Entrambe le parti devono aver concordato i termini (via proposta diplomatica).
   *
   * Una entità può avere UNA SOLA delega attiva alla volta.
   * Per cambiare controllore bisogna prima revocare quella esistente.
   */
  async createDelegation(dto: {
    entity_id:     string;
    entity_type:   ControllableEntityType;
    owner_id:      string;
    controller_id: string;
    terms:         DelegationAgreementTerms;
    current_tick:  number;
    origin_proposal_id?: string;
  }): Promise<DelegationAgreementEntity> {
    const { entity_id, entity_type, owner_id, controller_id, terms, current_tick } = dto;

    // Verifica che l'empire sia effettivamente il proprietario
    const ownership = await this.getOwnershipRecord(entity_id);
    if (ownership.owner_id !== owner_id) {
      throw new ForbiddenException(`${owner_id} does not own entity ${entity_id}`);
    }

    // Verifica che non ci sia già una delega attiva
    if (ownership.active_delegation_id) {
      throw new BadRequestException(
        `Entity ${entity_id} already has an active delegation (${ownership.active_delegation_id}). Revoke it first.`,
      );
    }

    if (owner_id === controller_id) {
      throw new BadRequestException('Owner and controller cannot be the same empire');
    }

    // Calcola tick apertura finestra rinnovo
    const renewalWindowTick = terms.renewal_terms.auto_renew && terms.duration_ticks
      ? (current_tick + terms.duration_ticks) - terms.renewal_terms.notice_ticks
      : null;

    // Esegui in transazione
    const delegation = await this.dataSource.transaction(async (manager) => {
      const d = manager.create(DelegationAgreementEntity, {
        entity_id,
        entity_type,
        owner_id,
        controller_id,
        terms,
        status:           DelegationStatus.ACTIVE,
        started_at_tick:  current_tick,
        expires_at_tick:  terms.duration_ticks
          ? current_tick + terms.duration_ticks
          : null,
        renewal_window_opens_at: renewalWindowTick,
        origin_proposal_id: dto.origin_proposal_id ?? null,
      });
      await manager.save(DelegationAgreementEntity, d);

      // Aggiorna il record di ownership
      ownership.controller_id         = controller_id;
      ownership.active_delegation_id   = d.id;
      ownership.status                 = ControllableStatus.DELEGATED;
      ownership.last_updated_tick      = current_tick;
      ownership.ownership_history = [
        ...ownership.ownership_history.slice(-19),
        {
          tick:        current_tick,
          event_type:  'DELEGATION_STARTED',
          from_empire: owner_id,
          to_empire:   controller_id,
          reason:      `delegation:${d.id}`,
        },
      ];
      await manager.save(EntityOwnershipEntity, ownership);

      return d;
    });

    await this.invalidateOwnershipCache(entity_id);
    await this.invalidateDelegationCache(delegation.id);

    this.logger.log(
      `Delegation created: ${entity_id} (${entity_type}) | owner=${owner_id} → controller=${controller_id}`,
    );

    return delegation;
  }

  /**
   * Richiede la revoca consensuale di una delega.
   * Chiunque delle due parti può richiederla.
   * L'altra parte ha `notice_ticks` tick per accettare/rifiutare.
   * Se nessuna risposta → la richiesta scade (non auto-revocata).
   */
  async requestRevocation(dto: {
    delegation_id:  string;
    requested_by:   string;
    reason?:        string;
    effective_tick: number;
    compensation?:  Partial<Record<ResourceType, number>>;
    current_tick:   number;
  }): Promise<DelegationAgreementEntity> {
    const del = await this.getDelegationById(dto.delegation_id);

    if (del.owner_id !== dto.requested_by && del.controller_id !== dto.requested_by) {
      throw new ForbiddenException('You are not a party of this delegation');
    }
    if (del.status !== DelegationStatus.ACTIVE) {
      throw new BadRequestException(`Delegation is already ${del.status}`);
    }
    if (del.pending_revocation) {
      throw new BadRequestException('A revocation request is already pending');
    }

    del.status = DelegationStatus.PENDING_REVOCATION;
    del.pending_revocation = {
      requested_by:  dto.requested_by,
      reason:        dto.reason,
      requested_at:  dto.current_tick,
      effective_at:  dto.effective_tick,
      compensation:  dto.compensation,
      status:        'PENDING',
    };

    await this.delegationRepo.save(del);
    await this.invalidateDelegationCache(del.id);

    this.logger.log(
      `Revocation requested for delegation ${del.id} by ${dto.requested_by}`,
    );

    return del;
  }

  /**
   * Risponde a una richiesta di revoca.
   */
  async respondToRevocation(dto: {
    delegation_id: string;
    responded_by:  string;
    accept:        boolean;
    current_tick:  number;
  }): Promise<void> {
    const del = await this.getDelegationById(dto.delegation_id);

    const otherParty = del.pending_revocation?.requested_by === dto.responded_by
      ? null // Chi ha richiesto non può rispondere a se stesso
      : dto.responded_by;

    if (!otherParty) {
      throw new ForbiddenException('The requester cannot respond to their own revocation request');
    }
    if (del.owner_id !== otherParty && del.controller_id !== otherParty) {
      throw new ForbiddenException('You are not a party of this delegation');
    }
    if (!del.pending_revocation || del.pending_revocation.status !== 'PENDING') {
      throw new BadRequestException('No pending revocation request');
    }

    if (dto.accept) {
      del.pending_revocation.status     = 'ACCEPTED';
      del.pending_revocation.responded_at = dto.current_tick;

      // Esegui revoca a partire da effective_at
      if (dto.current_tick >= del.pending_revocation.effective_at) {
        await this.executeDelegationEnd(del, 'REVOKED', dto.current_tick);
      } else {
        // Revoca schedulata: verrà eseguita dal tick phase quando
        // current_tick >= effective_at
        del.status = DelegationStatus.PENDING_REVOCATION;
        await this.delegationRepo.save(del);
      }
    } else {
      del.pending_revocation.status     = 'REJECTED';
      del.pending_revocation.responded_at = dto.current_tick;
      del.status = DelegationStatus.ACTIVE; // Torna attiva
      await this.delegationRepo.save(del);
    }

    await this.invalidateDelegationCache(del.id);
  }

  /**
   * Modifica i termini di una delega attiva tramite accordo bilaterale.
   * Crea una nuova delega che supersede la precedente.
   */
  async amendDelegation(dto: {
    delegation_id:  string;
    requested_by:   string;
    new_terms:      DelegationAgreementTerms;
    current_tick:   number;
  }): Promise<DelegationAgreementEntity> {
    const old = await this.getDelegationById(dto.delegation_id);

    if (old.owner_id !== dto.requested_by && old.controller_id !== dto.requested_by) {
      throw new ForbiddenException('You are not a party of this delegation');
    }

    // La modifica proposta deve essere accettata dall'altra parte.
    // Qui usiamo il sistema di approval come canale di negoziazione.
    // Semplificato: crea una nuova delega e supersede la vecchia.
    old.status = DelegationStatus.SUPERSEDED;
    await this.delegationRepo.save(old);

    const newDel = await this.createDelegation({
      entity_id:     old.entity_id,
      entity_type:   old.entity_type,
      owner_id:      old.owner_id,
      controller_id: old.controller_id,
      terms:         dto.new_terms,
      current_tick:  dto.current_tick,
    });
    newDel.supersedes_delegation_id = old.id;
    await this.delegationRepo.save(newDel);

    return newDel;
  }

  // ─────────────────────────────────────────────────────────
  //  SEZIONE 3 — PERMISSION CHECK
  //  Punto di ingresso unico per validare ogni azione
  // ─────────────────────────────────────────────────────────

  /**
   * Verifica se `empire_id` può eseguire `action` su `entity_id`.
   *
   * Logica di risoluzione:
   *   1. Il proprietario può SEMPRE fare qualsiasi cosa
   *   2. Il controllore può fare quanto consentito dalla delega
   *   3. Empire terzi hanno solo permessi espliciti (es. transito da trattato)
   *   4. Se richiede approvazione → crea ApprovalRequest e ritorna requires_approval: true
   */
  async checkPermission(dto: {
    empire_id:     string;
    entity_id:     string;
    action:        ControlAction;
    context?:      Record<string, any>;
    current_tick:  number;
  }): Promise<PermissionCheckResult> {
    const { empire_id, entity_id, action, context, current_tick } = dto;

    const ownership = await this.getOwnershipCached(entity_id);
    if (!ownership) {
      return { allowed: false, reason: 'Entity not found in ownership registry' };
    }

    // ── 1. Il proprietario ha tutti i diritti ──
    if (ownership.owner_id === empire_id) {
      return { allowed: true };
    }

    // ── 2. Il controllore ha i diritti della delega ──
    if (ownership.controller_id === empire_id && ownership.active_delegation_id) {
      const delegation = await this.getDelegationCached(ownership.active_delegation_id);
      if (!delegation || delegation.status !== DelegationStatus.ACTIVE) {
        return { allowed: false, reason: 'Delegation is no longer active' };
      }

      const result = this.evaluatePermission(action, delegation.terms, context);

      // Se richiede approvazione → crea richiesta
      if (result.requires_approval) {
        const approvalReq = await this.createApprovalRequest({
          delegation_id: delegation.id,
          entity_id,
          owner_id:     ownership.owner_id ?? '',
          controller_id: empire_id,
          action,
          context:      context ?? {},
          current_tick,
        });
        return { ...result, approval_request_id: approvalReq.id };
      }

      return result;
    }

    // ── 3. Empire senza relazione diretta ──
    // Unica eccezione: TRANSIT_FLEET se c'è un trattato di accesso militare
    // (gestito dal DiplomacyService — qui si nega per default)
    if (action === ControlAction.TRANSIT_FLEET) {
      // Il DiplomacyService sovrascriverà questo risultato se c'è un trattato
      return { allowed: false, reason: 'No transit rights. Request military access treaty.' };
    }

    return {
      allowed: false,
      reason: `${empire_id} has no ownership or delegated control over entity ${entity_id}`,
    };
  }

  /**
   * Valuta un'azione specifica contro la DelegationPermissions.
   */
  private evaluatePermission(
    action:  ControlAction,
    terms:   DelegationAgreementTerms,
    context?: Record<string, any>,
  ): PermissionCheckResult {
    const p = terms.permissions;
    const requiresApproval = (actionKey: string) =>
      p.political.requires_owner_approval.includes(actionKey);

    switch (action) {
      case ControlAction.STATION_FLEET:
        if (!p.military.can_station_fleets) return { allowed: false, reason: 'No fleet stationing rights' };
        if (p.military.max_fleet_size !== null) {
          const fleetSize = context?.fleet_size ?? 0;
          if (fleetSize > p.military.max_fleet_size) {
            return { allowed: false, reason: `Fleet size ${fleetSize} exceeds limit ${p.military.max_fleet_size}` };
          }
        }
        return { allowed: true };

      case ControlAction.ATTACK_FROM:
        if (!p.military.can_attack_from) return { allowed: false, reason: 'No attack rights from this entity' };
        if (requiresApproval('attack_from')) return { allowed: true, requires_approval: true };
        return { allowed: true };

      case ControlAction.DEFEND:
        if (!p.military.can_defend) return { allowed: false, reason: 'No defense rights' };
        return { allowed: true };

      case ControlAction.TRANSIT_FLEET:
        if (!p.military.can_transit) return { allowed: false, reason: 'No transit rights' };
        return { allowed: true };

      case ControlAction.RECRUIT_ARMY:
        if (!p.military.can_recruit_armies) return { allowed: false, reason: 'No army recruitment rights' };
        if (requiresApproval('recruit_armies')) return { allowed: true, requires_approval: true };
        return { allowed: true };

      case ControlAction.EXTRACT_RESOURCES:
        if (!p.economic.can_extract_resources) return { allowed: false, reason: 'No resource extraction rights' };
        return { allowed: true };

      case ControlAction.BUILD_STRUCTURE:
        if (!p.economic.can_build_structures) return { allowed: false, reason: 'No building rights' };
        if (requiresApproval('build_structures')) return { allowed: true, requires_approval: true };
        return { allowed: true };

      case ControlAction.ACCESS_BUILDING:
        return this.checkBuildingAccess(p.economic.can_access_buildings, context?.building_type);

      case ControlAction.CREATE_TRADE_ROUTE:
        if (!p.economic.can_use_trade_routes) return { allowed: false, reason: 'No trade route rights' };
        return { allowed: true };

      case ControlAction.COLLECT_INCOME:
        if (!p.economic.can_collect_income) return { allowed: false, reason: 'Income goes to owner under this delegation' };
        return { allowed: true };

      case ControlAction.COLONIZE:
        if (!p.political.can_colonize) return { allowed: false, reason: 'No colonization rights' };
        if (requiresApproval('colonize')) return { allowed: true, requires_approval: true };
        return { allowed: true };

      case ControlAction.MODIFY_LAWS:
        if (!p.political.can_modify_laws) return { allowed: false, reason: 'No law modification rights' };
        return { allowed: true };

      case ControlAction.SUB_DELEGATE:
        if (!p.political.can_sub_delegate) return { allowed: false, reason: 'Sub-delegation not permitted in this agreement' };
        return { allowed: true };

      case ControlAction.TRANSFER_OWNERSHIP:
        // Solo il proprietario può trasferire proprietà (mai il controllore)
        return { allowed: false, reason: 'Only the owner can transfer ownership' };

      default:
        return { allowed: false, reason: `Unknown action: ${action}` };
    }
  }

  private checkBuildingAccess(allowList: AllowList, buildingType?: string): PermissionCheckResult {
    if (allowList === 'ALL')  return { allowed: true };
    if (allowList === 'NONE') return { allowed: false, reason: 'No building access rights' };
    if (!buildingType)        return { allowed: false, reason: 'Building type not specified' };
    if ((allowList as string[]).includes(buildingType)) return { allowed: true };
    return { allowed: false, reason: `Access to building type "${buildingType}" not permitted` };
  }

  // ─────────────────────────────────────────────────────────
  //  SEZIONE 4 — APPROVAL REQUESTS
  // ─────────────────────────────────────────────────────────

  async createApprovalRequest(dto: {
    delegation_id:  string;
    entity_id:      string;
    owner_id:       string;
    controller_id:  string;
    action:         ControlAction;
    context:        Record<string, any>;
    current_tick:   number;
  }): Promise<ApprovalRequestEntity> {
    const req = this.approvalRepo.create({
      ...dto,
      status:          'PENDING',
      created_at_tick: dto.current_tick,
      expires_at_tick: dto.current_tick + 10,
    });
    await this.approvalRepo.save(req);

    // Notifica il proprietario via Redis
    await this.redis.publishEmpireDelta(dto.owner_id, {
      tick: dto.current_tick,
      approval_requests: [req],
    });

    return req;
  }

  async respondToApproval(dto: {
    request_id:   string;
    owner_id:     string;
    approved:     boolean;
    response?:    string;
    current_tick: number;
  }): Promise<ApprovalRequestEntity> {
    const req = await this.approvalRepo.findOneBy({ id: dto.request_id });
    if (!req) throw new NotFoundException('Approval request not found');
    if (req.owner_id !== dto.owner_id) throw new ForbiddenException('Not your request');
    if (req.status !== 'PENDING') throw new BadRequestException(`Request already ${req.status}`);

    req.status        = dto.approved ? 'APPROVED' : 'REJECTED';
    req.owner_response = dto.response ?? null;
    await this.approvalRepo.save(req);

    // Notifica il controllore
    await this.redis.publishEmpireDelta(req.controller_id, {
      tick: dto.current_tick,
      approval_responses: [{
        request_id: req.id,
        action:     req.action,
        entity_id:  req.entity_id,
        approved:   dto.approved,
        response:   dto.response,
      }],
    });

    return req;
  }

  // ─────────────────────────────────────────────────────────
  //  SEZIONE 5 — TAX FLOW
  // ─────────────────────────────────────────────────────────

  /**
   * Calcola e applica il flusso fiscale per una delega attiva.
   * Chiamato dal DelegationTickPhase per ogni delega ACTIVE.
   */
  async processTaxFlow(
    delegation: DelegationAgreementEntity,
    produced:   Partial<Record<ResourceType, number>>,
    tick:       number,
  ): Promise<TaxFlowSnapshot> {
    const tax = delegation.terms.tax_terms;
    const ownerShare:      Partial<Record<ResourceType, number>> = {};
    const controllerShare: Partial<Record<ResourceType, number>> = {};
    const shortfall:       Partial<Record<ResourceType, number>> = {};
    let minimumMet = true;

    for (const res of Object.values(ResourceType) as ResourceType[]) {
      const amount = (produced as Record<string, number>)[res] ?? 0;
      if (amount === 0) continue;

      let ownerRate: number;
      if (tax.mode === 'OWNER_TAXES_CONTROLLER') {
        ownerRate = (tax.rates as Record<string, number>)[res] ?? tax.default_rate;
      } else {
        // CONTROLLER_PAYS_OWNER: il controllore paga una quota fissa
        ownerRate = (tax.rates as Record<string, number>)[res] ?? tax.default_rate;
      }

      ownerRate = Math.max(0, Math.min(1, ownerRate));

      const ownerAmt      = Math.floor(amount * ownerRate);
      const controllerAmt = amount - ownerAmt;

      ownerShare[res]      = ownerAmt;
      controllerShare[res] = controllerAmt;

      // Verifica minimo garantito
      const minGuaranteed = (tax.minimum_guaranteed as Record<string, number>)?.[res] ?? 0;
      if (ownerAmt < minGuaranteed) {
        shortfall[res] = minGuaranteed - ownerAmt;
        minimumMet     = false;
      }
    }

    // Distribuisci le risorse sulle pool Redis
    await this.distributeResources(
      delegation.owner_id, delegation.controller_id,
      ownerShare, controllerShare,
    );

    // Log
    const snapshot: TaxFlowSnapshot = {
      delegation_id:    delegation.id,
      tick,
      produced,
      owner_share:      ownerShare,
      controller_share: controllerShare,
      shortfall,
    };

    const log = this.taxLogRepo.create({
      delegation_id:   delegation.id,
      entity_id:       delegation.entity_id,
      owner_id:        delegation.owner_id,
      controller_id:   delegation.controller_id,
      tick,
      produced,
      owner_share:     ownerShare,
      controller_share: controllerShare,
      shortfall,
      minimum_met:     minimumMet,
    });
    await this.taxLogRepo.save(log);

    delegation.last_tax_flow = snapshot;
    await this.delegationRepo.save(delegation);

    return snapshot;
  }

  // ─────────────────────────────────────────────────────────
  //  SEZIONE 6 — BREACH DETECTION
  // ─────────────────────────────────────────────────────────

  async checkBreachConditions(
    delegation: DelegationAgreementEntity,
    tick:       number,
    context:    Record<string, any>,
  ): Promise<BreachEvent | null> {
    const conditions = delegation.terms.breach_conditions ?? [];

    for (const condition of conditions) {
      const triggered = await this.evaluateBreachCondition(
        condition, delegation, tick, context,
      );
      if (!triggered) continue;

      delegation.breach_count += 1;
      const event: BreachEvent = {
        delegation_id: delegation.id,
        entity_id:     delegation.entity_id,
        breacher_id:   delegation.controller_id,
        condition:     condition.type,
        description:   this.breachDescription(condition.type),
        auto_revoked:  condition.immediate || delegation.breach_count >= 3,
      };

      if (event.auto_revoked) {
        await this.executeDelegationEnd(delegation, 'BROKEN', tick);
      } else {
        await this.delegationRepo.save(delegation);
        // Notifica proprietario: ha 10 tick per agire
        await this.redis.publishEmpireDelta(delegation.owner_id, {
          tick,
          breach_events: [event],
        });
      }

      return event;
    }
    return null;
  }

  private async evaluateBreachCondition(
    condition:  any,
    delegation: DelegationAgreementEntity,
    tick:       number,
    context:    Record<string, any>,
  ): Promise<boolean> {
    switch (condition.type as BreachConditionType) {
      case BreachConditionType.TAX_NOT_PAID:
        return (delegation.last_tax_flow?.shortfall &&
          Object.values(delegation.last_tax_flow.shortfall).some(v => (v ?? 0) > 0)) ?? false;

      case BreachConditionType.FLEET_LIMIT_EXCEEDED:
        return (context.current_fleet_size ?? 0) >
          (delegation.terms.permissions.military.max_fleet_size ?? Infinity);

      case BreachConditionType.LOYALTY_BELOW:
        return (context.current_loyalty ?? 100) < (condition.threshold ?? 20);

      default:
        return false;
    }
  }

  // ─────────────────────────────────────────────────────────
  //  SEZIONE 7 — FINE DELEGA
  // ─────────────────────────────────────────────────────────

  async executeDelegationEnd(
    delegation: DelegationAgreementEntity,
    endStatus:  'EXPIRED' | 'REVOKED' | 'BROKEN',
    tick:       number,
  ): Promise<void> {
    delegation.status = endStatus as DelegationStatus;
    await this.delegationRepo.save(delegation);

    // Ripristina owner come controller
    const ownership = await this.getOwnershipRecord(delegation.entity_id);
    ownership.controller_id         = ownership.owner_id;
    ownership.active_delegation_id  = null;
    ownership.status                = ControllableStatus.STABLE;
    ownership.last_updated_tick     = tick;
    ownership.ownership_history = [
      ...ownership.ownership_history.slice(-19),
      {
        tick,
        event_type:  'DELEGATION_ENDED',
        from_empire: delegation.controller_id,
        to_empire:   ownership.owner_id,
        reason:      `delegation_${endStatus.toLowerCase()}:${delegation.id}`,
      },
    ];
    await this.ownershipRepo.save(ownership);

    await this.invalidateOwnershipCache(delegation.entity_id);
    await this.invalidateDelegationCache(delegation.id);

    this.logger.log(
      `Delegation ${delegation.id} ended (${endStatus}): ${delegation.entity_id} ` +
      `controller reverted to owner ${ownership.owner_id}`,
    );
  }

  // ─────────────────────────────────────────────────────────
  //  SEZIONE 8 — QUERY
  // ─────────────────────────────────────────────────────────

  async getOwnerOf(entityId: string): Promise<string | null> {
    const cached = await this.redis.getJson<string>(`entity:owner:${entityId}`);
    if (cached !== null) return cached;
    const r = await this.ownershipRepo.findOneBy({ entity_id: entityId });
    if (r?.owner_id) await this.redis.setJson(`entity:owner:${entityId}`, r.owner_id, 30);
    return r?.owner_id ?? null;
  }

  async getControllerOf(entityId: string): Promise<string | null> {
    const cached = await this.redis.getJson<string>(`entity:controller:${entityId}`);
    if (cached !== null) return cached;
    const r = await this.ownershipRepo.findOneBy({ entity_id: entityId });
    if (r?.controller_id) await this.redis.setJson(`entity:controller:${entityId}`, r.controller_id, 30);
    return r?.controller_id ?? null;
  }

  /** Tutti gli elementi posseduti da un empire */
  async getOwnedEntities(
    empireId: string, type?: ControllableEntityType,
  ): Promise<EntityOwnershipEntity[]> {
    const query = this.ownershipRepo.createQueryBuilder('o')
      .where('o.owner_id = :empireId', { empireId });
    if (type) query.andWhere('o.entity_type = :type', { type });
    return query.getMany();
  }

  /** Tutti gli elementi CONTROLLATI (non posseduti) da un empire */
  async getControlledEntities(
    empireId: string, type?: ControllableEntityType,
  ): Promise<EntityOwnershipEntity[]> {
    return this.ownershipRepo.createQueryBuilder('o')
      .where('o.controller_id = :empireId', { empireId })
      .andWhere('o.owner_id != :empireId', { empireId })
      .andWhere(type ? 'o.entity_type = :type' : '1=1', type ? { type } : {})
      .getMany();
  }

  /** Tutte le deleghe attive di un empire (come owner o controller) */
  async getActiveDelegations(empireId: string): Promise<DelegationAgreementEntity[]> {
    return this.delegationRepo.createQueryBuilder('d')
      .where('(d.owner_id = :e OR d.controller_id = :e)', { e: empireId })
      .andWhere('d.status = :s', { s: DelegationStatus.ACTIVE })
      .getMany();
  }

  async getDelegationById(id: string): Promise<DelegationAgreementEntity> {
    const d = await this.delegationRepo.findOneBy({ id });
    if (!d) throw new NotFoundException(`Delegation ${id} not found`);
    return d;
  }

  // ─────────────────────────────────────────────────────────
  //  Helpers interni
  // ─────────────────────────────────────────────────────────

  private async getOwnershipRecord(entityId: string): Promise<EntityOwnershipEntity> {
    const r = await this.ownershipRepo.findOneBy({ entity_id: entityId });
    if (!r) throw new NotFoundException(`Entity ${entityId} not found in ownership registry`);
    return r;
  }

  private async getOwnershipCached(entityId: string): Promise<EntityOwnershipEntity | null> {
    const key = `ownership:${entityId}`;
    const cached = await this.redis.getJson<EntityOwnershipEntity>(key);
    if (cached) return cached;
    const r = await this.ownershipRepo.findOneBy({ entity_id: entityId });
    if (r) await this.redis.setJson(key, r, CACHE_TTL.OWNERSHIP);
    return r;
  }

  private async getDelegationCached(delId: string): Promise<DelegationAgreementEntity | null> {
    const key = `delegation:${delId}`;
    const cached = await this.redis.getJson<DelegationAgreementEntity>(key);
    if (cached) return cached;
    const d = await this.delegationRepo.findOneBy({ id: delId });
    if (d) await this.redis.setJson(key, d, CACHE_TTL.DELEGATION);
    return d;
  }

  private async invalidateOwnershipCache(entityId: string): Promise<void> {
    await this.redis.invalidate(
      `ownership:${entityId}`,
      `entity:owner:${entityId}`,
      `entity:controller:${entityId}`,
    );
  }

  private async invalidateDelegationCache(delId: string): Promise<void> {
    await this.redis.invalidate(`delegation:${delId}`);
  }

  private async distributeResources(
    ownerId:      string,
    controllerId: string,
    ownerShare:   Partial<Record<ResourceType, number>>,
    ctrlShare:    Partial<Record<ResourceType, number>>,
  ): Promise<void> {
    for (const [empireId, share] of [[ownerId, ownerShare], [controllerId, ctrlShare]] as const) {
      const pool = await this.redis.getJson<ResourceStock>(`empire:${empireId}:resources`);
      if (!pool) continue;
      for (const [res, amount] of Object.entries(share)) {
        pool[res as ResourceType] = (pool[res as ResourceType] ?? 0) + (amount as number);
      }
      await this.redis.setJson(`empire:${empireId}:resources`, pool);
    }
  }

  private breachDescription(type: BreachConditionType): string {
    const map: Record<BreachConditionType, string> = {
      [BreachConditionType.TAX_NOT_PAID]:         'Tasse non pagate: il minimo garantito non è stato rispettato.',
      [BreachConditionType.UNAUTHORIZED_ATTACK]:  'Attacco non autorizzato dal territorio delegato.',
      [BreachConditionType.FLEET_LIMIT_EXCEEDED]: 'Limite navi superato nel territorio delegato.',
      [BreachConditionType.UNAUTHORIZED_BUILD]:   'Costruzione non autorizzata nel territorio delegato.',
      [BreachConditionType.LOYALTY_BELOW]:        'Loyalty crollata sotto la soglia minima concordata.',
    };
    return map[type] ?? 'Violazione dei termini della delega.';
  }
}
