# CruzSync architecture

## The one rule

> **Code computes. The model explains.**

Gemma decides *which* questions to ask and turns the answers into something a tired student can
act on. It never performs the arithmetic. Every time, margin, headway and countdown on screen
comes from a pure, versioned, unit-tested engine.

This is not a stylistic preference. A language model that miscalculates a leave-by time by four
minutes produces advice that is fluent, confident and wrong, and the rider misses an hourly
bus. Putting the arithmetic behind typed tools means the worst a model failure can do is
degrade the prose — which is why the deterministic fallback produces an identical
recommendation.

## System diagram

```mermaid
flowchart TB
    subgraph sources["External sources"]
        GTFS["Static GTFS<br/>developer.scmetro.org/gtfs.zip"]
        RTV["GTFS-RT vehicles"]
        RTT["GTFS-RT trip updates"]
        RTA["GTFS-RT alerts"]
        OSM["OpenStreetMap<br/>Overpass API"]
        GP["Google Places<br/>(optional)"]
    end

    subgraph build["Build time"]
        PRUNE["scripts/build-gtfs.ts<br/>prune to routes 11/18/19/35<br/>~1.1 MB committed JSON"]
        PVER["scripts/verify-places.ts<br/>capture labelled place fixture"]
    end

    subgraph server["Server (Next.js route handlers) — all keys and protobuf stay here"]
        FEED["gtfs/feed.ts<br/>service days, past-midnight times"]
        RT["rt/fetch.ts<br/>MobilityData protobuf decode<br/>freshness + last-good cache"]
        PROV["rt/provider.ts<br/>live | cache | fixture"]

        subgraph engine["Deterministic engine — pure, ENGINE_VERSION"]
            EV["evidence.ts<br/>confidence from signals"]
            HW["headway.ts<br/>computed, never hardcoded"]
            ML["multileg.ts<br/>35 → walk → 11/18/19<br/>+ three-way comparison"]
            SW["safewait.ts<br/>leave_by, usable_wait, buffers"]
        end

        subgraph places["Waiting places"]
            OV["overpass.ts (default)"]
            GPP["googlePlaces.ts (keyed)"]
            HRS["hours.ts<br/>conservative parser"]
            RANK["rank.ts<br/>feasibility gate + ranking"]
        end

        subgraph agent["Gemma agent"]
            SCH["tools/schemas.ts<br/>12 Zod arg + result schemas"]
            REG["tools/registry.ts<br/>validated execution"]
            GEM["providers/google.ts<br/>generateContent + functionDeclarations"]
            ORCH["orchestrator.ts<br/>tool loop / deterministic fallback"]
            TR["trace.ts<br/>redaction, no chain-of-thought"]
        end
    end

    subgraph client["Browser — no keys, no protobuf"]
        UI["CruzSyncApp<br/>map, comparison, evidence,<br/>leave-by countdown, civic panel"]
    end

    GTFS --> PRUNE --> FEED
    OSM --> PVER --> RANK
    RTV & RTT & RTA --> RT --> PROV
    PROV --> EV & ML
    FEED --> EV & HW & ML
    EV --> ML --> SW
    OV & GPP --> HRS --> RANK
    SW --> RANK
    ML & SW & RANK & HW --> REG
    SCH --> REG
    SCH -->|JSON Schema| GEM
    REG <--> ORCH
    GEM <--> ORCH
    ORCH --> TR --> UI
    ORCH --> UI
```

## The agent loop

```mermaid
sequenceDiagram
    participant R as Rider
    participant O as Orchestrator
    participant G as Gemma 4 (Gemini API)
    participant T as Typed tools
    participant E as Deterministic engine

    R->>O: "I'm on the 35. Which bus for campus?"
    O->>G: system prompt + question + 12 functionDeclarations
    G-->>O: functionCall build_multileg_trip
    O->>T: validate args (Zod)
    T->>E: buildMultilegTrip()
    E-->>T: legs, transfer margin, earliestAtArea1
    T-->>O: validate result (Zod) + provenance
    O->>G: functionResponse
    G-->>O: functionCall compare_ucsc_options(earliestAtArea1)
    Note over O,E: the same transfer time is chained through,<br/>so comparison and recommendation cannot disagree
    O->>T: → E → ranked 11 / 18 / 19
    T-->>O: options, scores, evidence
    O->>G: functionResponse
    G-->>O: functionCall recommend_next_action
    O->>T: → E → structured recommendation
    G-->>O: prose citing sources and timestamps
    O-->>R: recommendation + evidence + sanitised trace
```

