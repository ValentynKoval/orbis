/**
 * Tropical cyclones from GDACS, the UN and European Commission's Global Disaster Alert and Coordination
 * System: every storm now active, with its observed track, the official forecast and the cone of
 * uncertainty, boiled down from GDACS's event geometry (a few hundred kilobytes each) to a few kilobytes.
 */

export interface StormPoint {
  /** Unix ms. */
  t: number;
  lat: number;
  lon: number;
}

export interface Storm {
  id: number;
  /** "Vance", from GDACS's "VANCE-26". */
  name: string;
  alert: "green" | "orange" | "red";
  /** Strongest sustained wind over the storm's life, km/h. */
  windKmh: number;
  countries: string[];
  /** Observed and forecast centres, in time order. */
  track: StormPoint[];
  /** Outline of the forecast cone as [lon, lat] pairs; empty when there is none. */
  cone: [number, number][];
  report: string;
}

interface GdacsProps {
  eventid: number;
  eventname: string;
  alertlevel: string;
  fromdate: string;
  Class?: string;
  polygonlabel?: string;
  url?: { report?: string };
  affectedcountries?: { countryname: string }[];
  severitydata?: { severity?: number };
}
interface GdacsFeature {
  properties: GdacsProps;
  geometry: { type: string; coordinates: unknown };
}

const round = (x: number) => Math.round(x * 100) / 100;

/** "21/10 15:00 UTC" in the year that puts it nearest the storm's start. */
function labelTime(label: string, from: number): number | null {
  const m = label.match(/^(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2})/);
  if (!m) return null;
  const year = new Date(from).getUTCFullYear();
  const at = (y: number) => Date.UTC(y, Number(m[2]) - 1, Number(m[1]), Number(m[3]), Number(m[4]));
  return [year - 1, year, year + 1].map(at).reduce((a, b) => (Math.abs(b - from) < Math.abs(a - from) ? b : a));
}

function title(name: string): string {
  const base = name.replace(/-\d+$/, "").toLowerCase();
  return base.replace(/(^|[\s-])\p{L}/gu, (c) => c.toUpperCase());
}

/** One storm from its event-list entry and its geometry collection. */
export function parseStorm(event: GdacsProps, geometry: { features: GdacsFeature[] }): Storm | null {
  const from = Date.parse(event.fromdate + "Z");
  const track: StormPoint[] = [];
  let cone: [number, number][] = [];
  for (const f of geometry.features) {
    const cls = f.properties.Class ?? "";
    if (cls.startsWith("Point_Polygon_Point") && f.geometry.type === "Polygon") {
      // Each track point comes as a small circle around the centre.
      const ring = (f.geometry.coordinates as [number, number][][])[0].slice(0, -1);
      const t = labelTime(f.properties.polygonlabel ?? "", from);
      if (!ring.length || t === null) continue;
      const lon = ring.reduce((s, p) => s + p[0], 0) / ring.length;
      const lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
      track.push({ t, lat: round(lat), lon: round(lon) });
    } else if (cls === "Poly_Cones" && f.geometry.type === "Polygon") {
      const ring = (f.geometry.coordinates as [number, number][][])[0];
      const stride = Math.max(1, Math.ceil(ring.length / 120));
      cone = ring.filter((_, i) => i % stride === 0).map(([lon, lat]) => [round(lon), round(lat)]);
    }
  }
  if (!track.length) return null;
  track.sort((a, b) => a.t - b.t);
  const alert = event.alertlevel.toLowerCase();
  return {
    id: event.eventid,
    name: title(event.eventname),
    alert: alert === "red" || alert === "orange" ? alert : "green",
    windKmh: Math.round(event.severitydata?.severity ?? 0),
    countries: (event.affectedcountries ?? []).map((c) => c.countryname),
    track,
    cone,
    report: event.url?.report ?? "https://www.gdacs.org",
  };
}

/**
 * Saffir–Simpson category from the strongest sustained wind in km/h: -1 for a tropical depression, 0 for a
 * tropical storm, 1 to 5 for a hurricane, typhoon or cyclone of that category.
 */
export function stormCategory(windKmh: number): number {
  if (windKmh < 63) return -1;
  if (windKmh < 119) return 0;
  return [154, 178, 209, 252].filter((limit) => windKmh >= limit).length + 1;
}

/** Where the storm's centre is at `time`, along its track; null outside the track's span. */
export function stormAt(storm: Storm, time: number): { lat: number; lon: number } | null {
  const tr = storm.track;
  if (!tr.length || time < tr[0].t || time > tr[tr.length - 1].t) return null;
  for (let i = 1; i < tr.length; i++) {
    if (time <= tr[i].t) {
      const a = tr[i - 1];
      const b = tr[i];
      const k = b.t === a.t ? 0 : (time - a.t) / (b.t - a.t);
      let dl = b.lon - a.lon;
      if (dl > 180) dl -= 360;
      if (dl < -180) dl += 360;
      return { lat: a.lat + (b.lat - a.lat) * k, lon: ((a.lon + dl * k + 540) % 360) - 180 };
    }
  }
  return { lat: tr[0].lat, lon: tr[0].lon };
}
