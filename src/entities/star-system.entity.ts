import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('star_systems')
export class StarSystemEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() name: string;
  @Column({ type: 'jsonb' }) coordinates: { x: number; y: number; z: number };
  @Column({ type: 'bigint' }) seed: number;
  @Column({ nullable: true }) @Index() owner_id: string;
  @Column({ nullable: true }) controller_id: string;
  @Column({ default: 'STABLE' }) @Index() status: string;
  @Column({ type: 'jsonb', default: [] }) influence_map: any[];
  @Column({ default: false }) has_anomaly: boolean;
  @Column({ type: 'jsonb', default: [] }) hyperlane_ids: string[];
  @Column({ type: 'jsonb', default: [] }) wormhole_ids: string[];
  @Column({ type: 'int', default: 0 }) star_type_index: number;
  @Column({ nullable: true }) active_delegation_id: string;
  @CreateDateColumn() created_at: Date;
}
