// ============================================================
//  DIPLOMACY TICK PHASE
//  Si inserisce nel TickEngine come estensione della fase 9
//  (ProcessEvents). Esegue ogni tick:
//
//  1. Scade proposte non risposte
//  2. Scade trattati (expires_at_tick raggiunto)
//  3. Esegue termini periodici dei trattati (pagamenti, trasferimenti)
//  4. Aggiorna war score delle guerre attive
//  5. Risolve operazioni spy
//  6. Aggiorna influenza passiva e attiva
//  7. Esegue tributi vassallaggio
//  8. Pubblica delta diplomatici via Redis
// ============================================================

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository }   from '@nestjs/typeorm';
import { Repository, In }     from 'typeorm';

import { RedisService }      from '../redis/redis.service';
import { ResourceType, ResourceStock } from '../common/game.types';

import {
  TreatyStatus, TreatyTermType, DiplomacyStatus,
  ProposalStatus, TrustModifierSource,
  DiplomacyDelta, TreatyUpdate, WarUpdate,
} from './diplomacy.types';

import {
  DiplomaticRelationEntity, DiplomaticProposalEntity,
  TreatyEntity, WarEntity, VassalAgreementEntity,
} from './diplomacy.entities';

import { DiplomacyService } from './diplomacy.service';
import { InfluenceService } from '../influence/influence.service';
import { SpyService }       from '../spy/spy.service';

@Injectable()
export class DiplomacyTickPhase {
  private readonly logger = new Logger(DiplomacyTickPhase.name);

  constructor(
    @InjectRepository(DiplomaticProposalEntity)
    private readonly proposalRepo:  Repository<DiplomaticProposalEntity>,
    @InjectRepository(TreatyEntity)
    private readonly treatyRepo:    Repository<TreatyEntity>,
    @InjectRepository(WarEntity)
    private readonly warRepo:       Repository<WarEntity>,
    @InjectRepository(DiplomaticRelationEntity)
    private readonly relationRepo:  Repository<DiplomaticRelationEntity>,
    @InjectRepository(VassalAgreementEntity)
    private readonly vassalRepo:    Repository<VassalAgreementEntity>,
    private readonly diplomacyService: DiplomacyService,
    private readonly influenceService: InfluenceService,
    private readonly spyService:       SpyService,
    private readonly redis:            RedisService,
  ) {}

  // ─── Entry point ─────────────────────────────────────────

  async execute(tick: number): Promise<DiplomacyDelta> {
    const delta: DiplomacyDelta = {
      tick,
      timestamp:        new Date().toISOString(),
      proposals:        [],
      treaties:         [],
      wars:             [],
      spy_results:      [],
      trust_changes:    [],
      influence_updates: [],
    };

    // Esegui tutte le fasi in ordine
    await this.expireProposals(tick, delta);
    await this.processActiveTreaties(tick, delta);
    await this.expireTreaties(tick, delta);
    await this.updateWarScores(tick, delta);
    await this.processVassalTributes(tick, delta);
    await this.resolveSpyOperations(tick, delta);
    await this.updateInfluence(tick, delta);
    await this.decayTrust(tick);
    await this.publishDiplomacyDelta(delta);

    return delta;
  }

  // ─── 1. Scadenza proposte ─────────────────────────────────

  private async expireProposals(tick: number, delta: DiplomacyDelta): Promise<void> {
    const expired = await this.proposalRepo
      .createQueryBuilder('p')
      .where('p.expires_at_tick <= :tick', { tick })
      .andWhere('p.status = :status', { status: ProposalStatus.PENDING })
      .getMany();

    for (const p of expired) {
      p.status = ProposalStatus.EXPIRED;
      await this.proposalRepo.save(p);

      delta.proposals!.push({
        proposal_id: p.id,
        type:        p.type,
        from_empire: p.from_empire_id,
        to_empire:   p.to_empire_id,
        status:      ProposalStatus.EXPIRED,
        expires_at:  p.expires_at_tick,
        summary:     `Proposta ${p.type} scaduta`,
      });

      this.logger.debug(`Proposal ${p.id} expired at tick ${tick}`);
    }
  }

  // ─── 2. Termini periodici trattati ────────────────────────

