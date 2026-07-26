/**
 * Route evidence scoring.
 *
 *   route_confidence = evidence_weight(vehicle_visibility, trip_update_age,
 *                                      schedule_deviation, alerts)
 *
 * Deliberately simple and additive so a rider (or a judge) can read the exact
 * arithmetic off the screen. The score starts at a schedule-only baseline and
 * moves up or down as real evidence appears.
 *
 * This is a heuristic, not a probability. We have no historical arrival outcomes
 * for Santa Cruz METRO, so nothing here is calibrated and the UI says so.
 */
import { DEFAULTS, ENGINE_VERSION } from '@/lib/domain';
import type { NormalisedAlert, NormalisedTripUpdate, NormalisedVehicle, RealtimeSnapshot } from '@/lib/rt/types';
import type { EvidenceSignal, RouteEvidence } from './types';

/** Weights are named so they can be shown in the UI and changed in one place. */
export const EVIDENCE_WEIGHTS = {
  scheduleBaseline: 0.35,
  vehicleVisibleFresh: 0.4,
  vehicleVisibleAging: 0.2,
  tripUpdateFresh: 0.15,
  tripUpdateAging: 0.05,
  staleRealtimePenalty: -0.15,
  largeDeviationPenalty: -0.1,
  alertReducesServicePenalty: -0.45,
  alertInformationalPenalty: -0.05,
} as const;

/** Effects that genuinely mean "you may not get this bus". */
const SERVICE_REDUCING_EFFECTS = new Set([
  'NO_SERVICE',
  'REDUCED_SERVICE',
  'SIGNIFICANT_DELAYS',
  'DETOUR',
  'STOP_MOVED',
]);

export function isAlertActive(alert: NormalisedAlert, nowMs: number): boolean {
  if (alert.activePeriods.length === 0) return true;
  return alert.activePeriods.some(
    (p) => (p.startMs === null || p.startMs <= nowMs) && (p.endMs === null || p.endMs >= nowMs),
  );
}

export function findRelevantAlerts(
  snapshot: RealtimeSnapshot,
  { routeId, stopId, tripId }: { routeId: string; stopId?: string; tripId?: string },
  nowMs: number,
): NormalisedAlert[] {
  return snapshot.alerts.filter((a) => {
    if (!isAlertActive(a, nowMs)) return false;
    if (a.informedRouteIds.includes(routeId)) return true;
    if (stopId && a.informedStopIds.includes(stopId)) return true;
    if (tripId && a.informedTripIds.includes(tripId)) return true;
    return false;
  });
}

function findVehicle(snapshot: RealtimeSnapshot, tripId: string): NormalisedVehicle | undefined {
  return snapshot.vehicles.find((v) => v.tripId === tripId);
}

function findTripUpdate(snapshot: RealtimeSnapshot, tripId: string): NormalisedTripUpdate | undefined {
  return snapshot.tripUpdates.find((t) => t.tripId === tripId);
}

/** Deviation in seconds for a specific stop, preferring the stop-level value. */
function deviationForStop(tu: NormalisedTripUpdate | undefined, stopId: string): number | null {
  if (!tu) return null;
  const stu = tu.stopTimeUpdates.find((s) => s.stopId === stopId);
  if (stu) {
    if (stu.departureDelaySec !== null) return stu.departureDelaySec;
    if (stu.arrivalDelaySec !== null) return stu.arrivalDelaySec;
  }
  return tu.delaySec;
}

export interface AnalyseEvidenceInput {
  snapshot: RealtimeSnapshot;
  routeId: string;
  tripId: string;
  stopId: string;
  scheduledDepartureMs: number;
  nowMs: number;
}

