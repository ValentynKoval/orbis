/**
 * Ships, sampled on demand: when the ships route is asked and the last listen
 * is over 90 s old, this server instance listens to the aisstream.io firehose
 * for a few seconds and folds what it heard into a store it keeps between
 * requests. The CDN in front (stale-while-revalidate) means visitors almost
 * never wait for a listen, and a warm instance builds up thousands of vessels.
 *
 * Each listen's catch is posted to the relay, which keeps the sum across
 * instances; a cold instance starts from the relay's store (or, when the relay
 * is down, from the AIS workflow's snapshot if it is recent).
 *
 * Why not a socket in the relay: an always-open socket in a Durable Object
 * counts every incoming message as a request and exhausts Cloudflare's free
 * tier. Why not only the GitHub Action: scheduled workflows run hours apart.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import { fetchUpstream } from "../http";
import { parseAisMessage, ShipStore, type PositionUpdate, type ShipUpdates, type StaticUpdate } from "./ships";

const AIS_URL = "wss://stream.aisstream.io/v0/stream";
export const SHIPS_SNAPSHOT_URL = "https://github.com/ValentynKoval/orbis/releases/download/ais/ships.json.gz";
const LISTEN_EVERY_MS = 90_000;
/** A cold store listens longer so the first answer is not sparse. */
const LISTEN_COLD_MS = 15_000;
const LISTEN_WARM_MS = 7_000;
const SEED_MAX_AGE_S = 3600;

const store = new ShipStore();
let lastListen = 0;
let listening: Promise<void> | null = null;
let seeding: Promise<void> | null = null;

function relay(): { base: string; token: string } | null {
  const base = process.env.RELAY_URL;
  const token = process.env.RELAY_TOKEN;
  return base && token ? { base, token } : null;
}

/** Starts a cold store from the relay's, or from the workflow's snapshot when it is under an hour old. */
function seed(): Promise<void> {
  seeding ??= (async () => {
    const r = relay();
    if (r) {
      try {
        const res = await fetch(`${r.base}/ships/dump`, { headers: { "x-orbis-key": r.token }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
        if (res.ok) {
          store.apply((await res.json()) as ShipUpdates);
          if (store.size > 1000) return;
        }
      } catch {
        // Try the workflow's snapshot.
      }
    }
    const res = await fetchUpstream(SHIPS_SNAPSHOT_URL, {}, 15_000);
    const snapshot = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8")) as {
      t1: number;
      positions: PositionUpdate[];
      statics: StaticUpdate[];
    };
    if (Date.now() / 1000 - snapshot.t1 > SEED_MAX_AGE_S) return;
    for (const p of snapshot.positions) store.position(p);
    for (const s of snapshot.statics) store.static(s);
  })().catch(() => undefined);
  return seeding;
}

/** Hands one listen's catch to the relay; best effort. */
async function share(updates: ShipUpdates) {
  const r = relay();
  if (!r || !updates.positions.length) return;
  try {
    await fetch(`${r.base}/ships/ingest`, {
      method: "POST",
      headers: { "x-orbis-key": r.token, "Content-Type": "application/json", "Content-Encoding": "gzip" },
      body: new Uint8Array(gzipSync(Buffer.from(JSON.stringify(updates)))),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // The relay is down; the next listen tries again.
  }
}

function listen(apiKey: string, ms: number): Promise<ShipUpdates> {
  const heard: ShipUpdates = { positions: [], statics: [] };
  return new Promise((resolve) => {
    let done = false;
    const ws = new WebSocket(AIS_URL);
    ws.binaryType = "arraybuffer";
    const decoder = new TextDecoder();
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Already closed.
      }
      resolve(heard);
    };
    const timer = setTimeout(finish, ms);
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          APIKey: apiKey,
          BoundingBoxes: [
            [
              [-90, -180],
              [90, 180],
            ],
          ],
          FilterMessageTypes: ["PositionReport", "StandardClassBPositionReport", "ShipStaticData"],
        }),
      );
    });
    ws.addEventListener("message", (event) => {
      const data = event.data as unknown;
      const raw = typeof data === "string" ? data : data instanceof ArrayBuffer ? decoder.decode(data) : "";
      const parsed = raw ? parseAisMessage(raw) : null;
      if (parsed?.position) {
        store.position(parsed.position);
        heard.positions.push(parsed.position);
      }
      if (parsed?.static) {
        store.static(parsed.static);
        heard.statics.push(parsed.static);
      }
    });
    ws.addEventListener("close", finish);
    ws.addEventListener("error", finish);
  });
}

/** The store, refreshed by a short listen when due. Without a key it only holds the workflow's snapshot. */
export async function sampledShips(): Promise<ShipStore> {
  const apiKey = process.env.AISSTREAM_API_KEY;
  if (store.size === 0) await seed();
  const now = Date.now();
  if (apiKey && !listening && now - lastListen > LISTEN_EVERY_MS) {
    const ms = store.size > 4000 ? LISTEN_WARM_MS : LISTEN_COLD_MS;
    listening = listen(apiKey, ms)
      .then(share)
      .finally(() => {
        lastListen = Date.now();
        listening = null;
      });
  }
  if (listening) await listening;
  store.prune(Math.floor(Date.now() / 1000));
  return store;
}
