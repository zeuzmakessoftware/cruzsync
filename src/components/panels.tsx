"use client";

/**
 * The story-telling panels: recommendation, comparison, timeline, tool trace,
 * waiting places, notifications and the civic dashboard.
 */
import { useEffect, useState } from "react";
import {
  AmenityFact,
  Button,
  Card,
  Chip,
  Empty,
  RouteBadge,
  type StatusTone,
} from "./ui";

const clock = (iso: string | null | undefined) =>
  iso
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(iso))
    : "-";

const mins = (s: number) => `${Math.round(s / 60)} min`;

export function evidenceTone(label: string): StatusTone {
  return label === "observed"
    ? "good"
    : label === "reported"
      ? "warn"
      : label === "blocked"
        ? "bad"
        : "neutral";
}

export function evidenceWords(label: string): string {
  return (
    {
      observed: "vehicle visible",
      reported: "trip update only",
      "scheduled-only": "schedule only",
      stale: "data gone quiet",
      blocked: "blocked",
    }[label] ?? label
  );
}

/* ------------------------------------------------------------------ */

export interface Recommendation {
  action: string;
  headline: string;
  subhead: string;
  boardingStopLabel: string | null;
  departureIso: string | null;
  leaveByIso: string | null;
  reevaluateAtIso: string | null;
  backupPlan: string;
  blockedReasons: string[];
}

