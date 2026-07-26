/**
 * Loads the pruned static GTFS committed under data/gtfs and answers schedule
 * questions against it.
 *
 * Everything here is pure and synchronous -- the data is bundled, so there is no
 * network dependency and the tests can exercise real schedules rather than mocks.
 */
import metaJson from '@data/gtfs/meta.json';
import routesJson from '@data/gtfs/routes.json';
import tripsJson from '@data/gtfs/trips.json';
import stopsJson from '@data/gtfs/stops.json';
import stopTimesJson from '@data/gtfs/stop_times.json';
import calendarJson from '@data/gtfs/calendar.json';
import calendarDatesJson from '@data/gtfs/calendar_dates.json';
import shapesJson from '@data/gtfs/shapes.json';

import type {
  GtfsCalendar,
  GtfsCalendarDate,
  GtfsMeta,
  GtfsRoute,
  GtfsShape,
  GtfsStop,
  GtfsStopTime,
  GtfsTrip,
  ScheduledDeparture,
} from './types';
import {
  agencyDateString,
  agencyDayOfWeek,
  parseGtfsTime,
  serviceDateTimeToEpochMs,
  shiftServiceDate,
} from './time';

export const gtfsMeta = metaJson as GtfsMeta;
export const routes = routesJson as GtfsRoute[];
export const trips = tripsJson as GtfsTrip[];
export const stops = stopsJson as GtfsStop[];
export const calendar = calendarJson as unknown as GtfsCalendar[];
export const calendarDates = calendarDatesJson as unknown as GtfsCalendarDate[];
export const shapes = shapesJson as GtfsShape[];

const stopTimesRaw = stopTimesJson as { fields: string[]; rows: (string | number)[][] };

/** Decoded once at module load; the tuple encoding is purely an on-disk concern. */
export const stopTimes: GtfsStopTime[] = stopTimesRaw.rows.map((r) => {
  const arrival = parseGtfsTime(String(r[1]));
  const depRaw = String(r[2]);
  return {
    trip_id: String(r[0]),
    arrivalSec: arrival,
    departureSec: depRaw === '' ? arrival : parseGtfsTime(depRaw),
    stop_id: String(r[3]),
    stop_sequence: Number(r[4]),
    pickup_type: String(r[5] ?? ''),
    drop_off_type: String(r[6] ?? ''),
  };
});

export const tripsById = new Map(trips.map((t) => [t.trip_id, t]));
export const stopsById = new Map(stops.map((s) => [s.stop_id, s]));
export const routesById = new Map(routes.map((r) => [r.route_id, r]));

const stopTimesByStop = new Map<string, GtfsStopTime[]>();
const stopTimesByTrip = new Map<string, GtfsStopTime[]>();
for (const st of stopTimes) {
  let a = stopTimesByStop.get(st.stop_id);
  if (!a) stopTimesByStop.set(st.stop_id, (a = []));
  a.push(st);
  let b = stopTimesByTrip.get(st.trip_id);
  if (!b) stopTimesByTrip.set(st.trip_id, (b = []));
  b.push(st);
}
for (const list of stopTimesByTrip.values()) list.sort((x, y) => x.stop_sequence - y.stop_sequence);

export function getStopTimesForTrip(tripId: string): GtfsStopTime[] {
  return stopTimesByTrip.get(tripId) ?? [];
}

export function getStop(stopId: string): GtfsStop | undefined {
  return stopsById.get(stopId);
}

const DAY_FIELDS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

/**
 * Service ids running on a YYYYMMDD date, honouring both calendar.txt ranges and
 * calendar_dates.txt exceptions (type 1 adds, type 2 removes).
 */
export function activeServiceIds(serviceDate: string): Set<string> {
  const dow = agencyDayOfWeek(serviceDateTimeToEpochMs(serviceDate, 12 * 3600));
  const active = new Set<string>();
  for (const c of calendar) {
    if (serviceDate < c.start_date || serviceDate > c.end_date) continue;
    if (c[DAY_FIELDS[dow]] === '1') active.add(c.service_id);
  }
  for (const ex of calendarDates) {
    if (ex.date !== serviceDate) continue;
    if (ex.exception_type === '1') active.add(ex.service_id);
    else if (ex.exception_type === '2') active.delete(ex.service_id);
  }
  return active;
}

export interface DepartureQuery {
  stopId: string;
  /** Restrict to these route ids. Omit for all routes in the pruned feed. */
  routeIds?: readonly string[];
  /** Window start, epoch ms. */
  fromMs: number;
  /** How far ahead to look. */
  windowMinutes: number;
  /** Exclude stop events where GTFS says no pickup is possible. */
  requirePickup?: boolean;
}

/**
 * Scheduled departures from a stop inside a time window.
 *
 * Both today's and yesterday's service days are scanned, because a trip listed
 * at 24:20:00 yesterday is still running at 00:20 today.
 */
export function getScheduledDepartures(q: DepartureQuery): ScheduledDeparture[] {
  const toMs = q.fromMs + q.windowMinutes * 60_000;
  const today = agencyDateString(q.fromMs);
  const candidates = [shiftServiceDate(today, -1), today, shiftServiceDate(today, 1)];
  const routeFilter = q.routeIds ? new Set(q.routeIds) : null;
  const atStop = stopTimesByStop.get(q.stopId) ?? [];
  const out: ScheduledDeparture[] = [];

  for (const serviceDate of candidates) {
    const services = activeServiceIds(serviceDate);
    if (services.size === 0) continue;
    for (const st of atStop) {
      const trip = tripsById.get(st.trip_id);
      if (!trip || !services.has(trip.service_id)) continue;
      if (routeFilter && !routeFilter.has(trip.route_id)) continue;
      if (q.requirePickup !== false && st.pickup_type === '1') continue;
      const departureEpochMs = serviceDateTimeToEpochMs(serviceDate, st.departureSec);
      if (departureEpochMs < q.fromMs || departureEpochMs > toMs) continue;
      out.push({
        tripId: st.trip_id,
        routeId: trip.route_id,
        serviceId: trip.service_id,
        directionId: trip.direction_id,
        headsign: trip.trip_headsign,
        stopId: st.stop_id,
        stopSequence: st.stop_sequence,
        departureEpochMs,
        arrivalEpochMs: serviceDateTimeToEpochMs(serviceDate, st.arrivalSec),
        serviceDate,
      });
    }
  }
  // A trip can theoretically appear from two service days; keep it once.
  const seen = new Set<string>();
  return out
    .filter((d) => {
      const key = `${d.tripId}:${d.stopSequence}:${d.departureEpochMs}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.departureEpochMs - b.departureEpochMs);
}

/**
 * Scheduled arrival of a given trip at a downstream stop, as epoch ms.
 * Returns undefined when the trip does not serve that stop at all -- which is
 * how "Route 18 never reaches Kerr Hall" surfaces as a fact rather than a guess.
 */
export function getTripArrivalAtStop(
  tripId: string,
  stopId: string,
  serviceDate: string,
): number | undefined {
  const st = getStopTimesForTrip(tripId).find((s) => s.stop_id === stopId);
  if (!st) return undefined;
  return serviceDateTimeToEpochMs(serviceDate, st.arrivalSec);
}

/** Whether a trip serves `stopId` after `afterSequence`. */
export function tripServesStopAfter(
  tripId: string,
  stopId: string,
  afterSequence: number,
): boolean {
  return getStopTimesForTrip(tripId).some(
    (s) => s.stop_id === stopId && s.stop_sequence > afterSequence,
  );
}

export function getShapesForRoute(routeId: string): GtfsShape[] {
  return shapes.filter((s) => s.routeId === routeId);
}
