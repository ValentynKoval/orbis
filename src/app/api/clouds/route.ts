import { connection } from "next/server";
import { cacheHeaders } from "@/lib/http";

/**
 * Where today's cloud mask lives. The mask itself is built every few hours by
 * the data workflow (scripts/cloud-mask.mjs) and served straight from the
 * `data` branch, so visitors load a static image and no function touches it.
 */
const DATA = "https://raw.githubusercontent.com/ValentynKoval/orbis/data/clouds";

export async function GET() {
  await connection();
  let date: string | null = null;
  try {
    const res = await fetch(`${DATA}/meta.json`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (res.ok) date = ((await res.json()) as { date?: string }).date ?? null;
  } catch {
    // Fall through to the bundled composite.
  }
  const body = date
    ? { date, source: "gibs", urls: { "4k": `${DATA}/latest-4k.jpg`, "2k": `${DATA}/latest-2k.jpg` } }
    : { date: null, source: "blue-marble", urls: { "4k": "/textures/clouds-fallback-2k.jpg", "2k": "/textures/clouds-fallback-2k.jpg" } };
  return Response.json(body, { headers: cacheHeaders(date ? 1800 : 300) });
}
