/**
 * Scene convention: the Earth is a unit sphere fixed in the scene, Y is the
 * north pole, longitude 0 points to +X and 90°E to −Z. This matches the UV
 * layout of an equirectangular texture on THREE.SphereGeometry.
 */

export const EARTH_RADIUS_KM = 6371;
const DEG = Math.PI / 180;

export type Vec3 = [number, number, number];

export function latLonToVec(lat: number, lon: number, r = 1): Vec3 {
  const la = lat * DEG;
  const lo = lon * DEG;
  const c = Math.cos(la);
  return [r * c * Math.cos(lo), r * Math.sin(la), -r * c * Math.sin(lo)];
}

export function vecToLatLon([x, y, z]: Vec3): { lat: number; lon: number; r: number } {
  const r = Math.hypot(x, y, z);
  return { lat: Math.asin(y / r) / DEG, lon: Math.atan2(-z, x) / DEG, r };
}

/** Equatorial frame (x, y, z with z north) → scene axes. Works for ECI and ECEF alike. */
export function equatorialToScene(x: number, y: number, z: number): Vec3 {
  return [x, z, -y];
}

/** Great-circle distance in km. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Advances a position along a near-circular orbit by rotating it about the
 * angular-momentum axis. The satellite shader does the same on the GPU; this
 * copy keeps CPU picking in sync with what is drawn.
 */
export function advanceOrbit(p: Vec3, v: Vec3, dt: number): Vec3 {
  const r2 = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
  const h: Vec3 = [p[1] * v[2] - p[2] * v[1], p[2] * v[0] - p[0] * v[2], p[0] * v[1] - p[1] * v[0]];
  const hl = Math.hypot(h[0], h[1], h[2]);
  if (hl === 0 || r2 === 0) return p;
  const k: Vec3 = [h[0] / hl, h[1] / hl, h[2] / hl];
  const ang = (hl / r2) * dt;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const kxp: Vec3 = [k[1] * p[2] - k[2] * p[1], k[2] * p[0] - k[0] * p[2], k[0] * p[1] - k[1] * p[0]];
  const kdp = k[0] * p[0] + k[1] * p[1] + k[2] * p[2];
  return [
    p[0] * c + kxp[0] * s + k[0] * kdp * (1 - c),
    p[1] * c + kxp[1] * s + k[1] * kdp * (1 - c),
    p[2] * c + kxp[2] * s + k[2] * kdp * (1 - c),
  ];
}

/** Rotates a scene vector about the polar (Y) axis. */
export function rotateY([x, y, z]: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [x * c + z * s, y, -x * s + z * c];
}
