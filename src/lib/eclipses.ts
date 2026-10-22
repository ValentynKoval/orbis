/**
 * Solar and lunar eclipses from the site's own ephemerides: the Meeus Moon
 * and the Almanac Sun, both referred to the equinox of date. Each new and full
 * Moon is refined to the moment the shadow axis passes closest to the Earth's
 * centre (or the Moon to the Earth's shadow axis), then classified by the
 * geometry of the umbral and penumbral cones. Timing is good to a few
 * minutes and the shadow track to about a hundred kilometres: plenty for
 * jumping the globe to an eclipse and watching the Moon's shadow cross it.
 */
import { gmst } from "./astro";
import { AU_KM, eclipticToEquatorial, moonPosition } from "./orbits";
import type { Vec3 } from "./geo";

const DEG = Math.PI / 180;
const EARTH_KM = 6371;
const SUN_R = 695_700 / EARTH_KM;
const MOON_R = 1737.4 / EARTH_KM;
/** The atmosphere widens the Earth's shadow by about 2 % (Chauvenet). */
const SHADOW_GROWTH = 1.02;
const SYNODIC_MS = 29.530589 * 86_400_000;

export type EclipseKind = "solar" | "lunar";
export type EclipseType = "total" | "annular" | "partial" | "penumbral";

export interface Eclipse {
  kind: EclipseKind;
  type: EclipseType;
  /** Greatest eclipse, Unix ms. */
  time: number;
  /** Solar: closest approach of the shadow axis to the Earth's centre; lunar: of the Moon's centre to the shadow axis. Earth radii. */
  gamma: number;
  /** Solar: where the shadow axis meets the Earth (or the nearest point under it); lunar: where the Moon is overhead. */
  lat: number;
  lon: number;
}

