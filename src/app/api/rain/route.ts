import { connection } from "next/server";
import { cacheHeaders, fetchUpstream, upstreamError } from "@/lib/http";

/** The newest RainViewer radar frame (free for non-commercial use with attribution); tiles load straight from their CDN. */
export async function GET() {
  await connection();
  try {
    const json = (await (await fetchUpstream("https://api.rainviewer.com/public/weather-maps.json")).json()) as {
      host: string;
      radar: { past: { time: number; path: string }[] };
    };
    const latest = json.radar.past.at(-1);
    if (!latest) throw new Error("no radar frames");
    return Response.json({ host: json.host, path: latest.path, time: latest.time * 1000 }, { headers: cacheHeaders(300) });
  } catch (err) {
    return upstreamError(err);
  }
}
