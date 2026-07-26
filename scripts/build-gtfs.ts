/**
 * Downloads the Santa Cruz METRO static GTFS feed and prunes it to just the
 * routes CruzSync models, emitting compact JSON into data/gtfs/.
 *
 * The raw feed is ~15MB unzipped (stop_times.txt alone is 6.4MB). Pruning to
 * routes 11/18/19/35 gets us to a few hundred KB, which is small enough to
 * commit -- so the app boots and the tests run with no network at all.
 *
 * Usage: npm run gtfs:build
 *        npm run gtfs:build -- --from-dir ./some/unzipped/gtfs
 */
import AdmZip from 'adm-zip';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const GTFS_URL = 'https://developer.scmetro.org/gtfs.zip';
const OUT_DIR = resolve(process.cwd(), 'data/gtfs');

/** Routes CruzSync models. Variants are kept so real-time trips still resolve. */
const KEEP_ROUTES = new Set(['11', '18', '19', '35', '18B', '19B', '35B', '35X']);

/** Minimal RFC 4180 parser -- METRO quotes stop names containing commas. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (c !== '\r') field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((r) => r.length > 1)
    .map((r) => {
      const o: Record<string, string> = {};
      header.forEach((h, i) => (o[h.trim()] = (r[i] ?? '').trim()));
      return o;
    });
}

async function loadFeed(): Promise<Map<string, string>> {
  const fromDirIdx = process.argv.indexOf('--from-dir');
  const files = new Map<string, string>();

  if (fromDirIdx !== -1) {
    const dir = resolve(process.argv[fromDirIdx + 1]);
    console.log(`Reading GTFS from ${dir}`);
    for (const name of [
      'agency.txt',
      'routes.txt',
      'trips.txt',
      'stops.txt',
      'stop_times.txt',
      'calendar.txt',
      'calendar_dates.txt',
      'shapes.txt',
      'feed_info.txt',
    ]) {
      const p = join(dir, name);
      if (existsSync(p)) files.set(name, readFileSync(p, 'utf8'));
    }
    return files;
  }

  console.log(`Downloading ${GTFS_URL} ...`);
  const res = await fetch(GTFS_URL);
  if (!res.ok) throw new Error(`GTFS download failed: HTTP ${res.status}`);
  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
  for (const entry of zip.getEntries()) {
    if (!entry.isDirectory) files.set(entry.entryName, entry.getData().toString('utf8'));
  }
  return files;
}

async function main() {
  const files = await loadFeed();
  const need = (n: string) => {
    const t = files.get(n);
    if (!t) throw new Error(`Missing ${n} in feed`);
    return parseCsv(t);
  };

  const feedInfo = need('feed_info.txt')[0] ?? {};
  const allRoutes = need('routes.txt');
  const allTrips = need('trips.txt');
  const allStops = need('stops.txt');
  const calendar = need('calendar.txt');
  const calendarDates = files.get('calendar_dates.txt')
    ? parseCsv(files.get('calendar_dates.txt')!)
    : [];

  const routes = allRoutes.filter((r) => KEEP_ROUTES.has(r.route_id));
  const routeIds = new Set(routes.map((r) => r.route_id));
  const trips = allTrips.filter((t) => routeIds.has(t.route_id));
  const tripIds = new Set(trips.map((t) => t.trip_id));

  // stop_times is the big one -- stream it line by line rather than parsing it all.
  const stRaw = files.get('stop_times.txt')!;
  const lines = stRaw.split(/\r?\n/);
  const header = lines[0].split(',').map((h) => h.trim());
  const col = (n: string) => header.indexOf(n);
  const iTrip = col('trip_id');
  const iArr = col('arrival_time');
  const iDep = col('departure_time');
  const iStop = col('stop_id');
  const iSeq = col('stop_sequence');
  const iPick = col('pickup_type');
  const iDrop = col('drop_off_type');

  const stopTimes: {
    trip_id: string;
    arrival_time: string;
    departure_time: string;
    stop_id: string;
    stop_sequence: number;
    pickup_type: string;
    drop_off_type: string;
  }[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // stop_times.txt has no quoted commas in this feed; a plain split is safe and fast.
    const v = line.split(',');
    const tripId = v[iTrip];
    if (!tripIds.has(tripId)) continue;
    stopTimes.push({
      trip_id: tripId,
      arrival_time: v[iArr],
      departure_time: v[iDep] || v[iArr],
      stop_id: v[iStop],
      stop_sequence: Number(v[iSeq]),
      pickup_type: v[iPick] ?? '',
      drop_off_type: v[iDrop] ?? '',
    });
  }

  const usedStopIds = new Set(stopTimes.map((s) => s.stop_id));
  const stops = allStops
    .filter((s) => usedStopIds.has(s.stop_id))
    .map((s) => ({
      stop_id: s.stop_id,
      stop_code: s.stop_code,
      stop_name: s.stop_name,
      stop_lat: Number(s.stop_lat),
      stop_lon: Number(s.stop_lon),
      wheelchair_boarding: s.wheelchair_boarding,
    }));

  // Keep one representative shape per (route, direction) so the map can draw the
  // legs without carrying the full 5.9MB shapes.txt.
  const shapesWanted = new Map<string, string>();
  for (const t of trips) {
    const key = `${t.route_id}:${t.direction_id}`;
    if (t.shape_id && !shapesWanted.has(key)) shapesWanted.set(key, t.shape_id);
  }
  const wantedShapeIds = new Set(shapesWanted.values());
  const shapePoints = new Map<string, { lat: number; lon: number; seq: number }[]>();
  if (files.get('shapes.txt')) {
    const sl = files.get('shapes.txt')!.split(/\r?\n/);
    const sh = sl[0].split(',').map((h) => h.trim());
    const sI = sh.indexOf('shape_id');
    const laI = sh.indexOf('shape_pt_lat');
    const loI = sh.indexOf('shape_pt_lon');
    const seI = sh.indexOf('shape_pt_sequence');
    for (let i = 1; i < sl.length; i++) {
      if (!sl[i]) continue;
      const v = sl[i].split(',');
      if (!wantedShapeIds.has(v[sI])) continue;
      if (!shapePoints.has(v[sI])) shapePoints.set(v[sI], []);
      shapePoints
        .get(v[sI])!
        .push({ lat: Number(v[laI]), lon: Number(v[loI]), seq: Number(v[seI]) });
    }
  }
  const shapes = [...shapesWanted.entries()].map(([key, shapeId]) => {
    const [routeId, directionId] = key.split(':');
    const pts = (shapePoints.get(shapeId) ?? []).sort((a, b) => a.seq - b.seq);
    // Thin dense shapes; the map does not need sub-metre fidelity.
    const step = Math.max(1, Math.floor(pts.length / 220));
    const thinned = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
    return {
      routeId,
      directionId: Number(directionId),
      shapeId,
      points: thinned.map((p) => [Number(p.lat.toFixed(5)), Number(p.lon.toFixed(5))]),
    };
  });

  mkdirSync(OUT_DIR, { recursive: true });
  const meta = {
    feedVersion: feedInfo.feed_version ?? 'unknown',
    feedStartDate: feedInfo.feed_start_date ?? '',
    feedEndDate: feedInfo.feed_end_date ?? '',
    publisher: feedInfo.feed_publisher_name ?? 'Santa Cruz METRO',
    builtAt: new Date().toISOString(),
    source: GTFS_URL,
    keptRoutes: [...routeIds].sort(),
    counts: {
      routes: routes.length,
      trips: trips.length,
      stops: stops.length,
      stopTimes: stopTimes.length,
      shapes: shapes.length,
    },
  };

  const write = (name: string, data: unknown) => {
    const p = join(OUT_DIR, name);
    writeFileSync(p, JSON.stringify(data));
    console.log(`  ${name.padEnd(18)} ${(readFileSync(p).length / 1024).toFixed(0)} KB`);
  };

  write('meta.json', meta);
  write(
    'routes.json',
    routes.map((r) => ({
      route_id: r.route_id,
      route_short_name: r.route_short_name,
      route_long_name: r.route_long_name,
      route_color: r.route_color,
      route_url: r.route_url,
    })),
  );
  write(
    'trips.json',
    trips.map((t) => ({
      trip_id: t.trip_id,
      route_id: t.route_id,
      service_id: t.service_id,
      trip_headsign: t.trip_headsign,
      direction_id: Number(t.direction_id),
      shape_id: t.shape_id,
      wheelchair_accessible: t.wheelchair_accessible,
    })),
  );
  write('stops.json', stops);
  // Tuple rows rather than objects: same data, ~3x smaller on disk and faster to
  // parse. Field order is declared in the file itself so it stays self-describing.
  write('stop_times.json', {
    fields: ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence', 'pickup_type', 'drop_off_type'],
    rows: stopTimes.map((s) => [
      s.trip_id,
      s.arrival_time,
      s.departure_time === s.arrival_time ? '' : s.departure_time,
      s.stop_id,
      s.stop_sequence,
      s.pickup_type === '0' ? '' : s.pickup_type,
      s.drop_off_type === '0' ? '' : s.drop_off_type,
    ]),
  });
  write('calendar.json', calendar);
  write('calendar_dates.json', calendarDates);
  write('shapes.json', shapes);

  console.log(`\nFeed ${meta.feedVersion} (${meta.feedStartDate}..${meta.feedEndDate})`);
  console.log(JSON.stringify(meta.counts));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
