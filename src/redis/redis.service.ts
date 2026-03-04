// ============================================================
//  redis.service.ts — usa ioredis (in package.json)
//  PATH: src/redis/redis.service.ts
// ============================================================
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  client:     Redis;
  subscriber: Redis;   // esposto pubblicamente per il gateway WebSocket

  async onModuleInit() {
    const url        = process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.client      = new Redis(url);
    this.subscriber  = new Redis(url);   // connessione separata (subscribe blocca)
    this.client.on('error',     (e) => this.logger.error('Redis client error', e));
    this.subscriber.on('error', (e) => this.logger.error('Redis subscriber error', e));
    this.logger.log('Redis connected');
  }

  async onModuleDestroy() {
    await this.client?.quit();
    await this.subscriber?.quit();
  }

  // ── Primitivi ──────────────────────────────────────────────
  async get(key: string): Promise<string | null> { return this.client.get(key); }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) await this.client.setex(key, ttlSeconds, value);
    else            await this.client.set(key, value);
  }

  async del(key: string): Promise<void> { await this.client.del(key); }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) > 0;
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.client.expire(key, seconds);
  }

  // ── JSON helpers ──────────────────────────────────────────
  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (!raw) return null;
    try { return JSON.parse(raw) as T; } catch { return null; }
  }

  async setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  // ── Cache invalidation ────────────────────────────────────
  /** Elimina una chiave specifica */
  //async invalidate(key: string): Promise<void> {
    //await this.client.del(key);
  //}

  async invalidate(...keys: string[]): Promise<void> {
  if (!keys.length) return;
  await this.client.del(keys);
  }

  /** Elimina tutte le chiavi che corrispondono al pattern (es: 'empire:*:resources:stale') */
  async invalidatePattern(pattern: string): Promise<void> {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) await this.client.del(...keys);
    } while (cursor !== '0');
  }

  // ── Sets ──────────────────────────────────────────────────
  async addToSet(key: string, ...members: string[]): Promise<void> {
    await this.client.sadd(key, ...members);
  }

  async getSet(key: string): Promise<string[]> {
    return this.client.smembers(key);
  }

  async removeFromSet(key: string, member: string): Promise<void> {
    await this.client.srem(key, member);
  }

  // ── Pub/Sub ───────────────────────────────────────────────
  async publish(channel: string, message: string): Promise<void> {
    await this.client.publish(channel, message);
  }

  /** Invia un delta a un singolo impero */
  async publishEmpireDelta(empireId: string, delta: Record<string, unknown>): Promise<void> {
    await this.client.publish(`empire:${empireId}:delta`, JSON.stringify(delta));
  }

  /** Invia un evento a tutti i client connessi */
  async publishGlobalEvent(event: Record<string, unknown>): Promise<void> {
    await this.client.publish('game:global:events', JSON.stringify(event));
  }

  // ── Tick helpers ──────────────────────────────────────────
  async getCurrentTick(): Promise<number> {
    const val = await this.client.get('game:current_tick');
    return val ? parseInt(val, 10) : 0;
  }

  async setCurrentTick(tick: number): Promise<void> {
    await this.client.set('game:current_tick', tick.toString());
  }

  /** Incrementa atomicamente il tick e ritorna il nuovo valore */
  async incrementTick(): Promise<number> {
    return this.client.incr('game:current_tick');
  }

  /** Acquisisce un lock distribuito per il tick (evita esecuzioni doppie) */
  async acquireTickLock(tick: number): Promise<boolean> {
    const result = await this.client.set(
      `game:tick_lock:${tick}`, '1', 'EX', 60, 'NX',
    );
    return result === 'OK';
  }

  async releaseTickLock(): Promise<void> {
    const tick = await this.getCurrentTick();
    await this.client.del(`game:tick_lock:${tick}`);
  }

  async isTickRunning(): Promise<boolean> {
    return (await this.client.get('game:tick_running')) === '1';
  }

  async setTickRunning(running: boolean): Promise<void> {
    await this.client.set('game:tick_running', running ? '1' : '0');
  }

  async isPaused(): Promise<boolean> {
    return (await this.client.get('game:paused')) === '1';
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.client.set('game:paused', paused ? '1' : '0');
  }
}
