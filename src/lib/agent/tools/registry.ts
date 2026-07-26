/**
 * Tool implementations.
 *
 * Every tool is a thin, validated adapter over the deterministic engine. No tool
 * performs schedule arithmetic of its own, and no tool has any latitude to
 * editorialise -- they return structured facts with provenance attached, and the
 * model's job is to explain them, not to recompute them.
 */
import { z } from "zod";
import {
  CAMPUS_DESTINATIONS,
  DEFAULTS,
  ENGINE_VERSION,
  RIVERFRONT,
  SCOTTS_VALLEY,
  TRUNK_ROUTE_ID,
} from "@/lib/domain";
import { getScheduledDepartures, getStop } from "@/lib/gtfs/feed";
import { agencyDateString } from "@/lib/gtfs/time";
import { analyzeRouteEvidence, isAlertActive } from "@/lib/engine/evidence";
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
} from "@/lib/engine/safewait";
import {
  DEFAULT_PREFERENCES,
  type RiderPreferences,
  type RouteEvidence,
} from "@/lib/engine/types";
import {
  NO_FILTERS,
  type PlaceFilters,
  type WaitPlace,
} from "@/lib/places/types";
import { rankWaitPlaces, stayNearStopAdvice } from "@/lib/places/rank";
import type { RealtimeSnapshot } from "@/lib/rt/types";
import { toolArgSchemas, toolResultSchemas, type ToolName } from "./schemas";

export interface ToolContext {
  snapshot: RealtimeSnapshot;
  nowMs: number;
  /** Resolves nearby places. Injected so tests and demo mode stay offline. */
  findPlaces: (args: {
    lat: number;
    lon: number;
    radiusMetres: number;
  }) => Promise<WaitPlace[]>;
  placesProviderName: string;
  preferences: RiderPreferences;
}

const iso = (ms: number) => new Date(ms).toISOString();

function provenance(
  ctx: ToolContext,
  source: string,
  observedAtMs?: number | null,
) {
  return {
    source,
    origin: ctx.snapshot.origin,
    observedAtIso: observedAtMs ? iso(observedAtMs) : null,
    freshness: ctx.snapshot.freshness,
    engineVersion: ENGINE_VERSION,
  };
}

function serialiseEvidence(e: RouteEvidence) {
  return {
    routeId: e.routeId,
    tripId: e.tripId,
    stopId: e.stopId,
    label: e.label,
    confidence: e.confidence,
    // Stated explicitly on every payload so the model cannot present the score
    // as a probability of the bus arriving.
    confidenceIsCalibrated: false as const,
    vehicleVisible: e.vehicleVisible,
    vehicleAgeSeconds: e.vehicleAgeSeconds,
    scheduleDeviationSec: e.scheduleDeviationSec,
    occupancyStatus: e.occupancyStatus,
    scheduledDepartureIso: iso(e.scheduledDepartureMs),
    predictedDepartureIso: iso(e.predictedDepartureMs),
    signals: e.signals.map((s) => ({
      key: s.key,
      detail: s.detail,
      weight: s.weight,
      source: s.source,
    })),
    caveats: e.caveats,
    activeAlerts: e.activeAlerts,
  };
}

function mergePrefs(
  ctx: ToolContext,
  incoming?: Partial<RiderPreferences>,
): RiderPreferences {
  return { ...DEFAULT_PREFERENCES, ...ctx.preferences, ...(incoming ?? {}) };
}

function toFilters(
  p: RiderPreferences,
  incoming?: Partial<PlaceFilters>,
): PlaceFilters {
  return {
    ...NO_FILTERS,
    requireFree: p.requireFree,
    requireIndoor: p.requireIndoor,
    requireQuiet: p.wantQuiet,
    requireWifi: p.wantWifi,
    requireFood: p.wantFood,
    requireRestroom: p.wantRestroom,
    requireWheelchairAccess: p.requireWheelchairAccess,
    requireOpenLate: p.wantOpenLate,
    preferLocallyOwned: p.preferLocallyOwned,
    maxSpendUsd: p.maxSpendUsd,
    ...(incoming ?? {}),
  };
}

