/**
 * NASA FIRMS active-fire CSV → gridded hotspots. VIIRS pixels are 375 m and a
 * single burning area produces dozens of adjacent detections; at globe scale
 * merging them into ~4 km cells keeps the picture and cuts the payload ~3×.
 */

export interface FireGrid {
  /** Unix ms of the earliest detection; `minutes` are relative to it. */
  start: number;
  /** Unix ms of the latest detection. */
  end: number;
  /** Flat arrays, one entry per cell. Coordinates are degrees × 100. */
  lat: number[];
  lon: number[];
  /** Summed fire radiative power, MW (rounded). */
  frp: number[];
  /** Minutes after `start` of the latest detection in the cell. */
  minutes: number[];
}

export const FIRE_CELL_DEG = 0.04;

function detectionTime(date: string, hhmm: string): number {
  const t = hhmm.padStart(4, "0");
  return Date.parse(`${date}T${t.slice(0, 2)}:${t.slice(2)}:00Z`);
}

export function parseFirmsCsv(csv: string): FireGrid {
  const lines = csv.split("\n");
  const header = lines[0].trim().split(",");
  const col = (name: string) => header.indexOf(name);
  const iLat = col("latitude");
  const iLon = col("longitude");
  const iDate = col("acq_date");
  const iTime = col("acq_time");
  const iFrp = col("frp");
  const iConf = col("confidence");
  if (iLat < 0 || iLon < 0 || iDate < 0 || iTime < 0 || iFrp < 0) throw new Error("Unexpected FIRMS CSV header");

  const cells = new Map<number, { lat: number; lon: number; frp: number; n: number; t: number }>();
  let start = Infinity;
  let end = -Infinity;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = line.split(",");
    // VIIRS uses low/nominal/high, MODIS 0–100. Low-confidence pixels are mostly sun glint and hot surfaces.
    const conf = iConf >= 0 ? c[iConf] : "";
    if (conf === "l" || conf === "low" || (/^\d+$/.test(conf) && Number(conf) < 30)) continue;
    const lat = Number(c[iLat]);
    const lon = Number(c[iLon]);
    const frp = Number(c[iFrp]) || 0;
    const t = detectionTime(c[iDate], c[iTime].trim());
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(t)) continue;
    const gy = Math.floor((lat + 90) / FIRE_CELL_DEG);
    const gx = Math.floor((lon + 180) / FIRE_CELL_DEG);
    const key = gy * 100_000 + gx;
    const cell = cells.get(key);
    if (cell) {
      cell.lat += lat;
      cell.lon += lon;
      cell.frp += frp;
      cell.n++;
      cell.t = Math.max(cell.t, t);
    } else {
      cells.set(key, { lat, lon, frp, n: 1, t });
    }
    start = Math.min(start, t);
    end = Math.max(end, t);
  }

  const out: FireGrid = { start: Number.isFinite(start) ? start : 0, end: Number.isFinite(end) ? end : 0, lat: [], lon: [], frp: [], minutes: [] };
  for (const cell of cells.values()) {
    out.lat.push(Math.round((cell.lat / cell.n) * 100));
    out.lon.push(Math.round((cell.lon / cell.n) * 100));
    out.frp.push(Math.round(cell.frp));
    out.minutes.push(Math.round((cell.t - out.start) / 60_000));
  }
  return out;
}
