/**
 * Multi-leg trip construction and the three-way campus comparison.
 *
 * The single most important modelling rule in CruzSync lives here: Route 35 is
 * the Scotts Valley <-> downtown leg, and Routes 11/18/19 are the downtown <->
 * campus leg. They are sequential legs of one journey, never alternatives to one
 * another. `compareUcscOptions` therefore only ever ranks 11, 18 and 19.
 */
import {
  CAMPUS_ROUTE_IDS,
  DEFAULTS,
  ENGINE_VERSION,
  RIVERFRONT,
  TRUNK_ROUTE_ID,
  findCampusDestination,
  type CampusRouteId,
} from '@/lib/domain';
import { getScheduledDepartures, getStop, getStopTimesForTrip, getTripArrivalAtStop } from '@/lib/gtfs/feed';
import { serviceDateTimeToEpochMs } from '@/lib/gtfs/time';
import type { RealtimeSnapshot } from '@/lib/rt/types';
import { analyzeRouteEvidence } from './evidence';
import type {
  JourneyLeg,
  MultilegTrip,
  RiderPreferences,
  RouteEvidence,
  UcscComparison,
  UcscOption,
} from './types';
import { DEFAULT_PREFERENCES } from './types';

const stopName = (id: string) => getStop(id)?.stop_name ?? id;

/** Inter-area walk, adjusted when the rider has told us they walk more slowly. */
export function interAreaWalkSeconds(prefs: RiderPreferences): number {
  return prefs.reducedMobility
    ? Math.round(DEFAULTS.interAreaWalkSeconds * 1.6)
    : DEFAULTS.interAreaWalkSeconds;
}

export interface Route35ArrivalInput {
  snapshot: RealtimeSnapshot;
  nowMs: number;
  /** When the rider is already aboard, pin to that trip. */
  tripId?: string;
  /** Where the rider boards, for the to-campus direction. */
  originStopId?: string;
}

export interface Route35Arrival {
  tripId: string;
  scheduledArrivalMs: number;
  predictedArrivalMs: number;
  arrivalRangeMs: [number, number];
  evidence: RouteEvidence;
  boardingStopId: string;
}

/**
 * Resolves the inbound Route 35 trip that brings the rider to RiverFront Area 2.
 * Returns undefined when no such trip exists in the window -- which is itself a
 * legitimate answer we surface rather than paper over.
 */
export function resolveRoute35Arrival(input: Route35ArrivalInput): Route35Arrival | undefined {
  const { snapshot, nowMs } = input;
  const originStopId = input.originStopId;

  // Inbound Route 35 trips calling at Area 2 within the next three hours.
  const candidates = getScheduledDepartures({
    stopId: RIVERFRONT.AREA_2.stopId,
    routeIds: [TRUNK_ROUTE_ID],
    fromMs: nowMs - 20 * 60_000,
    windowMinutes: 180,
    requirePickup: false,
  }).filter((d) => d.directionId === 1);

  const chosen = input.tripId
    ? candidates.find((c) => c.tripId === input.tripId)
    : candidates.find((c) => c.arrivalEpochMs >= nowMs);
  if (!chosen) return undefined;

  const evidence = analyzeRouteEvidence({
    snapshot,
    routeId: TRUNK_ROUTE_ID,
    tripId: chosen.tripId,
    stopId: RIVERFRONT.AREA_2.stopId,
    scheduledDepartureMs: chosen.arrivalEpochMs,
    nowMs,
  });

  return {
    tripId: chosen.tripId,
    scheduledArrivalMs: chosen.arrivalEpochMs,
    predictedArrivalMs: evidence.predictedDepartureMs,
    arrivalRangeMs: evidence.departureRangeMs,
    evidence,
    boardingStopId: originStopId ?? RIVERFRONT.AREA_2.stopId,
  };
}

interface FallbackEntry {
  routeId: CampusRouteId;
  tripId: string;
  departureMs: number;
  /** Conservative (pessimistic) arrival at the rider's destination. */
  arrivalMs: number;
}

/**
 * All campus departures the rider could still physically catch, with their
 * scheduled arrival at the destination. Used to price "what if this one doesn't
 * show up?" against the real timetable instead of a made-up constant.
 */
