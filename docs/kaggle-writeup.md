# CruzSync — Know what to take. Know where to wait.

**Track: Autonomous Agent**

## The commute

I'm a student commuting from Scotts Valley to UCSC. First I catch the 35 into downtown Santa
Cruz. Then I transfer at RiverFront to the 11, 18 or 19 for campus. The 11 is sometimes faster
and, in my experience, usually less crowded — but sometimes it doesn't show up when I expect
it. If I miss the 35, or land a long wait downtown, I want to know whether I have time to grab
coffee or study without missing the next bus.

A normal transit app hands me a list of times. It doesn't know my trip has two structurally
different legs, and it certainly doesn't tell me what I can safely do with 48 minutes of dead
time.

## What the data actually says

Before writing any product logic I read the real Santa Cruz METRO feed (GTFS `S1000116`). Three
findings shaped everything:

**The three "RiverFront areas" are three distinct stops**, roughly 100 m apart. Route 35 arrives
at and departs from Area 2 (`1466`). Routes 11/18/19 _depart_ from Area 1 (`1726`) and _return_
to Area 3 (`1594`), because they run as downtown → campus → downtown loops. Collapsing these
into one stop would erase the inter-area walk that every transfer margin depends on.

**Routes 11 and 19 run the campus loop one way; Route 18 runs it the other.** The same physical
destination is a different GTFS stop depending on which bus you board, so ride time varies by
route in a way no constant offset captures. Coverage differs too: only the 18 reaches Crown &
Merrill; only the 11 and 19 reach Kerr Hall. Picking a destination can eliminate options
outright.

**Route 35's evening headway degrades from 30 minutes to hourly after 20:00.** Hardcoding "30
minutes" would have understated the evening wait by half. CruzSync computes headway from the
active service day, every time.

## Architecture

Five layers, one rule: **code computes, the model explains.**

1. **Ingestion.** Static GTFS pruned to the four routes and committed (~1.1 MB), so the app
   boots and all tests run with no network. GTFS-Realtime vehicles, trip updates and alerts are
   decoded server-side with the official MobilityData bindings — the browser never sees
   protobuf, CORS or a key. Freshness is tracked: fresh ≤ 90 s, stale ≤ 300 s, expired beyond.

2. **Deterministic engine.** Pure, versioned (`ENGINE_VERSION`), unit-tested. Evidence scoring,
   headway, multi-leg construction, the three-way comparison, safe-wait maths.

3. **Waiting-place engine.** Keyless OpenStreetMap/Overpass by default, Google Places when a
   key exists. Conservative hours parsing and a hard feasibility gate.

4. **Gemma agent.** Twelve typed tools, native function calling, a sanitised trace.

5. **Rider UI.** Map, comparison, evidence chips, leave-by countdown, civic dashboard.

## Gemma 4 specifically

CruzSync calls **`gemma-4-31b-it`** on the Gemini API
(`generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`) using **native
function calling**. Worth flagging for anyone building on this: the Gemini API serves exactly
two Gemma 4 models — `gemma-4-31b-it` and `gemma-4-26b-a4b-it`. Ids like `gemma-4-12b-it` exist
on Hugging Face but are _not_ callable there. CruzSync validates the configured id and explains
the mismatch rather than surfacing an opaque 404. Gemma on this endpoint also has no separate
system-instruction slot, so the system prompt leads the conversation as the first turn.

The twelve tools are defined once as Zod schemas. Those schemas generate the JSON Schema sent
as `functionDeclarations` _and_ validate arguments at runtime, so the model's contract and our
validation cannot drift. Results are validated too — a tool returning the wrong shape fails
loudly rather than corrupting a journey deep inside the UI. Invalid arguments come back to the
model as structured errors so it can correct itself.

Gemma's job is genuinely agentic: choose which evidence to gather, notice when the destination
is missing and ask, then explain. Its job is explicitly _not_ arithmetic. The system prompt
forbids adding times, computing headways or deriving leave-by times in free text. Every number
is quoted from a tool result.

That boundary is what makes the fallback safe. With no API key the same tools run on a fixed
plan and a template writes the prose. The recommendation is identical; only the wording
degrades, and the UI states which path ran.

## The engineering choice I'd defend hardest

My first ranking used a flat penalty for "we can't see this bus": `(1 − confidence) × 420s`.

