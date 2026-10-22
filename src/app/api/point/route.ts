import { connection, type NextRequest } from "next/server";
import sharp from "sharp";
import { cacheHeaders, fetchUpstream, upstreamError } from "@/lib/http";
import { decodeTerrarium, tileUv } from "@/lib/terrain";
import { tileAt } from "@/lib/tiles";

/**
 * Everything about one spot on the Earth, for the card that opens when the
 * globe is tapped where there is no object: its name (OpenStreetMap
 * Nominatim, used within its policy: one request per spot, cached, with a
 * descriptive User-Agent), ground elevation (Copernicus DEM via Open-Meteo),
 * the local time zone, today's sunrise and sunset, and the weather now. At
 * sea the depth comes from the bathymetry in the Terrarium elevation tiles.
 */
async function oceanDepth(lat: number, lon: number): Promise<number | null> {
  const z = 9;
  const { x, y } = tileAt(z, lat, lon);
  const png = Buffer.from(await (await fetchUpstream(`https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`, {}, 8000)).arrayBuffer());
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { u, v } = tileUv(z, x, y, lat, lon);
  const px = Math.min(info.width - 1, Math.max(0, Math.round(u * (info.width - 1))));
  const py = Math.min(info.height - 1, Math.max(0, Math.round((1 - v) * (info.height - 1))));
  const k = (py * info.width + px) * info.channels;
  const h = decodeTerrarium(data[k], data[k + 1], data[k + 2]);
  return h < 0 ? Math.round(h) : null;
}
export interface PointInfo {
  lat: number;
  lon: number;
  name: string | null;
  country: string | null;
  elevationM: number | null;
  /** Below sea level at sea, metres (negative), when the spot is open water. */
  depthM: number | null;
  timeZone: string | null;
  utcOffsetS: number | null;
  sunrise: string | null;
  sunset: string | null;
  temperature: number | null;
  weatherCode: number | null;
  wind: number | null;
}

export async function GET(request: NextRequest) {
  await connection();
  const q = request.nextUrl.searchParams;
  const lat = Number(q.get("lat"));
  const lon = Number(q.get("lon"));
  const lang = q.get("lang") === "uk" ? "uk" : "en";
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return Response.json({ error: "lat and lon required" }, { status: 400 });
  }
  // Two decimals (about a kilometre) keep the cache useful and the request anonymous.
  const la = lat.toFixed(2);
  const lo = lon.toFixed(2);
  try {
    const [place, weather, ground] = await Promise.all([
      fetchUpstream(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${la}&lon=${lo}&zoom=10&accept-language=${lang}`, {}, 8000)
        .then((r) => r.json() as Promise<{ name?: string; display_name?: string; address?: Record<string, string> }>)
        .catch(() => null),
      fetchUpstream(
        `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&timezone=auto&forecast_days=1&current=temperature_2m,weather_code,wind_speed_10m&daily=sunrise,sunset`,
        {},
        8000,
      )
        .then(
          (r) =>
            r.json() as Promise<{
              timezone?: string;
              utc_offset_seconds?: number;
              current?: { temperature_2m?: number; weather_code?: number; wind_speed_10m?: number };
              daily?: { sunrise?: string[]; sunset?: string[] };
            }>,
        )
        .catch(() => null),
      fetchUpstream(`https://api.open-meteo.com/v1/elevation?latitude=${la}&longitude=${lo}`, {}, 8000)
        .then((r) => r.json() as Promise<{ elevation?: number[] }>)
        .catch(() => null),
    ]);
    const a = place?.address ?? {};
    const name = a.city || a.town || a.village || a.municipality || a.county || a.state || place?.name || null;
    const elevationM = ground?.elevation?.[0] ?? null;
    const depthM = !elevationM ? await oceanDepth(lat, lon).catch(() => null) : null;
    const info: PointInfo = {
      lat,
      lon,
      name: name ?? null,
      country: a.country ?? null,
      elevationM,
      depthM,
      timeZone: weather?.timezone ?? null,
      utcOffsetS: weather?.utc_offset_seconds ?? null,
      sunrise: weather?.daily?.sunrise?.[0] ?? null,
      sunset: weather?.daily?.sunset?.[0] ?? null,
      temperature: weather?.current?.temperature_2m ?? null,
      weatherCode: weather?.current?.weather_code ?? null,
      wind: weather?.current?.wind_speed_10m ?? null,
    };
    if (!place && !weather && !ground) throw new Error("no source answered");
    return Response.json(info, { headers: cacheHeaders(900) });
  } catch (err) {
    return upstreamError(err);
  }
}