function serialiseCandidate(c: ReturnType<typeof rankWaitPlaces>[number]) {
  return {
    id: c.place.id,
    name: c.place.name,
    categoryLabel: c.place.categoryLabel,
    address: c.place.address,
    hoursKnown: Boolean(c.place.hours?.parsed),
    hoursRaw: c.place.hours?.raw ?? null,
    walkSeconds: c.walk.seconds,
    walkIsEstimated: c.walk.estimated,
    usableWaitSeconds: c.usableWaitSeconds,
    leaveByIso: iso(c.leaveByMs),
    feasible: c.feasible,
    summary: c.summary,
    reasons: c.reasons,
    blockedReasons: c.blockedReasons,
    amenities: amenityMap(c.place),
    sponsored: c.place.sponsored,
  };
}

function amenityMap(place: WaitPlace) {
  return {
    wifi: place.hasWifi,
    restroom: place.hasRestroom,
    wheelchairAccessible: place.wheelchairAccessible,
    indoor: place.isIndoor,
    quiet: place.isQuiet,
    food: place.servesFood,
    freeToEnter: place.freeToEnter,
    locallyOwned: place.locallyOwned,
  };
}

/* ---------------------------------------------------------------- */

type Impl = (args: never, ctx: ToolContext) => Promise<unknown>;

