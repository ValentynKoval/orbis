/**
 * Positions of the Moon, the planets and small bodies. Planets use the JPL
 * approximate Keplerian elements (Standish, valid 1800–2050, errors of
 * arcminutes); the Moon a truncated Meeus series (~0.2°); comets and asteroids
 * their JPL SBDB osculating elements through a Kepler solver.
 *
 * Results are heliocentric (planets, small bodies) or geocentric (Moon)
 * vectors in the equatorial J2000 frame, in AU; `toScene` maps them to the
 * engine's axes (y = north).
 */
import type { Vec3 } from "./geo";

export const AU_KM = 149_597_870.7;
export const EARTH_RADIUS_AU = 6371 / AU_KM;
const DEG = Math.PI / 180;
const OBLIQUITY = 23.43928 * DEG;
const J2000 = 2451545.0;
/** Gaussian gravitational constant, rad/day for a = 1 AU. */
const K = 0.01720209895;

export type Planet = "mercury" | "venus" | "earth" | "mars" | "jupiter" | "saturn" | "uranus" | "neptune";

/** [a, ȧ, e, ė, I, İ, L, L̇, ϖ, ϖ̇, Ω, Ω̇] at J2000, rates per Julian century. */
const ELEMENTS: Record<Planet, number[]> = {
  mercury: [0.38709927, 0.00000037, 0.20563593, 0.00001906, 7.00497902, -0.00594749, 252.2503235, 149472.67411175, 77.45779628, 0.16047689, 48.33076593, -0.12534081],
  venus: [0.72333566, 0.0000039, 0.00677672, -0.00004107, 3.39467605, -0.0007889, 181.9790995, 58517.81538729, 131.60246718, 0.00268329, 76.67984255, -0.27769418],
  earth: [1.00000261, 0.00000562, 0.01671123, -0.00004392, -0.00001531, -0.01294668, 100.46457166, 35999.37244981, 102.93768193, 0.32327364, 0, 0],
  mars: [1.52371034, 0.00001847, 0.0933941, 0.00007882, 1.84969142, -0.00813131, -4.55343205, 19140.30268499, -23.94362959, 0.44441088, 49.55953891, -0.29257343],
  jupiter: [5.202887, -0.00011607, 0.04838624, -0.00013253, 1.30439695, -0.00183714, 34.39644051, 3034.74612775, 14.72847983, 0.21252668, 100.47390909, 0.20469106],
  saturn: [9.53667594, -0.0012506, 0.05386179, -0.00050991, 2.48599187, 0.00193609, 49.95424423, 1222.49362201, 92.59887831, -0.41897216, 113.66242448, -0.28867794],
  uranus: [19.18916464, -0.00196176, 0.04725744, -0.00004397, 0.77263783, -0.00242939, 313.23810451, 428.48202785, 170.9542763, 0.40805281, 74.01692503, 0.04240589],
  neptune: [30.06992276, 0.00026291, 0.00859048, 0.00005105, 1.77004347, 0.00035372, -55.12002969, 218.45945325, 44.96476227, -0.32241464, 131.78422574, -0.00508664],
};

export const PLANETS: Planet[] = ["mercury", "venus", "earth", "mars", "jupiter", "saturn", "uranus", "neptune"];

export function julianDay(ms: number): number {
  return ms / 86_400_000 + 2440587.5;
}

