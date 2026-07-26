import { describe, expect, it } from 'vitest';
import { closingTimeMinutes, isOpenThrough, minutesOfDay, parseOpeningHours } from '@/lib/places/hours';
import { mapOverpassElement } from '@/lib/places/overpass';
import { mapGoogleHours, mapGooglePlace } from '@/lib/places/googlePlaces';
import { rankWaitPlaces, stayNearStopAdvice } from '@/lib/places/rank';
import { getFixturePlaces } from '@/lib/places/provider';
import { NO_FILTERS, type PlaceFilters, type WaitPlace } from '@/lib/places/types';
import { RIVERFRONT } from '@/lib/domain';
import { serviceDateTimeToEpochMs } from '@/lib/gtfs/time';

const D = '20260720'; // Monday
const at = (h: number, m: number) => serviceDateTimeToEpochMs(D, h * 3600 + m * 60);
const MONDAY = 1;

const boardingStop = {
  lat: RIVERFRONT.AREA_2.lat,
  lon: RIVERFRONT.AREA_2.lon,
  name: RIVERFRONT.AREA_2.label,
};

function place(over: Partial<WaitPlace> = {}): WaitPlace {
  return {
    id: 'test:1',
    name: 'Test Café',
    // ~250 m from Area 2, a short walk.
    lat: RIVERFRONT.AREA_2.lat + 0.002,
    lon: RIVERFRONT.AREA_2.lon,
    category: 'cafe',
    categoryLabel: 'Café',
    source: 'openstreetmap',
    businessStatus: 'unknown',
    website: null,
    address: null,
    hours: parseOpeningHours('Mo-Su 07:00-21:00', MONDAY, 'openstreetmap', at(20, 0)),
    hasWifi: 'unknown',
    hasRestroom: 'unknown',
    wheelchairAccessible: 'unknown',
    isIndoor: true,
    isQuiet: 'unknown',
    servesFood: 'unknown',
    freeToEnter: 'unknown',
    locallyOwned: 'unknown',
    priceLevel: null,
    sponsored: false,
    ...over,
  };
}

const rank = (places: WaitPlace[], filters: PlaceFilters = NO_FILTERS, nowMs = at(20, 12)) =>
  rankWaitPlaces({
    places,
    boardingStop,
    nowMs,
    predictedDepartureMs: at(21, 0),
    filters,
  });

/* ------------------------------------------------------------------ */

describe('opening hours parsing', () => {
  it('parses a simple all-week range', () => {
    const h = parseOpeningHours('Mo-Su 09:00-21:00', MONDAY, 'openstreetmap', 0);
    expect(h.parsed).toBe(true);
    expect(h.todayWindows).toEqual([{ openMin: 9 * 60, closeMin: 21 * 60 }]);
  });

  it('parses day lists and multiple windows', () => {
    const h = parseOpeningHours('Tu-Th,Su 16:00-20:00', 4 /* Thursday */, 'openstreetmap', 0);
    expect(h.parsed).toBe(true);
    expect(h.todayWindows).toEqual([{ openMin: 16 * 60, closeMin: 20 * 60 }]);
  });

  it('a day not mentioned in a parsed rule means closed, not unknown', () => {
    // Th-Mo means Tuesday is not covered.
    const h = parseOpeningHours('Th-Mo 09:00-16:00', 2 /* Tuesday */, 'openstreetmap', 0);
    expect(h.parsed).toBe(true);
    expect(h.todayWindows).toEqual([]);
  });

  it('handles a window that wraps past midnight', () => {
    const h = parseOpeningHours('Mo-Su 18:00-02:00', MONDAY, 'openstreetmap', 0);
    expect(h.todayWindows[0].closeMin).toBeGreaterThan(24 * 60);
  });

  it('handles 24/7', () => {
    const h = parseOpeningHours('24/7', MONDAY, 'openstreetmap', 0);
    expect(h.parsed).toBe(true);
    expect(h.todayWindows[0]).toEqual({ openMin: 0, closeMin: 1440 });
  });

  it('refuses to guess at expressions it does not fully understand', () => {
    for (const expr of ['Mo-Fr 09:00-17:00; PH off', 'sunrise-sunset', 'Jan-Mar 10:00-16:00']) {
      expect(parseOpeningHours(expr, MONDAY, 'openstreetmap', 0).parsed, expr).toBe(false);
    }
  });

  it('missing hours are unparsed rather than assumed open', () => {
    const h = parseOpeningHours(null, MONDAY, 'openstreetmap', 0);
    expect(h.parsed).toBe(false);
    expect(h.todayWindows).toEqual([]);
  });
});

