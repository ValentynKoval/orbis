/**
 * Every feed route is fetched by visitors, never the upstream source: the CDN
 * keeps one copy per region for `sMaxAge` seconds and serves stale data while
 * revalidating or when the source is down. This is what keeps upstream request
 * counts (and our bill) flat regardless of traffic.
 */
export function cacheHeaders(sMaxAge: number, extra: Record<string, string> = {}): HeadersInit {
  const value = `public, max-age=${Math.min(60, sMaxAge)}, s-maxage=${sMaxAge}, stale-while-revalidate=${sMaxAge * 4}, stale-if-error=86400`;
  return {
    "Cache-Control": value,
    "CDN-Cache-Control": value,
    "Access-Control-Allow-Origin": "*",
    ...extra,
  };
}

export const USER_AGENT = "Orbis/1.0 (+https://github.com/ValentynKoval/orbis; non-commercial live globe)";

export async function fetchUpstream(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": USER_AGENT, ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  return res;
}

export function upstreamError(err: unknown): Response {
  const message = err instanceof Error ? err.message : "Upstream unavailable";
  return Response.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
}