export function RecommendationCard({
  rec,
  nowMs,
  isDemo,
  onChoose,
  chosen,
}: {
  rec: Recommendation;
  nowMs: number;
  isDemo: boolean;
  onChoose: (action: string) => void;
  chosen: string | null;
}) {
  const uncertain = rec.action === "DATA TOO UNCERTAIN";
  const target = rec.leaveByIso ?? rec.departureIso;
  const secondsLeft = target
    ? Math.round((Date.parse(target) - nowMs) / 1000)
    : null;

  return (
    <section
      className="card rise recommendation"
      aria-labelledby="rec-heading"
      data-uncertain={uncertain ? "true" : "false"}
    >
      <div className="recommendation-label">
        <span>{uncertain ? "Check before leaving" : "Your best option"}</span>
        {isDemo && <span>Example trip</span>}
      </div>

      <h2 id="rec-heading" className="recommendation-title">
        {rec.headline}
      </h2>
      <p className="recommendation-subhead">{rec.subhead}</p>

      {secondsLeft !== null && (
        <div className="recommendation-time">
          <span className="recommendation-time-label">
            {rec.leaveByIso ? "Leave by" : "Departs"}
          </span>
          <strong className="tnum">{clock(target)}</strong>
          <span
            className="tnum"
            style={{
              color:
                secondsLeft < 300 ? "var(--danger-700)" : "var(--text-muted)",
              fontWeight: 700,
            }}
            role="timer"
            aria-live="polite"
          >
            {/* "16m 58s", not "16:58". The latter reads as a clock time. */}
            {secondsLeft <= 0
              ? "now"
              : `in ${Math.floor(secondsLeft / 60)}m ${String(secondsLeft % 60).padStart(2, "0")}s`}
          </span>
        </div>
      )}

      {rec.blockedReasons.length > 0 && (
        <ul
          style={{
            margin: "0 0 0.9rem",
            paddingLeft: "1.1rem",
            color: "var(--danger-700)",
            fontSize: "0.85rem",
          }}
        >
          {rec.blockedReasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}

      <details className="backup-plan">
        <summary>If this bus does not come</summary>
        <p>{rec.backupPlan}</p>
      </details>

      <div className="recommendation-actions">
        <Button
          variant="primary"
          onClick={() => onChoose(rec.action)}
          pressed={chosen === rec.action}
        >
          {chosen === rec.action ? "Plan saved" : "Use this plan"}
        </Button>
        <Button
          onClick={() => onChoose("WAIT AT STOP")}
          pressed={chosen === "WAIT AT STOP"}
        >
          Wait here
        </Button>
      </div>

      {rec.reevaluateAtIso && (
        <p
          style={{
            margin: "0.85rem 0 0",
            fontSize: "0.78rem",
            color: "var(--text-muted)",
          }}
        >
          We will check again before {clock(rec.reevaluateAtIso)}.
        </p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

export interface ComparisonOption {
  routeId: string;
  tripId?: string;
  feasible: boolean;
  score: number;
  transferMarginSec: number | null;
  arrivalRange?: [string, string];
  scoreBreakdown: { factor: string; detail: string; penaltySec: number }[];
  blockedReasons: string[];
  evidence?: {
    label: string;
    confidence: number;
    vehicleVisible: boolean;
    vehicleAgeSeconds: number | null;
    predictedDepartureIso: string;
    occupancyStatus: string | null;
    caveats: string[];
    signals: { key: string; detail: string; weight: number; source: string }[];
  };
}

export function RouteComparison({
  options,
  bestRouteId,
  destinationName,
  undecidedReason,
  onSelect,
  selected,
}: {
  options: ComparisonOption[];
  bestRouteId: string | null;
  destinationName: string;
  undecidedReason: string | null;
  onSelect: (routeId: string) => void;
  selected: string | null;
}) {
  return (
    <Card
      title="11 vs 18 vs 19"
      subtitle={
        <>
          The downtown&nbsp;→&nbsp;campus leg only, for{" "}
          <strong>{destinationName}</strong>. Route 35 is the other leg of this
          journey and is never compared here.
        </>
      }
    >
      {undecidedReason && (
        <p
          style={{
            margin: "0 0 0.9rem",
            padding: "0.7rem 0.85rem",
            borderRadius: 10,
            background: "var(--danger-100)",
            color: "var(--danger-700)",
            fontSize: "0.85rem",
          }}
        >
          {undecidedReason}
        </p>
      )}

      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "grid",
          gap: "0.6rem",
        }}
      >
        {options.map((o) => {
          const isBest = o.routeId === bestRouteId;
          return (
            <li
              key={o.routeId}
              style={{
                border: `1px solid ${isBest ? "var(--accent)" : "var(--border)"}`,
                borderLeftWidth: isBest ? 5 : 1,
                borderRadius: 12,
                padding: "0.75rem 0.85rem",
                opacity: o.feasible ? 1 : 0.72,
                background: isBest ? "var(--surface-2)" : "transparent",
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: "0.7rem",
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <RouteBadge routeId={o.routeId} />
                <div style={{ flex: "1 1 12rem", minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      gap: "0.4rem",
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    {isBest && <Chip tone="good">recommended</Chip>}
                    {!o.feasible && <Chip tone="bad">not an option</Chip>}
                    {o.evidence && (
                      <Chip tone={evidenceTone(o.evidence.label)}>
                        {evidenceWords(o.evidence.label)}
                      </Chip>
                    )}
                  </div>
                  <p
                    className="tnum"
                    style={{ margin: "0.35rem 0 0", fontSize: "0.85rem" }}
                  >
                    {o.evidence ? (
                      <>
                        Leaves {clock(o.evidence.predictedDepartureIso)}
                        {o.arrivalRange && (
                          <>
                            {" "}
                            , arrives {clock(o.arrivalRange[0])} to
                            {clock(o.arrivalRange[1])}
                          </>
                        )}
                        {o.transferMarginSec !== null && (
                          <>
                            {" "}
                            · {Math.round(o.transferMarginSec / 60)} min
                            transfer slack
                          </>
                        )}
                      </>
                    ) : (
                      (o.blockedReasons[0] ?? "No trip available.")
                    )}
                  </p>
                </div>
                {o.feasible && (
                  <Button
                    onClick={() => onSelect(o.routeId)}
                    pressed={selected === o.routeId}
                  >
                    {selected === o.routeId ? "✓ Chosen" : "Choose"}
                  </Button>
                )}
              </div>

              {o.blockedReasons.length > 0 && o.evidence && (
                <p
                  style={{
                    margin: "0.5rem 0 0",
                    fontSize: "0.8rem",
                    color: "var(--danger-700)",
                  }}
                >
                  {o.blockedReasons.join(" ")}
                </p>
              )}

              {o.scoreBreakdown.length > 0 && (
                <details style={{ marginTop: "0.5rem" }}>
                  <summary
                    style={{
                      cursor: "pointer",
                      fontSize: "0.78rem",
                      color: "var(--text-muted)",
                    }}
                  >
                    Why it scored {o.score} (lower is better)
                  </summary>
                  <table
                    style={{
                      width: "100%",
                      fontSize: "0.75rem",
                      marginTop: "0.4rem",
                      borderCollapse: "collapse",
                    }}
                  >
                    <thead>
                      <tr
                        style={{
                          textAlign: "left",
                          color: "var(--text-muted)",
                        }}
                      >
                        <th style={{ padding: "0.2rem 0" }}>Factor</th>
                        <th style={{ padding: "0.2rem 0" }}>Detail</th>
                        <th style={{ padding: "0.2rem 0", textAlign: "right" }}>
                          Seconds
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {o.scoreBreakdown.map((b, i) => (
                        <tr
                          key={i}
                          style={{ borderTop: "1px solid var(--border)" }}
                        >
                          <td style={{ padding: "0.25rem 0.4rem 0.25rem 0" }}>
                            {b.factor.replaceAll("_", " ")}
                          </td>
                          <td
                            style={{
                              padding: "0.25rem 0.4rem 0.25rem 0",
                              color: "var(--text-muted)",
                            }}
                          >
                            {b.detail}
                          </td>
                          <td
                            className="tnum"
                            style={{ padding: "0.25rem 0", textAlign: "right" }}
                          >
                            {b.penaltySec > 0 ? "+" : ""}
                            {b.penaltySec}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {o.evidence?.caveats.map((c, i) => (
                    <p
                      key={i}
                      style={{
                        margin: "0.4rem 0 0",
                        fontSize: "0.75rem",
                        color: "var(--text-muted)",
                      }}
                    >
                      {c}
                    </p>
                  ))}
                </details>
              )}
            </li>
          );
        })}
      </ul>
      <p
        style={{
          margin: "0.9rem 0 0",
          fontSize: "0.72rem",
          color: "var(--text-muted)",
        }}
      >
        Confidence values are inspectable heuristics computed from feed
        evidence. They are not calibrated probabilities and should not be read
        as “chance the bus arrives”.
      </p>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

export function JourneyTimeline({
  legs,
  transferMarginSec,
}: {
  legs: {
    kind: string;
    routeId?: string;
    label: string;
    fromStopName: string;
    toStopName: string;
    departureIso: string;
    arrivalIso: string;
  }[];
  transferMarginSec: number | null;
}) {
  if (legs.length === 0) return null;
  return (
    <Card
      title="Your journey"
      subtitle="Two legs, one walk between boarding areas."
    >
      <ol
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "grid",
          gap: "0.1rem",
        }}
      >
        {legs.map((l, i) => (
          <li
            key={i}
            style={{ display: "flex", gap: "0.75rem", alignItems: "stretch" }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                width: 44,
              }}
            >
              {l.kind === "bus" && l.routeId ? (
                <RouteBadge routeId={l.routeId} size="sm" />
              ) : (
                <span
                  aria-hidden="true"
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: "50%",
                    border: "2px dashed var(--text-muted)",
                    display: "grid",
                    placeItems: "center",
                    fontSize: "0.8rem",
                  }}
                >
                  ⇢
                </span>
              )}
              {i < legs.length - 1 && (
                <span
                  style={{
                    flex: 1,
                    width: 2,
                    background: "var(--border)",
                    minHeight: 18,
                  }}
                  aria-hidden="true"
                />
              )}
            </div>
            <div style={{ paddingBottom: "0.9rem", minWidth: 0 }}>
              <p style={{ margin: 0, fontWeight: 600, fontSize: "0.9rem" }}>
                {l.label}
              </p>
              <p
                className="tnum"
                style={{
                  margin: "0.15rem 0 0",
                  fontSize: "0.8rem",
                  color: "var(--text-muted)",
                }}
              >
                {clock(l.departureIso)} {l.fromStopName} → {clock(l.arrivalIso)}{" "}
                {l.toStopName}
              </p>
              {l.kind === "walk" && transferMarginSec !== null && (
                <p style={{ margin: "0.25rem 0 0", fontSize: "0.8rem" }}>
                  <Chip tone={transferMarginSec < 120 ? "warn" : "good"}>
                    {Math.round(transferMarginSec / 60)} min slack at the
                    transfer
                  </Chip>
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

export interface TraceEntryView {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  status: string;
  durationMs: number;
  source: string | null;
  origin: string | null;
  sourceTimestamp: string | null;
  resultSummary: string;
  error?: string;
}

export function ToolTrace({
  trace,
  mode,
  model,
  fallbackReason,
}: {
  trace: TraceEntryView[];
  mode: string;
  model: string;
  fallbackReason?: string;
}) {
  return (
    <Card
      title="How this plan was checked"
      subtitle="Sanitised tool calls and their sources. No private chain-of-thought is requested, stored, or shown."
      action={
        <Chip
          tone={
            mode === "live-gemma"
              ? "good"
              : mode === "deterministic-fallback"
                ? "warn"
                : "demo"
          }
        >
          {mode === "live-gemma"
            ? `live ${model}`
            : mode === "deterministic-fallback"
              ? "Gemma failed, deterministic fallback"
              : "deterministic demo"}
        </Chip>
      }
    >
      {fallbackReason && (
        <p
          style={{
            margin: "0 0 0.75rem",
            fontSize: "0.8rem",
            color: "var(--sunrise-600)",
          }}
        >
          Gemma was called and failed: {fallbackReason}. Every number below
          still comes from the deterministic engine, so the recommendation
          itself is unaffected.
        </p>
      )}
      {trace.length === 0 ? (
        <Empty>No tools have run yet. Ask a question to see the trace.</Empty>
      ) : (
        <div className="scroll-x">
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.78rem",
              minWidth: 620,
            }}
          >
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
                <th style={{ padding: "0.3rem 0.5rem 0.3rem 0" }}>#</th>
                <th style={{ padding: "0.3rem 0.5rem 0.3rem 0" }}>Tool</th>
                <th style={{ padding: "0.3rem 0.5rem 0.3rem 0" }}>Arguments</th>
                <th style={{ padding: "0.3rem 0.5rem 0.3rem 0" }}>Result</th>
                <th style={{ padding: "0.3rem 0.5rem 0.3rem 0" }}>Source</th>
                <th style={{ padding: "0.3rem 0", textAlign: "right" }}>ms</th>
              </tr>
            </thead>
            <tbody>
              {trace.map((t) => (
                <tr
                  key={t.step}
                  style={{ borderTop: "1px solid var(--border)" }}
                >
                  <td
                    className="tnum"
                    style={{ padding: "0.4rem 0.5rem 0.4rem 0" }}
                  >
                    {t.step}
                  </td>
                  <td
                    style={{
                      padding: "0.4rem 0.5rem 0.4rem 0",
                      fontFamily: "ui-monospace, monospace",
                    }}
                  >
                    {t.tool}
                  </td>
                  <td
                    style={{
                      padding: "0.4rem 0.5rem 0.4rem 0",
                      color: "var(--text-muted)",
                      maxWidth: 190,
                    }}
                  >
                    <code
                      style={{ fontSize: "0.72rem", wordBreak: "break-word" }}
                    >
                      {JSON.stringify(t.args)}
                    </code>
                  </td>
                  <td style={{ padding: "0.4rem 0.5rem 0.4rem 0" }}>
                    <Chip tone={t.status === "ok" ? "good" : "bad"}>
                      {t.status}
                    </Chip>{" "}
                    {t.error ?? t.resultSummary}
                  </td>
                  <td
                    style={{
                      padding: "0.4rem 0.5rem 0.4rem 0",
                      color: "var(--text-muted)",
                    }}
                  >
                    {t.source ?? "-"}
                    {t.origin && (
                      <>
                        {" "}
                        <Chip
                          tone={
                            t.origin === "fixture"
                              ? "demo"
                              : t.origin === "cache"
                                ? "warn"
                                : "good"
                          }
                        >
                          {t.origin}
                        </Chip>
                      </>
                    )}
                  </td>
                  <td
                    className="tnum"
                    style={{ padding: "0.4rem 0", textAlign: "right" }}
                  >
                    {t.durationMs}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

export interface PlaceView {
  id: string;
  name: string;
  categoryLabel: string;
  address: string | null;
  hoursKnown: boolean;
  hoursRaw: string | null;
  walkSeconds: number;
  walkIsEstimated: boolean;
  usableWaitSeconds: number;
  leaveByIso: string;
  feasible: boolean;
  summary: string;
  reasons: string[];
  blockedReasons: string[];
  amenities: Record<string, boolean | "unknown">;
  sponsored: boolean;
}

export function WaitPanel({
  places,
  fallbackAdvice,
  nowMs,
  onPick,
  picked,
}: {
  places: PlaceView[];
  fallbackAdvice: string | null;
  nowMs: number;
  onPick: (id: string) => void;
  picked: string | null;
}) {
  const feasible = places.filter((p) => p.feasible);
  const rejected = places.filter((p) => !p.feasible);

  return (
    <Card
      title="Make the wait useful"
      subtitle="Only places CruzSync can confirm are open long enough are recommended. Anything unverified is listed as unverified."
    >
      {feasible.length === 0 ? (
        <Empty>
          {fallbackAdvice ??
            "No nearby place can be safely recommended for this wait."}
        </Empty>
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "grid",
            gap: "0.7rem",
          }}
        >
          {feasible.slice(0, 4).map((p) => {
            const left = Math.round((Date.parse(p.leaveByIso) - nowMs) / 1000);
            const isPicked = picked === p.id;
            return (
              <li
                key={p.id}
                style={{
                  border: `1px solid ${isPicked ? "var(--accent)" : "var(--border)"}`,
                  borderLeftWidth: isPicked ? 5 : 1,
                  borderRadius: 12,
                  padding: "0.8rem 0.9rem",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "0.75rem",
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <p style={{ margin: 0, fontWeight: 700 }}>{p.name}</p>
                    <p
                      style={{
                        margin: "0.1rem 0 0",
                        fontSize: "0.8rem",
                        color: "var(--text-muted)",
                      }}
                    >
                      {p.categoryLabel}
                      {p.address ? ` · ${p.address}` : ""}
                    </p>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <p
                      style={{
                        margin: 0,
                        fontSize: "0.7rem",
                        textTransform: "uppercase",
                        color: "var(--text-muted)",
                      }}
                    >
                      Leave by
                    </p>
                    <strong className="tnum" style={{ fontSize: "1.35rem" }}>
                      {clock(p.leaveByIso)}
                    </strong>
                    <p
                      className="tnum"
                      style={{
                        margin: 0,
                        fontSize: "0.75rem",
                        color:
                          left < 300
                            ? "var(--danger-700)"
                            : "var(--text-muted)",
                      }}
                    >
                      {left <= 0
                        ? "leave now"
                        : `${Math.floor(left / 60)} min left`}
                    </p>
                  </div>
                </div>

                <p
                  className="tnum"
                  style={{ margin: "0.55rem 0 0.5rem", fontSize: "0.85rem" }}
                >
                  {mins(p.walkSeconds)}{" "}
                  {p.walkIsEstimated ? "estimated" : "verified"} walk ·{" "}
                  <strong>{mins(p.usableWaitSeconds)} usable</strong>
                </p>

                <div
                  style={{
                    display: "flex",
                    gap: "0.35rem",
                    flexWrap: "wrap",
                    marginBottom: "0.6rem",
                  }}
                >
                  {Object.entries(p.amenities).map(([k, v]) => (
                    <AmenityFact
                      key={k}
                      label={k.replace(/([A-Z])/g, " $1").toLowerCase()}
                      value={v}
                    />
                  ))}
                </div>

                {p.sponsored && (
                  <p
                    style={{
                      margin: "0 0 0.5rem",
                      fontSize: "0.75rem",
                      color: "var(--sunrise-600)",
                    }}
                  >
                    Sponsored listing. Sponsorship does not affect feasibility
                    or ranking.
                  </p>
                )}

                <Button
                  variant={isPicked ? "primary" : "secondary"}
                  onClick={() => onPick(p.id)}
                  pressed={isPicked}
                >
                  {isPicked ? "Waiting here, monitoring the bus" : "Wait here"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {rejected.length > 0 && (
        <details style={{ marginTop: "0.9rem" }}>
          <summary
            style={{
              cursor: "pointer",
              fontSize: "0.8rem",
              color: "var(--text-muted)",
            }}
          >
            {rejected.length} nearby place{rejected.length === 1 ? "" : "s"}{" "}
            ruled out and why
          </summary>
          <ul
            style={{
              margin: "0.5rem 0 0",
              paddingLeft: "1.1rem",
              fontSize: "0.78rem",
              color: "var(--text-muted)",
            }}
          >
            {rejected.slice(0, 10).map((p) => (
              <li key={p.id} style={{ marginBottom: "0.25rem" }}>
                <strong>{p.name}</strong>:{" "}
                {p.blockedReasons[0] ??
                  p.reasons.find((r) => r.includes("cannot confirm")) ??
                  "not feasible"}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

/** Hoisted so it is not re-created on every render of NotificationPreviews. */
function NotificationNote({
  active,
  title,
  body,
}: {
  active: boolean;
  title: string;
  body: string;
}) {
  return (
    <div
      style={{
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        background: active ? "var(--surface-2)" : "transparent",
        borderRadius: 12,
        padding: "0.7rem 0.85rem",
        opacity: active ? 1 : 0.6,
      }}
    >
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          alignItems: "center",
          marginBottom: "0.2rem",
        }}
      >
        <Chip tone={active ? "good" : "neutral"}>
          {active ? "firing now" : "scheduled"}
        </Chip>
        <strong style={{ fontSize: "0.85rem" }}>{title}</strong>
      </div>
      <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-muted)" }}>
        {body}
      </p>
    </div>
  );
}

/** The two notification previews, driven by the real leave-by clock. */
export function NotificationPreviews({
  leaveByIso,
  wrapUpLeadSec = 300,
  nowMs,
  boardingLabel,
  recheckedAt,
}: {
  leaveByIso: string | null;
  wrapUpLeadSec?: number;
  nowMs: number;
  boardingLabel: string;
  recheckedAt: string | null;
}) {
  if (!leaveByIso) return null;
  const leaveBy = Date.parse(leaveByIso);
  const wrapUpAt = leaveBy - wrapUpLeadSec * 1000;
  const wrapActive = nowMs >= wrapUpAt && nowMs < leaveBy;
  const leaveActive = nowMs >= leaveBy;

  return (
    <Card
      title="Notifications"
      subtitle="The bus is re-checked immediately before each of these fires, so an earlier bus shortens the countdown rather than surprising you."
    >
      <div style={{ display: "grid", gap: "0.6rem" }}>
        <NotificationNote
          active={wrapActive}
          title={`Wrap up in ${Math.round(wrapUpLeadSec / 60)} minutes`}
          body={`Start finishing up at ${clock(new Date(wrapUpAt).toISOString())}. You will need to leave for ${boardingLabel} shortly after.`}
        />
        <NotificationNote
          active={leaveActive}
          title={`Leave now for ${boardingLabel}`}
          body={`Leave at ${clock(leaveByIso)} to make the bus with your buffers intact.`}
        />
      </div>
      {recheckedAt && (
        <p
          style={{
            margin: "0.7rem 0 0",
            fontSize: "0.75rem",
            color: "var(--text-muted)",
          }}
        >
          Bus last re-checked at {clock(recheckedAt)}.
        </p>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

export interface CivicEvent {
  id: string;
  routeId: string;
  stopLabel: string;
  expectedIso: string;
  kind:
    | "no-vehicle-evidence"
    | "ghost-bus-report"
    | "forced-reroute"
    | "transfer-at-risk";
  note: string;
  isFixture: boolean;
}

export function CivicDashboard({
  events,
  onReport,
}: {
  events: CivicEvent[];
  onReport: () => void;
}) {
  const byKind = events.reduce<Record<string, number>>((acc, e) => {
    acc[e.kind] = (acc[e.kind] ?? 0) + 1;
    return acc;
  }, {});
  const minutesLost = events.length * 22; // Modelled, not measured; labelled below.

  return (
    <Card
      title="Where rider confidence breaks"
      subtitle="Anonymised. No names, no identity, no precise location history is stored."
      action={
        <Button onClick={onReport} variant="secondary">
          The bus didn’t show
        </Button>
      }
    >
      {events.length === 0 ? (
        <Empty>No confidence failures recorded in this session yet.</Empty>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              gap: "0.5rem",
              flexWrap: "wrap",
              marginBottom: "0.8rem",
            }}
          >
            {Object.entries(byKind).map(([k, n]) => (
              <Chip key={k} tone="warn">
                {k.replaceAll("-", " ")}: {n}
              </Chip>
            ))}
            <Chip
              tone="neutral"
              title="Modelled from a 22-minute average per event, not measured from rider outcomes."
            >
              ~{minutesLost} rider-minutes lost (modelled estimate)
            </Chip>
          </div>
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "grid",
              gap: "0.4rem",
            }}
          >
            {events.slice(0, 6).map((e) => (
              <li
                key={e.id}
                style={{
                  display: "flex",
                  gap: "0.6rem",
                  alignItems: "center",
                  fontSize: "0.8rem",
                  flexWrap: "wrap",
                }}
              >
                <RouteBadge routeId={e.routeId} size="sm" />
                <span className="tnum" style={{ color: "var(--text-muted)" }}>
                  {clock(e.expectedIso)}
                </span>
                <span style={{ flex: "1 1 10rem", minWidth: 0 }}>
                  {e.stopLabel}: {e.note}
                </span>
                <Chip tone={e.isFixture ? "demo" : "good"}>
                  {e.isFixture ? "fixture" : "this session"}
                </Chip>
              </li>
            ))}
          </ul>
        </>
      )}
      <p
        style={{
          margin: "0.85rem 0 0",
          fontSize: "0.72rem",
          color: "var(--text-muted)",
        }}
      >
        “Rider-minutes lost” is a modelled estimate (22 minutes per event), not
        a measured value. Event counts and timestamps are measured.
      </p>
    </Card>
  );
}

/** Ticks once a second so countdowns stay live without re-fetching. */
export function useTicker(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
}
