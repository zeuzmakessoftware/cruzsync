/**
 * Safe-wait arithmetic. This is the calculation a rider actually trusts with
 * their evening, so it is deterministic, conservative, and never delegated to a
 * language model.
 *
 *   usable_wait = predicted_departure - now - walk_back - boarding_buffer - uncertainty_buffer
 *   leave_by    = predicted_departure - walk_back - boarding_buffer - uncertainty_buffer
 *   place_is_safe = open_through(leave_by) && usable_wait >= minimum_useful_visit
 *
 * Every buffer is explicit and configurable, and the uncertainty buffer GROWS
 * when the evidence is weak. Uncertainty must always cost the rider time rather
 * than earn them time.
 */
import { DEFAULTS, ENGINE_VERSION } from '@/lib/domain';
import type { RouteEvidence } from './types';

export interface SafeWaitInput {
  nowMs: number;
  /** Predicted departure of the bus the rider must catch. */
  predictedDepartureMs: number;
  /** Verified or estimated walking time from the place back to the boarding stop. */
  walkSeconds: number;
  boardingBufferSeconds?: number;
  uncertaintyBufferSeconds?: number;
  minimumUsefulVisitSeconds?: number;
}

export interface SafeWaitResult {
  leaveByMs: number;
  /** Seconds of genuinely usable time at the destination. Never negative. */
  usableWaitSeconds: number;
  /** When the "start wrapping up" nudge should fire. */
  wrapUpAtMs: number;
  /** True when there is enough time for the visit to be worth making at all. */
  hasUsefulTime: boolean;
  breakdown: { label: string; seconds: number }[];
  walkSeconds: number;
  boardingBufferSeconds: number;
  uncertaintyBufferSeconds: number;
  minimumUsefulVisitSeconds: number;
  engineVersion: string;
}

export function calculateSafeWait(input: SafeWaitInput): SafeWaitResult {
  const boardingBufferSeconds = input.boardingBufferSeconds ?? DEFAULTS.boardingBufferSeconds;
  const uncertaintyBufferSeconds =
    input.uncertaintyBufferSeconds ?? DEFAULTS.baseUncertaintyBufferSeconds;
  const minimumUsefulVisitSeconds =
    input.minimumUsefulVisitSeconds ?? DEFAULTS.minimumUsefulVisitSeconds;
  const walkSeconds = Math.max(0, Math.round(input.walkSeconds));

  const totalReserveSec = walkSeconds + boardingBufferSeconds + uncertaintyBufferSeconds;
  const leaveByMs = input.predictedDepartureMs - totalReserveSec * 1000;
  const usableWaitSeconds = Math.max(0, Math.round((leaveByMs - input.nowMs) / 1000));

  return {
    leaveByMs,
    usableWaitSeconds,
    wrapUpAtMs: leaveByMs - DEFAULTS.wrapUpLeadSeconds * 1000,
    hasUsefulTime: usableWaitSeconds >= minimumUsefulVisitSeconds,
    breakdown: [
      { label: 'Time until the bus leaves', seconds: Math.round((input.predictedDepartureMs - input.nowMs) / 1000) },
      { label: 'Walk back to the stop', seconds: -walkSeconds },
      { label: 'Boarding buffer', seconds: -boardingBufferSeconds },
      { label: 'Uncertainty buffer', seconds: -uncertaintyBufferSeconds },
    ],
    walkSeconds,
    boardingBufferSeconds,
    uncertaintyBufferSeconds,
    minimumUsefulVisitSeconds,
    engineVersion: ENGINE_VERSION,
  };
}

/**
 * How much padding to reserve given what we actually know.
 *
 * Weak evidence, a stale feed or a fast-moving vehicle all INCREASE the buffer.
 * A vehicle moving quickly can arrive earlier than predicted, which is precisely
 * the case where a rider comfortably sipping coffee gets caught out.
 */
export function deriveUncertaintyBuffer(opts: {
  evidence?: RouteEvidence;
  feedAgeSeconds?: number;
  /** Speed of the vehicle serving the trip, when known. */
  vehicleSpeedMps?: number | null;
  /** Rider has not used this stop before. */
  unfamiliarStop?: boolean;
  /** Walking time came from an estimate rather than a routing provider. */
  walkingTimeEstimated?: boolean;
}): { seconds: number; reasons: string[] } {
  let seconds = DEFAULTS.baseUncertaintyBufferSeconds;
  const reasons: string[] = [`Base buffer ${DEFAULTS.baseUncertaintyBufferSeconds / 60} min.`];

  const label = opts.evidence?.label;
  if (label === 'scheduled-only') {
    seconds += 180;
    reasons.push('No real-time evidence for this trip: +3 min.');
  } else if (label === 'stale') {
    seconds += 300;
    reasons.push('Real-time evidence has gone stale: +5 min.');
  } else if (label === 'reported') {
    seconds += 60;
    reasons.push('Trip update only, no vehicle position: +1 min.');
  } else if (label === 'blocked') {
    seconds += 600;
    reasons.push('A service alert affects this trip: +10 min.');
  }

  if ((opts.feedAgeSeconds ?? 0) > DEFAULTS.staleAfterSeconds) {
    seconds += 120;
    reasons.push('The real-time feed itself is behind: +2 min.');
  }

  if ((opts.vehicleSpeedMps ?? 0) > 11) {
    seconds += 90;
    reasons.push('The bus is moving quickly and could arrive early: +1.5 min.');
  }

  if (opts.unfamiliarStop) {
    seconds += 60;
    reasons.push('Unfamiliar boarding area: +1 min.');
  }

  if (opts.walkingTimeEstimated) {
    seconds += 90;
    reasons.push('Walking time is estimated rather than verified: +1.5 min.');
  }

  return { seconds, reasons };
}

/** Great-circle distance in metres. */
export function haversineMetres(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Estimated walking time when no routing provider is configured.
 * Explicitly marked estimated so the UI never claims a verified walk.
 */
export function estimateWalkSeconds(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  opts: { reducedMobility?: boolean } = {},
): { seconds: number; metres: number; estimated: true } {
  const straight = haversineMetres(from, to);
  const metres = straight * DEFAULTS.walkingDetourFactor;
  const speed = opts.reducedMobility ? DEFAULTS.walkingSpeedMps * 0.65 : DEFAULTS.walkingSpeedMps;
  return { seconds: Math.round(metres / speed), metres: Math.round(metres), estimated: true };
}
