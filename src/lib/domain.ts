/**
 * CruzSync domain constants.
 *
 * Every identifier in this file was verified against the Santa Cruz METRO static
 * GTFS feed (feed_version S1000116, valid 2026-06-18 .. 2026-09-09) rather than
 * assumed. See docs/architecture.md for how these were derived.
 *
 * CruzSync is an independent student project. It is not affiliated with,
 * endorsed by, or operated by Santa Cruz METRO.
 */

/** Bumped whenever the deterministic scoring maths changes. Surfaced in the UI. */
export const ENGINE_VERSION = "1.0.0";

export const AGENCY_TIMEZONE = "America/Los_Angeles";

/**
 * The three downtown "RiverFront" boarding areas.
 *
 * These are three genuinely distinct GTFS stops roughly 100m apart, not three
 * labels for one stop. Routes 11/18/19 run as downtown -> campus -> downtown
 * loops, which is why they depart from Area 1 but return to Area 3.
 */
export const RIVERFRONT = {
  /** Routes 11/18/19 DEPART here toward UCSC. */
  AREA_1: {
    stopId: "1726",
    stopCode: "2754",
    name: "River St S. & Soquel Ave",
    label: "RiverFront Area 1",
    role: "UCSC routes depart",
    lat: 36.973724,
    lon: -122.023796,
  },
  /** Route 35 both ARRIVES from and DEPARTS toward Scotts Valley here. */
  AREA_2: {
    stopId: "1466",
    stopCode: "2365",
    name: "Soquel Ave & Front",
    label: "RiverFront Area 2",
    role: "Route 35 arrives and departs",
    lat: 36.973484,
    lon: -122.024208,
  },
  /** Routes 11/18/19 ARRIVE here from UCSC. */
  AREA_3: {
    stopId: "1594",
    stopCode: "2667",
    name: "Front & Soquel Ave",
    label: "RiverFront Area 3",
    role: "UCSC routes arrive",
    lat: 36.97403,
    lon: -122.024796,
  },
} as const;

export type RiverfrontArea = (typeof RIVERFRONT)[keyof typeof RIVERFRONT];

export const RIVERFRONT_AREAS: RiverfrontArea[] = [
  RIVERFRONT.AREA_1,
  RIVERFRONT.AREA_2,
  RIVERFRONT.AREA_3,
];

/** Scotts Valley end of the Route 35 leg. */
export const SCOTTS_VALLEY = {
  stopId: "1569",
  stopCode: "SVTC",
  name: "Cavallaro Transit Center (Scotts Valley)",
  lat: 37.048939,
  lon: -122.027916,
} as const;

/** Route 35 is the Scotts Valley <-> downtown leg. It is never an alternative to 11/18/19. */
export const TRUNK_ROUTE_ID = "35";

/** The three campus routes. These compete with each other only, on the downtown -> UCSC leg. */
export const CAMPUS_ROUTE_IDS = ["11", "18", "19"] as const;
export type CampusRouteId = (typeof CAMPUS_ROUTE_IDS)[number];

export const ROUTE_META: Record<
  string,
  { shortName: string; longName: string; color: string }
> = {
  "35": {
    shortName: "35",
    longName: "Highway 9/Scotts Valley",
    color: "#0f5c8c",
  },
  "11": {
    shortName: "11",
    longName: "UCSC via West Gate - High",
    color: "#c2541c",
  },
  "18": {
    shortName: "18",
    longName: "UCSC via Main Gate - Mission",
    color: "#2f6f4f",
  },
  "19": {
    shortName: "19",
    longName: "UCSC via West Gate - Bay",
    color: "#7b3f8f",
  },
};

/**
 * UCSC destinations a rider can pick.
 *
 * `stopIdByRoute` was computed from stop_times.txt, not guessed. Two real facts
 * fall out of the data and they are the reason a three-way comparison is worth
 * doing at all:
 *
 *  1. Routes 11 and 19 run the campus loop in one direction (direction_id=1/0
 *     respectively, sharing stop ids 1597..1606) while Route 18 runs it the
 *     other way round (stop ids 1033..1361). The same physical destination is
 *     therefore a *different* GTFS stop depending on which bus you board, and
 *     it sits at a different point in the loop -- so ride time to a given
 *     destination genuinely differs by route rather than by a constant offset.
 *
 *  2. Coverage differs. Only Route 18 reaches Crown & Merrill, the East Field
 *     House and Family Student Housing. Only Routes 11 and 19 reach Kerr Hall.
 *     Picking a destination can eliminate options outright.
 */
