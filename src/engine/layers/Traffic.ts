import * as THREE from "three";
import { latLonToVec, vecToLatLon, type Vec3 } from "@/lib/geo";
import { COORD_SCALE, SHIP_KINDS, type PlaneSnapshot, type PlaneTrack, type ShipDetail, type ShipSnapshot } from "@/lib/feeds/live";
import { Movers, type MoverInput } from "./Movers";

const DEG = Math.PI / 180;
const EARTH_M = 6_371_000;
const KNOT = 0.514444;
/** Aircraft altitude is exaggerated so cruise traffic visibly floats above the clouds. */
const ALT_SCALE = 8;
const SURFACE = 0.0005;

export const PlaneKind = { Airborne: 0, Ground: 1, Emergency: 2 } as const;
const PLANE_COLORS = ["#f5efe0", "#7d879c", "#ff4f6e"];
/** In ShipKind order: other, cargo, tanker, passenger, fishing, leisure, service. */
const SHIP_COLORS = ["#7fa39b", "#4fd1b0", "#2bb3c9", "#e6f6ff", "#9be564", "#b8a6ff", "#8fa3b8"];

export function planeAltitude(altM: number, ground: boolean) {
  return ground ? SURFACE : SURFACE + (altM / EARTH_M) * ALT_SCALE;
}

export interface PlaneInfo {
  id: string;
  callsign: string;
  reg: string;
  type: string;
  lat: number;
  lon: number;
  altM: number;
  speedMs: number;
  track: number;
  vrMs: number;
  ground: boolean;
  squawk: string;
  emergency: boolean;
  category: string;
  /** Unix ms of the last position fix. */
  seen: number;
}

export interface ShipInfo {
  id: number;
  lat: number;
  lon: number;
  sogKn: number;
  cog: number;
  kind: number;
  seen: number;
}

/** Aircraft and ships: snapshot loading, GPU layers, selection tracks. */
export class Traffic {
  readonly planes = new Movers({ size: 0.0062, maxExtrapolation: 240, colors: PLANE_COLORS, icon: "plane", renderOrder: 7 });
  readonly ships = new Movers({ size: 0.0046, maxExtrapolation: 1800, colors: SHIP_COLORS, icon: "ship", renderOrder: 6 });
  readonly track: THREE.Line;
  planeSnap: PlaneSnapshot | null = null;
  shipSnap: ShipSnapshot | null = null;
  private shipNames: Promise<Map<number, string>> | null = null;
  private trackFor: string | null = null;

