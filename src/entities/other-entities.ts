import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

// ── FLEET ────────────────────────────────────────────────────
@Entity('fleets')
export class FleetEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() name: string;
  @Column() @Index() empire_id: string;
  @Column({ nullable: true }) @Index() current_system_id: string;
  @Column({ type: 'jsonb', nullable: true }) travel_state: any;
  @Column({ type: 'jsonb', default: [] }) ship_ids: string[];
  @Column({ type: 'int', default: 0 }) total_ships: number;
  @Column({ type: 'float', default: 0 }) total_firepower: number;
  @Column({ type: 'float', default: 0 }) total_hull: number;
  @Column({ type: 'float', default: 0 }) total_shields: number;
  @Column({ type: 'float', default: 1 }) total_speed: number;
  @Column({ default: 'IDLE' }) @Index() status: string;
  @Column({ type: 'float', default: 100 }) morale: number;
  @Column({ type: 'float', default: 0 }) experience: number;
  @Column({ type: 'float', default: 100 }) supply_level: number;
  @Column({ type: 'jsonb', default: [] }) order_queue: any[];
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}

// ── WORMHOLE ─────────────────────────────────────────────────
@Entity('wormholes')
export class WormholeEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ nullable: true }) name: string;
  @Column() system_a: string;
  @Column() system_b: string;
  @Column({ default: 'UNKNOWN' }) status: string;
  @Column({ type: 'float', default: 100 }) stability: number;
  @Column({ type: 'float', default: 1.5 }) stability_decay: number;
  @Column({ type: 'float', default: 10 }) collapse_threshold: number;
  @Column({ type: 'float', default: 0.002 }) reopen_chance: number;
  @Column({ type: 'int', default: 5 }) traverse_ticks: number;
  @Column({ type: 'float', default: 20 }) risk_level: number;
  @Column({ type: 'jsonb', default: [] }) discovered_by: string[];
  @Column({ nullable: true }) discovered_at: Date;
  @Column({ type: 'jsonb', default: [] }) fleets_in_transit: string[];
  @UpdateDateColumn() updated_at: Date;
}

// ── TRADE ROUTE ───────────────────────────────────────────────
@Entity('trade_routes')
export class TradeRouteEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() @Index() empire_id: string;
  @Column() origin_id: string;
  @Column() dest_id: string;
  @Column({ type: 'jsonb', default: [] }) path: string[];
  @Column() resource_type: string;
  @Column({ type: 'float', default: 10 }) amount_per_tick: number;
  @Column({ default: 'AUTO_HYPERLANE' }) method: string;
  @Column({ nullable: true }) transport_fleet_id: string;
  @Column({ default: true }) is_active: boolean;
  @Column({ type: 'float', default: 1.0 }) efficiency: number;
  @Column({ type: 'int', default: 0 }) last_transfer_tick: number;
  @CreateDateColumn() created_at: Date;
}

// ── GAME EVENT ────────────────────────────────────────────────
@Entity('game_events')
export class GameEventEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() type: string;
  @Column() title: string;
  @Column({ type: 'text', nullable: true }) description: string;
  @Column({ type: 'jsonb', default: [] }) affected_empire_ids: string[];
  @Column({ type: 'jsonb', default: [] }) affected_body_ids: string[];
  @Column({ type: 'jsonb', nullable: true }) trigger_condition: any;
  @Column({ type: 'int', default: 0 }) triggered_at: number;
  @Column({ type: 'jsonb', default: [] }) effects: any[];
  @Column({ type: 'int', nullable: true }) duration: number;
  @Column({ type: 'int', nullable: true }) ends_at: number;
  @Column({ default: true }) is_active: boolean;
  @Column({ default: false }) requires_player_action: boolean;
  @Column({ type: 'jsonb', nullable: true }) player_choices: any[];
  @Column({ nullable: true }) player_choice_made: string;
  @CreateDateColumn() created_at: Date;
}

// ── HYPERLANE ─────────────────────────────────────────────────
@Entity('hyperlanes')
export class HyperlaneEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() system_a: string;
  @Column() system_b: string;
  @Column({ type: 'float' }) base_travel_ticks: number;
  @Column({ default: 'OPEN' }) status: string;
  @Column({ nullable: true }) blockaded_by: string;
  @CreateDateColumn() created_at: Date;
}

// ── PLAYER ────────────────────────────────────────────────────
@Entity('players')
export class PlayerEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ unique: true }) username: string;
  @Column({ unique: true }) email: string;
  @Column() password_hash: string;
  @Column({ nullable: true }) empire_id: string;
  @Column({ default: false }) is_admin: boolean;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
