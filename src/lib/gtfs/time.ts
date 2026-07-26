/**
 * Service-day and timezone arithmetic.
 *
 * Two things make GTFS time genuinely tricky and both are handled here rather
 * than being papered over:
 *
 *  1. Times may exceed 24:00:00. A trip listed at 24:20:00 on service date
 *     2026-07-27 actually departs at 00:20 on 2026-07-28 and still belongs to
 *     Monday's service. Truncating it would silently drop late-night trips --
 *     exactly the trips a rider stuck downtown cares about most.
 *
 *  2. The feed is in America/Los_Angeles, which observes DST. We resolve the
 *     real UTC offset for each instant via Intl rather than assuming -08:00.
 */
import { AGENCY_TIMEZONE } from "@/lib/domain";

/** Offset in ms that must be ADDED to UTC to get local time at `instant`. */
function tzOffsetMs(instant: Date, timeZone = AGENCY_TIMEZONE): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  // Intl renders midnight as hour 24 in some ICU versions; normalise it.
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
  return asUtc - instant.getTime();
}

/**
 * Converts a wall-clock time in the agency timezone to an epoch timestamp.
 * Iterates once to settle DST boundaries, where the naive offset guess is wrong.
 */
export function agencyWallTimeToEpochMs(
  year: number,
  month1: number,
  day: number,
  seconds: number,
): number {
  const naive = Date.UTC(year, month1 - 1, day) + seconds * 1000;
  let epoch = naive - tzOffsetMs(new Date(naive));
  // Re-resolve with the corrected instant; fixes the spring-forward/fall-back hour.
  epoch = naive - tzOffsetMs(new Date(epoch));
  return epoch;
}

/** "HH:MM:SS" -> seconds after midnight of the service day. Handles values >= 24h. */
export function parseGtfsTime(value: string): number {
  const m = /^(\d+):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return Number.NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Seconds after midnight -> "HH:MM" in 24h form, wrapping past-midnight values. */
export function formatGtfsTime(seconds: number): string {
  const s = ((seconds % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** YYYYMMDD for the given instant, as seen in the agency timezone. */
export function agencyDateString(
  instant: Date | number,
  timeZone = AGENCY_TIMEZONE,
): string {
  const d = typeof instant === "number" ? new Date(instant) : instant;
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return dtf.format(d).replaceAll("-", "");
}

/** Day of week 0=Sunday..6=Saturday, as seen in the agency timezone. */
export function agencyDayOfWeek(
  instant: Date | number,
  timeZone = AGENCY_TIMEZONE,
): number {
  const d = typeof instant === "number" ? new Date(instant) : instant;
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(d);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

/** Epoch ms for `secondsAfterMidnight` on the given YYYYMMDD service date. */
export function serviceDateTimeToEpochMs(
  serviceDate: string,
  secondsAfterMidnight: number,
): number {
  const year = Number(serviceDate.slice(0, 4));
  const month = Number(serviceDate.slice(4, 6));
  const day = Number(serviceDate.slice(6, 8));
  return agencyWallTimeToEpochMs(year, month, day, secondsAfterMidnight);
}

/** Shift a YYYYMMDD string by whole days. */
export function shiftServiceDate(serviceDate: string, days: number): string {
  const year = Number(serviceDate.slice(0, 4));
  const month = Number(serviceDate.slice(4, 6));
  const day = Number(serviceDate.slice(6, 8));
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

/** Human-friendly clock time in the agency timezone, e.g. "2:14 PM". */
export function formatClock(
  epochMs: number,
  timeZone = AGENCY_TIMEZONE,
): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(epochMs));
}

/** Rounds to whole minutes, never returning -0. */
export function minutesBetween(fromMs: number, toMs: number): number {
  return Math.round((toMs - fromMs) / 60000) + 0;
}