function buildFallbackPool(args: {
  destinationKey: string;
  routeIds: readonly CampusRouteId[];
  nowMs: number;
  earliestAtArea1Ms: number;
  requiredBufferSec: number;
  windowMinutes: number;
}): FallbackEntry[] {
  const dest = findCampusDestination(args.destinationKey);
  if (!dest) return [];
  const pool: FallbackEntry[] = [];
  for (const routeId of args.routeIds) {
    const destStopId = dest.stopIdByRoute[routeId];
    if (!destStopId || !dest.servedBy.includes(routeId)) continue;
    const deps = getScheduledDepartures({
      stopId: RIVERFRONT.AREA_1.stopId,
      routeIds: [routeId],
      fromMs: args.nowMs,
      windowMinutes: args.windowMinutes,
    });
    for (const d of deps) {
      if (d.departureEpochMs < args.earliestAtArea1Ms + args.requiredBufferSec * 1000) continue;
      const arrival = getTripArrivalAtStop(d.tripId, destStopId, d.serviceDate);
      if (arrival === undefined) continue;
      pool.push({ routeId, tripId: d.tripId, departureMs: d.departureEpochMs, arrivalMs: arrival });
    }
  }
  return pool.sort((a, b) => a.departureMs - b.departureMs);
}

/**
 * The earliest arrival available if the rider is standing at Area 1 having just
 * watched their intended bus fail to appear.
 */
function nextBestArrival(
  pool: FallbackEntry[],
  opts: { afterMs: number; excludeTripId: string },
): number | null {
  const later = pool.filter(
    (p) => p.tripId !== opts.excludeTripId && p.departureMs >= opts.afterMs,
  );
  if (later.length === 0) return null;
  return Math.min(...later.map((p) => p.arrivalMs));
}

export interface CompareUcscInput {
  snapshot: RealtimeSnapshot;
  nowMs: number;
  destinationKey: string;
  /**
   * When the rider is arriving on the 35, this is when they can realistically be
   * standing at Area 1. Omit if they are already downtown.
   */
  earliestAtArea1Ms?: number;
  /** The Route 35 arrival driving the transfer, used to report the margin. */
  route35ArrivalMs?: number;
  preferences?: RiderPreferences;
  candidateRouteIds?: readonly CampusRouteId[];
  windowMinutes?: number;
}

/**
 * Ranks Routes 11, 18 and 19 for the downtown -> campus leg.
 *
 *   best_ucsc_option = argmin(expected_arrival + transfer_risk + preference_penalties)
 *
 * Scores are in seconds so every term is directly comparable and explainable:
 * a penalty of 120 literally means "worth 2 minutes of arrival time".
 */
