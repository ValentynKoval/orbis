import { COORD_SCALE, shipKind, type ShipDetail, type ShipSnapshot } from "../../src/lib/feeds/live";

/** A vessel not heard from in this long is dropped from the map. */
const STALE_S = 3600;
/** Track points are sampled at most this often… */
const TRACK_STEP_S = 150;
/** …and at most this many are kept (~4 h). */
const TRACK_POINTS = 96;

interface Vessel {
  mmsi: number;
  lat: number;
  lon: number;
  sog: number;
  cog: number;
  heading: number | null;
  /** Unix seconds of the last position. */
  t: number;
  name: string;
  callsign: string;
  destination: string;
  type: number;
  lengthM: number;
  imo: number;
  /** Flat [t, lat, lon, …]. */
  track: number[];
}

export interface PositionUpdate {
  mmsi: number;
  lat: number;
  lon: number;
  sog: number;
  cog: number;
  heading: number | null;
  t: number;
  name?: string;
}

export interface StaticUpdate {
  mmsi: number;
  name: string;
  callsign: string;
  destination: string;
  type: number;
  lengthM: number;
  imo: number;
}

const clean = (s: unknown) => (typeof s === "string" ? s.replace(/@+/g, "").trim() : "");

/** Parses one aisstream.io message. Returns null for anything we don't use. */
export function parseAisMessage(raw: string): { position?: PositionUpdate; static?: StaticUpdate } | null {
  let msg: {
    MessageType: string;
    MetaData?: { MMSI: number; ShipName?: string; time_utc?: string };
    Message?: Record<string, Record<string, unknown>>;
  };
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  const meta = msg.MetaData;
  const body = msg.Message?.[msg.MessageType];
  if (!meta || !body) return null;
  const name = clean(meta.ShipName);
  if (msg.MessageType === "PositionReport" || msg.MessageType === "StandardClassBPositionReport") {
    const lat = Number(body.Latitude);
    const lon = Number(body.Longitude);
    // 91/181 are the AIS "not available" values.
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const heading = Number(body.TrueHeading);
    const cog = Number(body.Cog);
    const sog = Number(body.Sog);
    const t = meta.time_utc ? Math.floor(Date.parse(meta.time_utc.slice(0, 19).replace(" ", "T") + "Z") / 1000) : Math.floor(Date.now() / 1000);
    return {
      position: {
        mmsi: meta.MMSI,
        lat,
        lon,
        sog: Number.isFinite(sog) && sog < 102.3 ? sog : 0,
        cog: Number.isFinite(cog) && cog < 360 ? cog : 0,
        heading: Number.isFinite(heading) && heading < 360 ? heading : null,
        t: Number.isFinite(t) ? t : Math.floor(Date.now() / 1000),
        name: name || undefined,
      },
    };
  }
  if (msg.MessageType === "ShipStaticData") {
    const dim = (body.Dimension ?? {}) as { A?: number; B?: number };
    return {
      static: {
        mmsi: meta.MMSI,
        name: clean(body.Name) || name,
        callsign: clean(body.CallSign),
        destination: clean(body.Destination),
        type: Number(body.Type) || 0,
        lengthM: (dim.A ?? 0) + (dim.B ?? 0),
        imo: Number(body.ImoNumber) || 0,
      },
    };
  }
  return null;
}

export class ShipStore {
  private vessels = new Map<number, Vessel>();

  get size() {
    return this.vessels.size;
  }

  private vessel(mmsi: number): Vessel {
    let v = this.vessels.get(mmsi);
    if (!v) {
      v = { mmsi, lat: 0, lon: 0, sog: 0, cog: 0, heading: null, t: 0, name: "", callsign: "", destination: "", type: 0, lengthM: 0, imo: 0, track: [] };
      this.vessels.set(mmsi, v);
    }
    return v;
  }

  position(u: PositionUpdate) {
    const v = this.vessel(u.mmsi);
    if (u.t < v.t) return;
    v.lat = u.lat;
    v.lon = u.lon;
    v.sog = u.sog;
    v.cog = u.cog;
    v.heading = u.heading;
    v.t = u.t;
    if (u.name && !v.name) v.name = u.name;
    const n = v.track.length;
    if (n === 0 || u.t - v.track[n - 3] >= TRACK_STEP_S) {
      v.track.push(u.t, Math.round(u.lat * COORD_SCALE) / COORD_SCALE, Math.round(u.lon * COORD_SCALE) / COORD_SCALE);
      if (v.track.length > TRACK_POINTS * 3) v.track.splice(0, v.track.length - TRACK_POINTS * 3);
    }
  }

  static(u: StaticUpdate) {
    const v = this.vessel(u.mmsi);
    if (u.name) v.name = u.name;
    v.callsign = u.callsign || v.callsign;
    v.destination = u.destination || v.destination;
    v.type = u.type || v.type;
    v.lengthM = u.lengthM || v.lengthM;
    v.imo = u.imo || v.imo;
  }

  prune(nowS: number) {
    for (const [mmsi, v] of this.vessels) {
      if (nowS - v.t > STALE_S) this.vessels.delete(mmsi);
    }
  }

  snapshot(nowMs: number): ShipSnapshot {
    const nowS = Math.floor(nowMs / 1000);
    const snap: ShipSnapshot = { t: nowMs, ids: [], lat: [], lon: [], sog: [], cog: [], kind: [], age: [] };
    for (const v of this.vessels.values()) {
      if (!v.t || nowS - v.t > STALE_S) continue;
      snap.ids.push(v.mmsi);
      snap.lat.push(Math.round(v.lat * COORD_SCALE));
      snap.lon.push(Math.round(v.lon * COORD_SCALE));
      snap.sog.push(Math.round(v.sog * 10));
      snap.cog.push(Math.round(v.cog * 10));
      snap.kind.push(shipKind(v.type));
      snap.age.push(Math.max(0, nowS - v.t));
    }
    return snap;
  }

  names(): { ids: number[]; names: string[] } {
    const ids: number[] = [];
    const names: string[] = [];
    for (const v of this.vessels.values()) {
      if (!v.name || !v.t) continue;
      ids.push(v.mmsi);
      names.push(v.name);
    }
    return { ids, names };
  }

  detail(mmsi: number): ShipDetail | null {
    const v = this.vessels.get(mmsi);
    if (!v || !v.t) return null;
    return {
      mmsi: v.mmsi,
      name: v.name,
      callsign: v.callsign,
      destination: v.destination,
      kind: shipKind(v.type),
      type: v.type,
      lengthM: v.lengthM,
      imo: v.imo,
      lat: v.lat,
      lon: v.lon,
      sog: v.sog,
      cog: v.cog,
      heading: v.heading,
      t: v.t,
      track: v.track,
    };
  }

}
