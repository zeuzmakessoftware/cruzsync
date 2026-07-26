/**
 * Deterministic demo scenes.
 *
 * EVERYTHING IN THIS FILE IS LABELLED DEMO DATA. It is never presented as live.
 * The UI marks any value sourced from here with an explicit "demo" badge, and
 * `RealtimeSnapshot.origin` is set to 'fixture'.
 *
 * The scenes are anchored to real schedule facts from the committed GTFS feed
 * (feed_version S1000116), so the deterministic engine does genuine arithmetic
 * over a genuine timetable -- only the *real-time vehicle evidence* is fabricated,
 * because we cannot make METRO run a bus on demand while recording a video.
 *
 * Anchor day: Monday 2026-07-20 (weekday service).
 *
 *   Outbound scene, 08:03
 *     Route 35 trip 56020 is inbound, due RiverFront Area 2 at 08:10.
 *     From Area 1: Route 18 @ 08:15 (trip 1998020), Route 11 @ 08:20 (2147020),
 *     Route 19 @ 08:29 (214020). After a 3-minute inter-area walk the rider is at
 *     Area 1 around 08:13, which makes the 18 uncomfortably tight and leaves a
 *     real choice between the 11 and the 19.
 *
 *   Return scene, 20:12
 *     The rider is back at Area 3. Route 35 outbound from Area 2 runs 20:00 then
 *     21:00 -- the evening headway genuinely degrades from 30 to 60 minutes in
 *     the real timetable, producing a ~48 minute wait with no invention required.
 */
import { serviceDateTimeToEpochMs } from "@/lib/gtfs/time";
import type {
  NormalisedAlert,
  NormalisedTripUpdate,
  NormalisedVehicle,
  RealtimeSnapshot,
} from "@/lib/rt/types";

export const DEMO_SERVICE_DATE = "20260720";

const at = (h: number, m: number) =>
  serviceDateTimeToEpochMs(DEMO_SERVICE_DATE, h * 3600 + m * 60);

export type SceneId =
  "outbound-11-wins" | "outbound-11-ghost" | "return-long-wait";

export interface DemoScene {
  id: SceneId;
  title: string;
  /** First-person framing, in the creator's own voice. */
  narrative: string;
  /** The fixed clock this scene starts at. */
  anchorMs: number;
  direction: "to-campus" | "to-home";
  /** Default campus destination for the scene. */
  campusDestinationKey: string;
  build: (nowMs: number) => RealtimeSnapshot;
}

function vehicle(
  v: Partial<NormalisedVehicle> & { tripId: string; routeId: string },
  nowMs: number,
  ageSeconds: number,
): NormalisedVehicle {
  return {
    vehicleId: null,
    label: null,
    directionId: null,
    lat: null,
    lon: null,
    bearing: null,
    speedMps: null,
    currentStopId: null,
    currentStopSequence: null,
    currentStatus: "IN_TRANSIT_TO",
    occupancyStatus: null,
    ...v,
    timestampMs: nowMs - ageSeconds * 1000,
    ageSeconds,
  };
}

function tripUpdate(
  tripId: string,
  routeId: string,
  delaySec: number,
  nowMs: number,
  ageSeconds: number,
  stopTimeUpdates: NormalisedTripUpdate["stopTimeUpdates"] = [],
): NormalisedTripUpdate {
  return {
    tripId,
    routeId,
    directionId: null,
    startDate: DEMO_SERVICE_DATE,
    vehicleId: null,
    timestampMs: nowMs - ageSeconds * 1000,
    delaySec,
    scheduleRelationship: "SCHEDULED",
    stopTimeUpdates,
  };
}

function snapshot(
  nowMs: number,
  vehicles: NormalisedVehicle[],
  tripUpdates: NormalisedTripUpdate[],
  alerts: NormalisedAlert[],
): RealtimeSnapshot {
  return {
    vehicles,
    tripUpdates,
    alerts,
    freshness: {
      fetchedAtMs: nowMs,
      feedTimestampMs: nowMs - 8000,
      ageSeconds: 8,
      label: "fresh",
    },
    origin: "fixture",
    degradedReason: undefined,
    sources: [
      { name: "vehicles", url: "demo fixture", ok: true, fetchedAtMs: nowMs },
      { name: "trips", url: "demo fixture", ok: true, fetchedAtMs: nowMs },
      { name: "alerts", url: "demo fixture", ok: true, fetchedAtMs: nowMs },
    ],
  };
}

