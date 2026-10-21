// Captures README screenshots, the Open Graph image and a short video from a
// running site: `node scripts/capture.mjs https://orbis-live.vercel.app`.
// Uses Playwright's Chromium (npx playwright install chromium).
import { chromium, devices } from "@playwright/test";
import { mkdir, rename, readdir, rm } from "node:fs/promises";
import path from "node:path";

const base = process.argv[2] ?? "http://localhost:3300";
const out = path.resolve(import.meta.dirname, "..", "docs", "media");
const args = ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=d3d11", "--enable-unsafe-swiftshader"];
await mkdir(out, { recursive: true });

const ready = (page) => page.waitForFunction(() => getComputedStyle(document.querySelector("canvas")).opacity === "1", null, { timeout: 90_000 });
const settle = (page, ms) => page.waitForTimeout(ms);

const browser = await chromium.launch({ args });
const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "en-GB" });

let page = await desktop.newPage();
await page.goto(`${base}/en`);
await ready(page);
await settle(page, 7000);
await page.screenshot({ path: path.join(out, "landing.jpg"), quality: 86, type: "jpeg" });
await page.setViewportSize({ width: 1200, height: 630 });
await settle(page, 2500);
await page.screenshot({ path: path.resolve(import.meta.dirname, "..", "public", "og.jpg"), quality: 84, type: "jpeg" });

for (const [name, at] of [
  ["europe", "48,12,1.55"],
  ["orbit", "20,-30,11"],
  ["singapore", "1.6,103.9,1.25"],
]) {
  page = await desktop.newPage();
  await page.goto(`${base}/en/live?at=${at}`);
  await ready(page);
  await settle(page, 9000);
  await page.screenshot({ path: path.join(out, `${name}.jpg`), quality: 86, type: "jpeg" });
  await page.close();
}

page = await desktop.newPage();
await page.goto(`${base}/en/live?at=30,0,4.4`);
await ready(page);
await page.getByRole("button", { name: "Search" }).click();
await page.getByPlaceholder("Satellite, flight, ship or place").fill("ISS");
await settle(page, 800);
await page.keyboard.press("Enter");
await settle(page, 6000);
await page.screenshot({ path: path.join(out, "iss.jpg"), quality: 86, type: "jpeg" });
await page.close();

const phone = await browser.newContext({ ...devices["Pixel 7"], locale: "uk-UA" });
page = await phone.newPage();
await page.goto(`${base}/uk/live?at=49,31,2.2`);
await ready(page);
await settle(page, 8000);
await page.screenshot({ path: path.join(out, "phone.jpg"), quality: 86, type: "jpeg" });
await phone.close();

// A short flight for the README: the landing tour, scrolled chapter by chapter.
const videoDir = path.join(out, "raw");
const recorder = await browser.newContext({ viewport: { width: 960, height: 540 }, recordVideo: { dir: videoDir, size: { width: 960, height: 540 } } });
page = await recorder.newPage();
await page.goto(`${base}/en`);
await ready(page);
await settle(page, 5000);
for (let chapter = 0; chapter < 6; chapter++) {
  await page.mouse.wheel(0, 540 * 1.25);
  await settle(page, 3200);
}
await recorder.close();
const [file] = await readdir(videoDir);
await rename(path.join(videoDir, file), path.join(out, "orbis.webm"));
await rm(videoDir, { recursive: true, force: true });

await browser.close();
console.log("saved to", out);
