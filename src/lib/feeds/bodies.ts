import type { SmallBodyElements } from "../orbits";

export interface BodyRecord {
  name: string;
  el: SmallBodyElements;
  diameterKm?: number;
  /** Orbital period in years (comets). */
  periodYears?: number;
  /** Absolute total magnitude (comets); smaller is brighter. */
  magnitude?: number;
}

/** Comets everyone has heard of, always included when JPL has elements for them. */
const FAMOUS = ["1P/Halley", "2P/Encke", "67P/Churyumov-Gerasimenko", "C/1995 O1 (Hale-Bopp)", "C/2020 F3 (NEOWISE)", "12P/Pons-Brooks", "C/2023 A3 (Tsuchinshan-ATLAS)", "109P/Swift-Tuttle", "55P/Tempel-Tuttle", "C/2024 G3 (ATLAS)", "C/1996 B2 (Hyakutake)", "19P/Borrelly", "81P/Wild", "103P/Hartley"];

/**
 * From the full JPL comet list (rows in the order full_name, e, q, i, om, w,
 * tp, epoch, per_y, M1) keep the famous ones plus whatever passes perihelion
 * within a year and a half of `now` reasonably close to the Sun.
 */
export function pickComets(rows: string[][], now: number, limit = 60): BodyRecord[] {
  const jdNow = now / 86_400_000 + 2440587.5;
  const out: BodyRecord[] = [];
  const seen = new Set<string>();
  const parsed = rows
    .map((r) => ({
      name: r[0].trim(),
      el: { e: Number(r[1]), q: Number(r[2]), i: Number(r[3]), om: Number(r[4]), w: Number(r[5]), tp: Number(r[6]), epoch: Number(r[7]) },
      periodYears: Number(r[8]) || undefined,
      magnitude: Number(r[9]) || undefined,
    }))
    .filter((c) => Number.isFinite(c.el.e) && Number.isFinite(c.el.q) && Number.isFinite(c.el.tp) && c.el.q > 0);
  const push = (c: (typeof parsed)[number]) => {
    if (seen.has(c.name) || out.length >= limit) return;
    seen.add(c.name);
    out.push(c);
  };
  for (const f of FAMOUS) {
    const c = parsed.find((x) => x.name === f || x.name.startsWith(f + " ") || x.name.startsWith(f + "/"));
    if (c) push(c);
  }
  // Active now: perihelion within ±550 days, inside 2.5 AU, brightest first.
  parsed
    .filter((c) => Math.abs(c.el.tp - jdNow) < 550 && c.el.q < 2.5)
    .sort((a, b) => (a.magnitude ?? 20) - (b.magnitude ?? 20))
    .forEach(push);
  return out;
}

export interface CloseApproach {
  name: string;
  /** Unix ms. */
  time: number;
  /** Lunar distances (1 LD ≈ 384,400 km). */
  distanceLd: number;
  distanceKm: number;
  /** Relative velocity, km/s. */
  velocityKms: number;
  /** Estimated diameter range in metres from the absolute magnitude. */
  diameterM: [number, number];
}

const LD_AU = 0.002569555;

/** Rows of JPL's CAD API (des, orbit_id, jd, cd, dist, dist_min, dist_max, v_rel, v_inf, t_sigma_f, h). */
export function parseApproaches(rows: string[][]): CloseApproach[] {
  return rows.map((r) => {
    const h = Number(r[10]);
    // D = 1329 km / sqrt(albedo) × 10^(−H/5), for albedos 0.25 … 0.05.
    const d = (albedo: number) => Math.round((1329 / Math.sqrt(albedo)) * 10 ** (-h / 5) * 1000);
    const distAu = Number(r[4]);
    return {
      name: r[0],
      time: (Number(r[2]) - 2440587.5) * 86_400_000,
      distanceLd: Math.round((distAu / LD_AU) * 100) / 100,
      distanceKm: Math.round(distAu * 149_597_870.7),
      velocityKms: Math.round(Number(r[7]) * 10) / 10,
      diameterM: [d(0.25), d(0.05)],
    };
  });
}
