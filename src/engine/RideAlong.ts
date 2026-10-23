import { bearingDeg, vecToLatLon, type Vec3 } from "@/lib/geo";
import type { CameraRig } from "./CameraRig";
import type { Selection } from "./types";

export type Rideable = Extract<Selection, { kind: "satellite" | "plane" | "ship" }>;

/** Earth-fixed position (Earth radii) of a ridden object at a simulation time, or null when it is not known. */
export type Locate = (target: Rideable, simMs: number) => Vec3 | null;

/**
 * How far behind (Earth radii) and how steeply the camera rides: farther back for faster, higher things. From orbit
 * a gentler lean keeps the planet filling the lower part of the view instead of the black sky.
 */
const RIDE: Record<Rideable["kind"], [number, number]> = { satellite: [0.012, 60], plane: [0.0026, 74], ship: [0.0009, 64] };
/** The course is read from where the object will be this far ahead, ms. */
const AHEAD = 4000;

export function rideable(selection: Selection | null): selection is Rideable {
  return !!selection && (selection.kind === "satellite" || selection.kind === "plane" || selection.kind === "ship");
}

/**
 * Rides along with a satellite, aircraft or ship: each frame the camera is set behind the object, at its
 * height, looking along its course, so it keeps pace in real time or replay time.
 */
export class RideAlong {
  private target: Rideable | null = null;

  constructor(
    private rig: CameraRig,
    private locate: Locate,
  ) {}

  get active() {
    return !!this.target;
  }

  /** Starts riding with `target`, or with null hands the camera back (north up, the usual lean). */
  ride(target: Rideable | null) {
    this.target = target;
    if (!target) this.rig.resetOrientation();
  }

  /** Whether `selection` is the object being ridden (the ride ends when the selection changes). */
  rides(selection: Selection | null) {
    return !!this.target && selection === this.target;
  }

  update(simMs: number) {
    const target = this.target;
    if (!target) return;
    const now = this.locate(target, simMs);
    const next = this.locate(target, simMs + AHEAD);
    if (!now || !next) return;
    const p = vecToLatLon(now);
    const q = vecToLatLon(next);
    const moved = Math.abs(q.lat - p.lat) + Math.abs(q.lon - p.lon) > 1e-7;
    const heading = moved ? bearingDeg(p.lat, p.lon, q.lat, q.lon) : this.rig.heading;
    const altitude = target.kind === "ship" ? 0 : Math.max(0, p.r - 1);
    const [range, tilt] = RIDE[target.kind];
    this.rig.pivotAltitude = altitude;
    this.rig.track({ lat: p.lat, lon: p.lon, dist: 1 + altitude + range }, heading, tilt);
  }
}
