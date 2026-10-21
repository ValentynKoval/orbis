/** Three-line element sets → records the propagation worker can consume. */

export interface TleRecord {
  name: string;
  line1: string;
  line2: string;
  norad: number;
}

export function parseTle(text: string): TleRecord[] {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  const out: TleRecord[] = [];
  for (let i = 0; i + 2 < lines.length; ) {
    const name = lines[i];
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (l1?.startsWith("1 ") && l2?.startsWith("2 ")) {
      out.push({ name: name.trim(), line1: l1, line2: l2, norad: Number(l1.slice(2, 7)) });
      i += 3;
    } else {
      i += 1;
    }
  }
  return out;
}

/** Satellite families. The numeric value is what the shader receives. */
export const SatGroup = {
  Station: 0,
  Starlink: 1,
  OneWeb: 2,
  Navigation: 3,
  Geostationary: 4,
  Science: 5,
  Other: 6,
} as const;
export type SatGroup = (typeof SatGroup)[keyof typeof SatGroup];

export const ISS_NORAD = 25544;
const STATIONS = new Set([ISS_NORAD, 48274 /* Tianhe */]);
const SCIENCE = /HUBBLE|HST|SENTINEL|LANDSAT|TERRA|AQUA|SUOMI|NOAA|GOES|METOP|JASON|SWOT|ICESAT|GRACE|CALIPSO|SMAP|OCO/;
const NAVIGATION = /NAVSTAR|GPS|GLONASS|COSMOS 2[45]\d\d|GALILEO|GSAT0|BEIDOU|IRNSS|QZS/;

/** Mean motion (rev/day) from TLE line 2. */
export function meanMotion(line2: string): number {
  return Number(line2.slice(52, 63));
}

export function classify(rec: TleRecord): SatGroup {
  if (STATIONS.has(rec.norad)) return SatGroup.Station;
  const n = rec.name.toUpperCase();
  if (n.startsWith("STARLINK")) return SatGroup.Starlink;
  if (n.startsWith("ONEWEB")) return SatGroup.OneWeb;
  if (NAVIGATION.test(n)) return SatGroup.Navigation;
  const mm = meanMotion(rec.line2);
  if (mm > 0.9 && mm < 1.1) return SatGroup.Geostationary;
  if (SCIENCE.test(n)) return SatGroup.Science;
  return SatGroup.Other;
}
