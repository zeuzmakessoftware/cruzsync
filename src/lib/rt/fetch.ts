/**
 * GTFS-Realtime ingestion.
 *
 * Runs server-side only. The browser never sees protobuf, never deals with CORS
 * against rt.scmetro.org, and never holds an API key.
 *
 * Degradation policy, in order:
 *   1. Live fetch succeeds            -> origin 'live'
 *   2. Live fetch fails, cache exists -> origin 'cache', labelled with its age
 *   3. Neither                        -> origin 'fixture', explicitly demo data
 *
 * We never synthesise a plausible-looking "live" value. A missing vehicle is
 * reported as missing.
 */
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { DEFAULTS } from '@/lib/domain';
import type {
  Freshness,
  NormalisedAlert,
  NormalisedTripUpdate,
  NormalisedVehicle,
  RealtimeSnapshot,
} from './types';

export const RT_ENDPOINTS = {
  vehicles: 'https://rt.scmetro.org/gtfsrt/vehicles',
  trips: 'https://rt.scmetro.org/gtfsrt/trips',
  alerts: 'https://rt.scmetro.org/gtfsrt/alerts',
} as const;

export type RtFeedName = keyof typeof RT_ENDPOINTS;

/** protobufjs hands back Long|number|string for 64-bit fields. */
function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'object' && v !== null && 'toNumber' in v) {
    const n = (v as { toNumber(): number }).toNumber();
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Seconds -> ms, tolerating feeds that already use ms. */
function secondsToMs(v: unknown): number | null {
  const n = toNumber(v);
  if (n === null) return null;
  return n > 1e11 ? n : n * 1000;
}

export function computeFreshness(fetchedAtMs: number, feedTimestampMs: number | null, nowMs: number): Freshness {
  const reference = feedTimestampMs ?? fetchedAtMs;
  const ageSeconds = Math.max(0, Math.round((nowMs - reference) / 1000));
  const label: Freshness['label'] =
    ageSeconds <= DEFAULTS.staleAfterSeconds
      ? 'fresh'
      : ageSeconds <= DEFAULTS.hardStaleAfterSeconds
        ? 'stale'
        : 'expired';
  return { fetchedAtMs, feedTimestampMs, ageSeconds, label };
}

interface DecodedFeed {
  header: { timestampMs: number | null };
  entities: unknown[];
}

export function decodeFeedMessage(bytes: Uint8Array): DecodedFeed {
  const msg = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(bytes);
  const obj = GtfsRealtimeBindings.transit_realtime.FeedMessage.toObject(msg, {
    longs: String,
    enums: String,
    defaults: false,
  }) as { header?: { timestamp?: unknown }; entity?: unknown[] };
  return {
    header: { timestampMs: secondsToMs(obj.header?.timestamp) },
    entities: obj.entity ?? [],
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export function normaliseVehicles(entities: any[], fetchedAtMs: number): NormalisedVehicle[] {
  const out: NormalisedVehicle[] = [];
  for (const e of entities) {
    const v = e?.vehicle;
    if (!v) continue;
    const timestampMs = secondsToMs(v.timestamp);
    out.push({
      vehicleId: v.vehicle?.id ?? null,
      label: v.vehicle?.label ?? null,
      tripId: v.trip?.tripId ?? null,
      routeId: v.trip?.routeId ?? null,
      directionId: toNumber(v.trip?.directionId),
      lat: toNumber(v.position?.latitude),
      lon: toNumber(v.position?.longitude),
      bearing: toNumber(v.position?.bearing),
      speedMps: toNumber(v.position?.speed),
      currentStopId: v.stopId ?? null,
      currentStopSequence: toNumber(v.currentStopSequence),
      currentStatus: v.currentStatus ?? null,
      timestampMs,
      ageSeconds: timestampMs === null ? null : Math.max(0, Math.round((fetchedAtMs - timestampMs) / 1000)),
      // Agency-reported when present. Absent means unknown, never "empty".
      occupancyStatus: v.occupancyStatus ?? null,
    });
  }
  return out;
}

export function normaliseTripUpdates(entities: any[]): NormalisedTripUpdate[] {
  const out: NormalisedTripUpdate[] = [];
  for (const e of entities) {
    const tu = e?.tripUpdate;
    if (!tu) continue;
    out.push({
      tripId: tu.trip?.tripId ?? null,
      routeId: tu.trip?.routeId ?? null,
      directionId: toNumber(tu.trip?.directionId),
      startDate: tu.trip?.startDate ?? null,
      vehicleId: tu.vehicle?.id ?? null,
      timestampMs: secondsToMs(tu.timestamp),
      delaySec: toNumber(tu.delay),
      scheduleRelationship: tu.trip?.scheduleRelationship ?? null,
      stopTimeUpdates: (tu.stopTimeUpdate ?? []).map((s: any) => ({
        stopId: s.stopId ?? null,
        stopSequence: toNumber(s.stopSequence),
        arrivalTimeMs: secondsToMs(s.arrival?.time),
        departureTimeMs: secondsToMs(s.departure?.time),
        arrivalDelaySec: toNumber(s.arrival?.delay),
        departureDelaySec: toNumber(s.departure?.delay),
        scheduleRelationship: s.scheduleRelationship ?? null,
      })),
    });
  }
  return out;
}

function pickTranslation(t: any): string | null {
  const items = t?.translation;
  if (!Array.isArray(items) || items.length === 0) return null;
  const en = items.find((x: any) => (x.language ?? '').toLowerCase().startsWith('en'));
  return (en ?? items[0]).text ?? null;
}

export function normaliseAlerts(entities: any[]): NormalisedAlert[] {
  const out: NormalisedAlert[] = [];
  for (const e of entities) {
    const a = e?.alert;
    if (!a) continue;
    const informed = a.informedEntity ?? [];
    out.push({
      id: String(e.id ?? ''),
      cause: a.cause ?? null,
      effect: a.effect ?? null,
      headerText: pickTranslation(a.headerText),
      descriptionText: pickTranslation(a.descriptionText),
      url: pickTranslation(a.url),
      activePeriods: (a.activePeriod ?? []).map((p: any) => ({
        startMs: secondsToMs(p.start),
        endMs: secondsToMs(p.end),
      })),
      informedRouteIds: informed.map((i: any) => i.routeId).filter(Boolean),
      informedStopIds: informed.map((i: any) => i.stopId).filter(Boolean),
      informedTripIds: informed.map((i: any) => i.trip?.tripId).filter(Boolean),
    });
  }
  return out;
}

/* eslint-enable @typescript-eslint/no-explicit-any */

async function fetchOne(name: RtFeedName, signal?: AbortSignal): Promise<DecodedFeed> {
  const res = await fetch(RT_ENDPOINTS[name], {
    signal,
    cache: 'no-store',
    headers: { Accept: 'application/x-google-protobuf' },
  });
  if (!res.ok) throw new Error(`${name} feed returned HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error(`${name} feed returned an empty body`);
  return decodeFeedMessage(bytes);
}

/** Module-scoped last-good snapshot. Good enough for a single-instance demo. */
let lastGood: RealtimeSnapshot | null = null;

export function getCachedSnapshot(): RealtimeSnapshot | null {
  return lastGood;
}

/** Test seam. */
export function __setCachedSnapshot(s: RealtimeSnapshot | null) {
  lastGood = s;
}

export interface FetchSnapshotOptions {
  nowMs?: number;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchFeed?: (name: RtFeedName, signal?: AbortSignal) => Promise<DecodedFeed>;
}

/**
 * Fetches all three feeds concurrently and normalises them into one snapshot.
 * Partial failure is tolerated: if vehicles succeed but alerts fail we still
 * return what we have and record which source failed.
 */
export async function fetchRealtimeSnapshot(
  opts: FetchSnapshotOptions = {},
): Promise<RealtimeSnapshot> {
  const nowMs = opts.nowMs ?? Date.now();
  const timeoutMs = opts.timeoutMs ?? 8000;
  const doFetch = opts.fetchFeed ?? fetchOne;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const names: RtFeedName[] = ['vehicles', 'trips', 'alerts'];
  const settled = await Promise.allSettled(
    names.map((n) => doFetch(n, controller.signal)),
  );
  clearTimeout(timer);

  const sources = names.map((name, i) => ({
    name,
    url: RT_ENDPOINTS[name],
    ok: settled[i].status === 'fulfilled',
    fetchedAtMs: settled[i].status === 'fulfilled' ? nowMs : null,
  }));

  const okCount = sources.filter((s) => s.ok).length;
  if (okCount === 0) {
    const reason =
      settled
        .map((s) => (s.status === 'rejected' ? String(s.reason?.message ?? s.reason) : null))
        .filter(Boolean)
        .join('; ') || 'all real-time feeds unavailable';
    if (lastGood) {
      return {
        ...lastGood,
        origin: 'cache',
        degradedReason: `Live feeds unreachable (${reason}). Showing the last successful snapshot.`,
        freshness: computeFreshness(
          lastGood.freshness.fetchedAtMs,
          lastGood.freshness.feedTimestampMs,
          nowMs,
        ),
        sources,
      };
    }
    throw new RealtimeUnavailableError(reason);
  }

  const get = (i: number) => (settled[i].status === 'fulfilled' ? (settled[i] as PromiseFulfilledResult<DecodedFeed>).value : null);
  const vehiclesFeed = get(0);
  const tripsFeed = get(1);
  const alertsFeed = get(2);

  const feedTimestampMs =
    vehiclesFeed?.header.timestampMs ??
    tripsFeed?.header.timestampMs ??
    alertsFeed?.header.timestampMs ??
    null;

  const snapshot: RealtimeSnapshot = {
    vehicles: normaliseVehicles((vehiclesFeed?.entities ?? []) as never[], nowMs),
    tripUpdates: normaliseTripUpdates((tripsFeed?.entities ?? []) as never[]),
    alerts: normaliseAlerts((alertsFeed?.entities ?? []) as never[]),
    freshness: computeFreshness(nowMs, feedTimestampMs, nowMs),
    origin: 'live',
    degradedReason:
      okCount < names.length
        ? `Partial feed outage: ${sources.filter((s) => !s.ok).map((s) => s.name).join(', ')} unavailable.`
        : undefined,
    sources,
  };

  lastGood = snapshot;
  return snapshot;
}

export class RealtimeUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RealtimeUnavailableError';
  }
}