export interface CampusDestination {
  key: string;
  name: string;
  /** Stop ids in the downtown -> campus direction, keyed by route. */
  stopIdByRoute: Partial<Record<CampusRouteId, string>>;
  servedBy: CampusRouteId[];
}

export const CAMPUS_DESTINATIONS: CampusDestination[] = [
  {
    key: "science-hill",
    name: "Science Hill",
    stopIdByRoute: { "11": "1601", "19": "1601", "18": "1168" },
    servedBy: ["11", "18", "19"],
  },
  {
    key: "kresge",
    name: "Kresge College",
    stopIdByRoute: { "11": "1600", "19": "1600", "18": "1118" },
    servedBy: ["11", "18", "19"],
  },
  {
    key: "bookstore-cowell-stevenson",
    name: "Bookstore, Cowell & Stevenson",
    stopIdByRoute: { "11": "1603", "19": "1603", "18": "1361" },
    servedBy: ["11", "18", "19"],
  },
  {
    key: "college-9-lewis",
    name: "College 9 & John R. Lewis",
    stopIdByRoute: { "11": "1602", "19": "1602", "18": "1169" },
    servedBy: ["11", "18", "19"],
  },
  {
    key: "rachel-carson-porter",
    name: "Rachel Carson College & Porter",
    stopIdByRoute: { "11": "1598", "19": "1598", "18": "1501" },
    servedBy: ["11", "18", "19"],
  },
  {
    key: "oakes",
    name: "Oakes College",
    stopIdByRoute: { "11": "1597", "19": "1597", "18": "1117" },
    servedBy: ["11", "18", "19"],
  },
  {
    key: "east-remote",
    name: "East Remote Parking",
    stopIdByRoute: { "11": "1604", "19": "1604", "18": "1116" },
    servedBy: ["11", "18", "19"],
  },
  {
    key: "lower-campus",
    name: "Lower Campus (Coolidge & Hagar)",
    stopIdByRoute: { "11": "1606", "19": "1606", "18": "1034" },
    servedBy: ["11", "18", "19"],
  },
  {
    key: "main-gate",
    name: "Main Gate (Bay & High)",
    stopIdByRoute: { "11": "1472", "19": "1472", "18": "1033" },
    servedBy: ["11", "18", "19"],
  },
  {
    // Route 18 only -- picking this destination legitimately eliminates 11 and 19.
    key: "crown-merrill",
    name: "Crown & Merrill College",
    stopIdByRoute: { "18": "1170" },
    servedBy: ["18"],
  },
  {
    // Route 18 only.
    key: "east-field-house",
    name: "East Field House",
    stopIdByRoute: { "18": "1360" },
    servedBy: ["18"],
  },
  {
    // Routes 11 and 19 only -- Route 18's loop direction never reaches it.
    key: "kerr-hall",
    name: "Kerr Hall",
    stopIdByRoute: { "11": "1599", "19": "1599" },
    servedBy: ["11", "19"],
  },
];

export function findCampusDestination(
  key: string,
): CampusDestination | undefined {
  return CAMPUS_DESTINATIONS.find((d) => d.key === key);
}

/**
 * Deterministic buffers. Deliberately conservative; all configurable via the
 * safe-wait calculator so a rider can trade risk for time explicitly.
 */
export const DEFAULTS = {
  /** Walking Area 2 -> Area 1 (outbound transfer) or Area 3 -> Area 2 (return). */
  interAreaWalkSeconds: 180,
  /** Time to actually get on the bus once you are physically at the stop. */
  boardingBufferSeconds: 120,
  /** Baseline padding for prediction error. Raised when evidence is weak. */
  baseUncertaintyBufferSeconds: 180,
  /** Below this, going anywhere is not worth it. */
  minimumUsefulVisitSeconds: 12 * 60,
  /** Real-time data older than this is shown as stale. */
  staleAfterSeconds: 90,
  /** Older than this and we stop treating it as evidence at all. */
  hardStaleAfterSeconds: 300,
  /** Straight-line distance is optimistic; scale it for real street networks. */
  walkingDetourFactor: 1.35,
  /** Metres per second for an unhurried walk. */
  walkingSpeedMps: 1.25,
  /** "Start wrapping up" fires this long before leave_by. */
  wrapUpLeadSeconds: 5 * 60,
} as const;
