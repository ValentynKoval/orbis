/**
 * Camera targets for the landing tour, chosen from live data so the story
 * always lands on something real: the strongest quake of the day, the
 * busiest fire region, the most populated part of the night side.
 */
import type { FireGrid } from "./feeds/fires";
import type { Quake } from "./feeds/quakes";
import { latLonToVec } from "./geo";

export interface Spot {
  lat: number;
  lon: number;
}

export function strongestQuake(quakes: Quake[], now: number, windowMs = 86_400_000): Quake | null {
  let best: Quake | null = null;
  for (const q of quakes) {
    if (now - q.time > windowMs || q.time > now) continue;
    if (!best || q.mag > best.mag) best = q;
  }
  return best;
}

/** Centre of the 10°×10° box with the most fire cells. */
export function busiestFireRegion(grid: Pick<FireGrid, "lat" | "lon">): Spot | null {
  const counts = new Map<number, { n: number; lat: number; lon: number }>();
  for (let i = 0; i < grid.lat.length; i++) {
    const lat = grid.lat[i] / 100;
    const lon = grid.lon[i] / 100;
    const key = Math.floor((lat + 90) / 10) * 100 + Math.floor((lon + 180) / 10);
    const c = counts.get(key);
    if (c) {
      c.n++;
      c.lat += lat;
      c.lon += lon;
    } else counts.set(key, { n: 1, lat, lon });
  }
  let best: { n: number; lat: number; lon: number } | null = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best ? { lat: best.lat / best.n, lon: best.lon / best.n } : null;
}

/** Densely lit regions, roughly by population. */
const CITY_REGIONS: Spot[] = [
  { lat: 48, lon: 12 }, // Europe
  { lat: 25, lon: 80 }, // South Asia
  { lat: 33, lon: 115 }, // East Asia
  { lat: 38, lon: -88 }, // North America
  { lat: -20, lon: -48 }, // Brazil
  { lat: 28, lon: 35 }, // Middle East and Nile
];

/** The lit region deepest into night that still has some twilight nearby. */
export function nightSpot(sun: Spot): Spot {
  const s = latLonToVec(sun.lat, sun.lon);
  let best = CITY_REGIONS[0];
  let bestScore = -Infinity;
  for (const r of CITY_REGIONS) {
    const p = latLonToVec(r.lat, r.lon);
    const cos = p[0] * s[0] + p[1] * s[1] + p[2] * s[2];
    // Best around 35° past the terminator: dark enough for lights, close enough to show the line.
    const score = -Math.abs(cos + 0.55);
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}
