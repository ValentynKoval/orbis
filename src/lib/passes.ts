/**
 * When a satellite crosses the sky above a place. A pass is "visible" when
 * the observer is in darkness while the satellite is still in sunlight: the
 * only time the ISS can be seen with the naked eye.
 */
import { sunPosition } from "./astro";
import { ecfToLookAngles, eciToEcf, gstime, sgp4, twoline2satrec } from "./sgp4";

export interface Pass {
  /** Unix ms. */
  start: number;
  max: number;
  end: number;
  maxElevation: number;
  startAzimuth: number;
  maxAzimuth: number;
  endAzimuth: number;
  /** Naked-eye visible: dark sky at the observer, satellite in sunlight at the highest point. */
  visible: boolean;
}

const DEG = Math.PI / 180;
const EARTH_KM = 6371;
const MS_PER_DAY = 86_400_000;

function sunlit(pos: { x: number; y: number; z: number }, sun: [number, number, number]): boolean {
  const along = pos.x * sun[0] + pos.y * sun[1] + pos.z * sun[2];
  if (along > 0) return true;
  const px = pos.x - along * sun[0];
  const py = pos.y - along * sun[1];
  const pz = pos.z - along * sun[2];
  return Math.hypot(px, py, pz) > EARTH_KM;
}

export function predictPasses(
  line1: string,
  line2: string,
  lat: number,
  lon: number,
  fromMs: number,
  hours = 48,
  minElevation = 10,
  stepS = 20,
): Pass[] {
  const sat = twoline2satrec(line1, line2);
  const observer = { latitude: lat * DEG, longitude: lon * DEG, height: 0 };
  const passes: Pass[] = [];
  let current: { start: number; max: number; maxEl: number; startAz: number; maxAz: number; maxSunlit: boolean } | null = null;
  const steps = Math.ceil((hours * 3600) / stepS);
  for (let i = 0; i <= steps; i++) {
    const ms = fromMs + i * stepS * 1000;
    const minutes = (ms / MS_PER_DAY + 2440587.5 - sat.jdsatepoch) * 1440;
    const pv = sgp4(sat, minutes);
    if (!pv || typeof pv.position !== "object") continue;
    const g = gstime(new Date(ms));
    const look = ecfToLookAngles(observer, eciToEcf(pv.position, g));
    const el = look.elevation / DEG;
    const az = ((look.azimuth / DEG) % 360 + 360) % 360;
    if (el > 0) {
      if (!current) current = { start: ms, max: ms, maxEl: el, startAz: az, maxAz: az, maxSunlit: false };
      if (el > current.maxEl) {
        current.maxEl = el;
        current.max = ms;
        current.maxAz = az;
        current.maxSunlit = sunlit(pv.position, sunPosition(ms).eci);
      }
    } else if (current) {
      if (current.maxEl >= minElevation) {
        // Dark enough at the observer: Sun more than 6° below the horizon at the pass's peak.
        const sunEci = sunPosition(current.max).eci;
        const sunEcf = eciToEcf({ x: sunEci[0] * 1.5e8, y: sunEci[1] * 1.5e8, z: sunEci[2] * 1.5e8 }, gstime(new Date(current.max)));
        const sunEl = ecfToLookAngles(observer, sunEcf).elevation / DEG;
        passes.push({
          start: current.start,
          max: current.max,
          end: ms,
          maxElevation: Math.round(current.maxEl),
          startAzimuth: Math.round(current.startAz),
          maxAzimuth: Math.round(current.maxAz),
          endAzimuth: Math.round(az),
          visible: sunEl < -6 && current.maxSunlit,
        });
      }
      current = null;
    }
  }
  return passes;
}

/** Compass point for an azimuth in degrees. */
export function compass(az: number): string {
  const points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return points[Math.round((((az % 360) + 360) % 360) / 45) % 8];
}
