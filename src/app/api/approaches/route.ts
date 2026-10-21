import { connection } from "next/server";
import { cacheHeaders, fetchUpstream, upstreamError } from "@/lib/http";
import { parseApproaches } from "@/lib/feeds/bodies";

/** Asteroids passing within 0.05 AU of Earth over the next 60 days and the previous 7 (NASA/JPL CAD). */
export async function GET() {
  await connection();
  try {
    const from = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    const res = await fetchUpstream(`https://ssd-api.jpl.nasa.gov/cad.api?date-min=${from}&date-max=${to}&dist-max=0.05&sort=date`);
    const json = (await res.json()) as { data?: string[][] };
    return Response.json({ updated: Date.now(), approaches: parseApproaches(json.data ?? []) }, { headers: cacheHeaders(6 * 3600) });
  } catch (err) {
    return upstreamError(err);
  }
}
