import { connection, type NextRequest } from "next/server";
import { cacheHeaders, upstreamError } from "@/lib/http";

/**
 * Proxies the relay (a Cloudflare Worker). workers.dev is blocked by some
 * Ukrainian ISPs, so browsers only ever talk to this site; the CDN caches each
 * path so the relay sees a handful of requests per minute whatever the traffic.
 */
const ROUTES: [RegExp, number][] = [
  [/^planes$/, 20],
  [/^planes\/[0-9a-f]{6}\/track$/, 30],
  [/^ships$/, 30],
  [/^ships\/names$/, 600],
  [/^ships\/\d{6,9}$/, 30],
];

export const maxDuration = 20;

export async function GET(_request: NextRequest, { params }: RouteContext<"/api/live/[...path]">) {
  await connection();
  const path = (await params).path.join("/");
  const route = ROUTES.find(([re]) => re.test(path));
  if (!route) return Response.json({ error: "Not found" }, { status: 404 });
  const base = process.env.RELAY_URL;
  const token = process.env.RELAY_TOKEN;
  if (!base || !token) return upstreamError(new Error("Relay is not configured"));
  try {
    const res = await fetch(`${base}/${path}`, {
      headers: { "x-orbis-key": token },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return Response.json({ error: "Not found" }, { status: 404, headers: cacheHeaders(30) });
    if (!res.ok) throw new Error(`relay responded ${res.status}`);
    return new Response(res.body, { headers: cacheHeaders(route[1], { "Content-Type": "application/json; charset=utf-8" }) });
  } catch (err) {
    return upstreamError(err);
  }
}
