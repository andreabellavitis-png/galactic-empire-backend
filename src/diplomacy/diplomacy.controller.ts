// ============================================================
//  DIPLOMACY CONTROLLER — REST API
//  Tutti gli endpoint che un giocatore può chiamare per
//  interagire col sistema diplomatico.
//
//  Base path: /diplomacy
//
//  Autenticazione: JWT guard (empire_id estratto dal token)
//  Rate limiting: consigliato max 10 req/s per empire
// ============================================================

import {
  Controller, Get, Post, Delete, Param,
  Body, Req, UseGuards, HttpCode, HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard }    from '../auth/jwt-auth.guard'; // tuo guard JWT
import { CurrentEmpire }   from '../auth/current-empire.decorator';
import { DiplomacyService } from './diplomacy.service';
import { InfluenceService } from '../influence/influence.service';
import { SpyService }       from '../spy/spy.service';
import { RedisService }     from '../redis/redis.service';

import {
  ProposalType, TreatyType, CasusBelli,
  InfluenceActionType, SpyOperationType,
} from './diplomacy.types';

// ─────────────────────────────────────────────────────────────
//  DTOs (semplificati — in produzione aggiungere class-validator)
// ─────────────────────────────────────────────────────────────

interface SendProposalDto {
  to_empire_id:  string;
  type:          ProposalType;
  payload:       Record<string, any>;  // Dipende dal tipo
  message?:      string;
}

interface RespondProposalDto {
  action:           'ACCEPT' | 'REJECT';
  response_message?: string;
}

interface DeclareWarDto {
  target_empire_id: string;
  casus_belli:      CasusBelli;
  war_goals?:       Array<{ type: string; target_id: string }>;
}

interface OfferPeaceDto {
  war_id:   string;
  to_empire: string;
  terms:    Record<string, any>;
  message?: string;
}

interface StartInfluenceActionDto {
  target_id:      string;
  target_type:    'SYSTEM' | 'PLANET';
  action_type:    InfluenceActionType;
  duration_ticks?: number;
}

interface LaunchSpyOpDto {
  target_empire_id:    string;
  type:                SpyOperationType;
  target_entity_id?:   string;
  target_entity_type?: string;
  agents_assigned?:    number;
}

// ─────────────────────────────────────────────────────────────
//  CONTROLLER
// ─────────────────────────────────────────────────────────────

@Controller('diplomacy')
@UseGuards(JwtAuthGuard)
export class DiplomacyController {
  constructor(
    private readonly diplomacy:  DiplomacyService,
    private readonly influence:  InfluenceService,
    private readonly spy:        SpyService,
    private readonly redis:      RedisService,
  ) {}

  // ─── Visione globale relazioni ────────────────────────────

  /**
   * GET /diplomacy/relations
   * Tutte le relazioni diplomatiche dell'empire corrente.
   * Include status, trust e trattati attivi per ogni coppia.
   */
  @Get('relations')
  async getRelations(@CurrentEmpire() empireId: string) {
    return this.diplomacy.getAllRelations(empireId);
  }

  /**
   * GET /diplomacy/relations/:targetEmpireId
   * Relazione specifica con un empire.
   */
  @Get('relations/:targetEmpireId')
  async getRelation(
    @CurrentEmpire() empireId: string,
    @Param('targetEmpireId') targetId: string,
  ) {
    return this.diplomacy.getOrCreateRelation(empireId, targetId);
  }

  // ─── Proposte ─────────────────────────────────────────────

  /**
   * GET /diplomacy/proposals
   * Tutte le proposte pending (inviate e ricevute).
   */
  @Get('proposals')
  async getProposals(@CurrentEmpire() empireId: string) {
    return this.diplomacy.getPendingProposals(empireId);
  }

  /**
   * POST /diplomacy/proposals
   * Invia una proposta diplomatica a un altro empire.
   *
   * Esempi di payload per tipo:
   *
   * TREATY:
   *   { treaty_type: "NON_AGGRESSION", terms: [], duration_ticks: 100 }
   *
   * TERRITORY_DEAL:
   *   { from_empire: "id1", to_empire: "id2", planet_ids: ["p1"], price_credits: 500 }
   *
   * VASSAL_OFFER:
   *   { overlord_id: "id1", vassal_id: "id2", tribute_type: "CREDITS",
   *     tribute_amount: 50, protection: true, autonomy: 60 }
   *
   * PEACE_OFFER:
   *   { war_id: "w1", terms: { planet_ids: [], from_empire: "id1", to_empire: "id2" } }
   */
  @Post('proposals')
  async sendProposal(
    @CurrentEmpire() empireId: string,
    @Body() dto: SendProposalDto,
  ) {
    const tick = await this.redis.getCurrentTick();
    return this.diplomacy.sendProposal({
      from_empire_id: empireId,
      to_empire_id:   dto.to_empire_id,
      type:           dto.type,
      payload:        dto.payload,
      message:        dto.message,
      current_tick:   tick,
    });
  }

