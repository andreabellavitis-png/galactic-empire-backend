// ============================================================
//  AUTH MODULE — Register, Login, JWT
// ============================================================

// ── auth.service.ts ──────────────────────────────────────────
import {
  Injectable, UnauthorizedException, ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository }       from 'typeorm';
import { JwtService }       from '@nestjs/jwt';
import * as bcrypt          from 'bcrypt';
import { PlayerEntity }     from '../entities/other-entities';
import { EmpireEntity }     from '../entities/empire.entity';

export interface JwtPayload {
  sub:       string;   // player_id
  empire_id: string;
  username:  string;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(PlayerEntity)
    private readonly playerRepo: Repository<PlayerEntity>,
    @InjectRepository(EmpireEntity)
    private readonly empireRepo: Repository<EmpireEntity>,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: {
    username:    string;
    email:       string;
    password:    string;
    empire_name: string;
    empire_color?: string;
  }) {
    // Controlla duplicati
    const existing = await this.playerRepo.findOne({
      where: [{ username: dto.username }, { email: dto.email }],
    });
    if (existing) throw new ConflictException('Username or email already taken');

    const hash = await bcrypt.hash(dto.password, 12);

    // Crea empire
    const empire = this.empireRepo.create({
      name:  dto.empire_name,
      color: dto.empire_color ?? '#00e5ff',
      resource_pool: {
        METALS: 500, RARE_METALS: 100, ENERGY: 300,
        FOOD: 400, RESEARCH: 0, HELIUM3: 50,
        EXOTIC: 0, CREDITS: 1000,
      },
    });
    await this.empireRepo.save(empire);

    // Crea player
    const player = this.playerRepo.create({
      username:     dto.username,
      email:        dto.email,
      password_hash: hash,
      empire_id:    empire.id,
    });
    await this.playerRepo.save(player);

    // Collega empire al player
    empire.player_id = player.id;
    await this.empireRepo.save(empire);

    return this.signToken(player, empire.id);
  }

  async login(dto: { username: string; password: string }) {
    const player = await this.playerRepo.findOne({
      where: [{ username: dto.username }, { email: dto.username }],
    });
    if (!player) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, player.password_hash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    return this.signToken(player, player.empire_id);
  }

  private signToken(player: PlayerEntity, empireId: string) {
    const payload: JwtPayload = {
      sub:       player.id,
      empire_id: empireId,
      username:  player.username,
    };
    const token = this.jwt.sign(payload);
    return {
      access_token: token,
      player_id:    player.id,
      empire_id:    empireId,
      username:     player.username,
    };
  }

  async validateToken(payload: JwtPayload) {
    const player = await this.playerRepo.findOneBy({ id: payload.sub });
    if (!player) throw new UnauthorizedException();
    return payload;
  }
}

// ── jwt-auth.guard.ts ─────────────────────────────────────────
import {
  CanActivate, ExecutionContext, Injectable as Inj,
  UnauthorizedException as UA,
} from '@nestjs/common';
import { JwtService as JwtSvc } from '@nestjs/jwt';
import { Request } from 'express';

@Inj()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtSvc) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const token = this.extractToken(req);
    if (!token) throw new UA('Missing token');
    try {
      req['user'] = this.jwt.verify(token);
      return true;
    } catch {
      throw new UA('Invalid token');
    }
  }

  private extractToken(req: Request): string | null {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice(7);
    return (req.query?.token as string) ?? null;
  }
}

// ── current-empire.decorator.ts ───────────────────────────────
import { createParamDecorator, ExecutionContext as EC } from '@nestjs/common';

export const CurrentEmpire = createParamDecorator((_: unknown, ctx: EC): string => {
  const req = ctx.switchToHttp().getRequest();
  return req.user?.empire_id;
});

export const CurrentPlayer = createParamDecorator((_: unknown, ctx: EC): string => {
  const req = ctx.switchToHttp().getRequest();
  return req.user?.sub;
});

// ── auth.controller.ts ────────────────────────────────────────
import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * POST /auth/register
   * { username, email, password, empire_name, empire_color? }
   */
  @Post('register')
  async register(@Body() dto: {
    username:     string;
    email:        string;
    password:     string;
    empire_name:  string;
    empire_color?: string;
  }) {
    return this.authService.register(dto);
  }

  /**
   * POST /auth/login
   * { username, password }  ← username può essere anche email
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: { username: string; password: string }) {
    return this.authService.login(dto);
  }
}

// ── auth.module.ts ────────────────────────────────────────────
import { Module }         from '@nestjs/common';
import { TypeOrmModule }  from '@nestjs/typeorm';
import { JwtModule }      from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([PlayerEntity, EmpireEntity]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject:  [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret:      cfg.get('JWT_SECRET', 'dev-secret-change-in-production'),
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  providers:   [AuthService, JwtAuthGuard],
  controllers: [AuthController],
  exports:     [AuthService, JwtAuthGuard, JwtModule],
})
export class AuthModule {}