describe('isOpenThrough never coerces unknown into open', () => {
  it('returns unknown when hours could not be parsed', () => {
    const h = parseOpeningHours('sunrise-sunset', MONDAY, 'openstreetmap', 0);
    expect(isOpenThrough(h, 20 * 60, 21 * 60)).toBe('unknown');
  });

  it('returns unknown when there are no hours at all', () => {
    expect(isOpenThrough(null, 20 * 60, 21 * 60)).toBe('unknown');
  });

  it('returns false when the place closes before leave-by', () => {
    const h = parseOpeningHours('Mo-Su 07:00-20:30', MONDAY, 'openstreetmap', 0);
    expect(isOpenThrough(h, 20 * 60, 20 * 60 + 45)).toBe(false);
  });

  it('returns true only when the whole window is covered', () => {
    const h = parseOpeningHours('Mo-Su 07:00-21:00', MONDAY, 'openstreetmap', 0);
    expect(isOpenThrough(h, 20 * 60, 20 * 60 + 45)).toBe(true);
  });

  it('reports the closing time of the current window', () => {
    const h = parseOpeningHours('Mo-Su 07:00-21:00', MONDAY, 'openstreetmap', 0);
    expect(closingTimeMinutes(h, 20 * 60)).toBe(21 * 60);
  });

  it('minutesOfDay reads the agency timezone, not the host timezone', () => {
    expect(minutesOfDay(at(20, 12))).toBe(20 * 60 + 12);
  });
});

/* ------------------------------------------------------------------ */

describe('amenities are never inferred from the venue category', () => {
  it('an OSM café with no amenity tags reports unknown for everything subjective', () => {
    const p = mapOverpassElement(
      { type: 'node', id: 1, lat: 36.97, lon: -122.02, tags: { name: 'Anon Café', amenity: 'cafe' } },
      Date.now(),
    )!;
    expect(p.hasWifi).toBe('unknown');
    expect(p.hasRestroom).toBe('unknown');
    expect(p.wheelchairAccessible).toBe('unknown');
    expect(p.isQuiet).toBe('unknown');
    expect(p.freeToEnter).toBe('unknown');
    expect(p.locallyOwned).toBe('unknown');
  });

  it('explicit OSM tags are honoured in both directions', () => {
    const p = mapOverpassElement(
      {
        type: 'node',
        id: 2,
        lat: 36.97,
        lon: -122.02,
        tags: {
          name: 'Tagged Café',
          amenity: 'cafe',
          internet_access: 'wlan',
          wheelchair: 'no',
          toilets: 'customers',
        },
      },
      Date.now(),
    )!;
    expect(p.hasWifi).toBe(true);
    expect(p.wheelchairAccessible).toBe(false);
    expect(p.hasRestroom).toBe(true);
  });

  it('a park is known to be outdoors and free, which the tags do determine', () => {
    const p = mapOverpassElement(
      { type: 'way', id: 3, center: { lat: 36.97, lon: -122.02 }, tags: { name: 'A Park', leisure: 'park' } },
      Date.now(),
    )!;
    expect(p.isIndoor).toBe(false);
    expect(p.freeToEnter).toBe(true);
    // Still unknown: quietness and Wi-Fi are not implied by being a park.
    expect(p.isQuiet).toBe('unknown');
    expect(p.hasWifi).toBe('unknown');
  });

  it('a branded venue is recorded as not locally owned', () => {
    const p = mapOverpassElement(
      { type: 'node', id: 4, lat: 36.97, lon: -122.02, tags: { name: 'Chain', amenity: 'cafe', brand: 'Chain' } },
      Date.now(),
    )!;
    expect(p.locallyOwned).toBe(false);
  });

  it('an unnamed element is discarded rather than shown as a blank card', () => {
    expect(
      mapOverpassElement({ type: 'node', id: 5, lat: 36.97, lon: -122.02, tags: { amenity: 'cafe' } }, Date.now()),
    ).toBeNull();
  });

  it('Google Places results also keep quietness and Wi-Fi unknown', () => {
    const p = mapGooglePlace(
      {
        id: 'g1',
        displayName: { text: 'G Café' },
        location: { latitude: 36.97, longitude: -122.02 },
        primaryType: 'cafe',
        businessStatus: 'OPERATIONAL',
        accessibilityOptions: { wheelchairAccessibleEntrance: true },
      },
      Date.now(),
    )!;
    expect(p.hasWifi).toBe('unknown');
    expect(p.isQuiet).toBe('unknown');
    expect(p.locallyOwned).toBe('unknown');
    // Google does report this one.
    expect(p.wheelchairAccessible).toBe(true);
  });

  it('maps Google structured periods to the right day', () => {
    const h = mapGoogleHours(
      {
        periods: [
          { open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 21, minute: 0 } },
          { open: { day: 2, hour: 10, minute: 0 }, close: { day: 2, hour: 18, minute: 0 } },
        ],
      },
      1,
      Date.now(),
    )!;
    expect(h.todayWindows).toEqual([{ openMin: 540, closeMin: 1260 }]);
  });
});