const implementations: Record<ToolName, Impl> = {
  get_vehicle_positions: async (
    args: z.infer<typeof toolArgSchemas.get_vehicle_positions>,
    ctx,
  ) => {
    let v = ctx.snapshot.vehicles;
    if (args.routeId) v = v.filter((x) => x.routeId === args.routeId);
    if (args.tripId) v = v.filter((x) => x.tripId === args.tripId);
    if (args.vehicleId) v = v.filter((x) => x.vehicleId === args.vehicleId);
    return {
      provenance: provenance(
        ctx,
        "GTFS-Realtime vehicle positions",
        ctx.snapshot.freshness.feedTimestampMs,
      ),
      count: v.length,
      vehicles: v.map((x) => ({
        vehicleId: x.vehicleId,
        routeId: x.routeId,
        tripId: x.tripId,
        lat: x.lat,
        lon: x.lon,
        speedMps: x.speedMps,
        ageSeconds: x.ageSeconds,
        occupancyStatus: x.occupancyStatus,
      })),
    };
  },

  get_trip_updates: async (
    args: z.infer<typeof toolArgSchemas.get_trip_updates>,
    ctx,
  ) => {
    let t = ctx.snapshot.tripUpdates;
    if (args.routeId) t = t.filter((x) => x.routeId === args.routeId);
    if (args.tripId) t = t.filter((x) => x.tripId === args.tripId);
    if (args.stopId)
      t = t.filter((x) =>
        x.stopTimeUpdates.some((s) => s.stopId === args.stopId),
      );
    return {
      provenance: provenance(
        ctx,
        "GTFS-Realtime trip updates",
        ctx.snapshot.freshness.feedTimestampMs,
      ),
      count: t.length,
      tripUpdates: t.map((x) => ({
        tripId: x.tripId,
        routeId: x.routeId,
        delaySec: x.delaySec,
        scheduleRelationship: x.scheduleRelationship,
        ageSeconds: x.timestampMs
          ? Math.round((ctx.nowMs - x.timestampMs) / 1000)
          : null,
        stopCount: x.stopTimeUpdates.length,
      })),
    };
  },

  get_service_alerts: async (
    args: z.infer<typeof toolArgSchemas.get_service_alerts>,
    ctx,
  ) => {
    const all = ctx.snapshot.alerts.filter((a) => {
      if (args.routeId && !a.informedRouteIds.includes(args.routeId))
        return false;
      if (args.stopId && !a.informedStopIds.includes(args.stopId)) return false;
      return true;
    });
    return {
      provenance: provenance(
        ctx,
        "GTFS-Realtime service alerts",
        ctx.snapshot.freshness.feedTimestampMs,
      ),
      count: all.length,
      alerts: all.map((a) => ({
        id: a.id,
        effect: a.effect,
        header: a.headerText,
        description: a.descriptionText,
        informedRouteIds: a.informedRouteIds,
        active: isAlertActive(a, ctx.nowMs),
      })),
    };
  },

  get_stop_schedule: async (
    args: z.infer<typeof toolArgSchemas.get_stop_schedule>,
    ctx,
  ) => {
    const stop = getStop(args.stopId);
    let departures = getScheduledDepartures({
      stopId: args.stopId,
      routeIds: args.routeIds,
      fromMs: ctx.nowMs,
      windowMinutes: args.timeWindowMinutes ?? 90,
    });
    if (args.directionId !== undefined) {
      departures = departures.filter((d) => d.directionId === args.directionId);
    }
    // Headway only makes sense for a single route in a single direction. Route 35
    // both arrives at and departs from RiverFront Area 2, so mixing directions
    // there would report a one-minute "headway" between an arrival and the
    // departure of a different trip.
    const headwayRoute = args.routeIds?.length === 1 ? args.routeIds[0] : null;
    const headway =
      headwayRoute && args.directionId !== undefined
        ? analyzeHeadway({
            routeId: headwayRoute,
            stopId: args.stopId,
            nowMs: ctx.nowMs,
            directionId: args.directionId,
            windowMinutes: Math.max(args.timeWindowMinutes ?? 90, 240),
          })
        : null;
    return {
      provenance: provenance(
        ctx,
        `Static GTFS schedule (${agencyDateString(ctx.nowMs)})`,
      ),
      stopId: args.stopId,
      stopName: stop?.stop_name ?? args.stopId,
      serviceDate: args.serviceDate ?? agencyDateString(ctx.nowMs),
      departures: departures.map((d) => ({
        routeId: d.routeId,
        tripId: d.tripId,
        headsign: d.headsign,
        scheduledDepartureIso: iso(d.departureEpochMs),
        directionId: d.directionId,
      })),
      headway: headway
        ? {
            nextGapMinutes: headway.nextGapMinutes,
            medianGapMinutes: headway.medianGapMinutes,
            maxGapMinutes: headway.maxGapMinutes,
            degrades: headway.degrades,
            summary: headway.summary,
          }
        : null,
    };
  },

  build_multileg_trip: async (
    args: z.infer<typeof toolArgSchemas.build_multileg_trip>,
    ctx,
  ) => {
    const prefs = mergePrefs(
      ctx,
      args.preferences as Partial<RiderPreferences>,
    );
    const trip = buildMultilegTrip({
      snapshot: ctx.snapshot,
      nowMs: args.departureTime ? Date.parse(args.departureTime) : ctx.nowMs,
      destinationKey: args.destinationKey,
      route35TripId: args.route35TripId,
      originStopId: args.originStopId ?? SCOTTS_VALLEY.stopId,
      preferences: prefs,
    });
    const range = Number.isFinite(trip.expectedArrivalRangeMs[0])
      ? ([
          iso(trip.expectedArrivalRangeMs[0]),
          iso(trip.expectedArrivalRangeMs[1]),
        ] as [string, string])
      : null;
    return {
      provenance: provenance(ctx, "CruzSync deterministic routing engine"),
      legs: trip.legs.map((l) => ({
        kind: l.kind,
        routeId: l.routeId,
        label: l.label,
        fromStopName: l.fromStopName,
        toStopName: l.toStopName,
        departureIso: iso(l.departureMs),
        arrivalIso: iso(l.arrivalMs),
      })),
      expectedArrivalRange: range,
      downtownTransferMarginSec: trip.downtownTransferMarginSec,
      earliestAtArea1Iso: iso(trip.earliestAtArea1Ms),
      assumptions: trip.assumptions,
      blockedReasons: trip.blockedReasons,
    };
  },

  analyze_route_evidence: async (
    args: z.infer<typeof toolArgSchemas.analyze_route_evidence>,
    ctx,
  ) => {
    const nowMs = args.currentTime ? Date.parse(args.currentTime) : ctx.nowMs;
    // Resolve the scheduled departure from the timetable rather than trusting
    // the model to supply it.
    const dep = getScheduledDepartures({
      stopId: args.stopId,
      routeIds: [args.routeId],
      fromMs: nowMs - 60 * 60_000,
      windowMinutes: 240,
      requirePickup: false,
    }).find((d) => d.tripId === args.scheduledTripId);

    const evidence = analyzeRouteEvidence({
      snapshot: ctx.snapshot,
      routeId: args.routeId,
      tripId: args.scheduledTripId,
      stopId: args.stopId,
      scheduledDepartureMs: dep?.departureEpochMs ?? nowMs,
      nowMs,
    });
    return {
      provenance: provenance(
        ctx,
        "CruzSync evidence engine over GTFS-Realtime",
      ),
      evidence: serialiseEvidence(evidence),
    };
  },

  compare_ucsc_options: async (
    args: z.infer<typeof toolArgSchemas.compare_ucsc_options>,
    ctx,
  ) => {
    const prefs = mergePrefs(
      ctx,
      args.preferences as Partial<RiderPreferences>,
    );
    const c = compareUcscOptions({
      snapshot: ctx.snapshot,
      nowMs: ctx.nowMs,
      destinationKey: args.campusDestination,
      earliestAtArea1Ms: args.earliestAtArea1
        ? Date.parse(args.earliestAtArea1)
        : ctx.nowMs,
      preferences: prefs,
      candidateRouteIds: args.candidateRouteIds,
    });
    return {
      provenance: provenance(ctx, "CruzSync deterministic comparison engine"),
      destinationKey: c.destinationKey,
      destinationName: c.destinationName,
      bestRouteId: c.bestRouteId,
      undecidedReason: c.undecidedReason,
      assumptions: c.assumptions,
      options: c.options.map((o) => ({
        routeId: o.routeId,
        tripId: o.tripId,
        feasible: o.feasible,
        score: Number.isFinite(o.score) ? o.score : 999_999,
        transferMarginSec: o.transferMarginSec,
        arrivalRange: o.arrivalRangeMs
          ? ([iso(o.arrivalRangeMs[0]), iso(o.arrivalRangeMs[1])] as [
              string,
              string,
            ])
          : undefined,
        scoreBreakdown: o.scoreBreakdown,
        blockedReasons: o.blockedReasons,
        evidence: o.evidence ? serialiseEvidence(o.evidence) : undefined,
      })),
    };
  },

  get_nearby_wait_places: async (
    args: z.infer<typeof toolArgSchemas.get_nearby_wait_places>,
    ctx,
  ) => {
    const stop = getStop(args.boardingStopId);
    if (!stop) {
      return {
        provenance: provenance(ctx, ctx.placesProviderName),
        boardingStopId: args.boardingStopId,
        boardingStopName: args.boardingStopId,
        placesProvider: ctx.placesProviderName,
        count: 0,
        places: [],
        fallbackAdvice: `Unknown stop id ${args.boardingStopId}.`,
      };
    }

    const prefs = mergePrefs(ctx);
    const filters = toFilters(prefs, args.filters as Partial<PlaceFilters>);
    const predictedDepartureMs = ctx.nowMs + args.availableMinutes * 60_000;

    let places: WaitPlace[] = [];
    let providerError: string | null = null;
    try {
      places = await ctx.findPlaces({
        lat: stop.stop_lat,
        lon: stop.stop_lon,
        radiusMetres: args.radiusMetres ?? 600,
      });
    } catch (err) {
      providerError = err instanceof Error ? err.message : String(err);
    }

    // Derive the uncertainty buffer from the ACTUAL bus the rider must catch,
    // using the same inputs as recommend_next_action. Using a flat buffer here
    // instead produced leave-by times a minute apart between the recommendation
    // card and the place list, which is exactly the kind of small inconsistency
    // that destroys trust in a countdown.
    const nextDeparture = getScheduledDepartures({
      stopId: args.boardingStopId,
      fromMs: ctx.nowMs,
      windowMinutes: (args.availableMinutes ?? 30) + 10,
    })[0];
    const departureEvidence = nextDeparture
      ? analyzeRouteEvidence({
          snapshot: ctx.snapshot,
          routeId: nextDeparture.routeId,
          tripId: nextDeparture.tripId,
          stopId: args.boardingStopId,
          scheduledDepartureMs: nextDeparture.departureEpochMs,
          nowMs: ctx.nowMs,
        })
      : undefined;
    const uncertainty = deriveUncertaintyBuffer({
      evidence: departureEvidence,
      feedAgeSeconds: ctx.snapshot.freshness.ageSeconds,
      walkingTimeEstimated: true,
    });
    const ranked = rankWaitPlaces({
      places,
      boardingStop: {
        lat: stop.stop_lat,
        lon: stop.stop_lon,
        name: stop.stop_name,
      },
      nowMs: ctx.nowMs,
      predictedDepartureMs,
      uncertaintyBufferSeconds: uncertainty.seconds,
      filters,
      reducedMobility: prefs.reducedMobility,
    });

    const feasibleCount = ranked.filter((r) => r.feasible).length;
    const fallbackAdvice =
      feasibleCount > 0
        ? null
        : stayNearStopAdvice(
            stop.stop_name,
            providerError
              ? `Place data could not be loaded (${providerError}).`
              : places.length === 0
                ? "No nearby places were found in the data source."
                : "Nothing nearby could be confirmed open for long enough.",
          );

    return {
      provenance: provenance(ctx, ctx.placesProviderName),
      boardingStopId: args.boardingStopId,
      boardingStopName: stop.stop_name,
      placesProvider: ctx.placesProviderName,
      count: ranked.length,
      places: ranked.slice(0, 12).map(serialiseCandidate),
      fallbackAdvice,
    };
  },

  get_place_details: async (
    args: z.infer<typeof toolArgSchemas.get_place_details>,
    ctx,
  ) => {
    // Search around the downtown areas and match by id.
    const places = await ctx
      .findPlaces({
        lat: RIVERFRONT.AREA_2.lat,
        lon: RIVERFRONT.AREA_2.lon,
        radiusMetres: 800,
      })
      .catch(() => [] as WaitPlace[]);
    const place = places.find((p) => p.id === args.placeId);
    const fmt = (min: number) =>
      `${String(Math.floor((min % (24 * 60)) / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
    return {
      provenance: provenance(
        ctx,
        ctx.placesProviderName,
        place?.hours?.fetchedAtMs ?? null,
      ),
      found: Boolean(place),
      place: place
        ? {
            id: place.id,
            name: place.name,
            categoryLabel: place.categoryLabel,
            address: place.address,
            website: place.website,
            businessStatus: place.businessStatus,
            hoursKnown: Boolean(place.hours?.parsed),
            hoursRaw: place.hours?.raw ?? null,
            todayWindows: (place.hours?.todayWindows ?? []).map((w) => ({
              opens: fmt(w.openMin),
              closes: fmt(w.closeMin),
            })),
            amenities: amenityMap(place),
          }
        : null,
    };
  },

  get_walking_time: async (
    args: z.infer<typeof toolArgSchemas.get_walking_time>,
    ctx,
  ) => {
    const stop = getStop(args.destinationStopId);
    const places = await ctx
      .findPlaces({
        lat: RIVERFRONT.AREA_2.lat,
        lon: RIVERFRONT.AREA_2.lon,
        radiusMetres: 800,
      })
      .catch(() => [] as WaitPlace[]);
    const place = places.find((p) => p.id === args.originPlaceId);
    if (!stop || !place) {
      return {
        provenance: provenance(ctx, "CruzSync walking estimate"),
        seconds: 0,
        metres: 0,
        estimated: true,
        provider: "haversine-estimate",
      };
    }
    const est = estimateWalkSeconds(
      place,
      { lat: stop.stop_lat, lon: stop.stop_lon },
      { reducedMobility: ctx.preferences.reducedMobility },
    );
    return {
      provenance: provenance(ctx, "CruzSync walking estimate"),
      seconds: est.seconds,
      metres: est.metres,
      estimated: true,
      provider: "haversine-estimate",
    };
  },

  calculate_safe_wait: async (
    args: z.infer<typeof toolArgSchemas.calculate_safe_wait>,
    ctx,
  ) => {
    const r = calculateSafeWait({
      nowMs: ctx.nowMs,
      predictedDepartureMs: Date.parse(args.predictedDeparture),
      walkSeconds: args.walkSeconds,
      boardingBufferSeconds: args.boardingBufferSeconds,
      uncertaintyBufferSeconds: args.uncertaintyBufferSeconds,
      minimumUsefulVisitSeconds: args.minimumUsefulVisitSeconds,
    });
    return {
      provenance: provenance(ctx, "CruzSync safe-wait calculator"),
      leaveByIso: iso(r.leaveByMs),
      wrapUpAtIso: iso(r.wrapUpAtMs),
      usableWaitSeconds: r.usableWaitSeconds,
      hasUsefulTime: r.hasUsefulTime,
      breakdown: r.breakdown,
    };
  },

  recommend_next_action: async (
    args: z.infer<typeof toolArgSchemas.recommend_next_action>,
    ctx,
  ) => {
    const prefs = mergePrefs(
      ctx,
      args.preferences as Partial<RiderPreferences>,
    );
    const prov = provenance(ctx, "CruzSync recommendation engine");
    const evidenceRefs: string[] = [];

    if (args.direction === "to-campus") {
      const destKey = args.destinationKey ?? CAMPUS_DESTINATIONS[0].key;
      const trip = buildMultilegTrip({
        snapshot: ctx.snapshot,
        nowMs: ctx.nowMs,
        destinationKey: destKey,
        preferences: prefs,
      });
      const c = trip.comparison;
      if (!c.bestRouteId) {
        return {
          provenance: prov,
          action: "DATA TOO UNCERTAIN" as const,
          headline: "No campus connection can be recommended right now",
          subhead: c.undecidedReason ?? "Nothing feasible was found.",
          boardingStopId: RIVERFRONT.AREA_1.stopId,
          boardingStopLabel: RIVERFRONT.AREA_1.label,
          departureIso: null,
          leaveByIso: null,
          reevaluateAtIso: iso(ctx.nowMs + 5 * 60_000),
          backupPlan: `Wait at ${RIVERFRONT.AREA_1.label} and re-check in a few minutes.`,
          blockedReasons: [
            ...trip.blockedReasons,
            ...(c.undecidedReason ? [c.undecidedReason] : []),
          ],
          evidenceRefs,
          waitPlaces: null,
          fallbackAdvice: null,
        };
      }
      const best = c.options.find((o) => o.routeId === c.bestRouteId)!;
      const runnerUp = c.options.find(
        (o) => o.routeId !== c.bestRouteId && o.feasible,
      );
      if (best.evidence)
        evidenceRefs.push(`${best.evidence.label}:${best.evidence.tripId}`);
      return {
        provenance: prov,
        action: `TRANSFER TO ${best.routeId}` as
          "TRANSFER TO 11" | "TRANSFER TO 18" | "TRANSFER TO 19",
        headline: `35 → RiverFront · then take the ${best.routeId}`,
        subhead: `${c.destinationName} · ${
          best.evidence?.vehicleVisible
            ? `Route ${best.routeId} vehicle updated ${best.evidence.vehicleAgeSeconds}s ago`
            : `no current vehicle position is visible for this Route ${best.routeId} trip`
        }`,
        boardingStopId: RIVERFRONT.AREA_1.stopId,
        boardingStopLabel: RIVERFRONT.AREA_1.label,
        departureIso: best.evidence
          ? iso(best.evidence.predictedDepartureMs)
          : null,
        leaveByIso: null,
        reevaluateAtIso: iso(
          Math.min(
            ctx.nowMs + 5 * 60_000,
            best.evidence?.predictedDepartureMs ?? Infinity,
          ),
        ),
        backupPlan: runnerUp
          ? `If the ${best.routeId} does not appear, the ${runnerUp.routeId} is the next option from ${RIVERFRONT.AREA_1.label}.`
          : `If the ${best.routeId} does not appear, wait at ${RIVERFRONT.AREA_1.label} for the next campus route.`,
        blockedReasons: trip.blockedReasons,
        evidenceRefs,
        waitPlaces: null,
        fallbackAdvice: null,
      };
    }

    /* --- heading home --- */
    const ret = buildReturnTrip({
      snapshot: ctx.snapshot,
      nowMs: ctx.nowMs,
      preferences: prefs,
    });
    if (!ret.next35) {
      return {
        provenance: prov,
        action: "DATA TOO UNCERTAIN" as const,
        headline: "No Route 35 home could be found",
        subhead: ret.blockedReasons[0] ?? "No reachable departure.",
        boardingStopId: RIVERFRONT.AREA_2.stopId,
        boardingStopLabel: RIVERFRONT.AREA_2.label,
        departureIso: null,
        leaveByIso: null,
        reevaluateAtIso: iso(ctx.nowMs + 10 * 60_000),
        backupPlan: "Check Santa Cruz METRO directly for late-night service.",
        blockedReasons: ret.blockedReasons,
        evidenceRefs,
        waitPlaces: null,
        fallbackAdvice: null,
      };
    }

    const ev = ret.next35.evidence;
    evidenceRefs.push(`${ev.label}:${ev.tripId}`);
    const uncertainty = deriveUncertaintyBuffer({
      evidence: ev,
      feedAgeSeconds: ctx.snapshot.freshness.ageSeconds,
      walkingTimeEstimated: true,
    });

    // Is there enough slack to be anywhere other than the stop?
    const stop = getStop(RIVERFRONT.AREA_2.stopId)!;
    let bestPlace: ReturnType<typeof rankWaitPlaces>[number] | undefined;
    let rankedPlaces: ReturnType<typeof rankWaitPlaces> = [];
    if (args.considerWaitPlaces !== false) {
      const places = await ctx
        .findPlaces({
          lat: stop.stop_lat,
          lon: stop.stop_lon,
          radiusMetres: 600,
        })
        .catch(() => [] as WaitPlace[]);
      const ranked = rankWaitPlaces({
        places,
        boardingStop: {
          lat: stop.stop_lat,
          lon: stop.stop_lon,
          name: RIVERFRONT.AREA_2.label,
        },
        nowMs: ctx.nowMs,
        predictedDepartureMs: ret.next35.predictedDepartureMs,
        uncertaintyBufferSeconds: uncertainty.seconds,
        filters: toFilters(prefs),
        reducedMobility: prefs.reducedMobility,
      });
      rankedPlaces = ranked;
      bestPlace = ranked.find((r) => r.feasible);
    }

    if (bestPlace) {
      return {
        provenance: prov,
        action: "WAIT AT A PLACE" as const,
        headline: `You have ${Math.round(bestPlace.usableWaitSeconds / 60)} usable minutes`,
        subhead: `${bestPlace.place.name} · ${bestPlace.summary}`,
        boardingStopId: RIVERFRONT.AREA_2.stopId,
        boardingStopLabel: RIVERFRONT.AREA_2.label,
        departureIso: iso(ret.next35.predictedDepartureMs),
        leaveByIso: iso(bestPlace.leaveByMs),
        reevaluateAtIso: iso(bestPlace.wrapUpAtMs),
        backupPlan: `If the 35 moves earlier, CruzSync will re-check before the wrap-up nudge and shorten your leave-by time. The stop is ${Math.round(bestPlace.walk.seconds / 60)} minutes away on foot.`,
        blockedReasons: [],
        evidenceRefs,
        waitPlaces: rankedPlaces.slice(0, 12).map(serialiseCandidate),
        fallbackAdvice: null,
      };
    }

    const safe = calculateSafeWait({
      nowMs: ctx.nowMs,
      predictedDepartureMs: ret.next35.predictedDepartureMs,
      walkSeconds: ret.walkFromArea3Sec,
      uncertaintyBufferSeconds: uncertainty.seconds,
    });
    return {
      provenance: prov,
      action: "WAIT AT STOP" as const,
      headline: `Wait at ${RIVERFRONT.AREA_2.label}`,
      subhead: `Route ${TRUNK_ROUTE_ID} leaves in about ${Math.round((ret.next35.predictedDepartureMs - ctx.nowMs) / 60000)} minutes.`,
      boardingStopId: RIVERFRONT.AREA_2.stopId,
      boardingStopLabel: RIVERFRONT.AREA_2.label,
      departureIso: iso(ret.next35.predictedDepartureMs),
      leaveByIso: iso(safe.leaveByMs),
      reevaluateAtIso: iso(
        Math.min(ctx.nowMs + 5 * 60_000, ret.next35.predictedDepartureMs),
      ),
      backupPlan:
        "Nothing nearby could be confirmed open for long enough to be worth leaving the stop.",
      blockedReasons: [],
      evidenceRefs,
      waitPlaces: rankedPlaces.slice(0, 12).map(serialiseCandidate),
      fallbackAdvice: stayNearStopAdvice(
        RIVERFRONT.AREA_2.label,
        rankedPlaces.length === 0
          ? "No nearby places were found in the data source."
          : "Nothing nearby could be confirmed open for long enough.",
      ),
    };
  },
};

export interface ToolCallOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

/**
 * Executes a tool with full argument AND result validation.
 * A schema failure is returned to the model as a structured error so it can
 * correct itself, rather than throwing and killing the conversation.
 */
export async function executeTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolCallOutcome> {
  const started = Date.now();
  const finish = (o: Omit<ToolCallOutcome, "durationMs">): ToolCallOutcome => ({
    ...o,
    durationMs: Date.now() - started,
  });

  if (!(name in implementations)) {
    return finish({ ok: false, error: `Unknown tool "${name}".` });
  }
  const toolName = name as ToolName;

  const parsedArgs = toolArgSchemas[toolName].safeParse(rawArgs ?? {});
  if (!parsedArgs.success) {
    return finish({
      ok: false,
      error: `Invalid arguments for ${toolName}: ${parsedArgs.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    });
  }

  let raw: unknown;
  try {
    raw = await implementations[toolName](parsedArgs.data as never, ctx);
  } catch (err) {
    return finish({
      ok: false,
      error: `${toolName} failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const parsedResult = toolResultSchemas[toolName].safeParse(raw);
  if (!parsedResult.success) {
    return finish({
      ok: false,
      error: `${toolName} produced a result that failed its own schema: ${parsedResult.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    });
  }

  return finish({ ok: true, result: parsedResult.data });
}

export { DEFAULTS };