export const DEMO_SCENES: DemoScene[] = [
  {
    id: "outbound-11-wins",
    title: "Morning: which bus do I take at RiverFront?",
    narrative:
      "I'm on the 35 coming down Highway 9. It gets me to RiverFront Area 2 around 8:10. From Area 2 I still have to walk over to Area 1 and pick the 11, the 18 or the 19 to get to Science Hill.",
    anchorMs: at(8, 3),
    direction: "to-campus",
    campusDestinationKey: "science-hill",
    build: (nowMs) =>
      snapshot(
        nowMs,
        [
          // The 35 the rider is physically on, running two minutes late.
          vehicle(
            {
              tripId: "56020",
              routeId: "35",
              vehicleId: "1841",
              lat: 37.0102,
              lon: -122.0512,
              speedMps: 12.1,
              bearing: 190,
              occupancyStatus: "MANY_SEATS_AVAILABLE",
            },
            nowMs,
            18,
          ),
          // Route 11 has a live, recent position -- this is what earns it the recommendation.
          vehicle(
            {
              tripId: "2147020",
              routeId: "11",
              vehicleId: "1211",
              lat: 36.9761,
              lon: -122.0261,
              speedMps: 0,
              bearing: 95,
              occupancyStatus: "MANY_SEATS_AVAILABLE",
            },
            nowMs,
            34,
          ),
          // Route 19's bus is visible too, just further out and later.
          vehicle(
            {
              tripId: "214020",
              routeId: "19",
              vehicleId: "0322",
              lat: 36.9805,
              lon: -122.0301,
              speedMps: 8.4,
              bearing: 140,
              occupancyStatus: "FEW_SEATS_AVAILABLE",
            },
            nowMs,
            41,
          ),
          // Note: no vehicle is published for the 08:15 Route 18 trip. CruzSync
          // reports that as "no current vehicle position is visible", not as a
          // cancellation.
        ],
        [
          tripUpdate("56020", "35", 120, nowMs, 22),
          tripUpdate("2147020", "11", 0, nowMs, 30),
          tripUpdate("214020", "19", 60, nowMs, 45),
        ],
        [],
      ),
  },
  {
    id: "outbound-11-ghost",
    title: "Morning, harder: the 11 never turned up",
    narrative:
      "This is the gamble I actually live with. It's 8:22 and the 8:20 eleven simply never appeared -- no bus, no position, nothing. The next 11 isn't until 8:50. Do I keep waiting for the route I prefer, or take the 19 that I can actually see?",
    // Two minutes AFTER the 08:20 Route 11 was due. Nothing was ever published
    // for it, which is exactly what a ghost bus looks like in GTFS-Realtime.
    anchorMs: at(8, 22),
    direction: "to-campus",
    campusDestinationKey: "science-hill",
    build: (nowMs) =>
      snapshot(
        nowMs,
        [
          // The rider has already arrived downtown on the 35.
          // Route 19's 08:29 departure is visible and close.
          vehicle(
            {
              tripId: "214020",
              routeId: "19",
              vehicleId: "0322",
              lat: 36.9788,
              lon: -122.0269,
              speedMps: 6.2,
              bearing: 140,
              occupancyStatus: "FEW_SEATS_AVAILABLE",
            },
            nowMs,
            22,
          ),
          // The 08:45 Route 18 is also out there, further away.
          vehicle(
            {
              tripId: "1439020",
              routeId: "18",
              vehicleId: "0121",
              lat: 36.9942,
              lon: -122.0585,
              speedMps: 9.1,
              bearing: 210,
              occupancyStatus: "MANY_SEATS_AVAILABLE",
            },
            nowMs,
            37,
          ),
          // Deliberately absent: any vehicle for Route 11 trip 2147020 (the 08:20
          // that never came) or trip 1865020 (the 08:50). CruzSync must report
          // that as "no current vehicle position is visible", never as a
          // cancellation -- the feed has not said the trip was cancelled.
        ],
        [
          tripUpdate("214020", "19", 60, nowMs, 26),
          tripUpdate("1439020", "18", 0, nowMs, 41),
        ],
        [],
      ),
  },
  {
    id: "return-long-wait",
    title: "Evening: 48 minutes downtown before the 35",
    narrative:
      "I'm back at RiverFront Area 3 at 8:12 in the evening. The 35 home doesn't leave Area 2 until 9:00 because the evening service drops to hourly. That's the dead time I want back.",
    anchorMs: at(20, 12),
    direction: "to-home",
    campusDestinationKey: "science-hill",
    build: (nowMs) =>
      snapshot(
        nowMs,
        [
          // The 21:00 Route 35 hasn't been assigned a visible vehicle yet -- normal
          // this far ahead of departure, and CruzSync says so rather than guessing.
          vehicle(
            {
              tripId: "1062020",
              routeId: "35",
              vehicleId: "1511",
              lat: 37.0402,
              lon: -122.0221,
              speedMps: 9.7,
              bearing: 20,
              occupancyStatus: "MANY_SEATS_AVAILABLE",
            },
            nowMs,
            25,
          ),
        ],
        [tripUpdate("892020", "35", 0, nowMs, 55)],
        [],
      ),
  },
];

export function getScene(id: string): DemoScene | undefined {
  return DEMO_SCENES.find((s) => s.id === id);
}

export const DEFAULT_SCENE_ID: SceneId = "outbound-11-wins";
