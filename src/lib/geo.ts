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

/** Initial great-circle bearing from the first point to the second, degrees clockwise from north (0–360). */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const f1 = lat1 * DEG;
  const f2 = lat2 * DEG;
  const dl = (lon2 - lon1) * DEG;
  const b = Math.atan2(Math.sin(dl) * Math.cos(f2), Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl));
  return (b / DEG + 360) % 360;
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

/**
 * Point reached by travelling `angle` radians of arc from (lat, lon) along
 * `track` (radians clockwise from north), at `radius`. The movers shader
 * does the same; keep them in step.
 */
export function moveAlong(lat: number, lon: number, track: number, angle: number, radius = 1): Vec3 {
  const cl = Math.cos(lat);
  const sl = Math.sin(lat);
  const co = Math.cos(lon);
  const so = Math.sin(lon);
  const p0: Vec3 = [cl * co, sl, -cl * so];
  const east: Vec3 = [-so, 0, -co];
  const north: Vec3 = [-sl * co, cl, sl * so];
  const ct = Math.cos(track);
  const st = Math.sin(track);
  const dir: Vec3 = [north[0] * ct + east[0] * st, north[1] * ct + east[1] * st, north[2] * ct + east[2] * st];
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  return [(p0[0] * ca + dir[0] * sa) * radius, (p0[1] * ca + dir[1] * sa) * radius, (p0[2] * ca + dir[2] * sa) * radius];
}
