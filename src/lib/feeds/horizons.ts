/**
 * NASA/JPL Horizons: positions of spacecraft in deep space. The API returns
 * a text table; we keep the Cartesian vectors (AU, equatorial J2000 frame).
 */
import type { Vec3 } from "../geo";

export interface Spacecraft {
  /** Horizons body id, e.g. "-31" for Voyager 1. */
  id: string;
  name: string;
  /** Mission start, for the card. */
  launched: string;
}

export const SPACECRAFT: Spacecraft[] = [
  { id: "-31", name: "Voyager 1", launched: "1977" },
  { id: "-32", name: "Voyager 2", launched: "1977" },
  { id: "-98", name: "New Horizons", launched: "2006" },
  { id: "-170", name: "James Webb Space Telescope", launched: "2021" },
  { id: "-96", name: "Parker Solar Probe", launched: "2018" },
  { id: "-159", name: "Europa Clipper", launched: "2024" },
];

export interface SpacecraftTrack {
  id: string;
  name: string;
  launched: string;
  /** Unix ms of each sample. */
  times: number[];
  /** Flat x, y, z per sample, AU. */
  xyz: number[];
}

/** Query URL for one body: heliocentric vectors, equatorial frame, one sample per `step`. */
export function horizonsUrl(id: string, startIso: string, stopIso: string, step = "10d"): string {
  const q = new URLSearchParams({
    format: "text",
    COMMAND: `'${id}'`,
    OBJ_DATA: "'NO'",
    MAKE_EPHEM: "'YES'",
    EPHEM_TYPE: "'VECTORS'",
    CENTER: "'500@10'",
    START_TIME: `'${startIso}'`,
    STOP_TIME: `'${stopIso}'`,
    STEP_SIZE: `'${step}'`,
    OUT_UNITS: "'AU-D'",
    REF_PLANE: "'FRAME'",
    VEC_TABLE: "'1'",
    CSV_FORMAT: "'YES'",
  });
  return `https://ssd.jpl.nasa.gov/api/horizons.api?${q}`;
}

/** Parses the $$SOE … $$EOE block of a CSV vector table into times (Unix ms) and positions. */
export function parseHorizonsVectors(text: string): { times: number[]; xyz: number[] } {
  const start = text.indexOf("$$SOE");
  const end = text.indexOf("$$EOE");
  const times: number[] = [];
  const xyz: number[] = [];
  if (start < 0 || end < 0) return { times, xyz };
  for (const line of text.slice(start + 5, end).split("\n")) {
    const cols = line.split(",").map((c) => c.trim());
    if (cols.length < 5) continue;
    const jd = Number(cols[0]);
    const x = Number(cols[2]);
    const y = Number(cols[3]);
    const z = Number(cols[4]);
    if (![jd, x, y, z].every(Number.isFinite)) continue;
    times.push(Math.round((jd - 2440587.5) * 86_400_000));
    xyz.push(x, y, z);
  }
  return { times, xyz };
}

/** Position at `ms` by linear interpolation between samples (clamped at the ends). */
export function trackPosition(track: Pick<SpacecraftTrack, "times" | "xyz">, ms: number): Vec3 | null {
  const n = track.times.length;
  if (!n) return null;
  if (ms <= track.times[0]) return [track.xyz[0], track.xyz[1], track.xyz[2]];
  if (ms >= track.times[n - 1]) return [track.xyz[(n - 1) * 3], track.xyz[(n - 1) * 3 + 1], track.xyz[(n - 1) * 3 + 2]];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track.times[mid] <= ms) lo = mid;
    else hi = mid;
  }
  const f = (ms - track.times[lo]) / (track.times[hi] - track.times[lo]);
  const a = lo * 3;
  const b = hi * 3;
  return [
    track.xyz[a] + (track.xyz[b] - track.xyz[a]) * f,
    track.xyz[a + 1] + (track.xyz[b + 1] - track.xyz[a + 1]) * f,
    track.xyz[a + 2] + (track.xyz[b + 2] - track.xyz[a + 2]) * f,
  ];
}
