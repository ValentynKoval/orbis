// Builds the wind layer's texture from NOAA GFS: 10 m wind on the 1° grid, the newest cycle NOMADS has.
// Runs in the data workflow; writes <outDir>/latest.png (R = u, G = v, ±40 m/s mapped to 0…255, rows from
// 90° N to 90° S, columns from 0° E eastward) and <outDir>/meta.json.
//
//   node scripts/wind-field.mjs data/wind

import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { readGrib2 } from "../src/lib/grib2.ts";

const out = process.argv[2] ?? "out/wind";
const RANGE = 40;

/** GFS cycles run at 00, 06, 12 and 18 UTC and appear on NOMADS about four hours later. */
function cycles() {
  const list = [];
  const t = new Date(Date.now() - 4 * 3_600_000);
  t.setUTCMinutes(0, 0, 0);
  t.setUTCHours(t.getUTCHours() - (t.getUTCHours() % 6));
  for (let i = 0; i < 4; i++) list.push(new Date(t.getTime() - i * 6 * 3_600_000));
  return list;
}

let field = null;
let cycle = null;
for (const c of cycles()) {
  const day = c.toISOString().slice(0, 10).replaceAll("-", "");
  const hh = String(c.getUTCHours()).padStart(2, "0");
  const params = new URLSearchParams({
    dir: `/gfs.${day}/${hh}/atmos`,
    file: `gfs.t${hh}z.pgrb2.1p00.f000`,
    var_UGRD: "on",
    var_VGRD: "on",
    lev_10_m_above_ground: "on",
  });
  const res = await fetch(`https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl?${params}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    console.log(`cycle ${day} ${hh}z: ${res.status}`);
    continue;
  }
  const fields = readGrib2(new Uint8Array(await res.arrayBuffer()));
  const u = fields.find((f) => f.category === 2 && f.number === 2);
  const v = fields.find((f) => f.category === 2 && f.number === 3);
  // The global grid runs north to south from 0° E; the texture depends on that order.
  if (u && v && u.la1 === 90 && u.lo1 === 0) {
    field = { u, v };
    cycle = c;
    break;
  }
}
if (!field) throw new Error("no GFS cycle available");

const { u, v } = field;
const px = Buffer.alloc(u.ni * u.nj * 3);
const enc = (x) => Math.max(0, Math.min(255, Math.round(((x + RANGE) / (2 * RANGE)) * 255)));
for (let i = 0; i < u.ni * u.nj; i++) {
  px[i * 3] = enc(u.values[i]);
  px[i * 3 + 1] = enc(v.values[i]);
}
await mkdir(out, { recursive: true });
await sharp(px, { raw: { width: u.ni, height: u.nj, channels: 3 } }).png({ compressionLevel: 9 }).toFile(`${out}/latest.png`);
await writeFile(`${out}/meta.json`, JSON.stringify({ cycle: cycle.toISOString(), source: "NOAA GFS 1°, 10 m wind", range: RANGE, width: u.ni, height: u.nj }));
console.log(`wind ${cycle.toISOString()} ${u.ni}×${u.nj}`);