export function analyzeRouteEvidence(input: AnalyseEvidenceInput): RouteEvidence {
  const { snapshot, routeId, tripId, stopId, scheduledDepartureMs, nowMs } = input;
  const signals: EvidenceSignal[] = [];
  const caveats: string[] = [];

  signals.push({
    key: 'static_schedule',
    detail: `Scheduled in GTFS for this service day.`,
    weight: EVIDENCE_WEIGHTS.scheduleBaseline,
    source: 'static_schedule',
    observedAtMs: null,
  });
  let confidence: number = EVIDENCE_WEIGHTS.scheduleBaseline;

  const vehicle = findVehicle(snapshot, tripId);
  const tripUpdate = findTripUpdate(snapshot, tripId);
  const vehicleAge = vehicle?.ageSeconds ?? null;
  const tuAge =
    tripUpdate?.timestampMs != null
      ? Math.max(0, Math.round((nowMs - tripUpdate.timestampMs) / 1000))
      : null;

  let sawUsableRealtime = false;

  if (vehicle && vehicleAge !== null && vehicleAge <= DEFAULTS.staleAfterSeconds) {
    confidence += EVIDENCE_WEIGHTS.vehicleVisibleFresh;
    sawUsableRealtime = true;
    signals.push({
      key: 'vehicle_visible_fresh',
      detail: `Vehicle ${vehicle.vehicleId ?? '(unlabelled)'} position updated ${vehicleAge}s ago.`,
      weight: EVIDENCE_WEIGHTS.vehicleVisibleFresh,
      source: 'vehicle_positions',
      observedAtMs: vehicle.timestampMs,
    });
  } else if (vehicle && vehicleAge !== null && vehicleAge <= DEFAULTS.hardStaleAfterSeconds) {
    confidence += EVIDENCE_WEIGHTS.vehicleVisibleAging;
    sawUsableRealtime = true;
    signals.push({
      key: 'vehicle_visible_aging',
      detail: `Vehicle position is ${vehicleAge}s old — usable but no longer fresh.`,
      weight: EVIDENCE_WEIGHTS.vehicleVisibleAging,
      source: 'vehicle_positions',
      observedAtMs: vehicle.timestampMs,
    });
    caveats.push('The vehicle position for this trip is ageing; treat the timing as approximate.');
  } else if (vehicle) {
    confidence += EVIDENCE_WEIGHTS.staleRealtimePenalty;
    signals.push({
      key: 'vehicle_stale',
      detail: `A vehicle is assigned but its last position is ${vehicleAge ?? '?'}s old.`,
      weight: EVIDENCE_WEIGHTS.staleRealtimePenalty,
      source: 'vehicle_positions',
      observedAtMs: vehicle.timestampMs,
    });
    caveats.push('The assigned vehicle has stopped reporting recently.');
  } else {
    // Critical wording: absence of a position is NOT a cancellation.
    signals.push({
      key: 'no_vehicle_position',
      detail: 'No current vehicle position is visible for this trip.',
      weight: 0,
      source: 'vehicle_positions',
      observedAtMs: null,
    });
    caveats.push(
      'No current vehicle position is visible for this trip. That does not mean it is cancelled — it may not have been assigned a tracked bus yet, or the bus may not be reporting.',
    );
  }

  if (tuAge !== null && tuAge <= DEFAULTS.staleAfterSeconds) {
    confidence += EVIDENCE_WEIGHTS.tripUpdateFresh;
    sawUsableRealtime = true;
    signals.push({
      key: 'trip_update_fresh',
      detail: `Trip update received ${tuAge}s ago.`,
      weight: EVIDENCE_WEIGHTS.tripUpdateFresh,
      source: 'trip_updates',
      observedAtMs: tripUpdate?.timestampMs ?? null,
    });
  } else if (tuAge !== null && tuAge <= DEFAULTS.hardStaleAfterSeconds) {
    confidence += EVIDENCE_WEIGHTS.tripUpdateAging;
    sawUsableRealtime = true;
    signals.push({
      key: 'trip_update_aging',
      detail: `Trip update is ${tuAge}s old.`,
      weight: EVIDENCE_WEIGHTS.tripUpdateAging,
      source: 'trip_updates',
      observedAtMs: tripUpdate?.timestampMs ?? null,
    });
  } else if (tuAge !== null) {
    confidence += EVIDENCE_WEIGHTS.staleRealtimePenalty;
    signals.push({
      key: 'trip_update_stale',
      detail: `The most recent trip update is ${tuAge}s old, beyond the ${DEFAULTS.hardStaleAfterSeconds}s usable window.`,
      weight: EVIDENCE_WEIGHTS.staleRealtimePenalty,
      source: 'trip_updates',
      observedAtMs: tripUpdate?.timestampMs ?? null,
    });
    caveats.push('Real-time information for this trip has gone quiet.');
  }

  // The feed can state outright that a trip is cancelled. That is the ONE case
  // where CruzSync is entitled to say a bus is not coming, because the agency
  // said so. Silence is never treated this way.
  const cancelled =
    tripUpdate?.scheduleRelationship === 'CANCELED' ||
    tripUpdate?.stopTimeUpdates.some(
      (s) => s.stopId === stopId && s.scheduleRelationship === 'SKIPPED',
    );
  if (cancelled) {
    confidence = 0;
    signals.push({
      key: 'trip_cancelled',
      detail:
        tripUpdate?.scheduleRelationship === 'CANCELED'
          ? 'The agency feed reports this trip as cancelled.'
          : 'The agency feed reports this stop as skipped on this trip.',
      weight: -1,
      source: 'trip_updates',
      observedAtMs: tripUpdate?.timestampMs ?? null,
    });
    caveats.push(
      'Santa Cruz METRO has published this trip as cancelled, so this is a reported cancellation rather than an inference.',
    );
  }

  const deviationSec = deviationForStop(tripUpdate, stopId);
  if (deviationSec !== null && Math.abs(deviationSec) > 300) {
    confidence += EVIDENCE_WEIGHTS.largeDeviationPenalty;
    signals.push({
      key: 'large_schedule_deviation',
      detail: `Running ${Math.abs(Math.round(deviationSec / 60))} min ${deviationSec > 0 ? 'late' : 'early'}.`,
      weight: EVIDENCE_WEIGHTS.largeDeviationPenalty,
      source: 'trip_updates',
      observedAtMs: tripUpdate?.timestampMs ?? null,
    });
  } else if (deviationSec !== null && deviationSec !== 0) {
    signals.push({
      key: 'schedule_deviation',
      detail: `Running ${Math.abs(Math.round(deviationSec / 60))} min ${deviationSec > 0 ? 'late' : 'early'}.`,
      weight: 0,
      source: 'trip_updates',
      observedAtMs: tripUpdate?.timestampMs ?? null,
    });
  }

  const alerts = findRelevantAlerts(snapshot, { routeId, stopId, tripId }, nowMs);
  for (const a of alerts) {
    const reducing = a.effect ? SERVICE_REDUCING_EFFECTS.has(a.effect) : false;
    const weight = reducing
      ? EVIDENCE_WEIGHTS.alertReducesServicePenalty
      : EVIDENCE_WEIGHTS.alertInformationalPenalty;
    confidence += weight;
    signals.push({
      key: `alert_${a.id}`,
      detail: a.headerText ?? a.effect ?? 'Service alert in effect.',
      weight,
      source: 'service_alerts',
      observedAtMs: null,
    });
    if (reducing) caveats.push(`Service alert in effect: ${a.headerText ?? a.effect}.`);
  }

  if (snapshot.freshness.label === 'expired') {
    caveats.push(
      `The real-time feed itself is ${snapshot.freshness.ageSeconds}s old, so none of the above should be treated as current.`,
    );
  }

  confidence = Math.max(0, Math.min(1, confidence));

  const serviceReducingAlert = alerts.some((a) => a.effect === 'NO_SERVICE') || Boolean(cancelled);
  const label = determineLabel({
    serviceReducingAlert,
    vehicleFresh: Boolean(vehicle && vehicleAge !== null && vehicleAge <= DEFAULTS.staleAfterSeconds),
    hasAnyRealtime: Boolean(vehicle || tripUpdate),
    sawUsableRealtime,
    feedExpired: snapshot.freshness.label === 'expired',
  });

  const predictedDepartureMs = scheduledDepartureMs + (deviationSec ?? 0) * 1000;
  const spreadSec = uncertaintySpreadSeconds(label, confidence);

  return {
    routeId,
    tripId,
    stopId,
    label,
    confidence: Number(confidence.toFixed(3)),
    signals,
    scheduledDepartureMs,
    predictedDepartureMs,
    departureRangeMs: [
      predictedDepartureMs - spreadSec * 1000,
      predictedDepartureMs + spreadSec * 1000,
    ],
    scheduleDeviationSec: deviationSec,
    vehicleVisible: Boolean(vehicle),
    vehicleAgeSeconds: vehicleAge,
    tripUpdateAgeSeconds: tuAge,
    occupancyStatus: vehicle?.occupancyStatus ?? null,
    activeAlerts: alerts.map((a) => ({ id: a.id, header: a.headerText, effect: a.effect })),
    caveats,
  };
}

function determineLabel(x: {
  serviceReducingAlert: boolean;
  vehicleFresh: boolean;
  hasAnyRealtime: boolean;
  sawUsableRealtime: boolean;
  feedExpired: boolean;
}): RouteEvidence['label'] {
  if (x.serviceReducingAlert) return 'blocked';
  if (x.feedExpired) return 'stale';
  if (x.vehicleFresh) return 'observed';
  if (x.sawUsableRealtime) return 'reported';
  if (x.hasAnyRealtime) return 'stale';
  return 'scheduled-only';
}

/**
 * How wide the plausible departure window should be. Weak evidence widens it,
 * which downstream makes the safe-wait calculation more conservative rather than
 * more optimistic -- the direction that protects the rider.
 */
export function uncertaintySpreadSeconds(label: RouteEvidence['label'], confidence: number): number {
  const base = {
    observed: 90,
    reported: 150,
    'scheduled-only': 300,
    stale: 420,
    blocked: 600,
  }[label];
  // Low confidence widens the window by up to 50%.
  return Math.round(base * (1 + (1 - confidence) * 0.5));
}

export const EVIDENCE_ENGINE_VERSION = ENGINE_VERSION;