If any step fails — no key, provider error, rate limit, blocked prompt — the orchestrator runs
the same tools on a fixed plan and composes the answer from a template. The label changes from
`live-gemma` to `deterministic-fallback` and the reason is displayed. The recommendation does
not change.

## Responsibility boundaries

| Layer | Owns | Must never |
|---|---|---|
| **Ingestion** `gtfs/`, `rt/` | Fetching, protobuf decoding, normalising, freshness | Interpret data, or let protobuf/keys reach the browser |
| **Engine** `engine/` | All arithmetic: evidence, headway, margins, ranges, buffers | Perform I/O, or depend on a model |
| **Places** `places/` | Discovery, hours parsing, feasibility, ranking | Infer an amenity from a category, or treat unknown hours as open |
| **Agent** `agent/` | Tool selection, argument construction, prose, citation | Compute a number, assert an unsupported fact, expose reasoning |
| **UI** `components/` | Presentation, interaction, honest labelling | Recompute anything, or render a value without its provenance |

## Key data decisions

**Why the GTFS feed is pruned and committed.** The raw feed is ~15 MB unzipped
(`stop_times.txt` alone is 6.4 MB). Pruned to the four routes and stored as tuple-encoded JSON
it is ~1.1 MB, which is small enough to commit. The app therefore boots, and the entire test
suite runs, with no network access at all. `npm run gtfs:build` refreshes it and records the
feed version and fetch time.

**Why real-time decoding is server-side.** `rt.scmetro.org` serves
`application/x-google-protobuf` and does not send CORS headers. Decoding in a route handler
removes both problems and keeps the browser bundle free of protobuf machinery.

**Why the three RiverFront areas are separate constants.** They are three distinct GTFS stops
(`1726`, `1466`, `1594`) roughly 100 m apart. Collapsing them would erase the inter-area walk
that the entire transfer-margin calculation depends on.

**Why `earliestAtArea1` is chained between tools.** `compare_ucsc_options` called with "now"
and the same comparison called with the Route 35 arrival time can legitimately pick different
winners. Showing a judge a comparison card that says "Route 19" beside a recommendation that
says "take the 11" destroys trust instantly, so the transfer time computed by
`build_multileg_trip` is threaded into the comparison. The same reasoning is why
`recommend_next_action` returns the wait-place ranking it actually used rather than letting the
UI compute a second one with a different uncertainty buffer.

**Why `Tristate` instead of `boolean`.** Making unknown a distinct value at the type level
means a developer cannot accidentally write `if (place.hasWifi)` and silently treat "we don't
know" as "no" — or worse, default it to "yes".

## Versioning

`ENGINE_VERSION` in `src/lib/domain.ts` is bumped whenever the scoring maths changes. It is
attached to every tool result's provenance and rendered in the UI, so a recorded demo can
always be tied back to the exact formula that produced it.

## Testing strategy

132 tests across four files, all runnable offline:

| File | Covers |
|---|---|
| `tests/gtfs.test.ts` | Feed integrity, service days, past-midnight times, and the real network geometry — these assertions are pinned to independently verified facts so a future feed change fails loudly rather than silently misleading riders |
| `tests/engine.test.ts` | Evidence scoring, alerts, computed headway, the three-way comparison, transfer margins, arrival ranges, safe-wait maths, buffer growth |
| `tests/places.test.ts` | Hours parsing (including refusal to guess), unknown-unless-sourced amenities, closing-before-leave-by, filters, sponsorship neutrality |
| `tests/agent.test.ts` | Tool schema surface, argument and result validation, trace redaction, prompt guardrails, config honesty, and end-to-end happy paths |
