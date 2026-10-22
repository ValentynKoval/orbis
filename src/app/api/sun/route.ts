import { connection } from "next/server";
import { cacheHeaders, fetchUpstream, upstreamError } from "@/lib/http";
import { parseSolarWind, SWPC_MAG, SWPC_SPEED } from "@/lib/feeds/sun";

/** The Sun right now: when SDO's latest image was taken and what the solar wind is doing at L1. */
const SDO_LATEST = "https://sdo.gsfc.nasa.gov/assets/img/latest/latest_512_0304.jpg";

export async function GET() {
  await connection();
  try {
    const [speed, mag, head] = await Promise.all([
      fetchUpstream(SWPC_SPEED).then((r) => r.json()).catch(() => null),
      fetchUpstream(SWPC_MAG).then((r) => r.json()).catch(() => null),
      fetchUpstream(SDO_LATEST, { method: "HEAD" }).catch(() => null),
    ]);
    const wind = parseSolarWind(speed, mag);
    const imageAt = head?.ok ? Date.parse(head.headers.get("last-modified") ?? "") : NaN;
    if (!wind && !head?.ok) throw new Error("neither SWPC nor SDO answered");
    return Response.json(
      { updated: Date.now(), wind, image: head?.ok ? { url: "/api/sun/image", at: Number.isFinite(imageAt) ? imageAt : null } : null },
      { headers: cacheHeaders(600) },
    );
  } catch (err) {
    return upstreamError(err);
  }
}