  /**
   * Esegue ogni tick i termini che prevedono pagamenti o trasferimenti.
   * Verifica che i termini vengano rispettati; se un termine non può essere
   * onorato, il trattato viene marcato come BROKEN.
   */
  private async processActiveTreaties(tick: number, delta: DiplomacyDelta): Promise<void> {
    const treaties = await this.treatyRepo.find({
      where: { status: TreatyStatus.ACTIVE },
    });

    for (const treaty of treaties) {
      let isBroken = false;

      for (const term of treaty.terms) {
        const ok = await this.executeTreatyTerm(term, tick);
        if (!ok) {
          // Termine violato → trattato rotto
          isBroken = true;
          this.logger.warn(`Treaty ${treaty.id} broken by ${term.from_empire}: term ${term.type} failed`);

          treaty.status             = TreatyStatus.BROKEN;
          treaty.broken_by_empire_id = term.from_empire;
          treaty.broken_at_tick     = tick;
          await this.treatyRepo.save(treaty);

          // Penalità trust
          const others = treaty.party_ids.filter(id => id !== term.from_empire);
          for (const other of others) {
            await this.diplomacyService.applyTrustModifier(
              other, term.from_empire,
              TrustModifierSource.TREATY_BROKEN, tick,
              treaty.breach_trust_penalty,
            );
          }

          delta.treaties!.push({
            treaty_id: treaty.id,
            type:      treaty.type,
            status:    TreatyStatus.BROKEN,
            parties:   treaty.party_ids,
            broken_by: term.from_empire,
          });

          break;
        }
      }

      // Trust bonus per ogni tick in cui tutti i termini sono rispettati
      if (!isBroken && tick % 5 === 0) {
        const [a, b] = treaty.party_ids;
        if (a && b) {
          await this.diplomacyService.applyTrustModifier(
            a, b, TrustModifierSource.TREATY_RESPECTED, tick,
          );
          await this.diplomacyService.applyTrustModifier(
            b, a, TrustModifierSource.TREATY_RESPECTED, tick,
          );
        }
      }
    }
  }

  private async executeTreatyTerm(term: any, tick: number): Promise<boolean> {
    switch (term.type as TreatyTermType) {

      case TreatyTermType.PAY_CREDITS: {
        const pool =
        (await this.redis.getJson<ResourceStock>(
        `empire:${term.from_empire}:resources`,
        )) ?? {};

        const amount = term.value.amount ?? 0;
        const current = pool[ResourceType.CREDITS] ?? 0;

        if (current < amount) return false;

        pool[ResourceType.CREDITS] = current - amount;
        await this.redis.setJson(`empire:${term.from_empire}:resources`, pool);
      }

      case TreatyTermType.TRANSFER_RESOURCE: {
        const pool = await this.redis.getJson<ResourceStock>(
          `empire:${term.from_empire}:resources`,
        );
        if (!pool) return false;
        const rtype  = term.value.resource_type as ResourceType;
        const amount = term.value.amount ?? 0;
        const current = pool[rtype] ?? 0;
        if (current < amount) return false;

        pool[rtype] = current - amount;
        await this.redis.setJson(`empire:${term.from_empire}:resources`, pool);

        const destPool = await this.redis.getJson<ResourceStock>(
          `empire:${term.to_empire}:resources`,
        );
        if (destPool) {
          destPool[rtype] = (destPool[rtype] ?? 0) + amount;
          await this.redis.setJson(`empire:${term.to_empire}:resources`, destPool);
        }
        return true;
      }

      // I vincoli comportamentali (NO_ATTACK, FLEET_PASSAGE, ecc.) vengono
      // verificati on-action (nel servizio che gestisce l'azione), non qui.
      default:
        return true;
    }
  }

  // ─── 3. Scadenza trattati ─────────────────────────────────

  private async expireTreaties(tick: number, delta: DiplomacyDelta): Promise<void> {
    const expiring = await this.treatyRepo
      .createQueryBuilder('t')
      .where('t.expires_at_tick <= :tick', { tick })
      .andWhere('t.status = :status', { status: TreatyStatus.ACTIVE })
      .getMany();

    for (const treaty of expiring) {
      treaty.status = TreatyStatus.EXPIRED;
      await this.treatyRepo.save(treaty);

      // Aggiorna relazione diplomatica
      if (treaty.party_ids.length === 2) {
        const rel = await this.diplomacyService.getOrCreateRelation(
          treaty.party_ids[0], treaty.party_ids[1],
        );
        rel.active_treaty_ids = rel.active_treaty_ids.filter(id => id !== treaty.id);
        // Se non ci sono altri trattati, torna a NEUTRAL
        if (rel.active_treaty_ids.length === 0 && rel.status !== DiplomacyStatus.WAR) {
          rel.status = DiplomacyStatus.NEUTRAL;
        }
        await this.relationRepo.save(rel);
      }

      delta.treaties!.push({
        treaty_id: treaty.id,
        type:      treaty.type,
        status:    TreatyStatus.EXPIRED,
        parties:   treaty.party_ids,
      });

      this.logger.debug(`Treaty ${treaty.id} (${treaty.type}) expired at tick ${tick}`);
    }
  }

