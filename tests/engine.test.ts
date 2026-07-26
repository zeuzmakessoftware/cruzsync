import { describe, expect, it } from "vitest";
import {
  analyzeRouteEvidence,
  findRelevantAlerts,
  isAlertActive,
} from "@/lib/engine/evidence";
import { computeFreshness } from "@/lib/rt/fetch";
import { analyzeHeadway } from "@/lib/engine/headway";
import {
  buildMultilegTrip,
  buildReturnTrip,
  compareUcscOptions,
} from "@/lib/engine/multileg";
import {
  calculateSafeWait,
  deriveUncertaintyBuffer,
  estimateWalkSeconds,
  haversineMetres,
} from "@/lib/engine/safewait";
import { DEFAULT_PREFERENCES, type RiderPreferences } from "@/lib/engine/types";
import { RIVERFRONT, DEFAULTS } from "@/lib/domain";
import { serviceDateTimeToEpochMs } from "@/lib/gtfs/time";
import type { NormalisedAlert, RealtimeSnapshot } from "@/lib/rt/types";
import { DEMO_SCENES, DEMO_SERVICE_DATE, getScene } from "@fixtures/scenes";

const D = DEMO_SERVICE_DATE; // Monday 2026-07-20
const at = (h: number, m: number) =>
  serviceDateTimeToEpochMs(D, h * 3600 + m * 60);

function emptySnapshot(nowMs: number, ageSeconds = 5): RealtimeSnapshot {
  return {
    vehicles: [],
    tripUpdates: [],
    alerts: [],
    // Use the real freshness classifier so the helper cannot drift from the
    // thresholds the engine actually applies.
    freshness: computeFreshness(nowMs, nowMs - ageSeconds * 1000, nowMs),
    origin: "live",
    sources: [],
  };
}

const prefs = (p: Partial<RiderPreferences> = {}): RiderPreferences => ({
  ...DEFAULT_PREFERENCES,
  ...p,
});

/* ------------------------------------------------------------------ */
/* Evidence scoring                                                     */
/* ------------------------------------------------------------------ */

