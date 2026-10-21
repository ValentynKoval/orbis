# Orbis

**The planet, live.** A real-time 3D Earth in the browser: every tracked satellite and the ISS, today's earthquakes and
wildfires, yesterday's real clouds and tonight's city lights, on a globe lit by the actual position of the Sun.

Live: https://orbis-live.vercel.app

## What it does

- **Satellites.** ~16,000 active objects from CelesTrak, propagated with SGP4 in a Web Worker and advanced along their
  orbits on the GPU between updates, so thousands of points move smoothly at 60 fps. Tap one for altitude, speed,
  inclination, period and its orbit drawn around the planet. The ISS is highlighted in gold.
- **Aircraft.** ~12,000 aircraft worldwide from the adsb.lol community network, refreshed every 90 seconds and
  flown along great circles on the GPU in between; each update blends from where an icon was drawn, so nothing jumps.
  Tap one for flight, registration, type, altitude, speed and its track over the last hour.
- **Ships.** ~20,000 vessels from the global aisstream.io AIS feed plus Finland's Digitraffic, coloured by type
  (cargo, tanker, passenger, fishing, leisure, service), with destination, size and a four-hour track.
- **Search and filters.** One box (`/` or Ctrl+K) finds satellites, flights, ships and quakes and flies there;
  aircraft can be filtered by altitude, ships by type.
- **Time machine.** A 24-hour timeline: scrub to any moment or play it back at 60× or 600×. Satellites are
  re-propagated for that instant, the terminator and quakes follow, and aircraft and ships come from 5-minute frames
  the relay records into its Durable Object's SQLite storage.
- **Ask Orbis.** An AI analyst (Gemini, free tier) with tools: it queries live aircraft, ships, quakes, fires and
  satellite positions, answers in Ukrainian or English, and moves the camera or opens the object it talks about.
  Visitors get a daily question allowance enforced by the relay.
- **Earthquakes.** USGS real-time feeds: every event of the past day plus M4.5+ of the week, drawn as rings that ripple
  from each epicentre, coloured by depth and fading with age.
- **Fires.** NASA FIRMS VIIRS (NOAA-20) detections of the last 24 hours, merged into ~4 km cells, sized and coloured by
  radiative power.
- **Clouds.** Yesterday's NASA GIBS true-colour mosaic turned into a cloud mask on the server (bright, colourless and
  brighter than the cloud-free Blue Marble beneath), with real cloud shadows on the ground.
- **Day and night.** A solar ephemeris places the terminator; the night side shows NASA Black Marble city lights, the
  day side uses the Blue Marble image for the current month, with sun glint on water and a scattering atmosphere.
- **Landing tour.** A scroll-driven flight that picks its stops from live data: the strongest quake of the day, the
  busiest fire region, the most populated part of the night side.
- Ukrainian and English interface.

## Stack

Next.js 16 (App Router), TypeScript, three.js with hand-written GLSL shaders, satellite.js, GSAP, Zustand,
Tailwind CSS 4, Vitest. Hosted on Vercel; live traffic comes through a relay on Cloudflare Workers (one Durable
Object holding the AIS WebSocket and polling the aircraft feed); a GitHub Action mirrors CelesTrak data.

```
src/engine/          renderer, camera rig, simulated clock, layers, shaders, SGP4 worker
src/app/api/*        feed routes: fetch upstream once, cache on the CDN, serve everyone
src/lib/             astronomy, geometry, feed parsers, tour logic (unit-tested)
src/i18n/            UA / EN dictionaries
relay/               Cloudflare Worker + Durable Object: AIS stream, aircraft polling, tracks, snapshots
scripts/             asset pipeline for NASA and Natural Earth imagery
```

## Data and costs

Everything is free and non-commercial. Visitors never call the data providers directly: each feed is fetched by a
server route and cached on the CDN (USGS for a minute, FIRMS for 30 minutes, clouds for six hours), and CelesTrak is
read only by a scheduled GitHub Action that keeps a copy on the `data` branch, respecting CelesTrak's
one-download-per-update rule. Full credits are on the site's Sources page.

| Data | Source | Licence |
| --- | --- | --- |
| Satellites | CelesTrak GP element sets | Free, attribution |
| Aircraft | adsb.lol | ODbL 1.0 |
| Ships | aisstream.io, Digitraffic (Fintraffic) | Free; CC BY 4.0 |
| Earthquakes | USGS Earthquake Hazards Program | Public domain |
| Fires | NASA FIRMS (LANCE) | Free, attribution |
| Clouds | NASA GIBS | Free, attribution |
| Earth imagery | NASA Blue Marble, Black Marble | Public domain |
| Borders | Natural Earth | Public domain |

## Run locally

```bash
npm install
npm run dev
```

`npm run check` runs lint, type checks, unit tests and a production build. `npm run assets` regenerates the textures.

## Roadmap

1. Globe, landing, satellites, quakes, fires, clouds, city lights. *(done)*
2. Live aircraft and ships through a relay, smooth motion for tens of thousands of objects, search, tracks. *(done)*
3. 24-hour history with a replay timeline, an AI analyst that answers questions and moves the camera. *(done)*
4. Mobile polish, sound, end-to-end tests, case study.