/** Geocentric Sun in Earth radii, equatorial frame of date. */
function sunVector(ms: number): Vec3 {
  const n = ms / 86_400_000 + 2440587.5 - 2451545.0;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lambda = (280.46 + 0.9856474 * n + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const rAu = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
  const r = (rAu * AU_KM) / EARTH_KM;
  return eclipticToEquatorial([r * Math.cos(lambda), r * Math.sin(lambda), 0]);
}

function moonVector(ms: number): Vec3 {
  const m = moonPosition(ms);
  const k = AU_KM / EARTH_KM;
  return [m[0] * k, m[1] * k, m[2] * k];
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => scale(a, 1 / len(a));

/** Earth-fixed latitude and longitude (degrees) of an equatorial direction at a moment. */
function groundPoint(v: Vec3, ms: number): { lat: number; lon: number } {
  const u = unit(v);
  const lon = (Math.atan2(u[1], u[0]) - gmst(ms)) / DEG;
  return { lat: Math.asin(u[2]) / DEG, lon: ((((lon + 180) % 360) + 360) % 360) - 180 };
}

/** The Moon's shadow axis relative to the Earth at a moment. */
export function solarGeometry(ms: number) {
  const S = sunVector(ms);
  const M = moonVector(ms);
  const axis = unit(sub(M, S));
  // Closest point of the axis (through the Moon, away from the Sun) to the Earth's centre.
  const along = -dot(M, axis);
  const closest: Vec3 = [M[0] + axis[0] * along, M[1] + axis[1] * along, M[2] + axis[2] * along];
  const gamma = len(closest);
  const dMoonSun = len(sub(S, M));
  // Where the axis pierces the sphere, if it does: step back toward the Moon from the closest point.
  const surface = gamma < 1 ? sub(closest, scale(axis, Math.sqrt(1 - gamma * gamma))) : closest;
  const toSurface = len(sub(surface, M));
  const umbra = MOON_R - (toSurface * (SUN_R - MOON_R)) / dMoonSun;
  const penumbra = MOON_R + (toSurface * (SUN_R + MOON_R)) / dMoonSun;
  return { gamma, umbra, penumbra, surface, facing: along > 0 };
}

/** The Moon relative to the Earth's shadow at a moment. */
export function lunarGeometry(ms: number) {
  const S = sunVector(ms);
  const M = moonVector(ms);
  const anti = scale(unit(S), -1);
  const x = dot(M, anti);
  const d = len(sub(M, scale(anti, x)));
  const dSun = len(S);
  const umbra = SHADOW_GROWTH * (1 - (x * (SUN_R - 1)) / dSun);
  const penumbra = SHADOW_GROWTH * (1 + (x * (SUN_R + 1)) / dSun);
  return { d, umbra, penumbra, moon: M, behind: x > 0 };
}

/** Golden-section minimum of f on [a, b]. */
function minimise(f: (t: number) => number, a: number, b: number, tol = 20_000): number {
  const r = (Math.sqrt(5) - 1) / 2;
  let c = b - r * (b - a);
  let d = a + r * (b - a);
  while (b - a > tol) {
    if (f(c) < f(d)) b = d;
    else a = c;
    c = b - r * (b - a);
    d = a + r * (b - a);
  }
  return (a + b) / 2;
}

/** Angle between the Sun and the Moon as seen from the Earth's centre, radians. */
function elongation(ms: number): number {
  const s = unit(sunVector(ms));
  const m = unit(moonVector(ms));
  return Math.acos(Math.max(-1, Math.min(1, dot(s, m))));
}

/** Every eclipse from `from` to `to` (Unix ms), in time order. */
export function findEclipses(from: number, to: number): Eclipse[] {
  const out: Eclipse[] = [];
  const step = 6 * 3_600_000;
  let prev = elongation(from - step);
  let cur = elongation(from);
  for (let t = from; t < to + SYNODIC_MS / 2; t += step) {
    const next = elongation(t + step);
    // New moon: local minimum of elongation; full moon: local maximum.
    if (cur <= prev && cur <= next) {
      const best = minimise((ms) => solarGeometry(ms).gamma, t - step, t + step);
      const g = solarGeometry(best);
      if (best >= from && best <= to && g.facing && g.gamma < 1 + g.penumbra) {
        // Central when the axis meets the Earth: total if the umbra still reaches the ground, annular if not.
        const type: EclipseType = g.gamma < 1 ? (g.umbra > 0 ? "total" : "annular") : "partial";
        out.push({ kind: "solar", type, time: best, gamma: g.gamma, ...groundPoint(g.surface, best) });
      }
    } else if (cur >= prev && cur >= next) {
      const best = minimise((ms) => lunarGeometry(ms).d, t - step, t + step);
      const g = lunarGeometry(best);
      if (best >= from && best <= to && g.behind && g.d - MOON_R < g.penumbra) {
        const type: EclipseType = g.d + MOON_R <= g.umbra ? "total" : g.d - MOON_R < g.umbra ? "partial" : "penumbral";
        out.push({ kind: "lunar", type, time: best, gamma: g.d, ...groundPoint(g.moon, best) });
      }
    }
    prev = cur;
    cur = next;
  }
  return out;
}

/**
 * How much of the Sun's disc the Moon hides from a point on the Earth, 0…1,
 * for testing the shader's eclipse shading against.
 */
export function sunCovered(ms: number, lat: number, lon: number): number {
  const theta = gmst(ms) + lon * DEG;
  const p: Vec3 = [Math.cos(lat * DEG) * Math.cos(theta), Math.cos(lat * DEG) * Math.sin(theta), Math.sin(lat * DEG)];
  const toSun = sub(sunVector(ms), p);
  const toMoon = sub(moonVector(ms), p);
  const rs = Math.asin(SUN_R / len(toSun));
  const rm = Math.asin(MOON_R / len(toMoon));
  const sep = Math.acos(Math.max(-1, Math.min(1, dot(unit(toSun), unit(toMoon)))));
  return discOverlap(sep, rs, rm);
}

/** Fraction of a disc of radius `rs` hidden by one of radius `rm` at separation `d` (same units). */
export function discOverlap(d: number, rs: number, rm: number): number {
  if (d >= rs + rm) return 0;
  if (d <= Math.abs(rm - rs)) return rm >= rs ? 1 : (rm * rm) / (rs * rs);
  const a = rs * rs * Math.acos((d * d + rs * rs - rm * rm) / (2 * d * rs));
  const b = rm * rm * Math.acos((d * d + rm * rm - rs * rs) / (2 * d * rm));
  const c = 0.5 * Math.sqrt((-d + rs + rm) * (d + rs - rm) * (d - rs + rm) * (d + rs + rm));
  return (a + b - c) / (Math.PI * rs * rs);
}