/* ------------------------------------------------------------------ */

describe('feasibility gating', () => {
  it('recommends a place that is open through leave-by', () => {
    const [c] = rank([place()]);
    expect(c.feasible).toBe(true);
    expect(c.checks.openThroughLeaveBy).toBe(true);
    expect(c.usableWaitSeconds).toBeGreaterThan(0);
  });

  it('rejects a business that closes before the rider must leave', () => {
    // Leave-by lands near 20:49; this place shuts at 20:30.
    const [c] = rank([place({ hours: parseOpeningHours('Mo-Su 07:00-20:30', MONDAY, 'openstreetmap', 0) })]);
    expect(c.feasible).toBe(false);
    expect(c.blockedReasons.join(' ')).toMatch(/Closes at/);
  });

  it('never marks a place with unverifiable hours as safe to visit', () => {
    const [c] = rank([place({ hours: parseOpeningHours(null, MONDAY, 'openstreetmap', 0) })]);
    expect(c.checks.openThroughLeaveBy).toBe('unknown');
    expect(c.feasible).toBe(false);
    expect(c.reasons.join(' ')).toMatch(/cannot confirm/);
  });

  it('an unparseable hours string is treated as unknown, not as open', () => {
    const [c] = rank([place({ hours: parseOpeningHours('sunrise-sunset', MONDAY, 'openstreetmap', 0) })]);
    expect(c.feasible).toBe(false);
    expect(c.reasons.join(' ')).toMatch(/could not be interpreted/);
  });

  it('rejects a place when there is not enough usable time left', () => {
    const [c] = rank([place()], NO_FILTERS, at(20, 50)); // only 10 min to 21:00
    expect(c.feasible).toBe(false);
    expect(c.blockedReasons.join(' ')).toMatch(/usable minutes/);
  });

  it('drops permanently closed venues entirely', () => {
    expect(rank([place({ businessStatus: 'CLOSED_PERMANENTLY' })])).toHaveLength(0);
  });

  it('flags a temporarily closed venue rather than recommending it', () => {
    const [c] = rank([place({ businessStatus: 'CLOSED_TEMPORARILY' })]);
    expect(c.feasible).toBe(false);
  });

  it('a longer walk reduces usable time and pulls leave-by earlier', () => {
    const near = rank([place()])[0];
    const far = rank([place({ lat: RIVERFRONT.AREA_2.lat + 0.02 })])[0];
    expect(far.usableWaitSeconds).toBeLessThan(near.usableWaitSeconds);
    expect(far.leaveByMs).toBeLessThan(near.leaveByMs);
  });

  it('walking time is reported as estimated when no routing provider is configured', () => {
    expect(rank([place()])[0].walk.estimated).toBe(true);
    expect(rank([place()])[0].walk.provider).toBe('haversine-estimate');
  });
});

