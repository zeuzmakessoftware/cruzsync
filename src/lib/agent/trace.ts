/**
 * Trace sanitisation.
 *
 * The trace is rendered in the UI and shipped in docs/example-agent-trace.json,
 * so it must be safe to publish. Two rules:
 *
 *  1. No chain-of-thought. We record what the agent DID (tool, arguments,
 *     result summary), never any private reasoning text. Nothing in this file
 *     ever reads a "thinking" field.
 *
 *  2. No personal data. Free-text the rider typed is redacted, as are anything
 *     that looks like coordinates precise enough to locate a person, and any
 *     value whose key suggests a credential.
 */
import type { TraceEntry } from "./types";

/**
 * Sensitive words are matched against whole name SEGMENTS, not substrings.
 *
 * A naive /key/i also matches `destinationKey`, `placeId`… and redacting those
 * would gut the trace of exactly the information that makes it auditable. The
 * trace is only useful to a judge if it still says what was asked.
 */
const SENSITIVE_SEGMENTS = new Set([
  "token",
  "secret",
  "password",
  "passwd",
  "auth",
  "authorization",
  "credential",
  "credentials",
  "email",
  "phone",
  "ssn",
]);

/**
 * `key` is only sensitive on its own or in a credential compound. `destinationKey`
 * and `cacheKey` are ordinary fields, and redacting them would hide the very
 * thing a reader needs to check the agent asked the right question.
 */
const KEY_QUALIFIERS = new Set([
  "api",
  "secret",
  "private",
  "access",
  "client",
  "signing",
]);

/** Splits camelCase, snake_case and kebab-case into lowercase segments. */
function segmentsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .map((s) => s.toLowerCase())
    .filter(Boolean);
}

function isSensitiveKey(name: string): boolean {
  const segs = segmentsOf(name);
  if (segs.some((s) => SENSITIVE_SEGMENTS.has(s))) return true;

  const keyAt = segs.indexOf("key");
  if (keyAt !== -1) {
    // Bare `key`, or qualified as a credential (apiKey, x-api-key, secretKey).
    if (segs.length === 1) return true;
    if (keyAt > 0 && KEY_QUALIFIERS.has(segs[keyAt - 1])) return true;
  }

  // Catch concatenations that survive segmenting, e.g. `apikey`, `authtoken`.
  const flat = name.toLowerCase().replace(/[^a-z]/g, "");
  return ["apikey", "authtoken", "accesstoken", "secretkey", "privatekey"].some(
    (s) => flat.includes(s),
  );
}

const FREE_TEXT_KEYS = new Set([
  "message",
  "query",
  "transcript",
  "note",
  "utterance",
]);

export function redactArgs(args: unknown): Record<string, unknown> {
  if (args === null || typeof args !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (isSensitiveKey(k)) {
      out[k] = "[redacted]";
    } else if (FREE_TEXT_KEYS.has(k) && typeof v === "string") {
      // Keep the shape, drop the content.
      out[k] = `[redacted free text, ${v.length} chars]`;
    } else if (
      typeof v === "number" &&
      Math.abs(v) > 1 &&
      Math.abs(v) < 180 &&
      /lat|lon/i.test(k)
    ) {
      out[k] = Number(v.toFixed(3)); // ~100 m precision, enough to be useful
    } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out[k] = redactArgs(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** One short line describing what a tool returned. Never the full payload. */
export function summariseResult(tool: string, result: unknown): string {
  if (result === null || typeof result !== "object") return "no data";
  const r = result as Record<string, never>;

  switch (tool) {
    case "get_vehicle_positions":
      return `${r.count ?? 0} vehicle position(s)`;
    case "get_trip_updates":
      return `${r.count ?? 0} trip update(s)`;
    case "get_service_alerts":
      return `${r.count ?? 0} alert(s)`;
    case "get_stop_schedule": {
      const deps = (r.departures as unknown as unknown[])?.length ?? 0;
      const hw = r.headway as unknown as { summary?: string } | null;
      return `${deps} scheduled departure(s)${hw?.summary ? ` — ${hw.summary}` : ""}`;
    }
    case "compare_ucsc_options": {
      const best = r.bestRouteId as unknown as string | null;
      const opts =
        (r.options as unknown as { routeId: string; feasible: boolean }[]) ??
        [];
      return best
        ? `best = Route ${best} of ${opts.length} evaluated`
        : `no feasible option (${(r.undecidedReason as unknown as string) ?? "unspecified"})`;
    }
    case "build_multileg_trip": {
      const legs = (r.legs as unknown as unknown[])?.length ?? 0;
      const margin = r.downtownTransferMarginSec as unknown as number | null;
      return `${legs} leg(s); transfer margin ${margin === null ? "n/a" : `${Math.round(margin / 60)} min`}`;
    }
    case "analyze_route_evidence": {
      const e = r.evidence as unknown as {
        label?: string;
        confidence?: number;
      };
      return `${e?.label ?? "?"} (confidence ${e?.confidence ?? "?"})`;
    }
    case "get_nearby_wait_places": {
      const places = (r.places as unknown as { feasible: boolean }[]) ?? [];
      return `${places.filter((p) => p.feasible).length} feasible of ${places.length} nearby`;
    }
    case "get_place_details":
      return r.found ? "place found" : "place not found";
    case "get_walking_time":
      return `${Math.round((r.seconds as unknown as number) / 60)} min (${r.estimated ? "estimated" : "verified"})`;
    case "calculate_safe_wait":
      return `${Math.round((r.usableWaitSeconds as unknown as number) / 60)} usable minutes, leave by ${r.leaveByIso}`;
    case "recommend_next_action":
      return `${r.action}`;
    default:
      return "ok";
  }
}

export function buildTraceEntry(args: {
  step: number;
  tool: string;
  rawArgs: unknown;
  ok: boolean;
  durationMs: number;
  result?: unknown;
  error?: string;
}): TraceEntry {
  const prov =
    args.result && typeof args.result === "object"
      ? ((args.result as Record<string, unknown>).provenance as
          | {
              source?: string;
              origin?: string;
              observedAtIso?: string | null;
              freshness?: { ageSeconds?: number };
            }
          | undefined)
      : undefined;

  return {
    step: args.step,
    tool: args.tool,
    args: redactArgs(args.rawArgs),
    status: args.ok ? "ok" : "error",
    durationMs: args.durationMs,
    source: prov?.source ?? null,
    origin: (prov?.origin as TraceEntry["origin"]) ?? null,
    sourceTimestamp: prov?.observedAtIso ?? null,
    resultSummary: args.ok ? summariseResult(args.tool, args.result) : "failed",
    ...(args.error ? { error: args.error } : {}),
  };
}
