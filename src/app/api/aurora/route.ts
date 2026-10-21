import { connection } from "next/server";
import sharp from "sharp";
import { cacheHeaders, fetchUpstream, upstreamError } from "@/lib/http";

/**
 * NOAA SWPC OVATION aurora forecast (probability 0–100 on a 1° grid) as an
 * 8-bit greyscale image the globe wraps around the planet, plus the current Kp.
 */
export const maxDuration = 20;

export async function GET() {
  await connection();
  try {
    const [ovation, kp] = await Promise.all([
      fetchUpstream("https://services.swpc.noaa.gov/json/ovation_aurora_latest.json").then((r) => r.json()),
      fetchUpstream("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json")
        .then((r) => r.json())
        .catch(() => null),
    ]);
    const W = 360;
    const H = 181;
    const px = new Uint8Array(W * H);
    for (const [lon, lat, p] of (ovation.coordinates as [number, number, number][]) ?? []) {
      const x = ((Math.round(lon) % 360) + 360) % 360;
      const y = 90 - Math.round(lat);
      if (y >= 0 && y < H) px[y * W + x] = Math.min(255, Math.round(p * 2.55));
    }
    const png = await sharp(Buffer.from(px), { raw: { width: W, height: H, channels: 1 } }).blur(1.2).png().toBuffer();
    const latestKp = Array.isArray(kp) && kp.length > 1 ? Number(kp[kp.length - 1].Kp) : null;
    return new Response(new Uint8Array(png), {
      headers: cacheHeaders(600, {
        "Content-Type": "image/png",
        "X-Orbis-Aurora": JSON.stringify({ forecast: ovation["Forecast Time"], observed: ovation["Observation Time"], kp: latestKp }),
        "Access-Control-Expose-Headers": "X-Orbis-Aurora",
      }),
    });
  } catch (err) {
    return upstreamError(err);
  }
}
