import { connection } from "next/server";
import { cacheHeaders, fetchUpstream, upstreamError } from "@/lib/http";
import { horizonsUrl, parseHorizonsVectors, SPACECRAFT, type SpacecraftTrack } from "@/lib/feeds/horizons";

/** Deep-space probes from JPL Horizons: a year of positions behind and ahead, refreshed daily. */
export const maxDuration = 60;

export async function GET() {
  await connection();
  const day = 86_400_000;
  const start = new Date(Date.now() - 400 * day).toISOString().slice(0, 10);
  const stop = new Date(Date.now() + 400 * day).toISOString().slice(0, 10);
  try {
    // Horizons refuses parallel requests from one client (503), so one body at a time; a failure skips that body.
    const craft: SpacecraftTrack[] = [];
    for (const s of SPACECRAFT) {
      try {
        const text = await (await fetchUpstream(horizonsUrl(s.id, start, stop, "5d"), {}, 20_000)).text();
        const track = parseHorizonsVectors(text);
        if (track.times.length > 2) craft.push({ ...s, ...track });
      } catch {
        // Try the next one.
      }
    }
    const ok = craft;
    if (!ok.length) throw new Error("Horizons returned no vectors");
    return Response.json({ updated: Date.now(), craft: ok }, { headers: cacheHeaders(86_400) });
  } catch (err) {
    return upstreamError(err);
  }
}