export function compareUcscOptions(input: CompareUcscInput): UcscComparison {
  const prefs = input.preferences ?? DEFAULT_PREFERENCES;
  const { snapshot, nowMs } = input;
  const dest = findCampusDestination(input.destinationKey);
  const assumptions: string[] = [];

  if (!dest) {
    return {
      destinationKey: input.destinationKey,
      destinationName: input.destinationKey,
      options: [],
      bestRouteId: null,
      undecidedReason: `Unknown campus destination "${input.destinationKey}".`,
      assumptions,
      engineVersion: ENGINE_VERSION,
    };
  }

  const walkSec = interAreaWalkSeconds(prefs);
  const earliestAtArea1 = input.earliestAtArea1Ms ?? nowMs;
  const requiredBufferSec = DEFAULTS.boardingBufferSeconds + prefs.extraTransferBufferSec;

  assumptions.push(
    `Inter-area walk from ${RIVERFRONT.AREA_2.label} to ${RIVERFRONT.AREA_1.label} assumed at ${Math.round(walkSec / 60)} min.`,
  );
  assumptions.push(`Boarding buffer of ${Math.round(requiredBufferSec / 60)} min applied at the transfer.`);
  if (prefs.reducedMobility) assumptions.push('Walking times increased because reduced mobility is set.');

  const candidates = input.candidateRouteIds ?? CAMPUS_ROUTE_IDS;
  const options: UcscOption[] = [];

  /**
   * Every campus departure the rider could still catch, across all three routes,
   * with its conservative arrival at the chosen destination. This is what makes
   * "what does it cost me if this bus doesn't turn up?" answerable from the
   * timetable rather than invented.
   */
  const fallbackPool = buildFallbackPool({
    destinationKey: dest.key,
    routeIds: candidates,
    nowMs,
    earliestAtArea1Ms: earliestAtArea1,
    requiredBufferSec,
    windowMinutes: (input.windowMinutes ?? 120) + 90,
  });

  for (const routeId of candidates) {
    const destStopId = dest.stopIdByRoute[routeId];
    const blockedReasons: string[] = [];
    const rationale: string[] = [];
    const scoreBreakdown: UcscOption['scoreBreakdown'] = [];

    // Coverage is a hard fact from the timetable, not a preference.
    if (!destStopId || !dest.servedBy.includes(routeId)) {
      options.push({
        routeId,
        score: Number.POSITIVE_INFINITY,
        scoreBreakdown: [],
        transferMarginSec: null,
        feasible: false,
        blockedReasons: [`Route ${routeId} does not serve ${dest.name}.`],
        rationale: [`Route ${routeId} never reaches ${dest.name}, so it is not an option for this trip.`],
      });
      continue;
    }

    const departures = getScheduledDepartures({
      stopId: RIVERFRONT.AREA_1.stopId,
      routeIds: [routeId],
      fromMs: nowMs,
      windowMinutes: input.windowMinutes ?? 120,
    });

    // The first departure the rider can physically make.
    const reachable = departures.find(
      (d) => d.departureEpochMs >= earliestAtArea1 + requiredBufferSec * 1000,
    );
    const anyDeparture = departures[0];

    if (!reachable) {
      options.push({
        routeId,
        tripId: anyDeparture?.tripId,
        score: Number.POSITIVE_INFINITY,
        scoreBreakdown: [],
        transferMarginSec: anyDeparture
          ? Math.round((anyDeparture.departureEpochMs - earliestAtArea1) / 1000) - requiredBufferSec
          : null,
        feasible: false,
        blockedReasons: [
          anyDeparture
            ? `The next Route ${routeId} leaves ${RIVERFRONT.AREA_1.label} before you could reach it on foot.`
            : `No Route ${routeId} departure is scheduled from ${RIVERFRONT.AREA_1.label} in the next ${input.windowMinutes ?? 120} minutes.`,
        ],
        rationale: [],
      });
      continue;
    }

    const evidence = analyzeRouteEvidence({
      snapshot,
      routeId,
      tripId: reachable.tripId,
      stopId: RIVERFRONT.AREA_1.stopId,
      scheduledDepartureMs: reachable.departureEpochMs,
      nowMs,
    });

    const scheduledArrival = getTripArrivalAtStop(reachable.tripId, destStopId, reachable.serviceDate);
    if (scheduledArrival === undefined) {
      options.push({
        routeId,
        tripId: reachable.tripId,
        evidence,
        score: Number.POSITIVE_INFINITY,
        scoreBreakdown: [],
        transferMarginSec: null,
        feasible: false,
        blockedReasons: [`This Route ${routeId} trip does not call at ${dest.name}.`],
        rationale: [],
      });
      continue;
    }

    const deviationMs = (evidence.scheduleDeviationSec ?? 0) * 1000;
    const predictedArrival = scheduledArrival + deviationMs;
    const spreadMs = evidence.departureRangeMs[1] - evidence.predictedDepartureMs;
    const arrivalRangeMs: [number, number] = [
      predictedArrival - spreadMs,
      predictedArrival + spreadMs,
    ];

    const transferMarginSec = Math.round(
      (evidence.predictedDepartureMs - earliestAtArea1) / 1000 - requiredBufferSec,
    );

    // --- scoring, all terms in seconds ---
    // Base: conservative arrival. Using the pessimistic end means an option only
    // wins if it is better even on a bad day.
    let score = (arrivalRangeMs[1] - nowMs) / 1000;
    scoreBreakdown.push({
      factor: 'conservative_arrival',
      detail: `Conservative arrival at ${dest.name}.`,
      penaltySec: Math.round(score),
    });

    // Transfer risk: thin margins are penalised steeply and non-linearly.
    const transferRisk =
      transferMarginSec >= 300 ? 0 : transferMarginSec >= 0 ? (300 - transferMarginSec) * 1.5 : 3600;
    if (transferRisk > 0) {
      score += transferRisk;
      scoreBreakdown.push({
        factor: 'transfer_risk',
        detail:
          transferMarginSec < 0
            ? 'You cannot reach this departure in time.'
            : `Only ${Math.round(transferMarginSec / 60)} min of slack at the transfer.`,
        penaltySec: Math.round(transferRisk),
      });
    }

    // Evidence risk, weighted by consequence rather than by a flat constant.
    //
    // A flat penalty is the wrong shape: not being able to see a bus matters
    // enormously when the fallback is 25 minutes later, and barely at all when
    // another bus follows 4 minutes behind. So we price the risk as
    //
    //   exposure = (1 - confidence) x (fallback_arrival - this_arrival)
    //
    // where the fallback is the genuinely next-best arrival from the timetable.
    // `confidence` is used as a risk WEIGHT, not as a probability -- it is not
    // calibrated, and the UI says so.
    const fallbackArrivalMs = nextBestArrival(fallbackPool, {
      afterMs: evidence.predictedDepartureMs,
      excludeTripId: reachable.tripId,
    });
    const fallbackLossSec =
      fallbackArrivalMs === null
        ? 30 * 60 // nothing else today: treat a no-show as costing half an hour
        : Math.max(0, Math.round((fallbackArrivalMs - arrivalRangeMs[1]) / 1000));
    const evidenceRisk = Math.round((1 - evidence.confidence) * fallbackLossSec);
    score += evidenceRisk;
    scoreBreakdown.push({
      factor: 'evidence_risk',
      detail:
        `Confidence ${(evidence.confidence * 100).toFixed(0)}% (${evidence.label.replace('-', ' ')}). ` +
        (fallbackArrivalMs === null
          ? 'No later option to fall back on.'
          : `If it does not turn up, the next option costs about ${Math.round(fallbackLossSec / 60)} min more.`),
      penaltySec: evidenceRisk,
    });

    // Saved rider preference. Small by design: it breaks ties, it never
    // overrides a materially better or safer option.
    if (prefs.preferQuieterRoute11 && routeId === '11') {
      score -= 90;
      scoreBreakdown.push({
        factor: 'rider_preference',
        detail:
          'Saved rider preference: Route 11 usually feels less crowded. This is your own note, not live crowding data.',
        penaltySec: -90,
      });
    }

    // Agency-reported occupancy, used only when the feed actually publishes it.
    if (evidence.occupancyStatus === 'FULL' || evidence.occupancyStatus === 'CRUSHED_STANDING_ROOM_ONLY') {
      score += 180;
      scoreBreakdown.push({
        factor: 'reported_occupancy',
        detail: `Agency-reported occupancy: ${evidence.occupancyStatus.replaceAll('_', ' ').toLowerCase()}.`,
        penaltySec: 180,
      });
    }

    if (evidence.label === 'blocked') {
      blockedReasons.push('A service alert rules this option out.');
    }

    rationale.push(
      `Leaves ${RIVERFRONT.AREA_1.label} at ${new Date(evidence.predictedDepartureMs).toISOString()}.`,
    );
    rationale.push(
      evidence.vehicleVisible
        ? `A vehicle position is visible, updated ${evidence.vehicleAgeSeconds}s ago.`
        : 'No current vehicle position is visible for this trip.',
    );
    rationale.push(`Transfer slack ${Math.round(transferMarginSec / 60)} min.`);

    options.push({
      routeId,
      tripId: reachable.tripId,
      evidence,
      arrivalRangeMs,
      score: Math.round(score),
      scoreBreakdown,
      transferMarginSec,
      feasible: blockedReasons.length === 0,
      blockedReasons,
      rationale,
    });
  }

  const feasible = options.filter((o) => o.feasible && Number.isFinite(o.score));
  feasible.sort((a, b) => a.score - b.score);
  const best = feasible[0];

  let undecidedReason: string | null = null;
  if (!best) {
    undecidedReason =
      options.length === 0
        ? 'No campus routes were evaluated.'
        : `None of Routes ${candidates.join(', ')} can be recommended for ${dest.name} right now. ${options
            .flatMap((o) => o.blockedReasons)
            .join(' ')}`;
  } else if (feasible.length > 1 && Math.abs(feasible[0].score - feasible[1].score) < 60) {
    assumptions.push(
      `Routes ${feasible[0].routeId} and ${feasible[1].routeId} score within a minute of each other; either is reasonable.`,
    );
  }

  // Sort the full list for display: feasible ones by score, then the rest.
  const ordered = [
    ...feasible,
    ...options.filter((o) => !feasible.includes(o)),
  ];

  return {
    destinationKey: dest.key,
    destinationName: dest.name,
    options: ordered,
    bestRouteId: best?.routeId ?? null,
    undecidedReason,
    assumptions,
    engineVersion: ENGINE_VERSION,
  };
}