describe("route evidence scoring", () => {
  const now = at(8, 3);
  const scheduled = at(8, 20);

  it("scores a schedule-only trip below one with a fresh vehicle", () => {
    const scheduleOnly = analyzeRouteEvidence({
      snapshot: emptySnapshot(now),
      routeId: "11",
      tripId: "2147020",
      stopId: RIVERFRONT.AREA_1.stopId,
      scheduledDepartureMs: scheduled,
      nowMs: now,
    });

    const observed = analyzeRouteEvidence({
      snapshot: getScene("outbound-11-wins")!.build(now),
      routeId: "11",
      tripId: "2147020",
      stopId: RIVERFRONT.AREA_1.stopId,
      scheduledDepartureMs: scheduled,
      nowMs: now,
    });

    expect(scheduleOnly.label).toBe("scheduled-only");
    expect(observed.label).toBe("observed");
    expect(observed.confidence).toBeGreaterThan(scheduleOnly.confidence);
    expect(observed.vehicleVisible).toBe(true);
    expect(scheduleOnly.vehicleVisible).toBe(false);
  });

  it("never describes a missing vehicle as a cancellation", () => {
    const ev = analyzeRouteEvidence({
      snapshot: emptySnapshot(now),
      routeId: "18",
      tripId: "1998020",
      stopId: RIVERFRONT.AREA_1.stopId,
      scheduledDepartureMs: at(8, 15),
      nowMs: now,
    });
    const text = [...ev.caveats, ...ev.signals.map((s) => s.detail)]
      .join(" ")
      .toLowerCase();
    expect(text).toContain("no current vehicle position is visible");
    // The word "cancelled" may appear, but only inside an explicit denial.
    expect(text).toContain("does not mean it is cancelled");
    expect(text).not.toMatch(/\bis cancelled\b(?! —)/);
    expect(text).not.toContain("not running");
    expect(ev.label).toBe("scheduled-only");
  });

  it("weaker evidence widens the plausible departure range", () => {
    const fresh = analyzeRouteEvidence({
      snapshot: getScene("outbound-11-wins")!.build(now),
      routeId: "11",
      tripId: "2147020",
      stopId: RIVERFRONT.AREA_1.stopId,
      scheduledDepartureMs: scheduled,
      nowMs: now,
    });
    const bare = analyzeRouteEvidence({
      snapshot: emptySnapshot(now),
      routeId: "11",
      tripId: "2147020",
      stopId: RIVERFRONT.AREA_1.stopId,
      scheduledDepartureMs: scheduled,
      nowMs: now,
    });

    expect(bare.confidence).toBeLessThan(fresh.confidence);
    const freshSpread = fresh.departureRangeMs[1] - fresh.departureRangeMs[0];
    const bareSpread = bare.departureRangeMs[1] - bare.departureRangeMs[0];
    expect(bareSpread).toBeGreaterThan(freshSpread);
  });

  it("reports an agency-published cancellation as exactly that, and nothing less", () => {
    const snap = emptySnapshot(now);
    snap.tripUpdates = [
      {
        tripId: "2147020",
        routeId: "11",
        directionId: null,
        startDate: D,
        vehicleId: null,
        timestampMs: now - 10_000,
        delaySec: null,
        scheduleRelationship: "CANCELED",
        stopTimeUpdates: [],
      },
    ];
    const ev = analyzeRouteEvidence({
      snapshot: snap,
      routeId: "11",
      tripId: "2147020",
      stopId: RIVERFRONT.AREA_1.stopId,
      scheduledDepartureMs: scheduled,
      nowMs: now,
    });
    expect(ev.label).toBe("blocked");
    expect(ev.confidence).toBe(0);
    expect(ev.caveats.join(" ")).toContain(
      "reported cancellation rather than an inference",
    );
  });

  it("applies observed schedule deviation to the predicted departure", () => {
    const snap = getScene("outbound-11-wins")!.build(now);
    const ev = analyzeRouteEvidence({
      snapshot: snap,
      routeId: "35",
      tripId: "56020",
      stopId: RIVERFRONT.AREA_2.stopId,
      scheduledDepartureMs: at(8, 10),
      nowMs: now,
    });
    // The fixture puts this 35 two minutes down.
    expect(ev.scheduleDeviationSec).toBe(120);
    expect(ev.predictedDepartureMs).toBe(at(8, 10) + 120_000);
  });

  it("does not invent occupancy when the feed omits it", () => {
    const ev = analyzeRouteEvidence({
      snapshot: emptySnapshot(now),
      routeId: "11",
      tripId: "2147020",
      stopId: RIVERFRONT.AREA_1.stopId,
      scheduledDepartureMs: scheduled,
      nowMs: now,
    });
    expect(ev.occupancyStatus).toBeNull();
  });

  it("marks everything stale when the feed itself has expired", () => {
    const ev = analyzeRouteEvidence({
      snapshot: emptySnapshot(now, 900),
      routeId: "11",
      tripId: "2147020",
      stopId: RIVERFRONT.AREA_1.stopId,
      scheduledDepartureMs: scheduled,
      nowMs: now,
    });
    expect(ev.label).toBe("stale");
    expect(ev.caveats.join(" ")).toContain("real-time feed itself");
  });
});

