import { connection } from "next/server";
import { parseUsgs } from "@/lib/feeds/quakes";
import { cacheHeaders, fetchUpstream, upstreamError } from "@/lib/http";

const FEED = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary";

export async function GET() {
  await connection();
  try {
    // Every quake of the last day, plus M4.5+ of the week so quiet days still show the big picture.
    const [day, week] = await Promise.all([
      fetchUpstream(`${FEED}/all_day.geojson`).then((r) => r.json()),
      fetchUpstream(`${FEED}/4.5_week.geojson`).then((r) => r.json()),
    ]);
    return Response.json({ updated: Date.now(), quakes: parseUsgs(day, week) }, { headers: cacheHeaders(60) });
  } catch (err) {
    return upstreamError(err);
  }
}
