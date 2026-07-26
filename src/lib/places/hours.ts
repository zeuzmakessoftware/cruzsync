/**
 * A deliberately conservative parser for the OSM `opening_hours` syntax.
 *
 * The full grammar is large and full of edge cases (public holidays, seasonal
 * ranges, "sunset", month spans). We implement the common subset and, crucially,
 * we return `parsed: false` for anything we do not fully understand rather than
 * guessing. Downstream, unparsed hours mean CruzSync will NOT tell a rider a
 * place is safe to sit in -- it says the hours could not be verified and
 * suggests staying near the stop.
 *
 * Being wrong about closing time is how a rider ends up locked out in the dark
 * having missed their bus, so unknown must stay unknown.
 */
import type { OpeningHours, PlaceSource, Tristate } from "./types";

const DAY_INDEX: Record<string, number> = {
  su: 0,
  mo: 1,
  tu: 2,
  we: 3,
  th: 4,
  fr: 5,
  sa: 6,
};

const DAY_TOKEN = /^(mo|tu|we|th|fr|sa|su)$/i;

function expandDayRange(token: string): number[] | null {
  const parts = token.split("-");
  if (parts.length === 1) {
    const d = DAY_INDEX[parts[0].toLowerCase()];
    return d === undefined ? null : [d];
  }
  if (parts.length !== 2) return null;
  const a = DAY_INDEX[parts[0].toLowerCase()];
  const b = DAY_INDEX[parts[1].toLowerCase()];
  if (a === undefined || b === undefined) return null;
  const out: number[] = [];
  for (let i = 0; i < 7; i++) {
    const d = (a + i) % 7;
    out.push(d);
    if (d === b) break;
  }
  return out;
}

function parseClock(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 48 || min > 59) return null;
  return h * 60 + min;
}

interface ParsedRule {
  days: number[];
  windows: { openMin: number; closeMin: number }[];
}

/**
 * Returns null when the expression contains anything we do not confidently
 * understand. Null propagates to `parsed: false`.
 */
function parseExpression(expr: string): ParsedRule[] | null {
  const normalised = expr.trim().toLowerCase();
  if (!normalised) return null;

  // Constructs we explicitly refuse to guess at.
  if (
    /ph|su?nrise|sunset|dawn|dusk|week|easter|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/.test(
      normalised,
    )
  ) {
    // "24/7" is safe and common enough to special-case before bailing out.
    if (normalised !== "24/7") return null;
  }
  if (normalised === "24/7") {
    return [
      {
        days: [0, 1, 2, 3, 4, 5, 6],
        windows: [{ openMin: 0, closeMin: 24 * 60 }],
      },
    ];
  }

  const rules: ParsedRule[] = [];
  for (const chunk of normalised.split(";")) {
    const rule = chunk.trim();
    if (!rule) continue;

    const tokens = rule.split(/\s+/);
    const dayTokens: string[] = [];
    let i = 0;
    // Leading day specifiers, possibly comma separated: "mo-fr,su 09:00-17:00".
    while (i < tokens.length) {
      const t = tokens[i];
      const candidates = t.split(",");
      if (candidates.every((c) => DAY_TOKEN.test(c.split("-")[0]))) {
        dayTokens.push(...candidates);
        i++;
      } else break;
    }

    const timePart = tokens.slice(i).join(" ").trim();
    const days = dayTokens.length
      ? dayTokens.flatMap((t) => expandDayRange(t) ?? [])
      : [0, 1, 2, 3, 4, 5, 6];
    if (dayTokens.length && days.length === 0) return null;

    if (timePart === "off" || timePart === "closed") {
      rules.push({ days, windows: [] });
      continue;
    }
    if (!timePart) return null;

    const windows: { openMin: number; closeMin: number }[] = [];
    for (const span of timePart.split(",")) {
      const [from, to] = span.trim().split("-");
      const openMin = parseClock(from ?? "");
      let closeMin = parseClock(to ?? "");
      if (openMin === null || closeMin === null) return null;
      // "18:00-02:00" wraps past midnight.
      if (closeMin <= openMin) closeMin += 24 * 60;
      windows.push({ openMin, closeMin });
    }
    rules.push({ days, windows });
  }

  return rules.length ? rules : null;
}

export function parseOpeningHours(
  raw: string | null | undefined,
  dayOfWeek: number,
  source: PlaceSource,
  fetchedAtMs: number,
): OpeningHours {
  if (!raw || !raw.trim()) {
    return {
      raw: raw ?? null,
      parsed: false,
      todayWindows: [],
      source,
      fetchedAtMs,
    };
  }
  const rules = parseExpression(raw);
  if (!rules) {
    return { raw, parsed: false, todayWindows: [], source, fetchedAtMs };
  }
  // Later rules override earlier ones for the same day, per the OSM spec.
  let windows: { openMin: number; closeMin: number }[] = [];
  let matched = false;
  for (const rule of rules) {
    if (rule.days.includes(dayOfWeek)) {
      windows = rule.windows;
      matched = true;
    }
  }
  return {
    raw,
    // A rule set that simply does not mention today means closed today, which
    // is a real answer -- but only when we understood the whole expression.
    parsed: true,
    todayWindows: matched ? windows : [],
    source,
    fetchedAtMs,
  };
}

/**
 * Whether the place is open continuously from now until `leaveByMin`.
 *
 * Returns 'unknown' when hours could not be parsed. 'unknown' must never be
 * silently coerced to true anywhere downstream.
 */
export function isOpenThrough(
  hours: OpeningHours | null,
  nowMin: number,
  leaveByMin: number,
): Tristate {
  if (!hours || !hours.parsed) return "unknown";
  if (hours.todayWindows.length === 0) return false;
  return hours.todayWindows.some(
    (w) => w.openMin <= nowMin && w.closeMin >= leaveByMin,
  );
}

/** Closing time for the window covering `nowMin`, as minutes after midnight. */
export function closingTimeMinutes(
  hours: OpeningHours | null,
  nowMin: number,
): number | null {
  if (!hours || !hours.parsed) return null;
  const w = hours.todayWindows.find(
    (x) => x.openMin <= nowMin && x.closeMin > nowMin,
  );
  return w ? w.closeMin : null;
}

/** Minutes after midnight in the agency timezone. */
export function minutesOfDay(
  epochMs: number,
  timeZone = "America/Los_Angeles",
): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(epochMs));
  const h = Number(parts.find((p) => p.type === "hour")?.value) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value);
  return h * 60 + m;
}

/** Formats minutes-after-midnight as a friendly clock, e.g. "9 PM". */
export function formatMinutes(min: number): string {
  const m = min % (24 * 60);
  const h24 = Math.floor(m / 60);
  const mm = m % 60;
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return mm === 0
    ? `${h12} ${ampm}`
    : `${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
}
