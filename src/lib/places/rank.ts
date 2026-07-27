/**
 * Feasibility and ranking for waiting places.
 *
 * Two rules that are not negotiable:
 *
 *  1. Only FEASIBLE places are ranked. A place that closes before the rider must
 *     leave, or whose hours we could not verify, never appears as a confident
 *     recommendation -- it is either excluded or shown with an explicit warning
 *     and the "stay near the stop" alternative.
 *
 *  2. Sponsorship cannot buy feasibility or rank. The `sponsored` flag is carried
 *     through for disclosure only and contributes exactly zero to the score.
 */
import { DEFAULTS } from "@/lib/domain";
import { formatClock } from "@/lib/gtfs/time";
import { calculateSafeWait, estimateWalkSeconds } from "@/lib/engine/safewait";
import {
  closingTimeMinutes,
  formatMinutes,
  isOpenThrough,
  minutesOfDay,
} from "./hours";
import type {
  PlaceFilters,
  Tristate,
  WaitCandidate,
  WaitPlace,
  WalkEstimate,
} from "./types";

export interface RankInput {
  places: WaitPlace[];
  /** Where the rider must return to in order to board. */
  boardingStop: { lat: number; lon: number; name: string };
  nowMs: number;
  predictedDepartureMs: number;
  boardingBufferSeconds?: number;
  uncertaintyBufferSeconds?: number;
  minimumUsefulVisitSeconds?: number;
  filters: PlaceFilters;
  reducedMobility?: boolean;
  /** Supply real walking times when a routing provider is configured. */
  walkProvider?: (place: WaitPlace) => WalkEstimate | undefined;
}

/** A required filter fails only on an explicit `false`; 'unknown' is a soft warning. */
function checkFilter(
  required: boolean,
  value: Tristate,
  label: string,
  blocked: string[],
  warnings: string[],
): boolean {
  if (!required) return true;
  if (value === true) return true;
  if (value === false) {
    blocked.push(
      `You asked for ${label}, and this place is recorded as not having it.`,
    );
    return false;
  }
  warnings.push(
    `${label}: not recorded in the data source, so this is unconfirmed.`,
  );
  return true;
}

