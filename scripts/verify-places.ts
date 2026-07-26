/**
 * Verifies the downtown Santa Cruz seed venues against live OpenStreetMap data
 * and regenerates fixtures/places.generated.json.
 *
 * We do NOT hardcode opening hours as permanent facts. This script records what
 * the source said and WHEN it said it, so the fixture is honestly labelled as a
 * point-in-time snapshot rather than ground truth.
 *
 * Usage: npm run places:verify
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OverpassProvider } from '../src/lib/places/overpass';
import { RIVERFRONT } from '../src/lib/domain';
import type { WaitPlace } from '../src/lib/places/types';

/** The venues named in the brief, to be confirmed rather than assumed. */
const SEED_NAMES = [
  'Abbott Square',
  'Bookshop Santa Cruz',
  'Santa Cruz Coffee Roasting',
  'Verve Coffee',
  'Mariposa',
];

async function main() {
  const provider = new OverpassProvider();
  console.log('Querying OpenStreetMap around RiverFront Area 2 ...');
  const places = await provider.search({
    lat: RIVERFRONT.AREA_2.lat,
    lon: RIVERFRONT.AREA_2.lon,
    radiusMetres: 700,
    limit: 80,
  });
  console.log(`  ${places.length} named venues returned\n`);

  const matched: WaitPlace[] = [];
  for (const seed of SEED_NAMES) {
    const hit = places.find((p) => p.name.toLowerCase().includes(seed.toLowerCase()));
    if (hit) {
      matched.push(hit);
      const hrs = hit.hours?.raw ?? '(no opening_hours published)';
      console.log(`  FOUND    ${seed.padEnd(28)} -> "${hit.name}"  hours: ${hrs}`);
    } else {
      console.log(`  MISSING  ${seed.padEnd(28)} -> not present in OSM within 700 m`);
    }
  }

  // Keep the seed matches plus a spread of other nearby options.
  const extras = places.filter((p) => !matched.includes(p)).slice(0, 20);
  const all = [...matched, ...extras];

  const withHours = all.filter((p) => p.hours?.parsed).length;
  console.log(
    `\n  ${withHours}/${all.length} have opening hours we can parse. The rest are reported as "hours unknown".`,
  );

  const out = {
    _comment:
      'DEMO FIXTURE. Snapshot of OpenStreetMap data captured at generatedAt. Opening hours are point-in-time and may be stale or missing; CruzSync treats unverified hours as unknown and will not issue a confident "safe to visit" recommendation from them.',
    generatedAt: new Date().toISOString(),
    source: 'OpenStreetMap via Overpass API, (c) OpenStreetMap contributors, ODbL',
    anchor: { stopId: RIVERFRONT.AREA_2.stopId, label: RIVERFRONT.AREA_2.label },
    places: all,
  };
  const path = resolve(process.cwd(), 'fixtures/places.generated.json');
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${path} (${all.length} places)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