export interface BuildMultilegInput {
  snapshot: RealtimeSnapshot;
  nowMs: number;
  destinationKey: string;
  preferences?: RiderPreferences;
  /** Trip the rider is already riding on the 35, when known. */
  route35TripId?: string;
  originStopId?: string;
}

/**
 * Builds the full Scotts Valley -> Area 2 -> walk -> Area 1 -> campus journey.
 */
export function buildMultilegTrip(
  input: BuildMultilegInput,
): MultilegTrip & { comparison: UcscComparison; earliestAtArea1Ms: number } {
  const prefs = input.preferences ?? DEFAULT_PREFERENCES;
  const walkSec = interAreaWalkSeconds(prefs);
  const assumptions: string[] = [];
  const blockedReasons: string[] = [];
  const legs: JourneyLeg[] = [];

  const arrival = resolveRoute35Arrival({
    snapshot: input.snapshot,
    nowMs: input.nowMs,
    tripId: input.route35TripId,
    originStopId: input.originStopId,
  });

  let earliestAtArea1: number;
  if (arrival) {
    const boardStopId = input.originStopId ?? RIVERFRONT.AREA_2.stopId;
    const boardTime =
      getStopTimesForTrip(arrival.tripId).find((s) => s.stop_id === boardStopId)?.departureSec ?? null;
    legs.push({
      kind: 'bus',
      routeId: TRUNK_ROUTE_ID,
      tripId: arrival.tripId,
      label: `Route ${TRUNK_ROUTE_ID} to ${RIVERFRONT.AREA_2.label}`,
      fromStopId: boardStopId,
      fromStopName: stopName(boardStopId),
      toStopId: RIVERFRONT.AREA_2.stopId,
      toStopName: RIVERFRONT.AREA_2.label,
      departureMs:
        boardTime !== null
          ? serviceDateTimeToEpochMs(
              // Reuse the arrival's own service day.
              new Date(arrival.scheduledArrivalMs).toISOString().slice(0, 10).replaceAll('-', ''),
              boardTime,
            )
          : arrival.scheduledArrivalMs,
      arrivalMs: arrival.predictedArrivalMs,
      evidence: arrival.evidence,
    });
    legs.push({
      kind: 'walk',
      label: `Walk ${RIVERFRONT.AREA_2.label} → ${RIVERFRONT.AREA_1.label}`,
      fromStopId: RIVERFRONT.AREA_2.stopId,
      fromStopName: RIVERFRONT.AREA_2.label,
      toStopId: RIVERFRONT.AREA_1.stopId,
      toStopName: RIVERFRONT.AREA_1.label,
      departureMs: arrival.predictedArrivalMs,
      arrivalMs: arrival.predictedArrivalMs + walkSec * 1000,
    });
    earliestAtArea1 = arrival.predictedArrivalMs + walkSec * 1000;
    assumptions.push(
      `Route 35 arrival at ${RIVERFRONT.AREA_2.label} taken from ${arrival.evidence.label.replace('-', ' ')} evidence.`,
    );
  } else {
    earliestAtArea1 = input.nowMs;
    blockedReasons.push(
      `No inbound Route ${TRUNK_ROUTE_ID} trip to ${RIVERFRONT.AREA_2.label} was found in the next three hours, so the first leg could not be resolved.`,
    );
  }

  const comparison = compareUcscOptions({
    snapshot: input.snapshot,
    nowMs: input.nowMs,
    destinationKey: input.destinationKey,
    earliestAtArea1Ms: earliestAtArea1,
    route35ArrivalMs: arrival?.predictedArrivalMs,
    preferences: prefs,
  });

  const best = comparison.options.find((o) => o.routeId === comparison.bestRouteId);
  if (best?.evidence && best.arrivalRangeMs) {
    legs.push({
      kind: 'bus',
      routeId: best.routeId,
      tripId: best.tripId,
      label: `Route ${best.routeId} to ${comparison.destinationName}`,
      fromStopId: RIVERFRONT.AREA_1.stopId,
      fromStopName: RIVERFRONT.AREA_1.label,
      toStopId: findCampusDestination(comparison.destinationKey)?.stopIdByRoute[best.routeId] ?? '',
      toStopName: comparison.destinationName,
      departureMs: best.evidence.predictedDepartureMs,
      arrivalMs: (best.arrivalRangeMs[0] + best.arrivalRangeMs[1]) / 2,
      evidence: best.evidence,
    });
  } else if (comparison.undecidedReason) {
    blockedReasons.push(comparison.undecidedReason);
  }

  const downtownTransferMarginSec =
    arrival && best?.evidence
      ? Math.round(
          (best.evidence.predictedDepartureMs - arrival.predictedArrivalMs) / 1000 - walkSec,
        )
      : null;

  const expectedArrivalRangeMs: [number, number] = best?.arrivalRangeMs ?? [
    Number.NaN,
    Number.NaN,
  ];

  return {
    legs,
    expectedArrivalRangeMs,
    downtownTransferMarginSec,
    assumptions: [...assumptions, ...comparison.assumptions],
    blockedReasons,
    engineVersion: ENGINE_VERSION,
    comparison,
    // Exposed so a caller comparing campus routes separately can use the SAME
    // transfer time. Comparing against "now" instead would silently produce a
    // different winner from the one this journey recommends.
    earliestAtArea1Ms: earliestAtArea1,
  };
}

