/**
 * Data tools for the AI analyst, as pure functions over the same snapshots
 * the globe shows. The route feeds them live data; tests feed them fixtures.
 */
import { COORD_SCALE, type PlaneSnapshot, type ShipSnapshot } from "../feeds/live";
import type { Quake } from "../feeds/quakes";
import type { FireGrid } from "../feeds/fires";

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Inclusive; handles boxes that cross the antimeridian (west > east). */
export function inBox(lat: number, lon: number, box?: BBox): boolean {
  if (!box) return true;
  if (lat < box.south || lat > box.north) return false;
  return box.west <= box.east ? lon >= box.west && lon <= box.east : lon >= box.west || lon <= box.east;
}

const clampLimit = (n: unknown, max = 10) => Math.max(1, Math.min(max, Math.round(Number(n) || 5)));

export interface AircraftQuery {
  bbox?: BBox;
  sort_by?: "altitude" | "speed" | "climb" | "descent";
  limit?: number;
  include_ground?: boolean;
}

export function queryAircraft(snap: PlaneSnapshot, q: AircraftQuery) {
  const idx: number[] = [];
  for (let i = 0; i < snap.ids.length; i++) {
    if (!q.include_ground && snap.gnd[i]) continue;
    if (!inBox(snap.lat[i] / COORD_SCALE, snap.lon[i] / COORD_SCALE, q.bbox)) continue;
    idx.push(i);
  }
  const key: Record<string, (i: number) => number> = {
    altitude: (i) => snap.alt[i],
    speed: (i) => snap.spd[i],
    climb: (i) => snap.vr[i],
    descent: (i) => -snap.vr[i],
  };
  const by = key[q.sort_by ?? "altitude"] ?? key.altitude;
  idx.sort((a, b) => by(b) - by(a));
  return {
    matched: idx.length,
    data_time_utc: new Date(snap.t).toISOString(),
    aircraft: idx.slice(0, clampLimit(q.limit)).map((i) => ({
      id: snap.ids[i],
      callsign: snap.callsign[i] || null,
      registration: snap.reg[i] || null,
      type: snap.type[i] || null,
      lat: snap.lat[i] / COORD_SCALE,
      lon: snap.lon[i] / COORD_SCALE,
      altitude_m: snap.alt[i],
      speed_kmh: Math.round((snap.spd[i] / 10) * 3.6),
      vertical_rate_ms: snap.vr[i] / 10,
      on_ground: !!snap.gnd[i],
      emergency: !!snap.emg[i],
    })),
  };
}

export const SHIP_KIND_NAMES = ["other", "cargo", "tanker", "passenger", "fishing", "leisure", "service"] as const;

export interface ShipQuery {
  bbox?: BBox;
  kind?: (typeof SHIP_KIND_NAMES)[number];
  sort_by?: "speed";
  moving_only?: boolean;
  limit?: number;
}

export function queryShips(snap: ShipSnapshot, names: Map<number, string>, q: ShipQuery) {
  const kind = q.kind ? SHIP_KIND_NAMES.indexOf(q.kind) : -1;
  const idx: number[] = [];
  for (let i = 0; i < snap.ids.length; i++) {
    if (kind >= 0 && snap.kind[i] !== kind) continue;
    if (q.moving_only && snap.sog[i] < 10) continue;
    if (!inBox(snap.lat[i] / COORD_SCALE, snap.lon[i] / COORD_SCALE, q.bbox)) continue;
    idx.push(i);
  }
  idx.sort((a, b) => snap.sog[b] - snap.sog[a]);
  const byKind: Record<string, number> = {};
  for (const i of idx) byKind[SHIP_KIND_NAMES[snap.kind[i]] ?? "other"] = (byKind[SHIP_KIND_NAMES[snap.kind[i]] ?? "other"] ?? 0) + 1;
  return {
    matched: idx.length,
    by_kind: byKind,
    ships: idx.slice(0, clampLimit(q.limit)).map((i) => ({
      id: snap.ids[i],
      name: names.get(snap.ids[i]) ?? null,
      kind: SHIP_KIND_NAMES[snap.kind[i]] ?? "other",
      lat: snap.lat[i] / COORD_SCALE,
      lon: snap.lon[i] / COORD_SCALE,
      speed_knots: snap.sog[i] / 10,
    })),
  };
}

export interface QuakeQuery {
  bbox?: BBox;
  min_magnitude?: number;
  hours?: number;
  sort_by?: "magnitude" | "time";
  limit?: number;
}

export function queryQuakes(quakes: Quake[], now: number, q: QuakeQuery) {
  const since = now - Math.min(168, Math.max(1, q.hours ?? 24)) * 3600_000;
  const list = quakes.filter((x) => x.time >= since && x.mag >= (q.min_magnitude ?? 0) && inBox(x.lat, x.lon, q.bbox));
  list.sort((a, b) => (q.sort_by === "time" ? b.time - a.time : b.mag - a.mag));
  return {
    matched: list.length,
    earthquakes: list.slice(0, clampLimit(q.limit)).map((x) => ({
      id: x.id,
      magnitude: x.mag,
      place: x.place,
      time_utc: new Date(x.time).toISOString(),
      depth_km: x.depthKm,
      lat: x.lat,
      lon: x.lon,
      tsunami: x.tsunami,
    })),
  };
}

export function queryFires(grid: FireGrid, q: { bbox?: BBox; limit?: number }) {
  const idx: number[] = [];
  let power = 0;
  for (let i = 0; i < grid.lat.length; i++) {
    if (!inBox(grid.lat[i] / 100, grid.lon[i] / 100, q.bbox)) continue;
    idx.push(i);
    power += grid.frp[i];
  }
  idx.sort((a, b) => grid.frp[b] - grid.frp[a]);
  return {
    hotspots: idx.length,
    total_radiative_power_mw: Math.round(power),
    strongest: idx.slice(0, clampLimit(q.limit, 5)).map((i) => ({
      lat: grid.lat[i] / 100,
      lon: grid.lon[i] / 100,
      radiative_power_mw: grid.frp[i],
      detected_utc: new Date(grid.start + grid.minutes[i] * 60_000).toISOString(),
    })),
  };
}
