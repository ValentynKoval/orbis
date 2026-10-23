// Collects the tropical cyclones active now from GDACS into one small file for the storms layer.
// Runs in the data workflow (GDACS geometry is slow and heavy: hundreds of kilobytes per storm), so
// visitors load a few kilobytes of JSON from the data branch.
//
//   node scripts/storms.mjs data/storms

import { mkdir, writeFile } from "node:fs/promises";
import { parseStorm } from "../src/lib/feeds/storms.ts";

const out = process.argv[2] ?? "out/storms";
const API = "https://www.gdacs.org/gdacsapi/api";
const UA = { "User-Agent": "Orbis/1.0 (+https://github.com/ValentynKoval/orbis; non-commercial live globe)", Accept: "application/json" };

// GDACS answers an occasional request with a 400 or a timeout; one retry is usually enough.
const get = async (url, tries = 2) => {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(90_000) }).catch((err) => ({ ok: false, status: err.name }));
  if (res.ok) return res.json();
  if (tries > 1) return get(url, tries - 1);
  throw new Error(`${res.status} ${url}`);
};

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const list = await get(`${API}/events/geteventlist/SEARCH?eventlist=TC&alertlevel=green;orange;red&fromdate=${day(Date.now() - 21 * 86_400_000)}&todate=${day(Date.now() + 86_400_000)}`);
const current = (list.features ?? []).map((f) => f.properties).filter((p) => p.iscurrent === "true");
const storms = [];
for (const event of current) {
  try {
    const storm = parseStorm(event, await get(event.url.geometry));
    if (storm) storms.push(storm);
  } catch (err) {
    console.log(`${event.eventname}: ${err.message}`);
  }
}
// A failed run never replaces a good file with an empty one.
if (current.length && !storms.length) throw new Error("no storm geometry could be read");
await mkdir(out, { recursive: true });
await writeFile(`${out}/latest.json`, JSON.stringify({ updated: new Date().toISOString(), storms }));
console.log(`storms: ${storms.map((s) => s.name).join(", ") || "none active"}`);
