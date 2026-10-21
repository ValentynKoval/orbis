/**
 * Low-precision solar ephemeris and sidereal time, accurate to ~0.01° for
 * 1950–2050 (Astronomical Almanac). Good enough to place the terminator and
 * to rotate the inertial frame under the Earth.
 */

const DEG = Math.PI / 180;
const MS_PER_DAY = 86_400_000;
const J2000 = 2451545.0;

export function julianDate(ms: number): number {
  return ms / MS_PER_DAY + 2440587.5;
}

/** Greenwich mean sidereal time in radians, [0, 2π). IAU 1982, same model SGP4 uses. */
export function gmst(ms: number): number {
  const t = (julianDate(ms) - J2000) / 36525;
  let s = 67310.54841 + (876600 * 3600 + 8640184.812866) * t + 0.093104 * t * t - 6.2e-6 * t * t * t;
  s = ((s % 86400) + 86400) % 86400;
  return (s / 240) * DEG;
}

export interface SunPosition {
  /** Unit vector toward the Sun in the equatorial inertial frame (x → vernal equinox, z → north). */
  eci: [number, number, number];
  /** Sub-solar point, degrees. */
  lat: number;
  lon: number;
}

export function sunPosition(ms: number): SunPosition {
  const n = julianDate(ms) - J2000;
  const L = (280.46 + 0.9856474 * n) * DEG;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  const x = Math.cos(lambda);
  const y = Math.cos(eps) * Math.sin(lambda);
  const z = Math.sin(eps) * Math.sin(lambda);
  const lat = Math.asin(z) / DEG;
  const lon = normalizeLon((Math.atan2(y, x) - gmst(ms)) / DEG);
  return { eci: [x, y, z], lat, lon };
}

export function normalizeLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}
