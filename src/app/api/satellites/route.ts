import { connection } from "next/server";
import { cacheHeaders, fetchUpstream, upstreamError } from "@/lib/http";

/**
 * CelesTrak allows one download per data update (every 2 h) per client, so the
 * site never asks it directly in normal operation: a scheduled GitHub Action
 * (.github/workflows/mirror-celestrak.yml) copies the element sets to the
 * `data` branch, and this route serves that mirror through the CDN.
 */
const MIRROR = "https://raw.githubusercontent.com/ValentynKoval/orbis/data/celestrak/active.tle";
const CELESTRAK = "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle";

export const maxDuration = 30;

export async function GET() {
  await connection();
  let text: string | null = null;
  let source = "mirror";
  try {
    text = await (await fetchUpstream(MIRROR)).text();
  } catch {
    try {
      source = "celestrak";
      text = await (await fetchUpstream(CELESTRAK)).text();
    } catch (err) {
      return upstreamError(err);
    }
  }
  if (!text || !text.includes("\n1 ")) return upstreamError(new Error("Element sets are empty"));
  return new Response(text, {
    headers: cacheHeaders(3600, { "Content-Type": "text/plain; charset=utf-8", "X-Orbis-Source": source }),
  });
}