  // ─── 4. War score update ──────────────────────────────────

  /**
   * Aggiorna il war score ogni tick in base alle posizioni attuali.
   * War score influenza l'esito dei negoziati di pace e la capitolazione.
   */
  private async updateWarScores(tick: number, delta: DiplomacyDelta): Promise<void> {
    const wars = await this.warRepo.find({ where: { is_active: true } });

    for (const war of wars) {
      // Calcola contributo di questo tick al war score
      const attackerPlanets = await this.countOccupiedPlanets(
        war.attacker_id, war.defender_id,
      );
      const defenderPlanets = await this.countOccupiedPlanets(
        war.defender_id, war.attacker_id,
      );

      // War score cresce più velocemente chi occupa più territorio
      const attackerGain = attackerPlanets * 2;
      const defenderGain = defenderPlanets * 2;

      war.attacker_war_score = Math.min(100, war.attacker_war_score + attackerGain);
      war.defender_war_score = Math.min(100, war.defender_war_score + defenderGain);

      // Capitolazione: se un lato raggiunge 100 e l'altro è sotto 20
      if (war.attacker_war_score >= 100 && war.defender_war_score < 20) {
        await this.forceCapitulation(war, 'defender', tick);
      } else if (war.defender_war_score >= 100 && war.attacker_war_score < 20) {
        await this.forceCapitulation(war, 'attacker', tick);
      } else {
        await this.warRepo.save(war);
      }

      delta.wars!.push({
        war_id:          war.id,
        attacker_id:     war.attacker_id,
        defender_id:     war.defender_id,
        casus_belli:     war.casus_belli,
        started_at_tick: war.started_at_tick,
        is_new:          false,
      });
    }
  }

  private async countOccupiedPlanets(
    occupierEmpire: string, targetEmpire: string,
  ): Promise<number> {
    // Pianeti dove owner è targetEmpire ma controller è occupierEmpire
    const key = `war_score:${occupierEmpire}:${targetEmpire}:planets`;
    const cached = await this.redis.getJson<number>(key);
    return cached ?? 0;
  }

  private async forceCapitulation(
    war: WarEntity, loser: 'attacker' | 'defender', tick: number,
  ): Promise<void> {
    war.is_active     = false;
    war.ended_at_tick = tick;
    war.outcome       = 'CAPITULATION';
    await this.warRepo.save(war);

    const rel = await this.diplomacyService.getOrCreateRelation(
      war.attacker_id, war.defender_id,
    );
    rel.status = DiplomacyStatus.NEUTRAL;
    rel.active_war_ids = rel.active_war_ids.filter(id => id !== war.id);
    await this.relationRepo.save(rel);

    const winnerId = loser === 'attacker' ? war.defender_id : war.attacker_id;
    const loserId  = loser === 'attacker' ? war.attacker_id : war.defender_id;

    this.logger.warn(`War ${war.id}: CAPITULATION — winner: ${winnerId}, loser: ${loserId}`);
  }

  // ─── 5. Tributi vassallaggio ───────────────────────────────

  private async processVassalTributes(tick: number, delta: DiplomacyDelta): Promise<void> {
    const vassals = await this.vassalRepo.find({ where: { is_active: true } });

    for (const va of vassals) {
      if (va.ends_at_tick && tick >= va.ends_at_tick) {
        va.is_active = false;
        await this.vassalRepo.save(va);
        continue;
      }

      const pool = await this.redis.getJson<ResourceStock>(
        `empire:${va.vassal_id}:resources`,
      );
      if (!pool) continue;

      const rtype  = va.tribute_type as ResourceType;
      const amount = va.tribute_amount;

      const current = pool[rtype] ?? 0;

      if (current >= amount) {
        pool[rtype] = current - amount;
        await this.redis.setJson(`empire:${va.vassal_id}:resources`, pool);

        const overlordPool = await this.redis.getJson<ResourceStock>(
          `empire:${va.overlord_id}:resources`,
        );
        if (overlordPool) {
          overlordPool[rtype] = (overlordPool[rtype] ?? 0) + amount;
          await this.redis.setJson(`empire:${va.overlord_id}:resources`, overlordPool);
        }

        // Trust lieve positivo per tributo pagato
        await this.diplomacyService.applyTrustModifier(
          va.overlord_id, va.vassal_id, TrustModifierSource.TRIBUTE_PAID, tick,
        );
      } else {
        // Tributo non pagato → incrementa "ribellione" del vassallo
        va.liberation_war_score = Math.min(100, va.liberation_war_score + 5);
        await this.vassalRepo.save(va);

        this.logger.warn(`Vassal ${va.vassal_id} failed to pay tribute to ${va.overlord_id}`);
      }
    }
  }

