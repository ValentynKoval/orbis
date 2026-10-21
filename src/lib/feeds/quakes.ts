/** USGS earthquake GeoJSON → the compact shape the globe needs. */

export interface Quake {
  id: string;
  lat: number;
  lon: number;
  depthKm: number;
  mag: number;
  /** Unix ms. */
  time: number;
  place: string;
  url: string;
  tsunami: boolean;
  /** USGS PAGER alert level, if any. */
  alert: "green" | "yellow" | "orange" | "red" | null;
}

interface UsgsFeature {
  id: string;
  properties: {
    mag: number | null;
    place: string | null;
    time: number;
    url: string;
    tsunami: number;
    alert: string | null;
    type: string;
  };
  geometry: { coordinates: [number, number, number] } | null;
}

const ALERTS = new Set(["green", "yellow", "orange", "red"]);

export function parseUsgs(...collections: { features: UsgsFeature[] }[]): Quake[] {
  const byId = new Map<string, Quake>();
  for (const fc of collections) {
    for (const f of fc.features) {
      const p = f.properties;
      if (!f.geometry || p.mag === null || p.type !== "earthquake") continue;
      const [lon, lat, depth] = f.geometry.coordinates;
      byId.set(f.id, {
        id: f.id,
        lat,
        lon,
        depthKm: Math.max(0, Math.round(depth * 10) / 10),
        mag: Math.round(p.mag * 10) / 10,
        time: p.time,
        place: p.place ?? "",
        url: p.url,
        tsunami: p.tsunami === 1,
        alert: p.alert && ALERTS.has(p.alert) ? (p.alert as Quake["alert"]) : null,
      });
    }
  }
  return [...byId.values()].sort((a, b) => b.time - a.time);
}
