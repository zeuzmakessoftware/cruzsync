"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { CAMPUS_DESTINATIONS, RIVERFRONT } from "@/lib/domain";
import { Button, Card, Spinner } from "./ui";
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
          "The next 35 is far away. Where can I wait without missing it?",
          "Somewhere quiet and indoors near the stop, please.",
        ];

  const suggestionLabels =
    direction === "to-campus"
      ? ["Choose my bus", "Compare campus buses"]
      : ["Find somewhere to wait", "Find somewhere quiet"];

  const sceneLabels: Record<string, string> = {
    "outbound-11-wins": "Choose a campus bus",
    "outbound-11-ghost": "My bus did not arrive",
    "return-long-wait": "Find a place to wait",
  };

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to the recommendation
      </a>

      <header className="app-header">
        <div className="header-inner">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              CS
            </span>
            <div className="brand-copy">
              <h1>CruzSync</h1>
              <p>Santa Cruz commute intelligence</p>
            </div>
          </div>

          <div className="status-bar">
            <label className="header-control">
              <input
                type="checkbox"
                checked={demo}
                onChange={(e) => {
                  setDemo(e.target.checked);
                  clearAnalysis();
                }}
                aria-label="Use the reproducible demo story instead of live Santa Cruz data"
              />
              Try demo trips
            </label>
          </div>
        </div>
      </header>

      <main id="main" className="app-main">
        {snapError && (
          <div
            role="alert"
            className="card notice"
            style={{
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
            className="card notice"
            style={{
              borderColor: "var(--sunrise-300)",
              fontSize: "0.85rem",
            }}
          >
            <strong>Degraded data:</strong> {snap.snapshot.degradedReason}
          </div>
        )}

        {demo && scene && (
          <section className="demo-strip" aria-label="Example trips">
            <strong>Try an example</strong>
            <div className="scene-tabs">
              {snap?.scenes.map((s) => (
                <Button
                  key={s.id}
                  onClick={() => {
                    setSceneId(s.id);
                    clearAnalysis();
                  }}
                  pressed={s.id === sceneId}
                >
                  {sceneLabels[s.id] ?? s.title}
                </Button>
              ))}
            </div>
            <span className="demo-time tnum">Demo time {clock(nowMs)}</span>
            <button className="text-button" onClick={resetScene}>
              Restart
            </button>
          </section>
        )}

        <div className="workspace">
          {/* Map */}
          <section className="map-shell">
            <div className="map-label">35 → RiverFront → UCSC</div>
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
          <Card className="ask-panel" title="What do you need?">
            {direction === "to-campus" && (
              <div className="destination-row">
                <label htmlFor="dest" className="field-label">
                  I am going to
                </label>
                <select
                  className="select-input"
                  id="dest"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                >
                  {CAMPUS_DESTINATIONS.map((d) => (
                    <option key={d.key} value={d.key}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="quick-actions">
              {suggestions.map((suggestion, index) => (
                <button
                  className="quick-action"
                  key={suggestion}
                  disabled={busy}
                  onClick={() => {
                    setInput(suggestion);
                    void ask(suggestion);
                  }}
                >
                  {suggestionLabels[index]}
                  <span aria-hidden="true">→</span>
                </button>
              ))}
            </div>

            <details className="ask-more">
              <summary>Ask something else</summary>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void ask(input);
                }}
              >
                <label htmlFor="ask" className="field-label">
                  Your question
                </label>
                <input
                  className="ask-textarea"
                  id="ask"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Type your question"
                />

                <div className="ask-actions">
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={busy || !input.trim()}
                  >
                    {busy ? "Working..." : "Get my plan"}
                  </Button>
                  <Button
                    onClick={startListening}
                    disabled={listening}
                    ariaLabel="Dictate your question"
                  >
                    {listening ? "Listening..." : "Use voice"}
                  </Button>
                </div>
              </form>
            </details>

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
            {busy && <Spinner label="Finding the best plan..." />}
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

        {trip && trip.legs.length > 0 && (
          <JourneyTimeline
            legs={trip.legs}
            transferMarginSec={trip.downtownTransferMarginSec}
          />
        )}

        {comparison && (
          <details className="more-details">
            <summary>Compare the other buses</summary>
            <RouteComparison
              options={comparison.options}
              bestRouteId={comparison.bestRouteId}
              destinationName={comparison.destinationName}
              undecidedReason={comparison.undecidedReason}
              onSelect={setChosenRoute}
              selected={chosenRoute}
            />
          </details>
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

        {chosenAction && agent?.recommendation?.leaveByIso && (
          <NotificationPreviews
            leaveByIso={agent.recommendation.leaveByIso}
            nowMs={nowMs}
            boardingLabel={
              agent.recommendation.boardingStopLabel ?? RIVERFRONT.AREA_2.label
            }
            recheckedAt={recheckedAt}
          />
        )}

        {agent && (
          <details className="more-details">
            <summary>How this plan was checked</summary>
            <ToolTrace
              trace={agent.trace}
              mode={agent.explanationMode}
              model={agent.model}
              fallbackReason={agent.fallbackReason}
            />
          </details>
        )}

        <details className="more-details">
          <summary>Report a bus that did not arrive</summary>
          <CivicDashboard events={events} onReport={recordGhostReport} />
        </details>

        <footer className="app-footer">
          <p>Independent project. Not official Santa Cruz METRO information.</p>
          <details className="footer-details">
            <summary>Data sources</summary>
            <p>
              Transit data © Santa Cruz METRO (GTFS{" "}
              {snap?.gtfs.feedVersion ?? "-"}, valid {snap?.gtfs.validFrom} -{" "}
              {snap?.gtfs.validTo}). Place data ©{" "}
              <a
                href="https://www.openstreetmap.org/copyright"
                style={{ color: "var(--accent)" }}
              >
                OpenStreetMap
              </a>{" "}
              contributors (ODbL). Map tiles © OpenStreetMap.
            </p>
          </details>
        </footer>
      </main>
    </>
  );
}