/**
 * Return trip: a campus route brings the rider into Area 3, then Route 35 leaves
 * from Area 2. Returns the next viable outbound 35 and the wait it implies.
 */
export interface ReturnTripInput {
  snapshot: RealtimeSnapshot;
  nowMs: number;
  preferences?: RiderPreferences;
  /** Rider is already at Area 3; otherwise supply when they will arrive. */
  atArea3Ms?: number;
}

export interface ReturnTrip {
  /** Where the rider must physically be to board. */
  boardingStopId: string;
  boardingStopLabel: string;
  walkFromArea3Sec: number;
  next35: {
    tripId: string;
    scheduledDepartureMs: number;
    predictedDepartureMs: number;
    departureRangeMs: [number, number];
    evidence: RouteEvidence;
  } | null;
  /** Seconds between now and the predicted departure. */
  waitSeconds: number | null;
  headwaySummary: string;
  assumptions: string[];
  blockedReasons: string[];
  engineVersion: string;
}

export function buildReturnTrip(input: ReturnTripInput): ReturnTrip {
  const prefs = input.preferences ?? DEFAULT_PREFERENCES;
  const walkSec = interAreaWalkSeconds(prefs);
  const from = input.atArea3Ms ?? input.nowMs;
  const assumptions: string[] = [
    `Walk from ${RIVERFRONT.AREA_3.label} to ${RIVERFRONT.AREA_2.label} assumed at ${Math.round(walkSec / 60)} min.`,
  ];
  const blockedReasons: string[] = [];

  const departures = getScheduledDepartures({
    stopId: RIVERFRONT.AREA_2.stopId,
    routeIds: [TRUNK_ROUTE_ID],
    fromMs: from,
    windowMinutes: 300,
  }).filter((d) => d.directionId === 0);

  const reachable = departures.find(
    (d) => d.departureEpochMs >= from + (walkSec + DEFAULTS.boardingBufferSeconds) * 1000,
  );

  if (!reachable) {
    blockedReasons.push(
      `No outbound Route ${TRUNK_ROUTE_ID} departure from ${RIVERFRONT.AREA_2.label} is reachable in the next five hours.`,
    );
    return {
      boardingStopId: RIVERFRONT.AREA_2.stopId,
      boardingStopLabel: RIVERFRONT.AREA_2.label,
      walkFromArea3Sec: walkSec,
      next35: null,
      waitSeconds: null,
      headwaySummary: '',
      assumptions,
      blockedReasons,
      engineVersion: ENGINE_VERSION,
    };
  }

  const evidence = analyzeRouteEvidence({
    snapshot: input.snapshot,
    routeId: TRUNK_ROUTE_ID,
    tripId: reachable.tripId,
    stopId: RIVERFRONT.AREA_2.stopId,
    scheduledDepartureMs: reachable.departureEpochMs,
    nowMs: input.nowMs,
  });

  return {
    boardingStopId: RIVERFRONT.AREA_2.stopId,
    boardingStopLabel: RIVERFRONT.AREA_2.label,
    walkFromArea3Sec: walkSec,
    next35: {
      tripId: reachable.tripId,
      scheduledDepartureMs: reachable.departureEpochMs,
      predictedDepartureMs: evidence.predictedDepartureMs,
      departureRangeMs: evidence.departureRangeMs,
      evidence,
    },
    waitSeconds: Math.round((evidence.predictedDepartureMs - input.nowMs) / 1000),
    headwaySummary: '',
    assumptions,
    blockedReasons,
    engineVersion: ENGINE_VERSION,
  };
}
