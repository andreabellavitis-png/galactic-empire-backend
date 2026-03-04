import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('empires')
export class EmpireEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ unique: true }) player_id: string;
  @Column() name: string;
  @Column({ default: '#00e5ff' }) color: string;
  @Column({ type: 'jsonb', default: {} }) resource_pool: Record<string, number>;
  @Column({ type: 'jsonb', default: {} }) resource_flow: Record<string, any>;
  @Column({ type: 'jsonb', nullable: true }) government: Record<string, any>;
  @Column({ type: 'int', default: 0 }) tech_level: number;
  @Column({ type: 'int', default: 0 }) accumulated_research: number;
  @Column({ type: 'jsonb', default: [] }) research_queue: string[];
  @Column({ type: 'jsonb', default: [] }) diplomatic_relations: Record<string, any>[];
  @Column({ type: 'int', default: 0 }) victory_points: number;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