/** Solves E − e·sin E = M (elliptic) or e·sinh F − F = M (hyperbolic). */
export function solveKepler(M: number, e: number): number {
  if (e < 1) {
    // The equation is odd in M: solve for |M| in [0, π], where the root lies in [0, π] too, with Newton steps
    // kept inside that bracket. Plain Newton from E = π ran off for a negative M on eccentric orbits and
    // returned garbage after its iterations ran out: Halley or Encke jumped across the system for a frame.
    const turns = Math.round(M / (2 * Math.PI)) * 2 * Math.PI;
    const m = M - turns;
    const am = Math.abs(m);
    let lo = 0;
    let hi = Math.PI;
    let E = e < 0.8 ? am : Math.PI;
    for (let i = 0; i < 60; i++) {
      const f = E - e * Math.sin(E) - am;
      if (f > 0) hi = E;
      else lo = E;
      let next = E - f / (1 - e * Math.cos(E));
      if (!(next > lo && next < hi)) next = (lo + hi) / 2;
      const step = Math.abs(next - E);
      E = next;
      if (step < 1e-13) break;
    }
    return (m < 0 ? -E : E) + turns;
  }
  let F = Math.log(2 * Math.abs(M) / e + 1.8) * Math.sign(M || 1);
  for (let i = 0; i < 50; i++) {
    const d = (e * Math.sinh(F) - F - M) / (e * Math.cosh(F) - 1);
    F -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return F;
}

/** Orbital-plane coordinates → equatorial J2000, given ω, Ω, i in radians (ecliptic elements). */
function orientate(xp: number, yp: number, w: number, om: number, inc: number): Vec3 {
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const co = Math.cos(om);
  const so = Math.sin(om);
  const ci = Math.cos(inc);
  const si = Math.sin(inc);
  const x = (cw * co - sw * so * ci) * xp + (-sw * co - cw * so * ci) * yp;
  const y = (cw * so + sw * co * ci) * xp + (-sw * so + cw * co * ci) * yp;
  const z = sw * si * xp + cw * si * yp;
  return eclipticToEquatorial([x, y, z]);
}

export function eclipticToEquatorial([x, y, z]: Vec3): Vec3 {
  return [x, y * Math.cos(OBLIQUITY) - z * Math.sin(OBLIQUITY), y * Math.sin(OBLIQUITY) + z * Math.cos(OBLIQUITY)];
}

/** Heliocentric equatorial position of a planet in AU. */
export function planetPosition(planet: Planet, ms: number): Vec3 {
  const T = (julianDay(ms) - J2000) / 36525;
  const el = ELEMENTS[planet];
  const a = el[0] + el[1] * T;
  const e = el[2] + el[3] * T;
  const inc = (el[4] + el[5] * T) * DEG;
  const L = (el[6] + el[7] * T) * DEG;
  const peri = (el[8] + el[9] * T) * DEG;
  const om = (el[10] + el[11] * T) * DEG;
  const w = peri - om;
  const M = ((L - peri + Math.PI) % (2 * Math.PI)) - Math.PI;
  const E = solveKepler(M, e);
  return orientate(a * (Math.cos(E) - e), a * Math.sqrt(1 - e * e) * Math.sin(E), w, om, inc);
}

/** JPL SBDB osculating elements. Angles in degrees, a and q in AU, times in Julian days. */
export interface SmallBodyElements {
  e: number;
  /** Semi-major axis; absent or meaningless for e ≥ 1, where `q` is used. */
  a?: number;
  q?: number;
  i: number;
  om: number;
  w: number;
  /** Mean anomaly at `epoch` (asteroids) … */
  ma?: number;
  /** … or time of perihelion passage (comets). */
  tp?: number;
  epoch: number;
}

/** Heliocentric equatorial position of a comet or asteroid in AU, or null if the elements are unusable. */
export function smallBodyPosition(el: SmallBodyElements, ms: number): Vec3 | null {
  const jd = julianDay(ms);
  const e = el.e;
  const q = el.q ?? (el.a !== undefined ? el.a * (1 - e) : undefined);
  if (q === undefined || !Number.isFinite(q) || q <= 0) return null;
  const w = el.w * DEG;
  const om = el.om * DEG;
  const inc = el.i * DEG;
  if (e < 0.9999) {
    const a = q / (1 - e);
    const n = K / Math.sqrt(a * a * a);
    const M0 = el.ma !== undefined ? el.ma * DEG : el.tp !== undefined ? n * (el.epoch - el.tp) : null;
    if (M0 === null) return null;
    const M = M0 + n * (jd - el.epoch);
    const E = solveKepler(((M + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI, e);
    return orientate(a * (Math.cos(E) - e), a * Math.sqrt(1 - e * e) * Math.sin(E), w, om, inc);
  }
  // Near-parabolic and hyperbolic: treat as a hyperbola with e slightly above 1.
  const eh = Math.max(e, 1.0005);
  const a = q / (eh - 1);
  const n = K / Math.sqrt(a * a * a);
  const tp = el.tp ?? (el.ma !== undefined ? el.epoch - (el.ma * DEG) / n : null);
  if (tp === null) return null;
  const F = solveKepler(n * (jd - tp), eh);
  return orientate(a * (eh - Math.cosh(F)), a * Math.sqrt(eh * eh - 1) * Math.sinh(F), w, om, inc);
}

/** Points along a small body's orbit (one full ellipse, or the visible arc of a hyperbola), for drawing. */
export function orbitPath(el: SmallBodyElements, steps = 180, maxAu = 60): Vec3[] {
  const e = el.e;
  const q = el.q ?? (el.a !== undefined ? el.a * (1 - e) : undefined);
  if (q === undefined || q <= 0) return [];
  const w = el.w * DEG;
  const om = el.om * DEG;
  const inc = el.i * DEG;
  const out: Vec3[] = [];
  if (e < 0.9999) {
    const a = q / (1 - e);
    for (let k = 0; k <= steps; k++) {
      const E = (k / steps) * 2 * Math.PI;
      out.push(orientate(a * (Math.cos(E) - e), a * Math.sqrt(1 - e * e) * Math.sin(E), w, om, inc));
    }
    return out;
  }
  const eh = Math.max(e, 1.0005);
  const a = q / (eh - 1);
  const fMax = Math.acosh(Math.min(1e6, (maxAu / a + eh)));
  for (let k = 0; k <= steps; k++) {
    const F = -fMax + (2 * fMax * k) / steps;
    out.push(orientate(a * (eh - Math.cosh(F)), a * Math.sqrt(eh * eh - 1) * Math.sinh(F), w, om, inc));
  }
  return out;
}

/** Geocentric equatorial position of the Moon in AU (truncated Meeus, ~0.2°). */
export function moonPosition(ms: number): Vec3 {
  const T = (julianDay(ms) - J2000) / 36525;
  const Lp = (218.3164477 + 481267.88123421 * T - 0.0015786 * T * T) * DEG;
  const D = (297.8501921 + 445267.1114034 * T - 0.0018819 * T * T) * DEG;
  const M = (357.5291092 + 35999.0502909 * T - 0.0001536 * T * T) * DEG;
  const Mp = (134.9633964 + 477198.8675055 * T + 0.0087414 * T * T) * DEG;
  const F = (93.272095 + 483202.0175233 * T - 0.0036539 * T * T) * DEG;
  const s = Math.sin;
  const c = Math.cos;
  const lon =
    Lp +
    (6288774 * s(Mp) +
      1274027 * s(2 * D - Mp) +
      658314 * s(2 * D) +
      213618 * s(2 * Mp) -
      185116 * s(M) -
      114332 * s(2 * F) +
      58793 * s(2 * D - 2 * Mp) +
      57066 * s(2 * D - M - Mp) +
      53322 * s(2 * D + Mp) +
      45758 * s(2 * D - M) -
      40923 * s(M - Mp) -
      34720 * s(D) -
      30383 * s(M + Mp) +
      15327 * s(2 * D - 2 * F) -
      12528 * s(Mp + 2 * F) +
      10980 * s(Mp - 2 * F)) *
      1e-6 *
      DEG;
  const lat =
    (5128122 * s(F) +
      280602 * s(Mp + F) +
      277693 * s(Mp - F) +
      173237 * s(2 * D - F) +
      55413 * s(2 * D - Mp + F) +
      46271 * s(2 * D - Mp - F) +
      32573 * s(2 * D + F) +
      17198 * s(2 * Mp + F) +
      9266 * s(2 * D + Mp - F) +
      8822 * s(2 * Mp - F)) *
    1e-6 *
    DEG;
  const distKm =
    385000.56 +
    (-20905355 * c(Mp) -
      3699111 * c(2 * D - Mp) -
      2955968 * c(2 * D) -
      569925 * c(2 * Mp) +
      48888 * c(M) -
      3149 * c(2 * F) +
      246158 * c(2 * D - 2 * Mp) -
      152138 * c(2 * D - M - Mp) -
      170733 * c(2 * D + Mp) -
      204586 * c(2 * D - M) -
      129620 * c(M - Mp) +
      108743 * c(D) +
      104755 * c(M + Mp) +
      10321 * c(2 * D - 2 * F) +
      79661 * c(Mp - 2 * F)) /
      1000;
  const r = distKm / AU_KM;
  return eclipticToEquatorial([r * Math.cos(lat) * Math.cos(lon), r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat)]);
}

/** Phase of the Moon as seen from Earth: 0 = new, 0.5 = full; `illuminated` is the lit fraction. */
export function moonPhase(ms: number): { phase: number; illuminated: number } {
  const moon = moonPosition(ms);
  const earth = planetPosition("earth", ms);
  const sun: Vec3 = [-earth[0], -earth[1], -earth[2]];
  const dot = moon[0] * sun[0] + moon[1] * sun[1] + moon[2] * sun[2];
  const cosE = dot / (Math.hypot(...moon) * Math.hypot(...sun));
  const elongation = Math.acos(Math.max(-1, Math.min(1, cosE)));
  // Sign from the ecliptic z-component of moon × sun: waxing when the Moon trails the Sun eastward.
  const cross = moon[0] * sun[1] - moon[1] * sun[0];
  const phase = cross < 0 ? elongation / (2 * Math.PI) : 1 - elongation / (2 * Math.PI);
  return { phase, illuminated: (1 - Math.cos(elongation)) / 2 };
}

/** Equatorial (x, y, z with z north) → scene axes. */
export function toScene([x, y, z]: Vec3): Vec3 {
  return [x, z, -y];
}
