// Builds the real sky: star catalogue, constellation figures and the Milky Way.
//
//   node scripts/build-sky.mjs
//
// Sources (cached in .cache/sky):
// - Stars to magnitude 6 and constellation lines from d3-celestial by Olaf Frohn
//   (BSD 3-clause; data from the Yale Bright Star Catalogue / HYG).
// - The Milky Way from NASA/Goddard SVS "Deep Star Maps 2020" (Gaia DR2, ESA/Gaia/DPAC),
//   the version without the bright stars, in celestial coordinates.
//
// Outputs:
// - public/data/stars.bin: Float32 [ra, dec (radians), brightness 0..1, packed 0xRRGGBB] per star, brightest first.
// - public/data/constellations.json: { id: [[ra, dec], …] segments in degrees, label position }.
// - public/textures/milkyway-{4k,2k}.jpg: equirectangular, RA 0 at the centre increasing to the left.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import * as THREE from "three";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";

const CACHE = ".cache/sky";
const RAW = "https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data";
const SVS = "https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851";
mkdirSync(CACHE, { recursive: true });

async function cached(name, url) {
  const path = `${CACHE}/${name}`;
  if (!existsSync(path)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  return readFileSync(path);
}

/** B−V colour index → approximate RGB of the star (Ballesteros temperature, then a black-body fit). */
function bvToRgb(bv) {
  const b = Math.max(-0.4, Math.min(2, Number.isFinite(bv) ? bv : 0.6));
  const t = 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
  const k = t / 100;
  let r, g, bl;
  if (k <= 66) {
    r = 255;
    g = 99.47 * Math.log(k) - 161.12;
    bl = k <= 19 ? 0 : 138.52 * Math.log(k - 10) - 305.04;
  } else {
    r = 329.7 * Math.pow(k - 60, -0.1332);
    g = 288.12 * Math.pow(k - 60, -0.0755);
    bl = 255;
  }
  const c = (v) => Math.max(0, Math.min(255, Math.round(v)));
  // Pull toward white: the eye sees star colours as pale.
  return [c(r * 0.6 + 102), c(g * 0.6 + 102), c(bl * 0.6 + 102)];
}

// Stars.
const stars = JSON.parse(await cached("stars.6.json", `${RAW}/stars.6.json`)).features;
stars.sort((a, b) => a.properties.mag - b.properties.mag);
const out = new Float32Array(stars.length * 4);
stars.forEach((s, i) => {
  const [ra, dec] = s.geometry.coordinates;
  const mag = s.properties.mag;
  // Brightness for the shader: Sirius (−1.46) → 1, magnitude 6 → ~0.
  const bright = Math.max(0, Math.min(1, Math.pow((6.4 - mag) / 7.9, 1.6)));
  const [r, g, b] = bvToRgb(parseFloat(s.properties.bv));
  out.set([((ra + 360) % 360) * (Math.PI / 180), dec * (Math.PI / 180), bright, r * 65536 + g * 256 + b], i * 4);
});
mkdirSync("public/data", { recursive: true });
writeFileSync("public/data/stars.bin", Buffer.from(out.buffer));
console.log(`stars: ${stars.length}, ${(out.byteLength / 1024).toFixed(0)} KB`);

// Constellation figures, with a label point at the mean of each figure's vertices.
await cached("LICENSE", "https://raw.githubusercontent.com/ofrohn/d3-celestial/master/LICENSE");
const lines = JSON.parse(await cached("constellations.lines.json", `${RAW}/constellations.lines.json`)).features;
const names = JSON.parse(await cached("constellations.json", `${RAW}/constellations.json`)).features;
const figures = {};
for (const f of lines) {
  const name = names.find((n) => n.id === f.id)?.properties;
  const segments = f.geometry.coordinates.map((line) => line.map(([ra, dec]) => [Math.round(((ra + 360) % 360) * 100) / 100, Math.round(dec * 100) / 100]));
  // Label at the vector mean of the vertices (handles figures that cross RA 0).
  let x = 0;
  let y = 0;
  let z = 0;
  for (const line of segments)
    for (const [ra, dec] of line) {
      const a = (ra * Math.PI) / 180;
      const d = (dec * Math.PI) / 180;
      x += Math.cos(d) * Math.cos(a);
      y += Math.cos(d) * Math.sin(a);
      z += Math.sin(d);
    }
  const len = Math.hypot(x, y, z) || 1;
  const label = [Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360 * 100) / 100, Math.round((Math.asin(z / len) * 180) / Math.PI * 100) / 100];
  figures[f.id] = { name: name?.name ?? f.id, rank: Number(name?.rank ?? 3), label, lines: segments };
}
writeFileSync("public/data/constellations.json", JSON.stringify(figures));
console.log(`constellations: ${Object.keys(figures).length}`);

// The Milky Way: HDR → tone-mapped sRGB JPEGs.
const exr = await cached("milkyway_2020_4k.exr", `${SVS}/milkyway_2020_4k.exr`);
const loader = new EXRLoader();
loader.setDataType(THREE.FloatType);
const tex = loader.parse(exr.buffer.slice(exr.byteOffset, exr.byteOffset + exr.byteLength));
const { width, height, data } = tex;
const lum = new Float32Array(width * height);
for (let i = 0; i < width * height; i++) lum[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
const sorted = Float32Array.from(lum).sort();
const white = sorted[Math.floor(sorted.length * 0.9995)] || 1;
const rgb = Buffer.alloc(width * height * 3);
// EXR rows run bottom-up here; write top-down.
for (let y = 0; y < height; y++) {
  const src = tex.flipY === false ? height - 1 - y : y;
  for (let x = 0; x < width; x++) {
    const i = src * width + x;
    for (let c = 0; c < 3; c++) {
      const v = Math.max(0, data[i * 4 + c] / white);
      // Soft shoulder, then sRGB gamma.
      const t = v / (1 + v * 0.6);
      rgb[(y * width + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(Math.pow(t, 1 / 2.2) * 255)));
    }
  }
}
const img = sharp(rgb, { raw: { width, height, channels: 3 } });
await img.clone().jpeg({ quality: 80, mozjpeg: true }).toFile("public/textures/milkyway-4k.jpg");
await img.clone().resize(2048, 1024).jpeg({ quality: 80, mozjpeg: true }).toFile("public/textures/milkyway-2k.jpg");
console.log(`milky way: ${width}×${height}, white point ${white.toExponential(2)}, flipY ${tex.flipY}`);