describe("service alerts", () => {
  const now = at(8, 3);
  const alert = (over: Partial<NormalisedAlert>): NormalisedAlert => ({
    id: "a1",
    cause: null,
    effect: "NO_SERVICE",
    headerText: "Route 11 suspended",
    descriptionText: null,
    url: null,
    activePeriods: [],
    informedRouteIds: ["11"],
    informedStopIds: [],
    informedTripIds: [],
    ...over,
  });

  it("an open-ended alert with no active period is treated as active", () => {
    expect(isAlertActive(alert({}), now)).toBe(true);
  });

  it("an expired alert is not applied", () => {
    const past = alert({
      activePeriods: [{ startMs: now - 7200_000, endMs: now - 3600_000 }],
    });
    expect(isAlertActive(past, now)).toBe(false);
  });

  it("a NO_SERVICE alert blocks the option and tanks confidence", () => {
    const snap = { ...emptySnapshot(now), alerts: [alert({})] };
    expect(findRelevantAlerts(snap, { routeId: "11" }, now)).toHaveLength(1);
    const ev = analyzeRouteEvidence({
      snapshot: snap,
      routeId: "11",
      tripId: "2147020",
      stopId: RIVERFRONT.AREA_1.stopId,
      scheduledDepartureMs: at(8, 20),
      nowMs: now,
    });
    expect(ev.label).toBe("blocked");
    expect(ev.activeAlerts).toHaveLength(1);
  });

  it("an alert for a different route does not affect this one", () => {
    const snap = {
      ...emptySnapshot(now),
      alerts: [alert({ informedRouteIds: ["72"] })],
    };
    expect(findRelevantAlerts(snap, { routeId: "11" }, now)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Headway                                                              */
/* ------------------------------------------------------------------ */

describe("Route 35 headway is computed, never hardcoded", () => {
  it("detects the real evening degradation from 30 to 60 minutes", () => {
    const h = analyzeHeadway({
      routeId: "35",
      stopId: RIVERFRONT.AREA_2.stopId,
      nowMs: at(17, 55),
      directionId: 0,
      windowMinutes: 330,
    });
    // Verified from the raw feed: 18:00, 18:30, 19:00, 19:30, 20:00, 21:00, 22:00, 23:00.
    expect(h.gapsMinutes).toContain(30);
    expect(h.gapsMinutes).toContain(60);
    expect(h.degrades).toBe(true);
    expect(h.maxGapMinutes).toBe(60);
    expect(h.summary).toMatch(/60 minutes/);
  });

  it("reports the cost of missing the very next bus", () => {
    // At 20:05 the next 35 is 21:00 and the one after is 22:00.
    const h = analyzeHeadway({
      routeId: "35",
      stopId: RIVERFRONT.AREA_2.stopId,
      nowMs: at(20, 5),
      directionId: 0,
      windowMinutes: 240,
    });
    expect(h.nextGapMinutes).toBe(60);
  });

  it("says so plainly when nothing further is scheduled", () => {
    const h = analyzeHeadway({
      routeId: "35",
      stopId: RIVERFRONT.AREA_2.stopId,
      nowMs: at(2, 0),
      directionId: 0,
      windowMinutes: 60,
    });
    expect(h.departures).toHaveLength(0);
    expect(h.summary).toContain("No further");
  });
});

/* ------------------------------------------------------------------ */
/* Campus comparison                                                    */
/* ------------------------------------------------------------------ */

describe("comparing Routes 11, 18 and 19", () => {
  const now = at(8, 3);

  it("only ever ranks campus routes, never Route 35", () => {
    const c = compareUcscOptions({
      snapshot: getScene("outbound-11-wins")!.build(now),
      nowMs: now,
      destinationKey: "science-hill",
      earliestAtArea1Ms: at(8, 13),
      preferences: prefs(),
    });
    expect(c.options.map((o) => o.routeId).sort()).toEqual(["11", "18", "19"]);
    expect(c.options.some((o) => (o.routeId as string) === "35")).toBe(false);
  });

  it("picks Route 11 when it has credible fresh evidence", () => {
    const c = compareUcscOptions({
      snapshot: getScene("outbound-11-wins")!.build(now),
      nowMs: now,
      destinationKey: "science-hill",
      earliestAtArea1Ms: at(8, 13),
      preferences: prefs(),
    });
    expect(c.bestRouteId).toBe("11");
    const eleven = c.options.find((o) => o.routeId === "11")!;
    expect(eleven.evidence?.label).toBe("observed");
  });

  it("after the 11 ghosts, it switches to the route it can actually see", () => {
    const ghost = getScene("outbound-11-ghost")!;
    const t = ghost.anchorMs; // 08:22, two minutes after the 08:20 never came
    const c = compareUcscOptions({
      snapshot: ghost.build(t),
      nowMs: t,
      destinationKey: "science-hill",
      earliestAtArea1Ms: t,
      preferences: prefs(),
    });
    expect(c.bestRouteId).toBe("19");
    // The 08:20 trip is gone; the 11 on offer is now the 08:50.
    const eleven = c.options.find((o) => o.routeId === "11")!;
    expect(eleven.tripId).not.toBe("2147020");
    expect(eleven.evidence?.label).toBe("scheduled-only");
  });

  it("the saved Route 11 preference cannot override a genuinely better option", () => {
    const ghost = getScene("outbound-11-ghost")!;
    const t = ghost.anchorMs;
    const withPref = compareUcscOptions({
      snapshot: ghost.build(t),
      nowMs: t,
      destinationKey: "science-hill",
      earliestAtArea1Ms: t,
      preferences: prefs({ preferQuieterRoute11: true }),
    });
    expect(withPref.bestRouteId).toBe("19");
    // The preference must be disclosed as a personal note, never as live crowding.
    const eleven = withPref.options.find((o) => o.routeId === "11");
    const pref = eleven?.scoreBreakdown.find(
      (b) => b.factor === "rider_preference",
    );
    expect(pref?.detail).toContain("not live crowding data");
    // And it must be small enough that it cannot flip a 20-minute difference.
    expect(Math.abs(pref!.penaltySec)).toBeLessThan(300);
  });

  it("still prefers Route 11 when it is genuinely faster and visible", () => {
    // The honest counterpart: on the real network the 11 reaches Science Hill
    // materially sooner, so when it IS visible it should win on the merits.
    const c = compareUcscOptions({
      snapshot: getScene("outbound-11-wins")!.build(now),
      nowMs: now,
      destinationKey: "science-hill",
      earliestAtArea1Ms: at(8, 13),
      preferences: prefs({ preferQuieterRoute11: false }),
    });
    // Wins even with the personal preference switched off.
    expect(c.bestRouteId).toBe("11");
  });

  it("eliminates routes that do not serve the destination at all", () => {
    const c = compareUcscOptions({
      snapshot: getScene("outbound-11-wins")!.build(now),
      nowMs: now,
      destinationKey: "crown-merrill",
      earliestAtArea1Ms: at(8, 13),
      preferences: prefs(),
    });
    const eleven = c.options.find((o) => o.routeId === "11")!;
    const nineteen = c.options.find((o) => o.routeId === "19")!;
    expect(eleven.feasible).toBe(false);
    expect(eleven.blockedReasons.join(" ")).toContain("does not serve");
    expect(nineteen.feasible).toBe(false);
    expect(c.bestRouteId).toBe("18");
  });

  it("Kerr Hall eliminates Route 18 for the same reason", () => {
    const c = compareUcscOptions({
      snapshot: getScene("outbound-11-wins")!.build(now),
      nowMs: now,
      destinationKey: "kerr-hall",
      earliestAtArea1Ms: at(8, 13),
      preferences: prefs(),
    });
    expect(c.options.find((o) => o.routeId === "18")!.feasible).toBe(false);
    expect(["11", "19"]).toContain(c.bestRouteId);
  });

  it("penalises an unreachable connection rather than silently offering it", () => {
    // Rider cannot be at Area 1 until 08:19, so the 08:15 Route 18 is gone.
    const c = compareUcscOptions({
      snapshot: getScene("outbound-11-wins")!.build(now),
      nowMs: now,
      destinationKey: "science-hill",
      earliestAtArea1Ms: at(8, 19),
      preferences: prefs(),
    });
    const eighteen = c.options.find((o) => o.routeId === "18")!;
    // It must not be offering the 08:15 trip any more.
    expect(eighteen.tripId).not.toBe("1998020");
  });

  it("reports an honest undecided state when nothing is feasible", () => {
    const c = compareUcscOptions({
      snapshot: emptySnapshot(at(3, 0)),
      nowMs: at(3, 0),
      destinationKey: "science-hill",
      earliestAtArea1Ms: at(3, 0),
      preferences: prefs(),
      windowMinutes: 60,
    });
    expect(c.bestRouteId).toBeNull();
    expect(c.undecidedReason).toBeTruthy();
  });

  it("extra transfer buffer makes tight connections drop out", () => {
    const relaxed = compareUcscOptions({
      snapshot: getScene("outbound-11-wins")!.build(now),
      nowMs: now,
      destinationKey: "science-hill",
      earliestAtArea1Ms: at(8, 13),
      preferences: prefs({ extraTransferBufferSec: 0 }),
    });
    const cautious = compareUcscOptions({
      snapshot: getScene("outbound-11-wins")!.build(now),
      nowMs: now,
      destinationKey: "science-hill",
      earliestAtArea1Ms: at(8, 13),
      preferences: prefs({ extraTransferBufferSec: 600 }),
    });
    const relaxedTrip = relaxed.options.find((o) => o.routeId === "18")?.tripId;
    const cautiousTrip = cautious.options.find(
      (o) => o.routeId === "18",
    )?.tripId;
    expect(cautiousTrip).not.toBe(relaxedTrip);
  });
});

/* ------------------------------------------------------------------ */
/* Full journey                                                         */
/* ------------------------------------------------------------------ */

describe("multi-leg journey", () => {
  const now = at(8, 3);

  it("builds Route 35 -> walk -> campus route as sequential legs", () => {
    const trip = buildMultilegTrip({
      snapshot: getScene("outbound-11-wins")!.build(now),
      nowMs: now,
      destinationKey: "science-hill",
      route35TripId: "56020",
      preferences: prefs(),
    });
    expect(trip.legs.map((l) => l.kind)).toEqual(["bus", "walk", "bus"]);
    expect(trip.legs[0].routeId).toBe("35");
    expect(trip.legs[1].fromStopId).toBe(RIVERFRONT.AREA_2.stopId);
    expect(trip.legs[1].toStopId).toBe(RIVERFRONT.AREA_1.stopId);
    expect(["11", "18", "19"]).toContain(trip.legs[2].routeId);
  });

  it("computes a positive downtown transfer margin for the demo scene", () => {
    const trip = buildMultilegTrip({
      snapshot: getScene("outbound-11-wins")!.build(now),
      nowMs: now,
      destinationKey: "science-hill",
      route35TripId: "56020",
      preferences: prefs(),
    });
    // 35 predicted into Area 2 at 08:12, 3 min walk, 11 leaves Area 1 at 08:20.
    expect(trip.downtownTransferMarginSec).not.toBeNull();
    expect(trip.downtownTransferMarginSec!).toBeGreaterThan(0);
    expect(trip.downtownTransferMarginSec!).toBeLessThan(15 * 60);
  });

  it("produces an ordered arrival range, not a single false-precision time", () => {
    const trip = buildMultilegTrip({
      snapshot: getScene("outbound-11-wins")!.build(now),
      nowMs: now,
      destinationKey: "science-hill",
      route35TripId: "56020",
      preferences: prefs(),
    });
    const [optimistic, conservative] = trip.expectedArrivalRangeMs;
    expect(optimistic).toBeLessThan(conservative);
    expect(conservative).toBeGreaterThan(now);
  });

  it("reduced mobility lengthens the walk and shrinks the margin", () => {
    const base = buildMultilegTrip({
      snapshot: getScene("outbound-11-wins")!.build(now),
      nowMs: now,
      destinationKey: "science-hill",
      route35TripId: "56020",
      preferences: prefs(),
    });
    const slower = buildMultilegTrip({
      snapshot: getScene("outbound-11-wins")!.build(now),
      nowMs: now,
      destinationKey: "science-hill",
      route35TripId: "56020",
      preferences: prefs({ reducedMobility: true }),
    });
    expect(slower.downtownTransferMarginSec!).toBeLessThan(
      base.downtownTransferMarginSec!,
    );
  });

  it("blocks the journey honestly when the first leg cannot be resolved", () => {
    const t = at(3, 30);
    const trip = buildMultilegTrip({
      snapshot: emptySnapshot(t),
      nowMs: t,
      destinationKey: "science-hill",
      preferences: prefs(),
    });
    expect(trip.blockedReasons.length).toBeGreaterThan(0);
  });
});

describe("return trip", () => {
  it("finds the 21:00 Route 35 from Area 2 and reports a long wait", () => {
    const now = at(20, 12);
    const r = buildReturnTrip({
      snapshot: getScene("return-long-wait")!.build(now),
      nowMs: now,
      preferences: prefs(),
    });
    expect(r.next35).not.toBeNull();
    expect(r.next35!.scheduledDepartureMs).toBe(at(21, 0));
    expect(r.boardingStopId).toBe(RIVERFRONT.AREA_2.stopId);
    // 48 minutes of dead time -- the whole reason the waiting feature exists.
    expect(Math.round(r.waitSeconds! / 60)).toBe(48);
  });

  it("will not offer a bus the rider cannot physically walk to in time", () => {
    // 20:58 -- the 21:00 is two minutes away and the walk alone is three.
    const now = at(20, 58);
    const r = buildReturnTrip({
      snapshot: getScene("return-long-wait")!.build(now),
      nowMs: now,
      preferences: prefs(),
    });
    expect(r.next35!.scheduledDepartureMs).toBe(at(22, 0));
  });
});

/* ------------------------------------------------------------------ */
/* Safe wait                                                            */
/* ------------------------------------------------------------------ */

describe("safe wait calculation", () => {
  const now = at(20, 12);
  const departure = at(21, 0);

  it("subtracts every buffer from the raw gap", () => {
    const r = calculateSafeWait({
      nowMs: now,
      predictedDepartureMs: departure,
      walkSeconds: 240,
      boardingBufferSeconds: 120,
      uncertaintyBufferSeconds: 180,
    });
    // 48 min gap - 4 walk - 2 boarding - 3 uncertainty = 39 min usable.
    expect(Math.round(r.usableWaitSeconds / 60)).toBe(39);
    expect(r.leaveByMs).toBe(departure - (240 + 120 + 180) * 1000);
    expect(r.hasUsefulTime).toBe(true);
  });

  it("fires the wrap-up nudge before leave-by", () => {
    const r = calculateSafeWait({
      nowMs: now,
      predictedDepartureMs: departure,
      walkSeconds: 240,
    });
    expect(r.wrapUpAtMs).toBeLessThan(r.leaveByMs);
    expect(r.leaveByMs - r.wrapUpAtMs).toBe(DEFAULTS.wrapUpLeadSeconds * 1000);
  });

  it("never returns negative usable time", () => {
    const r = calculateSafeWait({
      nowMs: now,
      predictedDepartureMs: now + 60_000,
      walkSeconds: 600,
    });
    expect(r.usableWaitSeconds).toBe(0);
    expect(r.hasUsefulTime).toBe(false);
  });

  it("refuses to call a short gap useful", () => {
    const r = calculateSafeWait({
      nowMs: now,
      predictedDepartureMs: now + 14 * 60_000,
      walkSeconds: 240,
      minimumUsefulVisitSeconds: 12 * 60,
    });
    expect(r.hasUsefulTime).toBe(false);
  });

  it("a longer walk always reduces usable time", () => {
    const near = calculateSafeWait({
      nowMs: now,
      predictedDepartureMs: departure,
      walkSeconds: 120,
    });
    const far = calculateSafeWait({
      nowMs: now,
      predictedDepartureMs: departure,
      walkSeconds: 600,
    });
    expect(far.usableWaitSeconds).toBeLessThan(near.usableWaitSeconds);
    expect(far.leaveByMs).toBeLessThan(near.leaveByMs);
  });
});

describe("uncertainty buffer grows when confidence falls", () => {
  const now = at(8, 3);
  const mk = (sceneId: string, tripId: string) =>
    analyzeRouteEvidence({
      snapshot: getScene(sceneId)!.build(now),
      routeId: "11",
      tripId,
      stopId: RIVERFRONT.AREA_1.stopId,
      scheduledDepartureMs: at(8, 20),
      nowMs: now,
    });

  it("weak evidence buys more padding than strong evidence", () => {
    const strong = deriveUncertaintyBuffer({
      evidence: mk("outbound-11-wins", "2147020"),
    });
    const weak = deriveUncertaintyBuffer({
      evidence: mk("outbound-11-ghost", "2147020"),
    });
    expect(weak.seconds).toBeGreaterThan(strong.seconds);
    expect(weak.reasons.length).toBeGreaterThan(1);
  });

  it("a fast-moving bus increases the buffer, because it may arrive early", () => {
    const slow = deriveUncertaintyBuffer({ vehicleSpeedMps: 2 });
    const fast = deriveUncertaintyBuffer({ vehicleSpeedMps: 14 });
    expect(fast.seconds).toBeGreaterThan(slow.seconds);
    expect(fast.reasons.join(" ")).toContain("arrive early");
  });

  it("an estimated walking time costs extra padding versus a verified one", () => {
    const verified = deriveUncertaintyBuffer({ walkingTimeEstimated: false });
    const estimated = deriveUncertaintyBuffer({ walkingTimeEstimated: true });
    expect(estimated.seconds).toBeGreaterThan(verified.seconds);
  });

  it("a stale feed increases the buffer", () => {
    expect(
      deriveUncertaintyBuffer({ feedAgeSeconds: 600 }).seconds,
    ).toBeGreaterThan(deriveUncertaintyBuffer({ feedAgeSeconds: 5 }).seconds);
  });
});

describe("walking estimates", () => {
  it("the three RiverFront areas are genuinely a short walk apart", () => {
    const d = haversineMetres(RIVERFRONT.AREA_2, RIVERFRONT.AREA_1);
    expect(d).toBeLessThan(200);
  });

  it("applies a detour factor and flags itself as an estimate", () => {
    const w = estimateWalkSeconds(RIVERFRONT.AREA_2, RIVERFRONT.AREA_1);
    expect(w.estimated).toBe(true);
    expect(w.metres).toBeGreaterThan(
      haversineMetres(RIVERFRONT.AREA_2, RIVERFRONT.AREA_1),
    );
  });

  it("reduced mobility lengthens the estimate", () => {
    const a = estimateWalkSeconds(RIVERFRONT.AREA_2, RIVERFRONT.AREA_1);
    const b = estimateWalkSeconds(RIVERFRONT.AREA_2, RIVERFRONT.AREA_1, {
      reducedMobility: true,
    });
    expect(b.seconds).toBeGreaterThan(a.seconds);
  });
});

describe("demo scenes stay internally consistent", () => {
  it("every scene builds a fixture-labelled snapshot", () => {
    for (const scene of DEMO_SCENES) {
      const snap = scene.build(scene.anchorMs);
      expect(snap.origin).toBe("fixture");
      expect(snap.freshness.label).toBe("fresh");
    }
  });
});
