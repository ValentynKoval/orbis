/**
 * Answers for the live paths that do not need the relay: ships always come
 * from the on-demand AIS sampler, and aircraft come straight from adsb.lol
 * when the relay is down (a deploy, an outage, a spent Cloudflare quota).
 * Aircraft are held for a minute per server instance; the CDN caches both.
 */
import { fetchUpstream } from "../http";
import { ADSB_ALL_URL, buildPlaneSnapshot, type AdsbAircraft } from "./adsb";
import { sampledShips } from "./aisSampler";

const HOLD_MS = 60_000;
let planes: { at: number; json: Promise<string> } | null = null;

export function fallbackPlanes(): Promise<string> {
  if (!planes || Date.now() - planes.at > HOLD_MS) {
    const json = (async () => {
      const res = await fetchUpstream(ADSB_ALL_URL, { headers: { "Accept-Encoding": "gzip" } }, 25_000);
      const data = (await res.json()) as { now: number; aircraft: AdsbAircraft[] };
      return JSON.stringify(buildPlaneSnapshot(data.now, data.aircraft));
    })();
    planes = { at: Date.now(), json };
    json.catch(() => (planes = null));
  }
  return planes.json;
}

/** Ship paths, answered here rather than by the relay. Null for anything else or an unknown vessel. */
export async function shipsFor(path: string): Promise<string | null> {
  if (path === "ships") return JSON.stringify((await sampledShips()).snapshot(Date.now()));
  if (path === "ships/names") return JSON.stringify((await sampledShips()).names());
  const ship = path.match(/^ships\/(\d{6,9})$/);
  if (ship) {
    const detail = (await sampledShips()).detail(Number(ship[1]));
    return detail ? JSON.stringify(detail) : null;
  }
  return null;
}

/** The fallback answer for a relay path, or null when there is none (the caller reports the error). */
export async function fallbackFor(path: string): Promise<string | null> {
  if (path === "planes") return fallbackPlanes();
  const track = path.match(/^planes\/([0-9a-f]{6})\/track$/);
  if (track) return JSON.stringify({ id: track[1], track: [] });
  // No recorded history without the relay: the timeline simply shows none.
  if (path === "history") return JSON.stringify({ planes: [], ships: [] });
  return null;
}
