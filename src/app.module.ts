// ============================================================
//  app.module.ts — Root Module
//  PATH: src/app.module.ts
// ============================================================
import { Module }         from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule }  from '@nestjs/typeorm';

import { AuthModule }       from './auth/auth.module';
import { GameModule }       from './game/game.module';
import { TickEngineModule } from './tick-engine/tick-engine.module';

import {
  EmpireEntity, StarSystemEntity, CelestialBodyEntity,
  FleetEntity, WormholeEntity, TradeRouteEntity,
  GameEventEntity, HyperlaneEntity, PlayerEntity,
} from './entities';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        type:        'postgres',
        url:         cfg.get('DATABASE_URL', 'postgresql://postgres:pass@localhost:5432/galactic_empire'),
        entities: [
          EmpireEntity, StarSystemEntity, CelestialBodyEntity,
          FleetEntity, WormholeEntity, TradeRouteEntity,
          GameEventEntity, HyperlaneEntity, PlayerEntity,
        ],
        synchronize: cfg.get('DB_SYNC', 'true') === 'true',
        logging:     false,
        ssl:         false,
      }),
    }),
    AuthModule,
    GameModule,
    TickEngineModule,
  ],
})
export class AppModule {}