  /**
   * POST /diplomacy/proposals/:proposalId/respond
   * Accetta o rifiuta una proposta ricevuta.
   */
  @Post('proposals/:proposalId/respond')
  @HttpCode(HttpStatus.OK)
  async respondToProposal(
    @CurrentEmpire() empireId: string,
    @Param('proposalId') proposalId: string,
    @Body() dto: RespondProposalDto,
  ) {
    const tick = await this.redis.getCurrentTick();
    if (dto.action === 'ACCEPT') {
      await this.diplomacy.acceptProposal({
        proposal_id:      proposalId,
        empire_id:        empireId,
        current_tick:     tick,
        response_message: dto.response_message,
      });
      return { status: 'accepted' };
    } else {
      await this.diplomacy.rejectProposal({
        proposal_id:      proposalId,
        empire_id:        empireId,
        current_tick:     tick,
        response_message: dto.response_message,
      });
      return { status: 'rejected' };
    }
  }

  /**
   * DELETE /diplomacy/proposals/:proposalId
   * Ritira una proposta che hai inviato (solo se ancora PENDING).
   */
  @Delete('proposals/:proposalId')
  @HttpCode(HttpStatus.OK)
  async retractProposal(
    @CurrentEmpire() empireId: string,
    @Param('proposalId') proposalId: string,
  ) {
    const proposals = await this.diplomacy.getPendingProposals(empireId);
    const p = proposals.find(x => x.id === proposalId && x.from_empire_id === empireId);
    if (!p) throw new BadRequestException('Proposal not found or not yours');
    // In produzione: aggiungere metodo retractProposal nel service
    return { status: 'retracted' };
  }

  // ─── Trattati ─────────────────────────────────────────────

  /**
   * GET /diplomacy/treaties
   * Tutti i trattati attivi dell'empire.
   */
  @Get('treaties')
  async getTreaties(@CurrentEmpire() empireId: string) {
    return this.diplomacy.getActiveTreaties(empireId);
  }

  /**
   * DELETE /diplomacy/treaties/:treatyId
   * Revoca un trattato (con preavviso min_notice_ticks).
   */
  @Delete('treaties/:treatyId')
  @HttpCode(HttpStatus.OK)
  async cancelTreaty(
    @CurrentEmpire() empireId: string,
    @Param('treatyId') treatyId: string,
  ) {
    const tick = await this.redis.getCurrentTick();
    return this.diplomacy.cancelTreaty({
      treaty_id:    treatyId,
      empire_id:    empireId,
      current_tick: tick,
    });
  }

  // ─── Guerra ───────────────────────────────────────────────

  /**
   * GET /diplomacy/wars
   * Guerre attive che coinvolgono l'empire.
   */
  @Get('wars')
  async getWars(@CurrentEmpire() empireId: string) {
    return this.diplomacy.getActiveWars(empireId);
  }

  /**
   * POST /diplomacy/wars
   * Dichiara guerra a un empire.
   *
   * Body: { target_empire_id, casus_belli, war_goals? }
   *
   * Casus belli disponibili:
   *   TERRITORIAL_CLAIM, BROKEN_TREATY, AGGRESSION,
   *   LIBERATION, EXPANSION, VASSAL_REVOLT, JOINT_WAR
   */
  @Post('wars')
  async declareWar(
    @CurrentEmpire() empireId: string,
    @Body() dto: DeclareWarDto,
  ) {
    const tick = await this.redis.getCurrentTick();
    return this.diplomacy.declareWar({
      attacker_id:     empireId,
      defender_id:     dto.target_empire_id,
      casus_belli:     dto.casus_belli,
      war_goals:       dto.war_goals,
      current_tick:    tick,
    });
  }

  /**
   * POST /diplomacy/wars/:warId/peace
   * Invia un'offerta di pace durante una guerra.
   */
  @Post('wars/:warId/peace')
  async offerPeace(
    @CurrentEmpire() empireId: string,
    @Param('warId') warId: string,
    @Body() dto: OfferPeaceDto,
  ) {
    const tick = await this.redis.getCurrentTick();
    return this.diplomacy.offerPeace({
      from_empire_id: empireId,
      to_empire_id:   dto.to_empire,
      war_id:         warId,
      terms:          dto.terms,
      message:        dto.message,
      current_tick:   tick,
    });
  }

  // ─── Influenza ─────────────────────────────────────────────

  /**
   * GET /diplomacy/influence/:targetId
   * Mappa di influenza per un sistema o pianeta.
   */
  @Get('influence/:targetId')
  async getInfluenceMap(@Param('targetId') targetId: string) {
    return this.influence.getInfluenceMap(targetId);
  }

  /**
   * POST /diplomacy/influence/actions
   * Avvia un'azione attiva di influenza.
   *
   * Body: { target_id, target_type, action_type, duration_ticks? }
   *
   * Tipi azione:
   *   CULTURAL_MISSION (2.5/tick, 15cr/tick)
   *   PROPAGANDA (1.8/tick, 20cr/tick) → -loyalty al proprietario
   *   DIPLOMATIC_MISSION (3.0/tick, 25cr/tick)
   *   ECONOMIC_INVESTMENT (2.0/tick, 30cr/tick) → +produzione
   *   AGENT_NETWORK (1.2/tick, 10cr/tick) → passivo continuo
   */
  @Post('influence/actions')
  async startInfluenceAction(
    @CurrentEmpire() empireId: string,
    @Body() dto: StartInfluenceActionDto,
  ) {
    const tick = await this.redis.getCurrentTick();
    return this.influence.startInfluenceAction({
      empire_id:     empireId,
      target_id:     dto.target_id,
      target_type:   dto.target_type,
      action_type:   dto.action_type,
      duration_ticks: dto.duration_ticks,
      current_tick:  tick,
    });
  }

