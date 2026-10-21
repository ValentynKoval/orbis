# Orbis — project rules for Claude Code

Orbis is a portfolio project: a live 3D Earth with satellites, earthquakes, fires, clouds and city lights
(planes, ships, a 24-hour replay and an AI analyst come in later stages).
Owner: Valentyn (GitHub `ValentynKoval`, Vercel `valentyngolf`). Claude writes the code; Valentyn sets tasks and reviews.
It is shown in the shared Intromax portfolio on Freelancehunt.

## Hard rules

- **Budget is $0.** Every data source, host and API must stay on a free tier. If a step would cost money, stop and ask.
- **Non-commercial.** No ads, no paid features, no tracking; several sources (OpenSky, airplanes.live) allow non-commercial use only.
  Keep the `/[locale]/sources` attribution page complete when adding a source.
- **Visitors never call upstream APIs.** Feeds go through our own routes (`src/app/api/*`) with CDN cache headers
  (`lib/http.ts`); live traffic comes from the relay through `/api/live/*`. CelesTrak is read only by the GitHub Action mirror
  (`.github/workflows/mirror-celestrak.yml` → orphan branch `data`).
- **No `Co-Authored-By` trailers or any AI attribution** in commits, PRs, README or UI (Valentyn's rule).
- **Repository is public.** No secrets in code or history; keys go to env vars and `.env.example` lists them.
  The Gemini key lives in Valentyn's `D:\Dev\olx-monitor\.env`; copy it to Vercel env, never into the repo.
- `pages.dev` / `workers.dev` are blocked by the Ukrainian ISP Vega: anything visitors load must be served from Vercel
  (rewrite/proxy if the backend is elsewhere).

## Relay (`relay/`, Cloudflare Worker + one Durable Object)

- Account: Valentyn's Cloudflare (`valentyn.golf@gmail.com`), URL `https://orbis-relay.valentyngolf.workers.dev`.
  The global wrangler login on this PC belongs to Maxim, so **every wrangler command for Orbis runs with
  `XDG_CONFIG_HOME='C:\Users\Valentyn\.orbis-wrangler'`** (Valentyn's login lives there). Never run `wrangler login` globally.
- The `Hub` object holds the aisstream.io WebSocket (global, compressed), polls adsb.lol every 90 s and Digitraffic,
  keeps ship and plane tracks in memory, and serves JSON snapshots. One always-on object uses ~10,800 of the
  13,000 free GB-s per day: do not add a second always-on object.
- Only requests with `x-orbis-key: RELAY_TOKEN` are served; Vercel holds the token (`RELAY_URL`, `RELAY_TOKEN` env).
  Secrets on the worker: `RELAY_TOKEN`, `AISSTREAM_API_KEY` (`wrangler secret put`). Local dev: `relay/.dev.vars` (ignored).
- OpenSky is not used: it does not answer requests from Cloudflare or Vercel (AWS) networks. Aircraft come from
  adsb.lol (ODbL), which must stay credited on the Sources page.
- The `data` branch is refreshed by `.github/workflows/data.yml` every 2 h: CelesTrak element sets and the cloud mask
  (`scripts/cloud-mask.mjs`, 8k GIBS mosaic → 4k/2k masks). Browsers load the mask straight from raw.githubusercontent.
- History: the hub writes one gzipped frame per kind every 5 min (planes: motion columns only; ships: full snapshot)
  into its SQLite table `frames`, keeps 25 h. `/history` lists frames, `/history/{planes|ships}/{t}` serves the gzip as-is.
- AI analyst quota lives in the hub (`/quota/{visitorHash}`): 15 questions per visitor and 300 in total per UTC day.
- Deploy: `cd relay && XDG_CONFIG_HOME=... npx wrangler deploy`. A deploy restarts the object; ships repopulate in minutes.

## AI analyst

- `/api/analyst` (POST) runs an agent loop on Gemini (`GEMINI_API_KEY`, `GEMINI_MODEL` in Vercel env; free tier only,
  Claude API is not used because it is paid). Data tools run on the server (`lib/analyst/tools.ts`, unit-tested);
  UI tools come back as `actions` that `components/Analyst.tsx` performs. Keep the Google disclosure in the panel
  and on the Sources page.
- When testing with curl on this PC, send non-ASCII questions from a UTF-8 file (`--data-binary @q.json`):
  Git Bash mangles Cyrillic in `-d`.

## Languages

- UI text lives in `src/i18n/en.ts` (source of truth, typed) and `src/i18n/uk.ts` (must match its shape).
  Never hard-code user-facing strings in components. Routes are `/uk/…` and `/en/…`; `src/proxy.ts` picks one
  from the `orbis-locale` cookie or Accept-Language.
- Code, comments, README, commit messages: English. Reports to Valentyn: Russian.

## Definition of done (every round)

`npm run lint` → `npm run typecheck` → `npm run test` → `npm run build` → `npm run test:e2e` (Playwright, desktop + phone,
against the build, real feeds) → commit → push → `vercel deploy --prod` → link + short report.
On this PC `next build` may need `NODE_OPTIONS=--max-old-space-size=4096`. Stop the dev server before building.

## Architecture

- Next.js 16 App Router, TypeScript strict, Tailwind v4 (tokens in `src/app/globals.css` `@theme`), three.js with
  hand-written GLSL (`src/engine/shaders.ts`), GSAP for the landing, Zustand for UI state.
- `src/engine/` is framework-free: `Engine` owns the renderer, `CameraRig` the camera, `SimClock` the simulated time.
  Layers (`engine/layers/*`) take data and expose `update(simMs)` + `setOpacity()`. React talks to the engine only via
  `useOrbis` (store) and the engine instance in it.
- Scene convention (`lib/geo.ts`): Earth is a fixed unit sphere, Y = north, lon 0 = +X, 90°E = −Z. Inertial objects
  (satellites, stars) live in a group rotated by −GMST.
- Imagery tiles (`engine/layers/Tiles.ts`, `lib/tiles.ts`): Web Mercator quadtree over the base globe, refined by
  screen-space error; a parent stays drawn while children fade in. Providers: EOX (levels 2–13, keyless, CC BY-NC-SA)
  and Esri via `NEXT_PUBLIC_ARCGIS_KEY` (14–19). Never use Esri or Bing tiles without a key: their terms forbid it.
  Tiles share the planet shader's uniforms, so lighting and clouds match the base sphere.
- Solar system (`engine/SolarSystem.ts`): separate scene in AU with a floating origin at the focused body; the Earth
  scene hands over at 70 Earth radii (`CameraRig.maxDist`) and takes back at `minDist`. `lib/orbits.ts` has the
  ephemerides (JPL planet elements, Meeus Moon, Kepler solver for JPL small-body elements), all unit-tested.
- The renderer uses a logarithmic depth buffer: every ShaderMaterial wraps its shaders with `logDepth()`.
- Satellites: SGP4 in a Web Worker (`engine/workers/sgp4.worker.ts`) every ~2.5 s of sim time; the vertex shader advances
  each one along its orbit in between. `lib/geo.ts#advanceOrbit` mirrors the shader for CPU picking — change both together. Nothing may import
  "satellite.js" directly (its WASM re-export hangs the worker build); use `lib/sgp4.ts`.
- Everything time-dependent reads `SimClock.now()`, never `Date.now()`, so the stage-3 timeline can scrub it.
- Pure logic (astronomy, feeds parsing, tour picks) lives in `src/lib/**` and is unit-tested with Vitest.
- Base imagery is generated by `npm run assets` (NASA Blue Marble per month, Black Marble, Natural Earth) into
  `public/textures` and `public/data`; outputs are committed, sources cached in `.cache/` (ignored).

## Design

- Space is pure black; one brand accent, Kapton gold `foil` (#f2c14e), used for brand, CTAs, stations and selection.
- Each data type keeps one colour everywhere: satellites `ion`, quakes `seismic`, fires `ember`, city lights `glow`.
- Type: Unbounded (display) + Geologica (UI), tabular numbers for readouts. Panels use the `.bezel` / `.bezel-core` glass.
- No all-caps labels, no numbered section markers, motion only for the intro and for responses to user actions.
