import { connection } from "next/server";
import { cacheHeaders } from "@/lib/http";

/**
 * Active tropical cyclones. GDACS geometry is slow and heavy, so the data workflow condenses it
 * (scripts/storms.mjs) into a few kilobytes on the `data` branch every two hours; this route serves that
 * file through the CDN.
 */
const DATA = "https://raw.githubusercontent.com/ValentynKoval/orbis/data/storms/latest.json";

export async function GET() {
  await connection();
  try {
    const res = await fetch(DATA, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(String(res.status));
    return new Response(await res.text(), { headers: { "Content-Type": "application/json", ...cacheHeaders(900) } });
  } catch {
    return Response.json({ error: "storms unavailable" }, { status: 503, headers: cacheHeaders(120) });
  }
}
