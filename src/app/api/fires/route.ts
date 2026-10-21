import { connection } from "next/server";
import { parseFirmsCsv } from "@/lib/feeds/fires";
import { cacheHeaders, fetchUpstream, upstreamError } from "@/lib/http";

// NOAA-20 VIIRS, last 24 h. Public file, no MAP_KEY needed; refreshed by FIRMS every few hours.
const CSV = "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv";

export const maxDuration = 30;

export async function GET() {
  await connection();
  try {
    const csv = await (await fetchUpstream(CSV, {}, 25_000)).text();
    return Response.json({ updated: Date.now(), ...parseFirmsCsv(csv) }, { headers: cacheHeaders(1800) });
  } catch (err) {
    return upstreamError(err);
  }
}
