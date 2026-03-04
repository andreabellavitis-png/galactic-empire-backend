// ============================================================
//  SEED SCRIPT
//  Genera una galassia starter con:
//    - 25 sistemi stellari collegati da iperlane
//    - ~3 pianeti per sistema (alcuni colonizzabili)
//    - 3 empire NPC + slot per giocatori umani
//    - 1 fleet starter per ogni empire
//    - 2 wormhole instabili
//
//  Uso: npx ts-node src/seed/seed.ts
//       (oppure: npm run seed)
// ============================================================

import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config }     from 'dotenv';

config();

import { EmpireEntity }        from '../entities/empire.entity';
import { StarSystemEntity }    from '../entities/star-system.entity';
import { CelestialBodyEntity } from '../entities/celestial-body.entity';
import {
  FleetEntity, WormholeEntity, HyperlaneEntity, PlayerEntity,
} from '../entities/other-entities';

// ── Helpers ──────────────────────────────────────────────────

const rand  = (min: number, max: number) => Math.random() * (max - min) + min;
const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1));
const pick  = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const uuid  = () => require('crypto').randomUUID();

const STAR_TYPES   = ['G', 'K', 'M', 'F', 'A', 'B', 'Neutron'];
const PLANET_TYPES = ['Terrestrial', 'Oceanic', 'Desert', 'Volcanic', 'Ice', 'Gas Giant', 'Barren', 'Continental'];
const SYSTEM_NAMES = [
  'Sol Primus', 'Kepler Nova', 'Arcturus Minor', 'Vega Station', 'Deneb Cross',
  'Rigel Gate', 'Altair Deep', 'Sirius Reach', 'Polaris Keep', 'Capella Drift',
  'Betelgeuse Rim', 'Aldebaran Hub', 'Fomalhaut Bay', 'Antares Hold', 'Procyon Break',
  'Regulus Run', 'Spica Fold', 'Castor Point', 'Pollux Verge', 'Achernar Pass',
  'Mimosa Spur', 'Hadar Bend', 'Acrux Rise', 'Gacrux Fall', 'Shaula Void',
];
const PLANET_NAMES = [
  'Kalos', 'Meras', 'Thyra', 'Velos', 'Ondra', 'Petra', 'Kyros', 'Zephyr',
  'Athos', 'Demos', 'Lyris', 'Nexus', 'Orin', 'Paxos', 'Quara', 'Rhea',
  'Stella', 'Tannis', 'Ulara', 'Viras', 'Wyren', 'Xalos', 'Yelta', 'Zoral',
  'Amara', 'Braxis', 'Calyx', 'Doran', 'Elara', 'Faros', 'Garen', 'Heron',
  'Ignis', 'Jalus', 'Korva', 'Lunar', 'Myros', 'Narox', 'Omara', 'Pyron',
];

// Palette colori empire
const EMPIRE_COLORS = ['#00e5ff', '#ff2244', '#00ff88', '#ffaa00', '#aa44ff'];
const EMPIRE_NAMES  = ['Hegemony of Kalos', 'Iron Concordat', 'The Velos Collective'];

// ─────────────────────────────────────────────────────────────