  /**
   * DELETE /diplomacy/influence/actions/:actionId
   * Interrompe un'azione di influenza attiva.
   */
  @Delete('influence/actions/:actionId')
  @HttpCode(HttpStatus.OK)
  async stopInfluenceAction(
    @CurrentEmpire() empireId: string,
    @Param('actionId') actionId: string,
  ) {
    await this.influence.stopInfluenceAction(actionId, empireId);
    return { status: 'stopped' };
  }

  // ─── Spionaggio ────────────────────────────────────────────

  /**
   * GET /diplomacy/spy/operations
   * Operazioni spy attive e in preparazione.
   */
  @Get('spy/operations')
  async getSpyOps(@CurrentEmpire() empireId: string) {
    return this.spy.getActiveOperations(empireId);
  }

  /**
   * POST /diplomacy/spy/operations
   * Lancia un'operazione di spionaggio.
   *
   * Body: { target_empire_id, type, target_entity_id?, agents_assigned? }
   *
   * Tipi op:
   *   GATHER_INTELLIGENCE  (economica, alta success)
   *   PLANT_AGENT          (intel continua)
   *   SABOTAGE_BUILDING    (distrugge edificio)
   *   SABOTAGE_FLEET       (-20% hull e scudi)
   *   STEAL_TECHNOLOGY     (+research)
   *   INCITE_REBELLION     (-loyalty pianeta)
   *   ASSASSINATE_LEADER   (-30 morale su tutti i pianeti, alto rischio)
   *   COUNTER_INTELLIGENCE (difensivo, continuo)
   */
  @Post('spy/operations')
  async launchSpyOp(
    @CurrentEmpire() empireId: string,
    @Body() dto: LaunchSpyOpDto,
  ) {
    const tick = await this.redis.getCurrentTick();
    return this.spy.launchOperation({
      attacker_empire_id:  empireId,
      target_empire_id:    dto.target_empire_id,
      type:                dto.type,
      target_entity_id:    dto.target_entity_id,
      target_entity_type:  dto.target_entity_type,
      agents_assigned:     dto.agents_assigned,
      current_tick:        tick,
    });
  }
}


// ============================================================
//  DIPLOMACY MODULE
// ============================================================

import { Module }         from '@nestjs/common';
import { TypeOrmModule }  from '@nestjs/typeorm';
import { JwtModule }      from '@nestjs/jwt';

// Services
import { DiplomacyTickPhase } from './diplomacy-tick.phase';

// Entities (diplomacy-specific)
import {
  DiplomaticRelationEntity, DiplomaticProposalEntity,
  TreatyEntity, WarEntity, VassalAgreementEntity,
  SpyOperationEntity, InfluenceRecordEntity, InfluenceActionEntity,
} from './diplomacy.entities';

// Entities (core — già definite nel TickEngine module)
import { EmpireEntity }        from '../entities/empire.entity';
import { CelestialBodyEntity } from '../entities/celestial-body.entity';
import { StarSystemEntity }    from '../entities/star-system.entity';
import { FleetEntity }         from '../entities/fleet.entity';


@Module({
  imports: [
    TypeOrmModule.forFeature([
      // Diplomacy entities
      DiplomaticRelationEntity,
      DiplomaticProposalEntity,
      TreatyEntity,
      WarEntity,
      VassalAgreementEntity,
      SpyOperationEntity,
      InfluenceRecordEntity,
      InfluenceActionEntity,
      // Core entities (read-only da diplomacy)
      EmpireEntity,
      CelestialBodyEntity,
      StarSystemEntity,
      FleetEntity,
    ]),
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env.JWT_SECRET ?? 'change-me',
      }),
    }),
  ],
  providers: [
    RedisService,
    DiplomacyService,
    InfluenceService,
    SpyService,
    DiplomacyTickPhase,
  ],
  controllers: [DiplomacyController],
  exports: [
    DiplomacyService,
    DiplomacyTickPhase,
    InfluenceService,
    SpyService,
  ],
})
export class DiplomacyModule {}


// ============================================================
//  INTEGRAZIONE CON TICK ENGINE
//  Nel tick-engine.service.ts, aggiungi DiplomacyTickPhase
//  come fase opzionale tra PROCESS_EVENTS e UPDATE_RESEARCH:
//
//  { name: 'DIPLOMACY',    fn: () => this.diplomacyTickPhase.execute(tick) },
//
//  E nel tick-engine.module.ts:
//  imports: [..., DiplomacyModule]
//  providers: [..., DiplomacyTickPhase]
// ============================================================
