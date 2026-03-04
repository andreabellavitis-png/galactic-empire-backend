// ============================================================
//  tick-engine.controller.ts — Admin / Debug Endpoints
// ============================================================
import { Controller, Get, Post, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { CanActivate, ExecutionContext, Injectable as Inj } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TickEngineService } from './tick-engine.service';

// Guard semplice basato su header X-Admin-Key
@Inj()
class AdminKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    return req.headers['x-admin-key'] === this.config.get('ADMIN_KEY', 'dev-key');
  }
}

@Controller('admin/tick')
@UseGuards(AdminKeyGuard)
export class TickEngineController {
  constructor(
    private readonly tickEngine: TickEngineService,
    private readonly config: ConfigService,
  ) {}

  @Get('status')
  getStatus(): any {  // puoi mettere TickEngineStatus se esporti il tipo
    return this.tickEngine.getStatus();
  }

  @Post('force')
  @HttpCode(HttpStatus.OK)
  async forceTick(): Promise<any> {  // TS vuole Promise<T>
    const stats = await this.tickEngine.forceTickNow();
    return { message: 'Tick forced', stats };
  }

  @Post('stop')
  @HttpCode(HttpStatus.OK)
  stopEngine(): any {
    this.tickEngine.stop();
    return { message: 'TickEngine stopped' };
  }

  @Post('start')
  @HttpCode(HttpStatus.OK)
  startEngine(): any {
    this.tickEngine.start();
    return { message: 'TickEngine started' };
  }
}