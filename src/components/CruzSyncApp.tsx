"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { CAMPUS_DESTINATIONS, RIVERFRONT } from "@/lib/domain";
import { Button, Card, Chip, Empty, Spinner } from "./ui";
import {
  CivicDashboard,
  JourneyTimeline,
  NotificationPreviews,
  RecommendationCard,
  RouteComparison,
  ToolTrace,
  WaitPanel,
  type CivicEvent,
  type ComparisonOption,
  type PlaceView,
  type Recommendation,
  type TraceEntryView,
} from "./panels";
import type { MapShape } from "./NetworkMap";
import type { NormalisedVehicle, RealtimeSnapshot } from "@/lib/rt/types";

// Leaflet touches window on import, so it must not render on the server.
const NetworkMap = dynamic(() => import("./NetworkMap"), {
  ssr: false,
  loading: () => (
    <div
      style={{
        display: "grid",
        placeItems: "center",
        height: "100%",
        color: "var(--text-muted)",
      }}
    >
      Loading map…
    </div>
  ),
});

interface SnapshotResponse {
  snapshot: RealtimeSnapshot;
  nowMs: number;
  sceneId: string | null;
  scenes: {
    id: string;
    title: string;
    narrative: string;
    anchorMs: number;
    direction: string;
    campusDestinationKey: string;
  }[];
  runtime: {
    gemmaMode: string;
    gemmaModel: string;
    gemmaProvider: string;
    demoMode: boolean;
    placesProvider: string;
    modeReason: string;
  };
  gtfs: {
    feedVersion: string;
    publisher: string;
    validFrom: string;
    validTo: string;
    builtAt: string;
  };
  placesFixture: { generatedAt: string; source: string; count: number };
}

interface AgentResponse {
  message: string;
  explanationMode: string;
  fallbackReason?: string;
  trace: TraceEntryView[];
  recommendation?: Recommendation;
  toolResults: { tool: string; result: unknown }[];
  model: string;
  engineVersion: string;
  nowMs: number;
  snapshotOrigin: string;
}

const clock = (ms: number) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));

