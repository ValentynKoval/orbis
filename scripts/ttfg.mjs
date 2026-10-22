// Time to first globe: from navigation start until the canvas fades in, plus transfer sizes.
import { chromium } from "@playwright/test";
const base = process.argv[2] ?? "https://orbis-live.vercel.app";
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const results = [];
for (let i = 0; i < 2; i++) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const sizes = new Map();
  page.on("response", async (r) => {
    try {
      const len = Number(r.headers()["content-length"]) || (await r.body()).length;
      sizes.set(r.url(), len);
    } catch {}
  });
  const t0 = Date.now();
  await page.goto(`${base}/en`);
  await page.waitForFunction(() => getComputedStyle(document.querySelector("canvas")).opacity === "1", null, { timeout: 90_000 });
  const ttfg = Date.now() - t0;
  const nav = await page.evaluate(() => { const n = performance.getEntriesByType("navigation")[0]; return { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd) }; });
  const byKind = {};
  for (const [url, len] of sizes) {
    const kind = url.includes("/textures/") ? "textures" : url.includes("/_next/static") ? "js+css" : url.includes("/api/") ? "api" : "other";
    byKind[kind] = (byKind[kind] ?? 0) + len;
  }
  results.push({ ttfg, ...nav, kb: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, Math.round(v / 1024)])) });
  await context.close();
}
console.log(JSON.stringify(results));
await browser.close();
