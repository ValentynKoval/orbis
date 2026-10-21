// Downloads public-domain source imagery (NASA Blue Marble NG, Black Marble 2016,
// Natural Earth) into .cache/ and writes the web-ready textures and vector data
// into public/. Run once after cloning: `npm run assets`. Outputs are committed,
// so this is only needed when the pipeline itself changes.
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE = path.join(ROOT, ".cache", "assets");
const TEX = path.join(ROOT, "public", "textures");
const DATA = path.join(ROOT, "public", "data");

const NASA = "https://eoimages.gsfc.nasa.gov/images/imagerecords";
const BLUE_MARBLE_RECORDS = [73580, 73605, 73630, 73655, 73701, 73726, 73751, 73776, 73801, 73826, 73884, 73909];
const NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson";

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function download(url, name) {
  const file = path.join(CACHE, name);
  if (await exists(file)) return file;
  process.stdout.write(`  downloading ${name}… `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  console.log("ok");
  return file;
}

async function dayTextures() {
  for (let m = 0; m < 12; m++) {
    const mm = String(m + 1).padStart(2, "0");
    const src = await download(
      `${NASA}/73000/${BLUE_MARBLE_RECORDS[m]}/world.topo.bathy.2004${mm}.3x5400x2700.jpg`,
      `bmng-${mm}.jpg`,
    );
    await sharp(src).resize(4096, 2048).jpeg({ quality: 84, mozjpeg: true }).toFile(path.join(TEX, `day-${mm}-4k.jpg`));
    await sharp(src).resize(2048, 1024).jpeg({ quality: 84, mozjpeg: true }).toFile(path.join(TEX, `day-${mm}-2k.jpg`));
  }
}

async function nightTextures() {
  const src = await download(`${NASA}/144000/144898/BlackMarble_2016_3km.jpg`, "black-marble-3km.jpg");
  // Night lights are only ever used as an emissive mask, so one luminance channel is enough.
  for (const [w, h, tag] of [
    [4096, 2048, "4k"],
    [2048, 1024, "2k"],
  ]) {
    await sharp(src)
      .resize(w, h)
      .grayscale()
      .linear(1.15, -12)
      .jpeg({ quality: 82, mozjpeg: true })
      .toFile(path.join(TEX, `night-${tag}.jpg`));
  }
}

async function fallbackClouds() {
  const src = await download(`${NASA}/57000/57747/cloud_combined_2048.jpg`, "clouds-2048.jpg");
  await sharp(src).grayscale().jpeg({ quality: 80, mozjpeg: true }).toFile(path.join(TEX, "clouds-fallback-2k.jpg"));
}

/** Equirectangular projection of [lon, lat] rings into an SVG path. */
function ringsToPath(rings, w, h) {
  let d = "";
  for (const ring of rings) {
    ring.forEach(([lon, lat], i) => {
      const x = ((lon + 180) / 360) * w;
      const y = ((90 - lat) / 180) * h;
      d += `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    });
    d += "Z";
  }
  return d;
}

function polygonsOf(geojson) {
  const out = [];
  for (const f of geojson.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "Polygon") out.push(g.coordinates);
    if (g.type === "MultiPolygon") out.push(...g.coordinates);
  }
  return out;
}

async function waterMask() {
  const land = JSON.parse(await readFile(await download(`${NE}/ne_50m_land.geojson`, "ne_50m_land.geojson"), "utf8"));
  const lakes = JSON.parse(await readFile(await download(`${NE}/ne_50m_lakes.geojson`, "ne_50m_lakes.geojson"), "utf8"));
  const w = 4096;
  const h = 2048;
  const landPath = polygonsOf(land).map((p) => ringsToPath(p, w, h)).join("");
  const lakePath = polygonsOf(lakes).map((p) => ringsToPath(p, w, h)).join("");
  // White = water (specular), black = land.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="#fff"/>
    <path d="${landPath}" fill="#000" fill-rule="nonzero"/>
    <path d="${lakePath}" fill="#fff" fill-rule="nonzero"/>
  </svg>`;
  await sharp(Buffer.from(svg))
    .resize(2048, 1024)
    .blur(0.6)
    .grayscale()
    .png({ compressionLevel: 9, palette: true, colors: 16 })
    .toFile(path.join(TEX, "water-2k.png"));
}

/** Quantised polylines: [[lon*100, lat*100, …], …] keeps the file small and gzip-friendly. */
function quantiseLines(geojson) {
  const lines = [];
  for (const f of geojson.features) {
    const g = f.geometry;
    if (!g) continue;
    const parts = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    for (const part of parts) {
      const flat = [];
      for (const [lon, lat] of part) flat.push(Math.round(lon * 100), Math.round(lat * 100));
      if (flat.length >= 4) lines.push(flat);
    }
  }
  return lines;
}

async function borders() {
  const b = JSON.parse(
    await readFile(
      await download(`${NE}/ne_50m_admin_0_boundary_lines_land.geojson`, "ne_50m_borders.geojson"),
      "utf8",
    ),
  );
  const c = JSON.parse(await readFile(await download(`${NE}/ne_50m_coastline.geojson`, "ne_50m_coastline.geojson"), "utf8"));
  await writeFile(
    path.join(DATA, "borders.json"),
    JSON.stringify({ borders: quantiseLines(b), coast: quantiseLines(c) }),
  );
}

await mkdir(CACHE, { recursive: true });
await mkdir(TEX, { recursive: true });
await mkdir(DATA, { recursive: true });
console.log("day textures");
await dayTextures();
console.log("night lights");
await nightTextures();
console.log("fallback clouds");
await fallbackClouds();
console.log("water mask");
await waterMask();
console.log("borders");
await borders();
console.log("done");
