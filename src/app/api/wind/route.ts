import { connection } from "next/server";
import { cacheHeaders } from "@/lib/http";

/**
 * Where the current wind field lives. The data workflow decodes NOAA GFS 10 m
 * wind every cycle (scripts/wind-field.mjs) and commits a small PNG to the
 * `data` branch, so visitors load a static image and no function decodes GRIB.
 */
const DATA = "https://raw.githubusercontent.com/ValentynKoval/orbis/data/wind";

export async function GET() {
  await connection();
  try {
    const res = await fetch(`${DATA}/meta.json`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(String(res.status));
    const meta = (await res.json()) as { cycle: string; range: number };
    // The cycle in the URL busts caches when a new field lands.
    return Response.json({ cycle: meta.cycle, range: meta.range, url: `${DATA}/latest.png?c=${Date.parse(meta.cycle)}` }, { headers: cacheHeaders(1800) });
  } catch {
    return Response.json({ error: "wind field unavailable" }, { status: 503, headers: cacheHeaders(120) });
  }
}