Testing against the real timetable showed why that's wrong. Route 11 reaches Science Hill about
15 minutes faster than Route 19. A flat seven-minute penalty could never overcome that, so the
11 won even with no evidence at all — and the demo I'd sketched, where CruzSync switches away
from an invisible bus, simply didn't happen.

The tempting fix was to inflate the penalty until the story worked. That would have been
rigging the demo.

The honest fix was recognising the penalty had the wrong _shape_. Not seeing a bus matters
enormously when the fallback is 25 minutes later and barely at all when another follows four
minutes behind. So evidence risk is now priced against the genuinely next-best arrival from the
timetable: `(1 − confidence) × (fallback_arrival − this_arrival)`.

Then I rebuilt the scene around what actually happens to me: it's 08:22 and the 08:20 eleven
never appeared. The next 11 is at 08:50, the 19 leaves at 08:30, and CruzSync switches — because
the timetable says so, not because I made it. On a network as well-designed as Santa Cruz's,
sometimes "wait for the 11 anyway" is genuinely correct, and the app says that too.

## Honesty rules, enforced in code

- **A missing vehicle is not a cancellation.** CruzSync may only say "cancelled" when the feed
  publishes `scheduleRelationship: CANCELED`. Otherwise: _"No current vehicle position is
  visible for this trip"_, plus what that does and doesn't mean.
- **Amenities are `true | false | 'unknown'`** — never inferred from category. A café isn't
  automatically quiet; a bookshop doesn't automatically have a restroom. A wheelchair user
  acting on an invented accessibility claim is a real person having a bad evening.
- **Unverifiable hours block the recommendation.** About 60% of downtown venues publish no
  hours to OSM. Those get "unknown" and a "stay near the stop" alternative — never an
  optimistic guess.
- **Confidence is a heuristic, not a probability.** No historical arrival outcomes exist to
  calibrate against, so every payload carries `confidenceIsCalibrated: false`.
- **Sponsorship contributes exactly zero** to feasibility or rank. A test asserts two otherwise
  identical venues score identically.
- **Demo data is never dressed as live.** Every snapshot carries `origin: live | cache |
fixture`, rendered on the header, the recommendation, and every trace row.
- **No chain-of-thought.** The trace shows what the agent _did_: tool, redacted arguments,
  duration, source, timestamp, summary.

## Challenges

**Two answers on one screen.** Live testing caught the comparison card saying "Route 19" beside
a recommendation saying "take the 11" — they'd used different transfer times. The fix threads
`earliestAtArea1` from the trip builder into the comparison. The same class of bug appeared
again with leave-by times differing by a minute between the recommendation and the place list;
now `recommend_next_action` returns the ranking it actually used. Both were caught by driving
the real app, not by unit tests.

**Overpass is a free, shared service.** It rate-limits and times out routinely. The fix was a
leaner query, three mirrors, and backoff — because for a rider, a 429 means no suggestions at
all.

**Hours parsing.** The OSM `opening_hours` grammar is large. CruzSync implements the common
subset and returns `parsed: false` for anything else, which propagates to "cannot confirm" and
blocks the recommendation. Being wrong about a closing time is how someone ends up locked out
in the dark having missed an hourly bus.

## Impact

Measured, per evening trip on the real timetable: **48 minutes** of transfer gap converted into
**38 usable minutes** at a verified-open venue, with a hard leave-by time. Four nearby venues
qualified; eight were correctly ruled out for closing too early or unverifiable hours. Foot
traffic goes to local businesses only when the visit is genuinely safe — never as disguised
advertising.

The civic panel logs anonymised confidence failures (route, stop, expected time, feed evidence
— nothing else). Rider-minutes lost is labelled a modelled estimate; event counts and
timestamps are measured. That distinction matters if this data is ever shown to a transit
agency.

## Limitations and future work

Confidence needs calibration against real arrival outcomes. Walking times are estimates
(haversine × 1.35) until a routing provider is configured — labelled everywhere, and estimation
buys extra buffer. The snapshot cache is in-process, so multi-instance deployment needs shared
storage. Abbott Square Market isn't in OSM near the stop, so it's absent from the keyless build.

Next: real walking routes, historical logging to calibrate confidence, and community amenity
submissions so "quiet" and "Wi-Fi" can stop being unknown.

CruzSync is an independent student project, not affiliated with or endorsed by Santa Cruz
METRO. Transit data © Santa Cruz METRO; place data © OpenStreetMap contributors (ODbL).