export default function CruzSyncApp({ shapes }: { shapes: MapShape[] }) {
  const [demo, setDemo] = useState(true);
  const [sceneId, setSceneId] = useState("outbound-11-wins");
  const [destination, setDestination] = useState("science-hill");
  const [snap, setSnap] = useState<SnapshotResponse | null>(null);
  const [agent, setAgent] = useState<AgentResponse | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapError, setSnapError] = useState<string | null>(null);
  const [chosenAction, setChosenAction] = useState<string | null>(null);
  const [chosenRoute, setChosenRoute] = useState<string | null>(null);
  const [pickedPlace, setPickedPlace] = useState<string | null>(null);
  const [sessionEvents, setSessionEvents] = useState<CivicEvent[]>([]);
  const [theme, setTheme] = useState<"auto" | "light" | "dark">("auto");
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [recheckedAt, setRecheckedAt] = useState<string | null>(null);

  /**
   * The demo clock.
   *
   * A scene starts at its fixed anchor time and then runs forward in real time,
   * so the opening state is reproducible for a recording while countdowns are
   * genuinely live. `nowMs` lives in state and is only ever written from a timer
   * or a fetch handler -- never computed during render, which would make the
   * component impure.
   */
  const [nowMs, setNowMs] = useState(0);
  const baseRef = useRef<{ sceneNowMs: number; localAtMs: number } | null>(
    null,
  );

  /** Wall-clock ms since the current scene was loaded. Handlers only. */
  const elapsedSinceLoad = useCallback(
    () => (baseRef.current ? Date.now() - baseRef.current.localAtMs : 0),
    [],
  );

  useEffect(() => {
    const id = setInterval(() => {
      const b = baseRef.current;
      if (b) setNowMs(b.sceneNowMs + (Date.now() - b.localAtMs));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (theme === "auto")
      document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const loadSnapshot = useCallback(
    async (resetClock: boolean) => {
      try {
        const q = new URLSearchParams({
          demo: String(demo),
          elapsedMs: String(resetClock ? 0 : elapsedSinceLoad()),
        });
        if (demo) q.set("scene", sceneId);
        const res = await fetch(`/api/snapshot?${q}`);
        if (!res.ok)
          throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
        const json: SnapshotResponse = await res.json();
        // Re-anchor the clock from a handler, not from render.
        baseRef.current = { sceneNowMs: json.nowMs, localAtMs: Date.now() };
        setSnap(json);
        setNowMs(json.nowMs);
        setSnapError(null);
      } catch (e) {
        setSnapError(
          e instanceof Error ? e.message : "Could not load transit data.",
        );
      }
    },
    [demo, sceneId, elapsedSinceLoad],
  );

  /** Clears the previous analysis without refetching. */
  const clearAnalysis = useCallback(() => {
    setAgent(null);
    setChosenAction(null);
    setChosenRoute(null);
    setPickedPlace(null);
    setSessionEvents([]);
  }, []);

  /** Explicit "start this scene over" for the reset button. */
  const resetScene = useCallback(() => {
    clearAnalysis();
    void loadSnapshot(true);
  }, [clearAnalysis, loadSnapshot]);

  // Fetch on mount and whenever the mode or scene changes. Scene and mode
  // switches only clear state; this effect owns the refetch, so they never
  // double-fire.
  //
  // react-hooks/set-state-in-effect cannot follow control flow across `await`,
  // so it flags this as a synchronous setState. Every state write inside
  // loadSnapshot happens after the fetch resolves, which is the documented
  // pattern for loading data in an effect.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSnapshot(true);
  }, [loadSnapshot]);

  // Refresh live data periodically; demo scenes stay put.
  useEffect(() => {
    if (demo) return;
    const id = setInterval(() => void loadSnapshot(false), 30_000);
    return () => clearInterval(id);
  }, [demo, loadSnapshot]);

  const scene = snap?.scenes.find((s) => s.id === sceneId);
  const direction: "to-campus" | "to-home" =
    (scene?.direction as "to-campus" | "to-home") ?? "to-campus";

  const ask = useCallback(
    async (message: string) => {
      if (!message.trim()) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            direction,
            destinationKey: destination,
            sceneId,
            demo,
            elapsedMs: elapsedSinceLoad(),
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        setAgent(json);
        // The agent's own clock, so a demo scene reports its scene time rather
        // than the operator's real wall-clock time.
        setRecheckedAt(new Date(json.nowMs).toISOString());
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "The agent could not be reached.",
        );
      } finally {
        setBusy(false);
      }
    },
    [direction, destination, sceneId, demo, elapsedSinceLoad],
  );

  /* --- derived views from the tool results --- */

  const comparison = useMemo(() => {
    const r = agent?.toolResults.find((t) => t.tool === "compare_ucsc_options")
      ?.result as
      | {
          options: ComparisonOption[];
          bestRouteId: string | null;
          destinationName: string;
          undecidedReason: string | null;
        }
      | undefined;
    return r;
  }, [agent]);

  const trip = useMemo(() => {
    return agent?.toolResults.find((t) => t.tool === "build_multileg_trip")
      ?.result as
      | {
          legs: {
            kind: string;
            routeId?: string;
            label: string;
            fromStopName: string;
            toStopName: string;
            departureIso: string;
            arrivalIso: string;
          }[];
          downtownTransferMarginSec: number | null;
        }
      | undefined;
  }, [agent]);

  /**
   * Prefer the place ranking that recommend_next_action actually built its
   * leave-by time from. A separately-computed list can differ by a minute
   * because of a different uncertainty buffer, and two different leave-by times
   * on one screen is exactly the sort of thing that makes a countdown
   * untrustworthy.
   */
  const placesResult = useMemo(() => {
    const rec = agent?.recommendation as
      | { waitPlaces?: PlaceView[] | null; fallbackAdvice?: string | null }
      | undefined;
    if (rec?.waitPlaces && rec.waitPlaces.length > 0) {
      return {
        places: rec.waitPlaces,
        fallbackAdvice: rec.fallbackAdvice ?? null,
      };
    }
    return agent?.toolResults.find((t) => t.tool === "get_nearby_wait_places")
      ?.result as
      { places: PlaceView[]; fallbackAdvice: string | null } | undefined;
  }, [agent]);

  const observedTripIds = useMemo(() => {
    const ids: string[] = [];
    for (const o of comparison?.options ?? []) {
      if (o.evidence?.label === "observed" && o.tripId) ids.push(o.tripId);
    }
    return ids;
  }, [comparison]);

  const vehicles: NormalisedVehicle[] = snap?.snapshot.vehicles ?? [];
  const freshness = snap?.snapshot.freshness;
  const origin = snap?.snapshot.origin;
  const isDemoData = origin === "fixture";

  const recordGhostReport = useCallback(() => {
    const opt = comparison?.options.find((o) => !o.evidence?.vehicleVisible);
    // Only route, stop, expected time and feed evidence are recorded. No
    // identity, no location history, no free text.
    setSessionEvents((prev) => [
      {
        id: `sess-${Date.now()}`,
        routeId: opt?.routeId ?? "11",
        stopLabel: RIVERFRONT.AREA_1.label,
        expectedIso:
          opt?.evidence?.predictedDepartureIso ?? new Date(nowMs).toISOString(),
        kind: "ghost-bus-report",
        note: "Rider reported the bus did not arrive; no vehicle position was published for this trip.",
        isFixture: false,
      },
      ...prev,
    ]);
  }, [comparison, nowMs]);

  /**
   * Missing-evidence findings are DERIVED from the current analysis rather than
   * copied into state, so they cannot drift out of sync with what is on screen.
   * Rider-submitted reports are the only thing genuinely stored.
   */
  const events: CivicEvent[] = useMemo(() => {
    const derived: CivicEvent[] = (comparison?.options ?? [])
      .filter((o) => o.evidence && !o.evidence.vehicleVisible)
      .map((o, i) => ({
        id: `ev-${o.routeId}-${i}`,
        routeId: o.routeId,
        stopLabel: RIVERFRONT.AREA_1.label,
        expectedIso: o.evidence!.predictedDepartureIso,
        kind: "no-vehicle-evidence" as const,
        note: "No current vehicle position was visible when this decision was made.",
        isFixture: isDemoData,
      }));
    return [...sessionEvents, ...derived];
  }, [comparison, isDemoData, sessionEvents]);

  /* --- speech input (browser capture, explicitly not Gemma audio) --- */
  const startListening = useCallback(() => {
    const W = window as unknown as {
      SpeechRecognition?: new () => never;
      webkitSpeechRecognition?: new () => never;
    };
    const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!Ctor) {
      setError(
        "Speech input is not supported in this browser. Please type instead.",
      );
      return;
    }
    const rec = new Ctor() as unknown as {
      lang: string;
      interimResults: boolean;
      onresult: (e: { results: { 0: { 0: { transcript: string } } } }) => void;
      onerror: () => void;
      onend: () => void;
      start: () => void;
    };
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.onresult = (e) => {
      const text = e.results[0][0].transcript;
      setInput(text);
      setTranscript(text);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    setListening(true);
    rec.start();
  }, []);

  const suggestions =
    direction === "to-campus"
      ? [
          "I'm on the 35 from Scotts Valley. Which bus should I transfer to for campus?",
          "Which of the 11, 18 or 19 gets me to Science Hill soonest?",
        ]
      : [
          "The next 35 is ages away — where can I hang out without missing it?",
          "Somewhere quiet and indoors near the stop, please.",
        ];

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to the recommendation
      </a>

      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 20,
          background: "var(--surface)",
          borderBottom: "1px solid var(--border)",
          padding: "0.7rem clamp(0.75rem,3vw,1.5rem)",
        }}
      >
        <div
          style={{
            maxWidth: 1280,
            margin: "0 auto",
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: "1 1 16rem", minWidth: 0 }}>
            <h1
              style={{
                margin: 0,
                fontSize: "1.35rem",
                letterSpacing: "-0.02em",
              }}
            >
              Cruz<span style={{ color: "var(--accent)" }}>Sync</span>
            </h1>
            <p
              style={{
                margin: 0,
                fontSize: "0.82rem",
                color: "var(--text-muted)",
              }}
            >
              Know what to take. Know where to wait.
            </p>
          </div>

          <div
            style={{
              display: "flex",
              gap: "0.4rem",
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <Chip
              tone={snap?.runtime.gemmaMode === "live-gemma" ? "good" : "demo"}
              title={snap?.runtime.modeReason}
            >
              {snap?.runtime.gemmaMode === "live-gemma"
                ? `Live Gemma · ${snap.runtime.gemmaModel}`
                : "Deterministic Demo"}
            </Chip>
            <Chip
              tone={
                isDemoData
                  ? "demo"
                  : freshness?.label === "fresh"
                    ? "good"
                    : freshness?.label === "stale"
                      ? "warn"
                      : "bad"
              }
              title={snap?.snapshot.degradedReason}
            >
              {isDemoData
                ? "demo fixture data"
                : origin === "cache"
                  ? `cached ${freshness?.ageSeconds}s ago`
                  : `live · ${freshness?.ageSeconds ?? "?"}s old`}
            </Chip>
            <label
              style={{
                fontSize: "0.78rem",
                display: "flex",
                alignItems: "center",
                gap: "0.3rem",
              }}
            >
              <input
                type="checkbox"
                checked={demo}
                onChange={(e) => {
                  setDemo(e.target.checked);
                  clearAnalysis();
                }}
                aria-label="Use the reproducible demo story instead of live Santa Cruz data"
              />
              Demo story
            </label>
            <select
              value={theme}
              onChange={(e) =>
                setTheme(e.target.value as "auto" | "light" | "dark")
              }
              aria-label="Colour theme"
              style={{
                fontSize: "0.78rem",
                padding: "0.3rem",
                borderRadius: 8,
                background: "var(--surface)",
                color: "var(--text)",
                border: "1px solid var(--border)",
              }}
            >
              <option value="auto">Auto theme</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
        </div>
      </header>

      <main
        id="main"
        style={{
          maxWidth: 1280,
          margin: "0 auto",
          padding: "clamp(0.75rem,3vw,1.5rem)",
          display: "grid",
          gap: "1rem",
          gridTemplateColumns: "minmax(0,1fr)",
        }}
      >
        {snapError && (
          <div
            role="alert"
            className="card"
            style={{
              padding: "1rem",
              borderColor: "var(--danger-700)",
              color: "var(--danger-700)",
            }}
          >
            <strong>Transit data unavailable.</strong> {snapError}{" "}
            <Button onClick={() => void loadSnapshot(true)}>Retry</Button>
          </div>
        )}

        {snap?.snapshot.degradedReason && (
          <div
            role="status"
            className="card"
            style={{
              padding: "0.75rem 1rem",
              borderColor: "var(--sunrise-300)",
              fontSize: "0.85rem",
            }}
          >
            <strong>Degraded data:</strong> {snap.snapshot.degradedReason}
          </div>
        )}

        {/* The story, in the creator's own words. */}
        {demo && scene && (
          <section className="card" style={{ padding: "1rem 1.1rem" }}>
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                flexWrap: "wrap",
                marginBottom: "0.6rem",
              }}
            >
              {snap?.scenes.map((s) => (
                <Button
                  key={s.id}
                  onClick={() => {
                    setSceneId(s.id);
                    clearAnalysis();
                  }}
                  pressed={s.id === sceneId}
                >
                  {s.title}
                </Button>
              ))}
            </div>
            <blockquote
              style={{
                margin: 0,
                paddingLeft: "0.9rem",
                borderLeft: "4px solid var(--accent)",
                fontSize: "1rem",
                fontStyle: "italic",
              }}
            >
              “{scene.narrative}”
            </blockquote>
            <p
              className="tnum"
              style={{
                margin: "0.6rem 0 0",
                fontSize: "0.8rem",
                color: "var(--text-muted)",
              }}
            >
              Demo clock: {clock(nowMs)} · Monday 20 July 2026 · every value
              here is demonstration data.{" "}
              <button
                onClick={resetScene}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--accent)",
                  cursor: "pointer",
                  padding: 0,
                  font: "inherit",
                  textDecoration: "underline",
                }}
              >
                Reset scene
              </button>
            </p>
          </section>
        )}

        <div
          style={{
            display: "grid",
            gap: "1rem",
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 22rem), 1fr))",
            alignItems: "start",
          }}
        >
          {/* Map */}
          <section
            className="card"
            style={{ overflow: "hidden", height: "clamp(18rem, 45vh, 26rem)" }}
          >
            <NetworkMap
              shapes={shapes}
              vehicles={vehicles}
              highlightRouteIds={[
                "35",
                ...(comparison?.bestRouteId
                  ? [comparison.bestRouteId]
                  : ["11", "18", "19"]),
              ]}
              observedTripIds={observedTripIds}
            />
          </section>

          {/* Ask */}
          <Card
            title="What should I do?"
            subtitle="Type or dictate. Speech is captured by your browser and sent as text — it is not Gemma audio input."
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void ask(input);
              }}
            >
              <label
                htmlFor="ask"
                style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}
              >
                Your question
              </label>
              <textarea
                id="ask"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                rows={3}
                placeholder={suggestions[0]}
                style={{
                  width: "100%",
                  marginTop: "0.3rem",
                  padding: "0.6rem",
                  borderRadius: 10,
                  border: "1px solid var(--border)",
                  background: "var(--surface-2)",
                  color: "var(--text)",
                  font: "inherit",
                  resize: "vertical",
                }}
              />

              <div
                style={{
                  display: "flex",
                  gap: "0.4rem",
                  flexWrap: "wrap",
                  margin: "0.6rem 0",
                }}
              >
                <label
                  htmlFor="dest"
                  style={{ fontSize: "0.8rem", alignSelf: "center" }}
                >
                  Campus destination
                </label>
                <select
                  id="dest"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                  style={{
                    padding: "0.4rem",
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                    color: "var(--text)",
                    font: "inherit",
                    fontSize: "0.82rem",
                    maxWidth: "100%",
                  }}
                >
                  {CAMPUS_DESTINATIONS.map((d) => (
                    <option key={d.key} value={d.key}>
                      {d.name} (Route {d.servedBy.join("/")})
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={busy || !input.trim()}
                >
                  {busy ? "Thinking…" : "Ask CruzSync"}
                </Button>
                <Button
                  onClick={startListening}
                  disabled={listening}
                  ariaLabel="Dictate your question"
                >
                  {listening ? "● Listening…" : "🎙 Speak"}
                </Button>
              </div>
            </form>

            <div
              style={{
                display: "flex",
                gap: "0.35rem",
                flexWrap: "wrap",
                marginTop: "0.7rem",
              }}
            >
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setInput(s);
                    void ask(s);
                  }}
                  style={{
                    fontSize: "0.75rem",
                    padding: "0.3rem 0.6rem",
                    borderRadius: 999,
                    border: "1px dashed var(--border)",
                    background: "transparent",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    font: "inherit",
                    fontSizeAdjust: "none",
                  }}
                >
                  {s}
                </button>
              ))}
            </div>

            {transcript && (
              <p
                style={{
                  margin: "0.7rem 0 0",
                  fontSize: "0.78rem",
                  color: "var(--text-muted)",
                }}
              >
                <strong>Transcript:</strong> “{transcript}”
              </p>
            )}
            {busy && <Spinner label="Calling tools and composing an answer…" />}
            {error && (
              <p
                role="alert"
                style={{
                  margin: "0.6rem 0 0",
                  color: "var(--danger-700)",
                  fontSize: "0.85rem",
                }}
              >
                {error}
              </p>
            )}
          </Card>
        </div>

        {agent?.recommendation && (
          <RecommendationCard
            rec={agent.recommendation}
            nowMs={nowMs}
            isDemo={isDemoData}
            onChoose={setChosenAction}
            chosen={chosenAction}
          />
        )}

        {agent && (
          <Card title="What CruzSync says">
            <p
              style={{ margin: 0, fontSize: "0.95rem", whiteSpace: "pre-wrap" }}
            >
              {agent.message}
            </p>
            <p
              style={{
                margin: "0.7rem 0 0",
                fontSize: "0.72rem",
                color: "var(--text-muted)",
              }}
            >
              Explanation produced by{" "}
              {agent.explanationMode === "live-gemma"
                ? `${agent.model} (live)`
                : agent.explanationMode === "deterministic-fallback"
                  ? `the deterministic composer after ${agent.model} failed`
                  : "the deterministic composer — no language model was called"}
              . Engine v{agent.engineVersion}.
            </p>
          </Card>
        )}

        {trip && trip.legs.length > 0 && (
          <JourneyTimeline
            legs={trip.legs}
            transferMarginSec={trip.downtownTransferMarginSec}
          />
        )}

        {comparison && (
          <RouteComparison
            options={comparison.options}
            bestRouteId={comparison.bestRouteId}
            destinationName={comparison.destinationName}
            undecidedReason={comparison.undecidedReason}
            onSelect={setChosenRoute}
            selected={chosenRoute}
          />
        )}

        {placesResult && (
          <WaitPanel
            places={placesResult.places}
            fallbackAdvice={placesResult.fallbackAdvice}
            nowMs={nowMs}
            onPick={setPickedPlace}
            picked={pickedPlace}
          />
        )}

        {agent?.recommendation?.leaveByIso && (
          <NotificationPreviews
            leaveByIso={agent.recommendation.leaveByIso}
            nowMs={nowMs}
            boardingLabel={
              agent.recommendation.boardingStopLabel ?? RIVERFRONT.AREA_2.label
            }
            recheckedAt={recheckedAt}
          />
        )}

        {(chosenAction || chosenRoute || pickedPlace) && (
          <Card title="Monitoring">
            <p style={{ margin: 0, fontSize: "0.9rem" }}>
              {chosenRoute && <>You chose Route {chosenRoute}. </>}
              {pickedPlace && <>You are waiting at a place. </>}
              CruzSync will keep watching this journey and will re-check the bus
              before each notification. Ask again at any time to force a fresh
              evaluation.
            </p>
          </Card>
        )}

        {agent && (
          <ToolTrace
            trace={agent.trace}
            mode={agent.explanationMode}
            model={agent.model}
            fallbackReason={agent.fallbackReason}
          />
        )}

        {!agent && !busy && (
          <Empty>
            Ask a question above to see the recommendation, the 11/18/19
            comparison, the evidence, and the full tool trace.
          </Empty>
        )}

        <CivicDashboard events={events} onReport={recordGhostReport} />

        <footer
          style={{
            fontSize: "0.72rem",
            color: "var(--text-muted)",
            padding: "0.5rem 0 2rem",
          }}
        >
          <p style={{ margin: "0 0 0.35rem" }}>
            Transit data © Santa Cruz METRO (GTFS{" "}
            {snap?.gtfs.feedVersion ?? "—"}, valid {snap?.gtfs.validFrom} –{" "}
            {snap?.gtfs.validTo}). Place data ©{" "}
            <a
              href="https://www.openstreetmap.org/copyright"
              style={{ color: "var(--accent)" }}
            >
              OpenStreetMap
            </a>{" "}
            contributors (ODbL). Map tiles © OpenStreetMap.
          </p>
          <p style={{ margin: 0 }}>
            CruzSync is an independent student project for the Cruz Into the
            Gemmaverse hackathon. It is{" "}
            <strong>
              not affiliated with, endorsed by, or operated by Santa Cruz METRO
            </strong>
            , and it is rider decision support only — never an official source
            of service information.
          </p>
        </footer>
      </main>
    </>
  );
}
