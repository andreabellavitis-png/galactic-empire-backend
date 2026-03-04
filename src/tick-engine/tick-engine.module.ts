import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { RedisService } from '../redis/redis.service';
import { TickEngineService } from './tick-engine.service';
import { TickEngineGateway } from './tick-engine.gateway';
import { TickEngineController } from './tick-engine.controller';  // ora esiste realmente

import {
  MoveFleetsPhase,
  ProduceResourcesPhase,
  TransferResourcesPhase,
  UpdatePopulationPhase,
  UpdateLoyaltyPhase,
  CheckRebellionsPhase,
  ResolveCombatPhase,
  UpdateWormholesPhase,
  ProcessEventsPhase,
  UpdateResearchPhase,
  NotifyPlayersPhase,
  PersistStatePhase,
} from './phases/all-phases';

// Entities
import { FleetEntity } from '../entities/fleet.entity';
import { CelestialBodyEntity } from '../entities/celestial-body.entity';
import { WormholeEntity } from '../entities/wormhole.entity';
import { EmpireEntity } from '../entities/empire.entity';
import { TradeRouteEntity } from '../entities/trade-route.entity';
import { GameEventEntity } from '../entities/game-event.entity';
import { StarSystemEntity } from '../entities/star-system.entity';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      FleetEntity,
      CelestialBodyEntity,
      WormholeEntity,
      EmpireEntity,
      TradeRouteEntity,
      GameEventEntity,
      StarSystemEntity,
    ]),
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env.JWT_SECRET ?? 'change-me-in-production',
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  providers: [
    RedisService,
    TickEngineService,
    TickEngineGateway,
    // Phases
    MoveFleetsPhase,
    ProduceResourcesPhase,
    TransferResourcesPhase,
    UpdatePopulationPhase,
    UpdateLoyaltyPhase,
    CheckRebellionsPhase,
    ResolveCombatPhase,
    UpdateWormholesPhase,
    ProcessEventsPhase,
    UpdateResearchPhase,
    NotifyPlayersPhase,
    PersistStatePhase,
  ],
  controllers: [TickEngineController], // ora funziona
  exports: [TickEngineService, RedisService],
})
export class TickEngineModule {}