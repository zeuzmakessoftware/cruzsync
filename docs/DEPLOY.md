# Deploying CruzSync

CruzSync is a single Next.js app. Everything server-side (protobuf decoding, feed polling, API
keys) lives in route handlers, so it deploys as one unit with no extra services.

## Vercel (recommended)

1. Push this repository to GitHub.
2. On <https://vercel.com/new>, import the repository. The framework is detected automatically;
   no build-command changes are needed.
3. Add environment variables (Project → Settings → Environment Variables):

   | Variable                | Value                                      | Required                     |
   | ----------------------- | ------------------------------------------ | ---------------------------- |
   | `GEMMA_PROVIDER`        | `google`                                   | no (defaults to `google`)    |
   | `GOOGLE_API_KEY`        | your Google AI Studio key                  | **only for Live Gemma**      |
   | `GEMMA_MODEL`           | `gemma-4-31b-it`                           | no (this is the default)     |
   | `DEMO_MODE`             | `true` for judging, `false` for live-first | no                           |
   | `GOOGLE_PLACES_API_KEY` | Places (New) key                           | no (Overpass used otherwise) |

4. Deploy. The result is a public, no-login URL.

**It works with zero environment variables.** With none set it runs fully in labelled
Deterministic Demo mode, which is a legitimate submission — the UI states exactly what is and
isn't running.

## Anywhere else

Any Node host works:

```bash
npm ci
npm run build
npm start          # honours PORT
```

Requirements: Node 20+, outbound HTTPS to `rt.scmetro.org` (real-time),
`developer.scmetro.org` (only for `npm run gtfs:build`), `overpass-api.de` (places, unless a
Places key is set) and `generativelanguage.googleapis.com` (only for Live Gemma).

The committed GTFS under `data/gtfs/` means the app boots even with **no** outbound network —
it will simply report the real-time feeds as unavailable, honestly, rather than failing.

## Before you go public

- [ ] `npm run verify` passes
- [ ] `git log -p | grep -iE "AIza|api[_-]?key|secret"` finds nothing
- [ ] `.env.local` is **not** committed (`.gitignore` covers `.env*.local`)
- [ ] `.env.example` contains placeholders only
- [ ] The deployed URL loads without a login
- [ ] The header badge reads what you expect (Live Gemma vs Deterministic Demo)

## Refreshing the data

The bundled GTFS feed is valid **2026-06-18 → 2026-09-09**. After it expires:

```bash
npm run gtfs:build      # re-download and re-prune
npm run places:verify   # re-capture the labelled OSM place fixture
npm test                # the pinned network-geometry assertions will catch real changes
```

`tests/gtfs.test.ts` deliberately pins the dates it exercises, so an expired feed fails loudly
instead of silently giving riders stale geography.
