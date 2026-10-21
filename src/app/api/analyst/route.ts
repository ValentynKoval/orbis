import { createHash } from "node:crypto";
import { connection, type NextRequest } from "next/server";
import { runAnalyst, type AnalystData } from "@/lib/analyst/gemini";
import type { AnalystRequest, AnalystResponse } from "@/lib/analyst/protocol";
import type { PlaneSnapshot, ShipSnapshot } from "@/lib/feeds/live";
import type { Quake } from "@/lib/feeds/quakes";
import type { FireGrid } from "@/lib/feeds/fires";
import { parseTle } from "@/lib/feeds/satellites";

export const maxDuration = 60;

/** Small per-instance caches so a burst of questions doesn't refetch the same snapshots. */
const cache = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${new URL(url).pathname} responded ${res.status}`);
  return res.json() as Promise<T>;
}

const error = (status: number, code: string) => Response.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: NextRequest) {
  await connection();
  const relay = process.env.RELAY_URL;
  const token = process.env.RELAY_TOKEN;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!relay || !token || !apiKey) return error(503, "not_configured");

  let body: AnalystRequest;
  try {
    body = await request.json();
  } catch {
    return error(400, "bad_request");
  }
  const question = typeof body.question === "string" ? body.question.trim().slice(0, 300) : "";
  if (question.length < 2) return error(400, "bad_request");
  const req: AnalystRequest = {
    question,
    locale: body.locale === "uk" ? "uk" : "en",
    view: { lat: Number(body.view?.lat) || 0, lon: Number(body.view?.lon) || 0 },
    history: Array.isArray(body.history)
      ? body.history.slice(-2).map((h) => ({ q: String(h.q).slice(0, 300), a: String(h.a).slice(0, 600) }))
      : [],
  };

  // Daily allowance per visitor, counted by the relay so every server instance agrees.
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const visitor = createHash("sha256").update(`${ip}:${token}`).digest("hex").slice(0, 32);
  const relayHeaders = { "x-orbis-key": token };
  let left = 0;
  try {
    const quota = await getJson<{ ok: boolean; left: number }>(`${relay}/quota/${visitor}`, relayHeaders);
    if (!quota.ok) return error(429, "quota");
    left = quota.left;
  } catch {
    return error(502, "relay");
  }

  const origin = request.nextUrl.origin;
  const data: AnalystData = {
    satellites: () =>
      cached("satellites", 3_600_000, async () => {
        const res = await fetch(`${origin}/api/satellites`, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`satellites ${res.status}`);
        return parseTle(await res.text());
      }),
    planes: () => cached("planes", 60_000, () => getJson<PlaneSnapshot>(`${relay}/planes`, relayHeaders)),
    ships: () =>
      cached("ships", 60_000, async () => {
        const [snap, names] = await Promise.all([
          getJson<ShipSnapshot>(`${relay}/ships`, relayHeaders),
          cached("names", 900_000, () => getJson<{ ids: number[]; names: string[] }>(`${relay}/ships/names`, relayHeaders)),
        ]);
        return { snap, names: new Map(names.ids.map((id, i) => [id, names.names[i]])) };
      }),
    quakes: () => cached("quakes", 60_000, () => getJson<{ quakes: Quake[] }>(`${origin}/api/quakes`).then((d) => d.quakes)),
    fires: () => cached("fires", 600_000, () => getJson<FireGrid>(`${origin}/api/fires`)),
  };

  try {
    const { answer, actions } = await runAnalyst(req, data, { apiKey, model: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite" });
    const payload: AnalystResponse = { answer, actions, left };
    return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("analyst", err instanceof Error ? err.message : err);
    return error(502, "model");
  }
}
