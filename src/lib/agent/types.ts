/** Sanitised, judge-facing record of one tool call. Contains no chain-of-thought. */
export interface TraceEntry {
  step: number;
  tool: string;
  /** Arguments after redaction. */
  args: Record<string, unknown>;
  status: "ok" | "error";
  durationMs: number;
  /** Where the underlying data came from. */
  source: string | null;
  origin: "live" | "cache" | "fixture" | null;
  sourceTimestamp: string | null;
  /** Short human-readable summary of what came back. Never the full payload. */
  resultSummary: string;
  error?: string;
}

export interface AgentResult {
  /** The rider-facing prose answer. */
  message: string;
  /** Which engine produced `message`. */
  explanationMode:
    "live-gemma" | "deterministic-demo" | "deterministic-fallback";
  /** Populated when Gemma was attempted and failed. */
  fallbackReason?: string;
  trace: TraceEntry[];
  /** The structured recommendation, when one was produced. */
  recommendation?: Record<string, unknown>;
  /** Everything the model was allowed to see, for the evidence panel. */
  toolResults: { tool: string; result: unknown }[];
  model: string;
  engineVersion: string;
}

export interface AgentRequest {
  message: string;
  direction: "to-campus" | "to-home";
  destinationKey?: string;
  sceneId?: string;
  demo?: boolean;
}