export function rankWaitPlaces(input: RankInput): WaitCandidate[] {
  const nowMin = minutesOfDay(input.nowMs);
  const candidates: WaitCandidate[] = [];

  for (const place of input.places) {
    const blockedReasons: string[] = [];
    const warnings: string[] = [];
    const reasons: string[] = [];

    if (place.businessStatus === "CLOSED_PERMANENTLY") {
      continue; // never worth showing
    }
    if (place.businessStatus === "CLOSED_TEMPORARILY") {
      blockedReasons.push("Reported as temporarily closed.");
    }

    const walk =
      input.walkProvider?.(place) ??
      ({
        ...estimateWalkSeconds(place, input.boardingStop, {
          reducedMobility: input.reducedMobility,
        }),
        provider: "haversine-estimate" as const,
      } satisfies WalkEstimate);

    const safe = calculateSafeWait({
      nowMs: input.nowMs,
      predictedDepartureMs: input.predictedDepartureMs,
      walkSeconds: walk.seconds,
      boardingBufferSeconds: input.boardingBufferSeconds,
      uncertaintyBufferSeconds: input.uncertaintyBufferSeconds,
      minimumUsefulVisitSeconds: input.minimumUsefulVisitSeconds,
    });

    const leaveByMin = minutesOfDay(safe.leaveByMs);
    // Handle a leave-by that lands after midnight relative to now.
    const adjustedLeaveByMin =
      leaveByMin < nowMin ? leaveByMin + 24 * 60 : leaveByMin;
    const openThroughLeaveBy = isOpenThrough(
      place.hours,
      nowMin,
      adjustedLeaveByMin,
    );

    if (openThroughLeaveBy === false) {
      const closes = closingTimeMinutes(place.hours, nowMin);
      blockedReasons.push(
        closes !== null
          ? `Closes at ${formatMinutes(closes)}, before you would need to leave at ${formatClock(safe.leaveByMs)}.`
          : "Closed at this time today.",
      );
    } else if (openThroughLeaveBy === "unknown") {
      warnings.push(
        place.hours?.raw
          ? `Opening hours could not be interpreted reliably ("${place.hours.raw}"), so CruzSync cannot confirm it stays open until ${formatClock(safe.leaveByMs)}.`
          : `No opening hours are published for this place, so CruzSync cannot confirm it is open until ${formatClock(safe.leaveByMs)}.`,
      );
    }

    let matchesFilters = true;
    const f = input.filters;
    matchesFilters =
      checkFilter(
        f.requireFree,
        place.freeToEnter,
        "somewhere free to sit",
        blockedReasons,
        warnings,
      ) && matchesFilters;
    matchesFilters =
      checkFilter(
        f.requireIndoor,
        place.isIndoor,
        "somewhere indoors",
        blockedReasons,
        warnings,
      ) && matchesFilters;
    matchesFilters =
      checkFilter(
        f.requireQuiet,
        place.isQuiet,
        "somewhere quiet",
        blockedReasons,
        warnings,
      ) && matchesFilters;
    matchesFilters =
      checkFilter(
        f.requireWifi,
        place.hasWifi,
        "Wi-Fi",
        blockedReasons,
        warnings,
      ) && matchesFilters;
    matchesFilters =
      checkFilter(
        f.requireFood,
        place.servesFood,
        "food",
        blockedReasons,
        warnings,
      ) && matchesFilters;
    matchesFilters =
      checkFilter(
        f.requireRestroom,
        place.hasRestroom,
        "a restroom",
        blockedReasons,
        warnings,
      ) && matchesFilters;
    matchesFilters =
      checkFilter(
        f.requireWheelchairAccess,
        place.wheelchairAccessible,
        "step-free access",
        blockedReasons,
        warnings,
      ) && matchesFilters;

    if (
      f.maxSpendUsd !== null &&
      place.priceLevel !== null &&
      place.priceLevel > 2 &&
      f.maxSpendUsd < 15
    ) {
      blockedReasons.push("Likely to cost more than your stated budget.");
      matchesFilters = false;
    }

    const enoughUsableTime = safe.hasUsefulTime;
    if (!enoughUsableTime) {
      blockedReasons.push(
        `Only ${Math.round(safe.usableWaitSeconds / 60)} usable minutes after walking back, which is not enough to be worth it.`,
      );
    }

    // The hard gate. 'unknown' hours are explicitly NOT treated as open.
    const feasible =
      blockedReasons.length === 0 &&
      enoughUsableTime &&
      matchesFilters &&
      openThroughLeaveBy === true;

    const closes = closingTimeMinutes(place.hours, nowMin);
    reasons.push(
      `${Math.round(walk.seconds / 60)}-minute ${walk.estimated ? "estimated" : "verified"} walk back to ${input.boardingStop.name}.`,
    );
    if (closes !== null) reasons.push(`Open until ${formatMinutes(closes)}.`);
    reasons.push(`${Math.round(safe.usableWaitSeconds / 60)} usable minutes.`);
    if (place.sponsored) {
      reasons.push(
        "Sponsored listing. This does not affect whether it is feasible or how it ranks.",
      );
    }

    // Lower is better. Composed only of rider-relevant factors.
    let score = walk.seconds; // closer is better
    score -= Math.min(safe.usableWaitSeconds, 45 * 60) * 0.35; // more usable time is better
    if (openThroughLeaveBy === "unknown") score += 900; // unverified hours are a real cost
    if (f.preferLocallyOwned && place.locallyOwned === true) score -= 240;
    if (place.hours?.source === "google-places") score -= 60; // fresher hours
    // Deliberately absent: any term involving `place.sponsored`.

    candidates.push({
      place,
      walk,
      usableWaitSeconds: safe.usableWaitSeconds,
      leaveByMs: safe.leaveByMs,
      wrapUpAtMs: safe.wrapUpAtMs,
      checks: { openThroughLeaveBy, enoughUsableTime, matchesFilters },
      feasible,
      reasons: [...reasons, ...warnings],
      blockedReasons,
      summary: [
        `${Math.round(walk.seconds / 60)}-min walk`,
        closes !== null
          ? `open until ${formatMinutes(closes)}`
          : "hours unknown",
        `${Math.round(safe.usableWaitSeconds / 60)} usable minutes`,
      ].join(", "),
      score: Math.round(score),
    });
  }

  // Feasible first, each group sorted by score. Infeasible ones are retained so
  // the UI can explain why they were rejected rather than silently dropping them.
  const feasible = candidates
    .filter((c) => c.feasible)
    .sort((a, b) => a.score - b.score);
  const rest = candidates
    .filter((c) => !c.feasible)
    .sort((a, b) => a.score - b.score);
  return [...feasible, ...rest];
}

/** The always-available fallback when nothing can be safely recommended. */
export function stayNearStopAdvice(
  boardingStopName: string,
  reason: string,
): string {
  return `Stay near ${boardingStopName}. ${reason} With less certainty than that, the safe call is to keep the stop in sight rather than risk the connection.`;
}

export const MIN_USEFUL_VISIT_SECONDS = DEFAULTS.minimumUsefulVisitSeconds;
