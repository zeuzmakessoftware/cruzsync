/**
 * These assertions are pinned to facts independently verified against the raw
 * Santa Cruz METRO feed (feed_version S1000116). If a future feed genuinely
 * changes the network, these tests are supposed to fail loudly rather than let
 * CruzSync quietly give riders stale geography.
 */
import { describe, expect, it } from 'vitest';
import {
  activeServiceIds,
  getScheduledDepartures,
  getStop,
  getStopTimesForTrip,
  gtfsMeta,
  stopTimes,
  trips,
} from '@/lib/gtfs/feed';
import {
  agencyDateString,
  formatGtfsTime,
  parseGtfsTime,
  serviceDateTimeToEpochMs,
  shiftServiceDate,
} from '@/lib/gtfs/time';
import { CAMPUS_DESTINATIONS, RIVERFRONT, SCOTTS_VALLEY, findCampusDestination } from '@/lib/domain';

/** A Monday inside the feed's validity window (2026-06-18 .. 2026-09-09). */
const WEEKDAY = '20260720';
/** The Sunday of the same week. */
const SUNDAY = '20260726';

describe('static feed integrity', () => {
  it('bundles the pruned feed with the routes CruzSync models', () => {
    expect(gtfsMeta.feedVersion).toBeTruthy();
    for (const r of ['11', '18', '19', '35']) expect(gtfsMeta.keptRoutes).toContain(r);
    expect(stopTimes.length).toBeGreaterThan(10_000);
  });

  it('feed validity window covers the dates the tests pin to', () => {
    expect(WEEKDAY >= gtfsMeta.feedStartDate).toBe(true);
    expect(SUNDAY <= gtfsMeta.feedEndDate).toBe(true);
  });

  it('resolves the three distinct RiverFront boarding areas', () => {
    const a1 = getStop(RIVERFRONT.AREA_1.stopId);
    const a2 = getStop(RIVERFRONT.AREA_2.stopId);
    const a3 = getStop(RIVERFRONT.AREA_3.stopId);
    expect(a1?.stop_name).toBe('River St S. & Soquel Ave');
    expect(a2?.stop_name).toBe('Soquel Ave & Front');
    expect(a3?.stop_name).toBe('Front & Soquel Ave');
    // They must be three different stops, not aliases of one.
    expect(new Set([a1?.stop_id, a2?.stop_id, a3?.stop_id]).size).toBe(3);
  });

  it('knows the Scotts Valley origin', () => {
    expect(getStop(SCOTTS_VALLEY.stopId)?.stop_name).toContain('Cavallaro');
  });
});

describe('service day resolution', () => {
  it('picks weekday service on a Monday and weekend service on a Sunday', () => {
    const weekday = activeServiceIds(WEEKDAY);
    const sunday = activeServiceIds(SUNDAY);
    expect(weekday.size).toBeGreaterThan(0);
    expect(sunday.size).toBeGreaterThan(0);
    expect([...weekday].join()).not.toBe([...sunday].join());
  });

  it('parses and reformats past-midnight GTFS times without truncating them', () => {
    expect(parseGtfsTime('24:20:00')).toBe(87_600);
    expect(parseGtfsTime('08:15:00')).toBe(29_700);
    // 24:20 must render as the next day's 00:20, not as 24:20 or 12:20.
    expect(formatGtfsTime(87_600)).toBe('00:20');
  });

  it('places a 24:20 service-day time on the following calendar date', () => {
    const epoch = serviceDateTimeToEpochMs(WEEKDAY, parseGtfsTime('24:20:00'));
    expect(agencyDateString(epoch)).toBe(shiftServiceDate(WEEKDAY, 1));
  });
});

