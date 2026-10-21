/**
 * adsb.lol (community ADS-B network, data under ODbL 1.0) → PlaneSnapshot.
 * Its readsb API returns every aircraft in one list. OpenSky would be the
 * natural first choice, but it does not answer requests from cloud networks
 * (Cloudflare, AWS), so the relay cannot reach it.
 */
import { COORD_SCALE, type PlaneSnapshot } from "./live";

export const ADSB_ALL_URL = "https://re-api.adsb.lol/?all";

export interface AdsbAircraft {
  hex: string;
  flight?: string;
  r?: string;
  t?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  alt_geom?: number;
  gs?: number;
  track?: number;
  true_heading?: number;
  baro_rate?: number;
  geom_rate?: number;
  category?: string;
  squawk?: string;
  emergency?: string;
  seen_pos?: number;
}

const FT = 0.3048;
const KT = 0.514444;
const FPM = 0.00508;
/** Positions older than this are dropped: the aircraft has most likely left coverage. */
const MAX_AGE_S = 120;
const EMERGENCY_SQUAWKS = new Set(["7500", "7600", "7700"]);

export function buildPlaneSnapshot(nowS: number, aircraft: AdsbAircraft[]): PlaneSnapshot {
  const snap: PlaneSnapshot = {
    t: Math.round(nowS * 1000),
    ids: [],
    callsign: [],
    reg: [],
    type: [],
    lat: [],
    lon: [],
    alt: [],
    spd: [],
    trk: [],
    vr: [],
    gnd: [],
    age: [],
    cat: [],
    squawk: [],
    emg: [],
  };
  for (const a of aircraft) {
    if (a.lat === undefined || a.lon === undefined || a.seen_pos === undefined || a.seen_pos > MAX_AGE_S) continue;
    // "~" marks non-ICAO (TIS-B / anonymous) addresses; they have no stable identity.
    if (a.hex.startsWith("~")) continue;
    const ground = a.alt_baro === "ground";
    const altFt = a.alt_geom ?? (typeof a.alt_baro === "number" ? a.alt_baro : 0);
    const squawk = a.squawk ?? "";
    snap.ids.push(a.hex);
    snap.callsign.push((a.flight ?? "").trim());
    snap.reg.push(a.r ?? "");
    snap.type.push(a.t ?? "");
    snap.lat.push(Math.round(a.lat * COORD_SCALE));
    snap.lon.push(Math.round(a.lon * COORD_SCALE));
    snap.alt.push(ground ? 0 : Math.max(0, Math.round(altFt * FT)));
    snap.spd.push(Math.round((a.gs ?? 0) * KT * 10));
    snap.trk.push(Math.round((a.track ?? a.true_heading ?? 0) * 10));
    snap.vr.push(Math.round((a.geom_rate ?? a.baro_rate ?? 0) * FPM * 10));
    snap.gnd.push(ground ? 1 : 0);
    snap.age.push(Math.round(a.seen_pos));
    snap.cat.push(a.category ?? "");
    snap.squawk.push(squawk);
    snap.emg.push((a.emergency && a.emergency !== "none") || EMERGENCY_SQUAWKS.has(squawk) ? 1 : 0);
  }
  return snap;
}