  // ─── 6. Spy operations ────────────────────────────────────

  private async resolveSpyOperations(tick: number, delta: DiplomacyDelta): Promise<void> {
    const summaries = await this.spyService.resolveReadyOperations(tick);

    for (const s of summaries) {
      // Notifica l'attacker del risultato
      delta.spy_results!.push({
        operation_id: s.operation_id,
        type:         s.type,
        status:       s.result.status,
        description:  s.result.description,
        empire_id:    s.attacker_empire_id,
      });

      // Se esposta → notifica anche il target
      if (s.result.diplomatic_incident) {
        delta.spy_results!.push({
          operation_id: s.operation_id,
          type:         s.type,
          status:       s.result.status,
          description:  `Spia dell'impero ${s.attacker_empire_id} catturata.`,
          empire_id:    s.target_empire_id,
        });
      }
    }
  }

  // ─── 7. Influenza ─────────────────────────────────────────

  private async updateInfluence(tick: number, delta: DiplomacyDelta): Promise<void> {
    // Eseguito ogni 5 tick per non sovraccaricare il DB
    if (tick % 5 !== 0) return;

    const results = await this.influenceService.updateAllInfluence(tick);
    for (const r of results) {
      if (r) {
        delta.influence_updates!.push({
          system_id:  r.target_id,
          empire_id:  r.empire_id,
          old_value:  r.old_value,
          new_value:  r.new_value,
        });
      }
    }
  }

  // ─── 8. Trust decay ───────────────────────────────────────

  /**
   * Il trust decade lentamente verso 0 in assenza di interazioni.
   * Eseguito ogni 20 tick.
   */
  private async decayTrust(tick: number): Promise<void> {
    if (tick % 20 !== 0) return;

    const relations = await this.relationRepo.find();
    for (const rel of relations) {
      // Decay verso 0: trust positivo scende, negativo sale
      const decayA = rel.trust_a_to_b > 0 ? -0.5 : rel.trust_a_to_b < 0 ? +0.5 : 0;
      const decayB = rel.trust_b_to_a > 0 ? -0.5 : rel.trust_b_to_a < 0 ? +0.5 : 0;

      if (decayA !== 0 || decayB !== 0) {
        rel.trust_a_to_b += decayA;
        rel.trust_b_to_a += decayB;
        await this.relationRepo.save(rel);
      }
    }
  }

  // ─── 9. Pubblica delta ────────────────────────────────────

  private async publishDiplomacyDelta(delta: DiplomacyDelta): Promise<void> {
    // Raccoglie tutti gli empire IDs coinvolti nel delta
    const empireIds = new Set<string>();

    delta.proposals?.forEach(p => { empireIds.add(p.from_empire); empireIds.add(p.to_empire); });
    delta.treaties?.forEach(t => { t.parties.forEach(p => empireIds.add(p)); });
    delta.wars?.forEach(w => { empireIds.add(w.attacker_id); empireIds.add(w.defender_id); });
    delta.spy_results?.forEach(s => { empireIds.add(s.empire_id); });

    for (const empireId of empireIds) {
      // Filtra il delta per mostrare solo le informazioni rilevanti per quell'empire
      const empireDelta: DiplomacyDelta = {
        tick:       delta.tick,
        timestamp:  delta.timestamp,
        proposals:  delta.proposals?.filter(p =>
          p.from_empire === empireId || p.to_empire === empireId,
        ),
        treaties:   delta.treaties?.filter(t => t.parties.includes(empireId)),
        wars:       delta.wars?.filter(w =>
          w.attacker_id === empireId || w.defender_id === empireId,
        ),
        spy_results: delta.spy_results?.filter(s => s.empire_id === empireId),
        influence_updates: delta.influence_updates?.filter(u => u.empire_id === empireId),
      };

      await this.redis.publishEmpireDelta(empireId, { diplomacy: empireDelta });
    }
  }
}
