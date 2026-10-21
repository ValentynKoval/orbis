import { gzipSync } from "node:zlib";
import { connection, type NextRequest } from "next/server";
import { cacheHeaders, upstreamError } from "@/lib/http";

/**
 * Proxies the relay (a Cloudflare Worker). workers.dev is blocked by some
 * Ukrainian ISPs, so browsers only ever talk to this site; the CDN caches each
 * path for about as long as the relay takes to refresh it. Bodies are
 * gzipped here because Vercel's free origin-transfer allowance counts what
 * the function returns, before the CDN compresses it.
 */
const ROUTES: [RegExp, number][] = [
  [/^planes$/, 60],
  [/^planes\/[0-9a-f]{6}\/track$/, 60],
  [/^ships$/, 90],
  [/^ships\/names$/, 900],
  [/^ships\/\d{6,9}$/, 60],
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
    const body = gzipSync(Buffer.from(await res.arrayBuffer()), { level: 6 });
    return new Response(new Uint8Array(body), {
      headers: cacheHeaders(route[1], {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Encoding": "gzip",
        Vary: "Accept-Encoding",
      }),
    });
  } catch (err) {
    return upstreamError(err);
  }
}