  constructor() {
    this.track = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: "#f2c14e", transparent: true, opacity: 0.75, depthWrite: false }),
    );
    this.track.frustumCulled = false;
    this.track.visible = false;
    this.track.renderOrder = 5;
  }

  /** Returns the number of aircraft, or null if the snapshot hasn't changed. */
  async loadPlanes(nowS: number, force = false): Promise<number | null> {
    const res = await fetch("/api/live/planes");
    if (!res.ok) throw new Error(`planes ${res.status}`);
    const snap: PlaneSnapshot = await res.json();
    if (this.replay || (!force && this.planeSnap && snap.t === this.planeSnap.t)) return null;
    this.applyPlanes(snap, nowS, true);
    return snap.ids.length;
  }

  async loadShips(nowS: number, force = false): Promise<number | null> {
    const res = await fetch("/api/live/ships");
    if (!res.ok) throw new Error(`ships ${res.status}`);
    const snap: ShipSnapshot = await res.json();
    if (this.replay || (!force && this.shipSnap && snap.t === this.shipSnap.t)) return null;
    this.applyShips(snap, nowS, true);
    return snap.ids.length;
  }

  // ------------------------------------------------------------- replay

  /** True while the timeline is away from "now": live polling pauses and history frames drive both layers. */
  replay = false;
  private frames: Record<"planes" | "ships", number[]> = { planes: [], ships: [] };
  private frameShown: Record<"planes" | "ships", number> = { planes: 0, ships: 0 };
  private frameLoading: Record<"planes" | "ships", boolean> = { planes: false, ships: false };

  /** Unix seconds of the oldest recorded traffic frame, or null before the index loads. */
  get historyStart(): number | null {
    const first = [this.frames.planes[0], this.frames.ships[0]].filter((t) => t !== undefined);
    return first.length ? Math.min(...first) : null;
  }

  async loadHistoryIndex() {
    const res = await fetch("/api/live/history");
    if (res.ok) this.frames = await res.json();
  }

  setReplay(on: boolean) {
    if (on === this.replay) return;
    this.replay = on;
    this.frameShown = { planes: 0, ships: 0 };
    // Frames are five minutes apart, so let objects coast a little longer between them.
    this.planes.setMaxExtrapolation(on ? 330 : 240);
    this.clearTrack();
  }

  /** Keeps the frame at or before `simS` on screen for each kind. */
  syncReplay(simS: number) {
    for (const kind of ["planes", "ships"] as const) {
      const t = frameAtOrBefore(this.frames[kind], simS);
      if (t === this.frameShown[kind] || this.frameLoading[kind]) continue;
      const layer = kind === "planes" ? this.planes : this.ships;
      if (t === null) {
        layer.set([], [], simS);
        this.frameShown[kind] = 0;
        continue;
      }
      this.frameLoading[kind] = true;
      const blend = Math.abs(t - this.frameShown[kind]) <= 600;
      fetch(`/api/live/history/${kind}/${t}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((frame) => {
          if (!frame || !this.replay) return;
          if (kind === "planes") this.applyPlanes(fillPlaneFrame(frame), simS, blend);
          else this.applyShips(frame, simS, blend);
          this.frameShown[kind] = t;
        })
        .catch(() => undefined)
        .finally(() => {
          this.frameLoading[kind] = false;
        });
    }
  }

  private applyPlanes(snap: PlaneSnapshot, nowS: number, blend: boolean) {
    const t = snap.t / 1000;
    const items: MoverInput[] = snap.ids.map((_, i) => ({
      lat: (snap.lat[i] / COORD_SCALE) * DEG,
      lon: (snap.lon[i] / COORD_SCALE) * DEG,
      t: t - snap.age[i],
      speed: snap.gnd[i] ? 0 : snap.spd[i] / 10 / EARTH_M,
      track: (snap.trk[i] / 10) * DEG,
      alt: planeAltitude(snap.alt[i], !!snap.gnd[i]),
      kind: snap.emg[i] ? PlaneKind.Emergency : snap.gnd[i] ? PlaneKind.Ground : PlaneKind.Airborne,
    }));
    this.planes.set(snap.ids, items, nowS, blend);
    this.planeSnap = snap;
  }

  private applyShips(snap: ShipSnapshot, nowS: number, blend: boolean) {
    const t = snap.t / 1000;
    const items: MoverInput[] = snap.ids.map((_, i) => {
      const kn = snap.sog[i] / 10;
      return {
        lat: (snap.lat[i] / COORD_SCALE) * DEG,
        lon: (snap.lon[i] / COORD_SCALE) * DEG,
        t: t - snap.age[i],
        // Below ~0.5 kn AIS speed is GPS noise around a moored ship.
        speed: kn < 0.5 ? 0 : (kn * KNOT) / EARTH_M,
        track: (snap.cog[i] / 10) * DEG,
        alt: SURFACE,
        kind: Math.min(snap.kind[i], SHIP_KINDS - 1),
      };
    });
    this.ships.set(snap.ids, items, nowS, blend);
    this.shipSnap = snap;
  }

  /** Names for search, fetched once on demand. */
  names(): Promise<Map<number, string>> {
    this.shipNames ??= fetch("/api/live/ships/names")
      .then((r) => (r.ok ? r.json() : { ids: [], names: [] }))
      .then((d: { ids: number[]; names: string[] }) => new Map(d.ids.map((id, i) => [id, d.names[i]])))
      .catch(() => {
        this.shipNames = null;
        return new Map();
      });
    return this.shipNames;
  }

  planeInfo(id: string, nowS: number): PlaneInfo | null {
    const s = this.planeSnap;
    const i = this.planes.indexOf(id);
    if (!s || i < 0) return null;
    const { lat, lon } = vecToLatLon(this.planes.displayed(i, nowS));
    return {
      id,
      callsign: s.callsign[i],
      reg: s.reg[i],
      type: s.type[i],
      lat,
      lon,
      altM: s.alt[i],
      speedMs: s.spd[i] / 10,
      track: s.trk[i] / 10,
      vrMs: s.vr[i] / 10,
      ground: !!s.gnd[i],
      squawk: s.squawk[i],
      emergency: !!s.emg[i],
      category: s.cat[i],
      seen: s.t - s.age[i] * 1000,
    };
  }

  shipInfo(id: number, nowS: number): ShipInfo | null {
    const s = this.shipSnap;
    const i = this.ships.indexOf(id);
    if (!s || i < 0) return null;
    const { lat, lon } = vecToLatLon(this.ships.displayed(i, nowS));
    return { id, lat, lon, sogKn: s.sog[i] / 10, cog: s.cog[i] / 10, kind: s.kind[i], seen: s.t - s.age[i] * 1000 };
  }

  /** Draws the recent path of a plane or ship, ending at where it is drawn now. */
  async showTrack(kind: "plane" | "ship", id: string | number, nowS: number): Promise<ShipDetail | null> {
    const key = `${kind}:${id}`;
    this.trackFor = key;
    this.track.visible = false;
    const res = await fetch(kind === "plane" ? `/api/live/planes/${id}/track` : `/api/live/ships/${id}`);
    if (!res.ok || this.trackFor !== key) return null;
    const points: Vec3[] = [];
    let detail: ShipDetail | null = null;
    if (kind === "plane") {
      const data: PlaneTrack = await res.json();
      for (let k = 0; k + 3 < data.track.length; k += 4) {
        points.push(latLonToVec(data.track[k + 1], data.track[k + 2], 1 + planeAltitude(data.track[k + 3], false)));
      }
    } else {
      detail = await res.json();
      const track = detail?.track ?? [];
      for (let k = 0; k + 2 < track.length; k += 3) points.push(latLonToVec(track[k + 1], track[k + 2], 1 + SURFACE));
    }
    const layer = kind === "plane" ? this.planes : this.ships;
    const i = layer.indexOf(id);
    if (i >= 0) points.push(layer.displayed(i, nowS));
    if (points.length >= 2 && this.trackFor === key) {
      this.track.geometry.dispose();
      this.track.geometry = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(...p)));
      this.track.visible = true;
    }
    return detail;
  }

  clearTrack() {
    this.trackFor = null;
    this.track.visible = false;
  }

  update(nowS: number) {
    this.planes.update(nowS);
    this.ships.update(nowS);
  }

  dispose() {
    this.planes.dispose();
    this.ships.dispose();
    this.track.geometry.dispose();
    (this.track.material as THREE.Material).dispose();
  }
}

/** Largest value in a sorted list that is ≤ t, or null. */
export function frameAtOrBefore(sorted: number[], t: number): number | null {
  let lo = 0;
  let hi = sorted.length - 1;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= t) {
      found = sorted[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** History frames carry motion only; give the identity columns empty values. */
function fillPlaneFrame(frame: Partial<PlaneSnapshot> & Pick<PlaneSnapshot, "t" | "ids">): PlaneSnapshot {
  const blank = frame.ids.map(() => "");
  return {
    callsign: blank,
    reg: blank,
    type: blank,
    vr: frame.ids.map(() => 0),
    cat: blank,
    squawk: blank,
    lat: [],
    lon: [],
    alt: [],
    spd: [],
    trk: [],
    gnd: [],
    age: [],
    emg: [],
    ...frame,
  };
}
