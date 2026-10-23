// How fast does the ground sharpen when you fly to a city? Opens the live globe (production build with
// ?debug=1), then for each city flies from orbit to street level and records:
//   first: time until the first tile of the final level is on screen,
//   sharp: time until 90 % of the drawn area is at the final level (or one above it),
//   settled: time until nothing is loading or wanted any more.
//
//   node scripts/zoombench.mjs [baseUrl] [--warm]
//
// Each city is new to the browser on the first pass; --warm repeats them with the caches filled.

import { chromium } from "@playwright/test";

const base = process.argv.find((a) => a.startsWith("http")) ?? "http://localhost:3300";
const warm = process.argv.includes("--warm");
const cities = process.argv.includes("--set3") ? [["Madrid", 40.4168, -3.7038], ["Osaka", 34.6937, 135.5023], ["Toronto", 43.6532, -79.3832], ["Odesa", 46.4825, 30.7233], ["Melbourne", -37.8136, 144.9631], ["Bogota", 4.711, -74.0721]] : process.argv.includes("--set2") ? [["London", 51.5074, -0.1278], ["Seoul", 37.5665, 126.978], ["Chicago", 41.8781, -87.6298], ["Lviv", 49.8397, 24.0297], ["Sydney", -33.8688, 151.2093], ["Lima", -12.0464, -77.0428]] : [
  ["Paris", 48.8566, 2.3522],
  ["Tokyo", 35.6762, 139.6503],
  ["New York", 40.7128, -74.006],
  ["Kyiv", 50.4501, 30.5234],
  ["Cape Town", -33.9249, 18.4241],
  ["Rio", -22.9068, -43.1729],
];
const DIST = 1.0008; // about 5 km up

const browser = await chromium.launch({ args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${base}/en/live?debug=1&layers=clouds,lights`, { waitUntil: "load" });
await page.evaluate(() => performance.setResourceTimingBufferSize(100_000));
await page.waitForFunction(() => window.__orbisStore?.getState().ready, null, { timeout: 60_000 });
const inflight = process.argv.find((a) => a.startsWith("--inflight="));
if (inflight) await page.evaluate((n) => (window.__orbisEngine.tiles.maxInFlight = n), Number(inflight.split("=")[1]));
const gpu = await page.evaluate(() => {
  const gl = document.querySelector("canvas").getContext("webgl2");
  const ext = gl?.getExtension("WEBGL_debug_renderer_info");
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
});
console.log(`GPU: ${gpu}`);

async function run(name, lat, lon) {
  return page.evaluate(
    async ({ lat, lon, dist }) => {
      const e = window.__orbisEngine;
      const t = e.tiles;
      // Start from orbit over the target, settled.
      e.rig.flyTo({ lat, lon, dist: 3.2 }, 0.05);
      await new Promise((r) => setTimeout(r, 1500));
      const t0 = performance.now();
      e.flyTo(lat, lon, dist);
      let first = null;
      let sharp = null;
      let settled = null;
      let maxZ = 0;
      while (performance.now() - t0 < 30_000) {
        await new Promise((r) => setTimeout(r, 50));
        const drawn = [...t.drawn];
        if (!drawn.length) continue;
        const top = Math.max(...drawn.map((n) => n.z));
        maxZ = Math.max(maxZ, top);
        const arrived = Math.abs(e.rig.pose.dist - dist) / dist < 0.02;
        if (arrived && first === null && drawn.some((n) => n.z >= maxZ && n.texture)) first = performance.now() - t0;
        // Area share by level: a tile at level z covers 4^-z.
        const area = (n) => 4 ** -n.z;
        const total = drawn.reduce((s, n) => s + area(n), 0);
        const fine = drawn.filter((n) => n.z >= maxZ - 1).reduce((s, n) => s + area(n), 0);
        if (arrived && sharp === null && fine / total > 0.9) sharp = performance.now() - t0;
        if (arrived && t.inFlight.size === 0 && t.wanted.length === 0) {
          settled = performance.now() - t0;
          break;
        }
      }
      const res = performance.getEntriesByType("resource").filter((r) => r.startTime >= t0 && /eox|arcgis|terrain/.test(r.name));
      const dur = res.map((r) => r.duration).sort((a, b) => a - b);
      const levels = {};
      for (const n of t.drawn) levels[n.z] = (levels[n.z] || 0) + 1;
      return { first, sharp, settled, maxZ, tiles: t.drawn.size, requests: res.length, unique: new Set(res.map((r) => r.name)).size, aborted: res.filter((r) => r.responseStatus === 0 || r.transferSize === 0 && r.decodedBodySize === 0).length, terrain: res.filter((r) => /terrain/.test(r.name)).length, median: dur[dur.length >> 1] | 0, p90: dur[Math.floor(dur.length * 0.9)] | 0, levels: JSON.stringify(levels) };
    },
    { lat, lon, dist: DIST },
  );
}

const rows = [];
for (const pass of warm ? ["cold", "warm"] : ["cold"]) {
  for (const [name, lat, lon] of cities) {
    const r = await run(name, lat, lon);
    const f = (ms) => (ms === null ? "—" : `${(ms / 1000).toFixed(2)} s`);
    rows.push(`${pass.padEnd(5)} ${name.padEnd(10)} first ${f(r.first).padStart(7)}  sharp ${f(r.sharp).padStart(7)}  settled ${f(r.settled).padStart(7)}  z${r.maxZ} ${r.tiles} tiles, ${r.requests} req, ${r.unique} unique, ${r.aborted} empty (${r.terrain} terrain), median ${r.median} ms, p90 ${r.p90} ms ${r.levels}`);
    console.log(rows.at(-1));
  }
}
await browser.close();
