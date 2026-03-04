import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  MessageBody,
  ConnectedSocket,
  WsException,
} from '@nestjs/websockets';
import { Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { RedisService } from '../redis/redis.service';
import { TickDelta }    from '../common/game.types';

// ─────────────────────────────────────────────────────────────
//  TICK ENGINE GATEWAY
//
//  WebSocket Gateway Socket.io che:
//  1. Autentica i client tramite JWT all'handshake
//  2. Iscrive ogni client al suo canale Redis (tick:delta:{empire_id})
//  3. Invia i delta tick in tempo reale al client corrispondente
//  4. Gestisce ping/pong per keep-alive
//
//  Architettura push:
//    Redis pub/sub → Gateway → Socket.io room → Client browser
//
//  Ogni client è in una room socket.io con nome = empire_id.
//  Questo permette di emettere a tutti i socket dello stesso empire
//  anche in caso di connessioni multiple (browser + mobile).
// ─────────────────────────────────────────────────────────────

interface AuthenticatedSocket extends Socket {
  empire_id:  string;
  player_id:  string;
}

@WebSocketGateway({
  cors: {
    origin:      process.env.FRONTEND_URL ?? 'http://localhost:3000',
    credentials: true,
  },
  namespace: '/game',
})
export class TickEngineGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(TickEngineGateway.name);

  // Map empireId → Set<socket.id> per tracking connessioni
  private readonly connections = new Map<string, Set<string>>();

  constructor(
    private readonly redis:   RedisService,
    private readonly jwt:     JwtService,
  ) {}

  // ─── Module init: subscribe to Redis channels ────────────

  async onModuleInit() {
    await this.subscribeToRedisChannels();
  }

  afterInit(server: Server) {
    this.logger.log('TickEngine WebSocket Gateway initialized');
  }

  // ─── Connection lifecycle ─────────────────────────────────

  async handleConnection(socket: AuthenticatedSocket) {
    try {
      // Autentica tramite JWT nell'header di handshake
      const token =
        socket.handshake.auth?.token ??
        socket.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) throw new UnauthorizedException('No token provided');

      const payload = this.jwt.verify<{ sub: string; empire_id: string }>(token);
      socket.player_id  = payload.sub;
      socket.empire_id  = payload.empire_id;

      // Unisci alla room dell'empire
      await socket.join(socket.empire_id);

      // Traccia connessione
      const existing = this.connections.get(socket.empire_id) ?? new Set();
      existing.add(socket.id);
      this.connections.set(socket.empire_id, existing);

      this.logger.log(`Client connected: ${socket.id} (empire: ${socket.empire_id})`);

      // Invia stato iniziale (snapshot corrente da Redis/DB)
      await this.sendInitialState(socket);

    } catch (err) {
      this.logger.warn(`Connection refused: ${socket.id} — ${err.message}`);
      socket.emit('error', { message: 'Authentication failed' });
      socket.disconnect(true);
    }
  }

  handleDisconnect(socket: AuthenticatedSocket) {
    if (socket.empire_id) {
      const existing = this.connections.get(socket.empire_id);
      existing?.delete(socket.id);
      if (existing?.size === 0) {
        this.connections.delete(socket.empire_id);
      }
    }
    this.logger.log(`Client disconnected: ${socket.id}`);
  }

  // ─── Redis → WebSocket bridge ────────────────────────────

  private async subscribeToRedisChannels() {
    const sub = this.redis.subscriber;

    // Subscribe a pattern tick:delta:* (tutti gli empire)
    sub.psubscribe('tick:delta:*', (err, count) => {
      if (err) this.logger.error('Redis psubscribe error', err);
      else this.logger.log(`Subscribed to ${count} Redis channel(s)`);
    });

    // Subscribe al canale globale
    sub.subscribe('tick:global', (err) => {
      if (err) this.logger.error('Redis subscribe global error', err);
    });

    // Handler messaggi
    sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
      try {
        const delta: TickDelta = JSON.parse(message);
        // Estrai empire_id dal canale → tick:delta:{empire_id}
        const empireId = channel.replace('tick:delta:', '');
        // Emette alla room dell'empire
        this.server.to(empireId).emit('tick:delta', delta);
      } catch (err) {
        this.logger.error('Error processing Redis message', err);
      }
    });

    sub.on('message', (channel: string, message: string) => {
      if (channel === 'tick:global') {
        try {
          const event = JSON.parse(message);
          // Broadcast a tutti i client connessi
          this.server.emit('tick:global', event);
        } catch (err) {
          this.logger.error('Error processing global event', err);
        }
      }
    });
  }

  // ─── Client message handlers ──────────────────────────────

  /**
   * Il client richiede snapshot del suo stato attuale.
   * Utile dopo reconnect o navigazione tra viste.
   */
  @SubscribeMessage('request:snapshot')
  async handleSnapshotRequest(
    @ConnectedSocket() socket: AuthenticatedSocket,
  ) {
    await this.sendInitialState(socket);
  }

  /**
   * Il client informa il server della vista corrente
   * (sistema stellare, pianeta) per ottimizzare i delta.
   * Futuro: usato per LOD update — inviare solo ciò che è visibile.
   */
  @SubscribeMessage('client:view')
  handleViewChange(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() data: { view: 'galaxy' | 'system' | 'planet'; target_id?: string },
  ) {
    socket.data.current_view = data;
    // Nessuna risposta necessaria — il server userà questa info per filtrare
  }

  /**
   * Il client risponde a una scelta di evento (ribellione, crisi, ecc.)
   * Il risultato viene processato nel prossimo tick (ProcessEventsPhase).
   */
  @SubscribeMessage('event:choice')
  async handleEventChoice(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() data: { event_id: string; choice_id: string },
  ) {
    if (!socket.empire_id) throw new WsException('Not authenticated');

    // Salva la scelta su Redis — verrà letta in ProcessEventsPhase
    await this.redis.setJson(
      `event:${data.event_id}:choice`,
      { empire_id: socket.empire_id, choice_id: data.choice_id, ts: Date.now() },
      300, // 5 minuti TTL
    );

    socket.emit('event:choice:ack', { event_id: data.event_id, status: 'queued' });
  }

  /**
   * Ping/pong per keep-alive e latency measurement.
   */
  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() socket: AuthenticatedSocket): void {
    socket.emit('pong', { ts: Date.now() });
  }

  // ─── Helpers ──────────────────────────────────────────────

  private async sendInitialState(socket: AuthenticatedSocket): Promise<void> {
    // Carica snapshot risorse empire da Redis
    const resources = await this.redis.getJson(`empire:${socket.empire_id}:resources`);
    const tick      = await this.redis.getCurrentTick();

    socket.emit('state:snapshot', {
      empire_id:     socket.empire_id,
      current_tick:  tick,
      resources,
      timestamp:     new Date().toISOString(),
    });
  }

  // ─── Monitoring API ───────────────────────────────────────

  getConnectionStats() {
    const stats: Record<string, number> = {};
    for (const [empireId, sockets] of this.connections) {
      stats[empireId] = sockets.size;
    }
    return {
      total_connections: [...this.connections.values()].reduce((s, c) => s + c.size, 0),
      empires_online:    this.connections.size,
      by_empire:         stats,
    };
  }
}
