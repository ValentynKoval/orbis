/**
 * Space weather from NOAA SWPC's summary products: the latest solar wind speed
 * and interplanetary magnetic field at L1 (DSCOVR/ACE/IMAP), a few numbers each.
 */

export interface SolarWind {
  /** km/s */
  speed: number;
  /** Total field, nT. */
  bt: number;
  /** North–south component (GSM), nT: strongly negative lets the wind couple into the magnetosphere. */
  bz: number;
  /** Unix ms of the newest reading. */
  time: number;
}

export const SWPC_SPEED = "https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json";
export const SWPC_MAG = "https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json";

export function parseSolarWind(speed: unknown, mag: unknown): SolarWind | null {
  const s = Array.isArray(speed) ? (speed[0] as { proton_speed?: unknown; time_tag?: unknown } | undefined) : undefined;
  const m = Array.isArray(mag) ? (mag[0] as { bt?: unknown; bz_gsm?: unknown; time_tag?: unknown } | undefined) : undefined;
  if (!s || !m) return null;
  const v = Number(s.proton_speed);
  const bt = Number(m.bt);
  const bz = Number(m.bz_gsm);
  const time = Date.parse(String(s.time_tag ?? m.time_tag ?? ""));
  if (!Number.isFinite(v) || !Number.isFinite(bt) || !Number.isFinite(bz) || !Number.isFinite(time)) return null;
  return { speed: v, bt, bz, time };
}