async function seed() {
  const ds = new DataSource({
    type:        'postgres',
    url:         process.env.DATABASE_URL ?? 'postgresql://postgres:pass@localhost:5432/galactic_empire',
    entities:    [EmpireEntity, StarSystemEntity, CelestialBodyEntity, FleetEntity, WormholeEntity, HyperlaneEntity, PlayerEntity],
    synchronize: true,
    logging:     false,
  });

  await ds.initialize();
  console.log('✅ DB connected');

  // Pulisce tutto prima di riseminare
  await ds.query('TRUNCATE TABLE star_systems, celestial_bodies, fleets, wormholes, hyperlanes, empires, players CASCADE');
  console.log('🧹 Tables cleared');

  // ── 1. Sistemi stellari ────────────────────────────────────

  const systems: StarSystemEntity[] = [];
  for (let i = 0; i < 25; i++) {
    // Posizioni in una spirale approssimata (2D per ora, z=0)
    const angle  = (i / 25) * Math.PI * 4;
    const radius = 20 + i * 8 + rand(-5, 5);
    const s = ds.getRepository(StarSystemEntity).create({
      id:          uuid(),
      name:        SYSTEM_NAMES[i],
      coordinates: {
        x: Math.cos(angle) * radius + rand(-3, 3),
        y: Math.sin(angle) * radius + rand(-3, 3),
        z: rand(-5, 5),
      },
      seed:        Math.floor(Math.random() * 999999),
      status:      'STABLE',
      star_type_index: randInt(0, STAR_TYPES.length - 1),
    });
    await ds.getRepository(StarSystemEntity).save(s);
    systems.push(s);
  }
  console.log(`🌟 Created ${systems.length} star systems`);

  // ── 2. Iperlane (grafo connesso) ───────────────────────────

  const hyperlanes: HyperlaneEntity[] = [];

  // Prima: connetti ogni sistema al suo vicino più prossimo (spanning tree)
  const connected = new Set<string>([systems[0].id]);
  const remaining = new Set(systems.slice(1).map(s => s.id));

  while (remaining.size > 0) {
    let bestDist = Infinity, bestA = '', bestB = '';
    for (const cId of connected) {
      const c = systems.find(s => s.id === cId)!;
      for (const rId of remaining) {
        const r = systems.find(s => s.id === rId)!;
        const d = Math.hypot(
          r.coordinates.x - c.coordinates.x,
          r.coordinates.y - c.coordinates.y,
        );
        if (d < bestDist) { bestDist = d; bestA = cId; bestB = rId; }
      }
    }
    const hl = ds.getRepository(HyperlaneEntity).create({
      id: uuid(), system_a: bestA, system_b: bestB,
      base_travel_ticks: Math.max(3, Math.floor(bestDist / 10)),
      status: 'OPEN',
    });
    await ds.getRepository(HyperlaneEntity).save(hl);
    hyperlanes.push(hl);
    connected.add(bestB);
    remaining.delete(bestB);

    // Aggiorna hyperlane_ids sui sistemi
    const sa = systems.find(s => s.id === bestA)!;
    const sb = systems.find(s => s.id === bestB)!;
    sa.hyperlane_ids = [...(sa.hyperlane_ids ?? []), hl.id];
    sb.hyperlane_ids = [...(sb.hyperlane_ids ?? []), hl.id];
    await ds.getRepository(StarSystemEntity).save([sa, sb]);
  }

  // Aggiungi alcune iperlane extra per creare cicli (più interessante)
  for (let extra = 0; extra < 8; extra++) {
    const a = systems[randInt(0, 24)];
    const b = systems[randInt(0, 24)];
    if (a.id === b.id) continue;
    const alreadyConnected = hyperlanes.some(
      h => (h.system_a === a.id && h.system_b === b.id) ||
           (h.system_a === b.id && h.system_b === a.id),
    );
    if (alreadyConnected) continue;

    const dist = Math.hypot(
      b.coordinates.x - a.coordinates.x,
      b.coordinates.y - a.coordinates.y,
    );
    const hl = ds.getRepository(HyperlaneEntity).create({
      id: uuid(), system_a: a.id, system_b: b.id,
      base_travel_ticks: Math.max(3, Math.floor(dist / 10)),
      status: 'OPEN',
    });
    await ds.getRepository(HyperlaneEntity).save(hl);
    hyperlanes.push(hl);
    a.hyperlane_ids = [...(a.hyperlane_ids ?? []), hl.id];
    b.hyperlane_ids = [...(b.hyperlane_ids ?? []), hl.id];
    await ds.getRepository(StarSystemEntity).save([a, b]);
  }
  console.log(`🔗 Created ${hyperlanes.length} hyperlanes`);

  // ── 3. Pianeti per sistema ─────────────────────────────────

  const allBodies: CelestialBodyEntity[] = [];
  let planetNameIdx = 0;

  for (const system of systems) {
    const numPlanets = randInt(2, 5);
    for (let p = 0; p < numPlanets; p++) {
      const type = pick(PLANET_TYPES);
      const habitability = type === 'Terrestrial' || type === 'Continental' || type === 'Oceanic'
        ? rand(40, 90) : type === 'Desert' ? rand(20, 50) : rand(0, 25);

      const body = ds.getRepository(CelestialBodyEntity).create({
        id:          uuid(),
        system_id:   system.id,
        name:        PLANET_NAMES[planetNameIdx++ % PLANET_NAMES.length] + ' ' + (p + 1),
        type,
        orbital_params: {
          orbit_radius:  rand(50, 400),
          orbit_speed:   rand(0.1, 1.5),
          current_angle: rand(0, Math.PI * 2),
          inclination:   rand(0, 0.3),
          eccentricity:  rand(0, 0.2),
        },
        habitability:   Math.round(habitability),
        status:         'UNINHABITED',
        population:     0,
        population_max: Math.round(habitability * 800),
        resource_flow: {
          production: {
            METALS:      randInt(2, 15),
            ENERGY:      randInt(1, 10),
            FOOD:        habitability > 40 ? randInt(3, 12) : 0,
            RESEARCH:    randInt(0, 5),
            RARE_METALS: randInt(0, 3),
          },
          consumption: {},
          surplus:     {},
        },
        resource_stock: {},
        loyalty: 50, morale: 50, stability: 50,
      });
      await ds.getRepository(CelestialBodyEntity).save(body);
      allBodies.push(body);
    }
  }
  console.log(`🪐 Created ${allBodies.length} planets`);

  // ── 4. Wormhole (2 instabili) ──────────────────────────────

  const wh1 = ds.getRepository(WormholeEntity).create({
    id: uuid(), name: 'The Rift',
    system_a: systems[2].id, system_b: systems[18].id,
    status: 'UNSTABLE', stability: 45, stability_decay: 2.0,
    traverse_ticks: 3, risk_level: 35, discovered_by: [],
  });
  const wh2 = ds.getRepository(WormholeEntity).create({
    id: uuid(), name: 'Void Passage',
    system_a: systems[7].id, system_b: systems[23].id,
    status: 'STABLE', stability: 80, stability_decay: 1.0,
    traverse_ticks: 2, risk_level: 10, discovered_by: [],
  });
  await ds.getRepository(WormholeEntity).save([wh1, wh2]);
  systems[2].wormhole_ids  = [wh1.id];
  systems[18].wormhole_ids = [wh1.id];
  systems[7].wormhole_ids  = [wh2.id];
  systems[23].wormhole_ids = [wh2.id];
  await ds.getRepository(StarSystemEntity).save([systems[2], systems[7], systems[18], systems[23]]);
  console.log('🌀 Created 2 wormholes');

  // ── 5. Empire (3 NPC starter) ──────────────────────────────

  const empires: EmpireEntity[] = [];
  for (let i = 0; i < 3; i++) {
    const empire = ds.getRepository(EmpireEntity).create({
      id:       uuid(),
      name:     EMPIRE_NAMES[i],
      color:    EMPIRE_COLORS[i + 1],
      player_id: `npc-${i}`,
      resource_pool: {
        METALS: 800, RARE_METALS: 150, ENERGY: 500,
        FOOD: 600, RESEARCH: 50, HELIUM3: 80,
        EXOTIC: 10, CREDITS: 2000,
      },
      tech_level: 1,
    });
    await ds.getRepository(EmpireEntity).save(empire);
    empires.push(empire);

    // Assegna sistema home e colonizza primo pianeta
    const homeSystem = systems[i * 8]; // sistemi 0, 8, 16
    homeSystem.owner_id      = empire.id;
    homeSystem.controller_id = empire.id;
    await ds.getRepository(StarSystemEntity).save(homeSystem);

    const homePlanets = allBodies.filter(b => b.system_id === homeSystem.id);
    const habitablePlanet = homePlanets.find(b => b.habitability > 40) ?? homePlanets[0];
    if (habitablePlanet) {
      habitablePlanet.owner_id      = empire.id;
      habitablePlanet.controller_id = empire.id;
      habitablePlanet.status        = 'STABLE';
      habitablePlanet.population    = randInt(5000, 20000);
      habitablePlanet.population_max = Math.round(habitablePlanet.habitability * 1000);
      habitablePlanet.loyalty       = randInt(65, 85);
      habitablePlanet.morale        = randInt(60, 80);
      habitablePlanet.colonized_at  = new Date();
      await ds.getRepository(CelestialBodyEntity).save(habitablePlanet);
    }

    // Fleet starter nel sistema home
    const fleet = ds.getRepository(FleetEntity).create({
      id:                uuid(),
      name:              `${empire.name.split(' ')[0]} 1st Fleet`,
      empire_id:         empire.id,
      current_system_id: homeSystem.id,
      status:            'IDLE',
      total_ships:       8,
      total_firepower:   80,
      total_hull:        800,
      total_shields:     400,
      total_speed:       1.5,
      supply_level:      100,
      morale:            80,
      experience:        10,
    });
    await ds.getRepository(FleetEntity).save(fleet);
  }
  console.log(`👑 Created ${empires.length} NPC empires with home systems and fleets`);

  // ── 6. Player demo (per testare login) ────────────────────

  const bcrypt = require('bcrypt');
  const demoHash = await bcrypt.hash('demo1234', 12);

  // Empire del giocatore demo (sistema 4 come home)
  const playerEmpire = ds.getRepository(EmpireEntity).create({
    id:       uuid(),
    name:     'United Terran Remnant',
    color:    '#00e5ff',
    player_id: 'placeholder',
    resource_pool: {
      METALS: 500, RARE_METALS: 100, ENERGY: 300,
      FOOD: 400, RESEARCH: 0, HELIUM3: 50,
      EXOTIC: 0, CREDITS: 1000,
    },
    tech_level: 1,
  });
  await ds.getRepository(EmpireEntity).save(playerEmpire);

  const demoPlayer = ds.getRepository(PlayerEntity).create({
    id:            uuid(),
    username:      'demo',
    email:         'demo@galactic.game',
    password_hash: demoHash,
    empire_id:     playerEmpire.id,
  });
  await ds.getRepository(PlayerEntity).save(demoPlayer);

  playerEmpire.player_id = demoPlayer.id;
  await ds.getRepository(EmpireEntity).save(playerEmpire);

  // Home system del giocatore
  const playerHome = systems[4];
  playerHome.owner_id      = playerEmpire.id;
  playerHome.controller_id = playerEmpire.id;
  await ds.getRepository(StarSystemEntity).save(playerHome);

  const playerPlanets = allBodies.filter(b => b.system_id === playerHome.id);
  const playerPlanet  = playerPlanets.find(b => b.habitability > 40) ?? playerPlanets[0];
  if (playerPlanet) {
    playerPlanet.owner_id      = playerEmpire.id;
    playerPlanet.controller_id = playerEmpire.id;
    playerPlanet.status        = 'STABLE';
    playerPlanet.population    = 12000;
    playerPlanet.population_max = 80000;
    playerPlanet.loyalty       = 75;
    playerPlanet.morale        = 70;
    playerPlanet.colonized_at  = new Date();
    await ds.getRepository(CelestialBodyEntity).save(playerPlanet);
  }

  // Fleet starter giocatore
  const playerFleet = ds.getRepository(FleetEntity).create({
    id:                uuid(),
    name:              'UTR First Fleet',
    empire_id:         playerEmpire.id,
    current_system_id: playerHome.id,
    status:            'IDLE',
    total_ships:       6,
    total_firepower:   60,
    total_hull:        600,
    total_shields:     300,
    total_speed:       1.5,
    supply_level:      100,
    morale:            80,
    experience:        0,
  });
  await ds.getRepository(FleetEntity).save(playerFleet);

  console.log(`👤 Demo player created — login: demo / demo1234`);

  // ── Summary ───────────────────────────────────────────────

  console.log('\n═══════════════════════════════════════');
  console.log('  SEED COMPLETE');
  console.log(`  Systems:  ${systems.length}`);
  console.log(`  Planets:  ${allBodies.length}`);
  console.log(`  Empires:  ${empires.length + 1} (3 NPC + 1 player)`);
  console.log(`  Hyperlanes: ${hyperlanes.length}`);
  console.log(`  Wormholes: 2`);
  console.log('  Demo login: demo / demo1234');
  console.log('═══════════════════════════════════════\n');

  await ds.destroy();
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