describe('the two legs of the commute', () => {
  it('Route 35 departs RiverFront Area 2 toward Scotts Valley on a weekday evening', () => {
    // 17:00 local, looking 7 hours ahead.
    const from = serviceDateTimeToEpochMs(WEEKDAY, 17 * 3600);
    const deps = getScheduledDepartures({
      stopId: RIVERFRONT.AREA_2.stopId,
      routeIds: ['35'],
      fromMs: from,
      windowMinutes: 420,
    }).filter((d) => d.directionId === 0);

    expect(deps.length).toBeGreaterThan(4);
    // Independently verified from the raw feed: 18:00, 18:30, 19:00, 19:30,
    // 20:00, then hourly 21:00, 22:00, 23:00.
    const clock = deps.map((d) =>
      formatGtfsTime(Math.round((d.departureEpochMs - serviceDateTimeToEpochMs(WEEKDAY, 0)) / 1000)),
    );
    expect(clock).toContain('18:00');
    expect(clock).toContain('18:30');
    expect(clock).toContain('21:00');
    expect(clock).toContain('22:00');
  });

  it('all three campus routes depart RiverFront Area 1, and none of them is Route 35', () => {
    const from = serviceDateTimeToEpochMs(WEEKDAY, 12 * 3600);
    const deps = getScheduledDepartures({
      stopId: RIVERFRONT.AREA_1.stopId,
      routeIds: ['11', '18', '19'],
      fromMs: from,
      windowMinutes: 120,
    });
    const seen = new Set(deps.map((d) => d.routeId));
    expect(seen).toEqual(new Set(['11', '18', '19']));
    expect(seen.has('35')).toBe(false);
  });

  it('campus route departures are staggered, which is why comparing them matters', () => {
    const from = serviceDateTimeToEpochMs(WEEKDAY, 12 * 3600);
    const deps = getScheduledDepartures({
      stopId: RIVERFRONT.AREA_1.stopId,
      routeIds: ['11', '18', '19'],
      fromMs: from,
      windowMinutes: 60,
    });
    const times = deps.map((d) => d.departureEpochMs).sort((a, b) => a - b);
    // Combined they are far more frequent than any single route.
    expect(times.length).toBeGreaterThanOrEqual(4);
    const gaps = times.slice(1).map((t, i) => (t - times[i]) / 60000);
    expect(Math.min(...gaps)).toBeLessThan(20);
  });

  it('Route 35 never departs from Area 1, so it can never be offered as a campus option', () => {
    const from = serviceDateTimeToEpochMs(WEEKDAY, 12 * 3600);
    const deps = getScheduledDepartures({
      stopId: RIVERFRONT.AREA_1.stopId,
      fromMs: from,
      windowMinutes: 240,
    });
    expect(deps.some((d) => d.routeId === '35')).toBe(false);
  });
});

describe('campus destination coverage is read from the feed, not assumed', () => {
  it('every declared destination stop is actually served by the routes claimed', () => {
    for (const dest of CAMPUS_DESTINATIONS) {
      for (const routeId of dest.servedBy) {
        const stopId = dest.stopIdByRoute[routeId];
        expect(stopId, `${dest.key} missing stop for route ${routeId}`).toBeTruthy();
        const routeTripIds = new Set(
          trips.filter((t) => t.route_id === routeId).map((t) => t.trip_id),
        );
        const served = [...routeTripIds].some((tid) =>
          getStopTimesForTrip(tid).some((st) => st.stop_id === stopId),
        );
        expect(served, `route ${routeId} does not serve ${dest.key} (${stopId})`).toBe(true);
      }
    }
  });

  it('Route 18 uses different stop ids than 11/19 because it runs the loop the other way', () => {
    const scienceHill = findCampusDestination('science-hill')!;
    expect(scienceHill.stopIdByRoute['11']).toBe(scienceHill.stopIdByRoute['19']);
    expect(scienceHill.stopIdByRoute['18']).not.toBe(scienceHill.stopIdByRoute['11']);
  });

  it('Crown & Merrill is Route 18 only; Kerr Hall is 11/19 only', () => {
    expect(findCampusDestination('crown-merrill')!.servedBy).toEqual(['18']);
    expect(findCampusDestination('kerr-hall')!.servedBy).toEqual(['11', '19']);
  });

  it('a route that does not serve a destination has no stop id for it', () => {
    const kerr = findCampusDestination('kerr-hall')!;
    expect(kerr.stopIdByRoute['18']).toBeUndefined();
  });
});
