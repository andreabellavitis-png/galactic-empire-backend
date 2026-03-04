import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('celestial_bodies')
export class CelestialBodyEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() @Index() system_id: string;
  @Column({ nullable: true }) parent_body_id: string;
  @Column() name: string;
  @Column() type: string;
  @Column({ type: 'jsonb' }) orbital_params: Record<string, number>;
  @Column({ type: 'float', default: 50 }) habitability: number;
  @Column({ type: 'int', default: 0 }) population: number;
  @Column({ type: 'int', default: 0 }) population_max: number;
  @Column({ type: 'float', default: 50 }) loyalty: number;
  @Column({ type: 'float', default: 50 }) morale: number;
  @Column({ type: 'float', default: 50 }) stability: number;
  @Column({ default: 'UNINHABITED' }) @Index() status: string;
  @Column({ nullable: true }) @Index() owner_id: string;
  @Column({ nullable: true }) controller_id: string;
  @Column({ nullable: true }) active_delegation_id: string;
  @Column({ type: 'jsonb', default: {} }) resource_stock: Record<string, number>;
  @Column({ type: 'jsonb', default: {} }) resource_flow: Record<string, any>;
  @Column({ type: 'jsonb', default: [] }) building_ids: string[];
  @Column({ type: 'jsonb', default: [] }) army_ids: string[];
  @Column({ type: 'float', default: 0 }) loyalty_building_bonus: number;
  @Column({ type: 'text', nullable: true }) description: string;
  @Column({ type: 'jsonb', default: [] }) discovered_by: string[];
  @Column({ nullable: true }) colonized_at: Date;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