describe('rider filters', () => {
  it('a required amenity recorded as absent blocks the place', () => {
    const [c] = rank([place({ wheelchairAccessible: false })], {
      ...NO_FILTERS,
      requireWheelchairAccess: true,
    });
    expect(c.feasible).toBe(false);
    expect(c.blockedReasons.join(' ')).toMatch(/step-free access/);
  });

  it('an unknown amenity warns instead of silently passing or silently failing', () => {
    const [c] = rank([place({ hasWifi: 'unknown' })], { ...NO_FILTERS, requireWifi: true });
    expect(c.checks.matchesFilters).toBe(true);
    expect(c.reasons.join(' ')).toMatch(/not recorded/);
  });

  it('a satisfied requirement passes cleanly', () => {
    const [c] = rank([place({ hasWifi: true })], { ...NO_FILTERS, requireWifi: true });
    expect(c.feasible).toBe(true);
  });
});

describe('ranking integrity', () => {
  it('sponsorship changes neither feasibility nor rank', () => {
    const plain = place({ id: 'a', name: 'Plain' });
    const sponsoredNear = place({ id: 'b', name: 'Sponsored', sponsored: true });
    const ranked = rank([plain, sponsoredNear]);
    // Identical inputs apart from the flag, so scores must match exactly.
    expect(ranked[0].score).toBe(ranked[1].score);
    const sponsored = ranked.find((c) => c.place.sponsored)!;
    expect(sponsored.reasons.join(' ')).toMatch(/does not affect/);
  });

  it('feasible places always sort above infeasible ones', () => {
    const ranked = rank([
      place({ id: 'closed', name: 'Closed', hours: parseOpeningHours('Mo-Su 07:00-20:15', MONDAY, 'openstreetmap', 0) }),
      place({ id: 'open', name: 'Open' }),
    ]);
    expect(ranked[0].feasible).toBe(true);
    expect(ranked[ranked.length - 1].feasible).toBe(false);
  });

  it('the summary states concrete, checkable facts', () => {
    const [c] = rank([place()]);
    expect(c.summary).toMatch(/\d+-min walk/);
    expect(c.summary).toMatch(/open until/);
    expect(c.summary).toMatch(/usable minutes/);
  });

  it('the stay-near-stop fallback explains itself', () => {
    const advice = stayNearStopAdvice(RIVERFRONT.AREA_2.label, 'Hours could not be verified.');
    expect(advice).toContain(RIVERFRONT.AREA_2.label);
    expect(advice).toContain('Hours could not be verified.');
  });
});

/* ------------------------------------------------------------------ */

describe('the committed places fixture', () => {
  it('contains real downtown venues captured from OpenStreetMap', () => {
    const places = getFixturePlaces(at(20, 12));
    expect(places.length).toBeGreaterThan(5);
    expect(places.some((p) => p.name.includes('Bookshop Santa Cruz'))).toBe(true);
  });

  it('re-resolves hours for the day being asked about, not the capture day', () => {
    // Mariposa Coffee Bar is tagged Th-Mo, so Tuesday must differ from Monday.
    const monday = getFixturePlaces(at(20, 12)).find((p) => p.name.includes('Mariposa'));
    const tuesday = getFixturePlaces(serviceDateTimeToEpochMs('20260721', 20 * 3600)).find((p) =>
      p.name.includes('Mariposa'),
    );
    if (monday?.hours?.parsed && tuesday?.hours?.parsed) {
      expect(monday.hours.todayWindows).not.toEqual(tuesday.hours.todayWindows);
    }
  });

  it('at 8:12 PM only genuinely late-opening venues survive the leave-by test', () => {
    const ranked = rank(getFixturePlaces(at(20, 12)));
    const feasible = ranked.filter((c) => c.feasible);
    expect(feasible.length).toBeGreaterThan(0);
    // Venues that really do shut earlier must be excluded with a stated reason.
    const verve = ranked.find((c) => c.place.name.includes('Verve'));
    if (verve) {
      expect(verve.feasible).toBe(false);
      expect(verve.blockedReasons.length).toBeGreaterThan(0);
    }
  });
});
