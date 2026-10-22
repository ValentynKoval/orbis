/**
 * What an observer at a place sees in the sky: altitude and azimuth of the
 * Sun, the Moon and the planets, and the Moon's phase. Planet positions come
 * from the JPL elements (J2000); the Moon and Sun from the Meeus and Almanac
 * series. Accurate to a fraction of a degree: right for "Jupiter is 35° up in
 * the south-east", not for pointing a telescope.
 */
import { gmst, sunPosition } from "./astro";
import { moonPhase, moonPosition, planetPosition, type Planet } from "./orbits";
import type { Vec3 } from "./geo";

const DEG = Math.PI / 180;

export interface Horizontal {
  /** Degrees above the horizon (negative: below). */
  alt: number;
  /** Degrees clockwise from north. */
  az: number;
}

/** Horizontal coordinates of an equatorial direction for an observer. */
export function toHorizontal(v: Vec3, lat: number, lon: number, ms: number): Horizontal {
  const r = Math.hypot(v[0], v[1], v[2]);
  const ra = Math.atan2(v[1], v[0]);
  const dec = Math.asin(v[2] / r);
  const h = gmst(ms) + lon * DEG - ra;
  const phi = lat * DEG;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h));
  const az = Math.atan2(-Math.sin(h), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(h));
  return { alt: alt / DEG, az: ((az / DEG) % 360 + 360) % 360 };
}

export type SkyObject = "moon" | Exclude<Planet, "earth">;

export interface SkyEntry extends Horizontal {
  id: SkyObject;
}

/** The Moon and the planets for an observer, highest first. */
export function skyFor(lat: number, lon: number, ms: number): { sun: Horizontal; objects: SkyEntry[] } {
  const sun = toHorizontal(sunPosition(ms).eci, lat, lon, ms);
  const earth = planetPosition("earth", ms);
  const objects: SkyEntry[] = [{ id: "moon", ...toHorizontal(moonPosition(ms), lat, lon, ms) }];
  for (const p of ["mercury", "venus", "mars", "jupiter", "saturn", "uranus", "neptune"] as const) {
    const h = planetPosition(p, ms);
    objects.push({ id: p, ...toHorizontal([h[0] - earth[0], h[1] - earth[1], h[2] - earth[2]], lat, lon, ms) });
  }
  objects.sort((a, b) => b.alt - a.alt);
  return { sun, objects };
}

export type PhaseName = "new" | "waxingCrescent" | "firstQuarter" | "waxingGibbous" | "full" | "waningGibbous" | "lastQuarter" | "waningCrescent";

/** The Moon's phase name and lit fraction. */
export function moonNow(ms: number): { name: PhaseName; illuminated: number; phase: number } {
  const { phase, illuminated } = moonPhase(ms);
  const names: PhaseName[] = ["new", "waxingCrescent", "firstQuarter", "waxingGibbous", "full", "waningGibbous", "lastQuarter", "waningCrescent"];
  return { name: names[Math.round(phase * 8) % 8], illuminated, phase };
}
