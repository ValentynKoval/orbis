// Builds the cloud mask from yesterday's NASA GIBS true-colour mosaic at 8192
// px, then writes 4k and 2k versions. Runs in GitHub Actions every six hours;
// outputs land on the `data` branch. Usage: node scripts/cloud-mask.mjs <outDir>
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { cloudMask, gibsDate } from "../src/lib/feeds/clouds.ts";

const out = process.argv[2] ?? "out/clouds";
const W = 8192;
const H = 4096;
const date = gibsDate();
const month = date.slice(5, 7);
const root = path.resolve(import.meta.dirname, "..");

const params = new URLSearchParams({
  SERVICE: "WMS",
  REQUEST: "GetMap",
  VERSION: "1.3.0",
  LAYERS: "VIIRS_NOAA20_CorrectedReflectance_TrueColor",
  CRS: "EPSG:4326",
  BBOX: "-90,-180,90,180",
  WIDTH: String(W),
  HEIGHT: String(H),
  FORMAT: "image/jpeg",
  TIME: date,
});
console.log("fetching GIBS", date);
const res = await fetch(`https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?${params}`, { signal: AbortSignal.timeout(120_000) });
if (!res.ok) throw new Error(`GIBS ${res.status}`);
const jpeg = Buffer.from(await res.arrayBuffer());
console.log("mosaic", (jpeg.length / 1e6).toFixed(1), "MB");

const grey = (file) => sharp(path.join(root, "public", "textures", file)).resize(W, H).greyscale().raw().toBuffer();
const [rgb, base, fallback] = await Promise.all([
  sharp(jpeg).resize(W, H).removeAlpha().raw().toBuffer(),
  grey(`day-${month}-4k.jpg`),
  grey("clouds-fallback-2k.jpg"),
]);
const mask = Buffer.from(cloudMask(rgb, base, fallback));

await mkdir(out, { recursive: true });
const image = sharp(mask, { raw: { width: W, height: H, channels: 1 } });
await image.clone().resize(4096, 2048, { kernel: "lanczos3" }).jpeg({ quality: 82, mozjpeg: true }).toFile(path.join(out, "latest-4k.jpg"));
await image.clone().resize(2048, 1024, { kernel: "lanczos3" }).jpeg({ quality: 82, mozjpeg: true }).toFile(path.join(out, "latest-2k.jpg"));
await writeFile(path.join(out, "meta.json"), JSON.stringify({ date, generated: new Date().toISOString(), source: "gibs" }));
console.log("written", out);
