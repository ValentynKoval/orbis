/** Web Mercator tile arithmetic (XYZ scheme, 256 px tiles, y down from the north). */

export interface TileBounds {
  west: number;
  east: number;
  south: number;
  north: number;
}

const DEG = 180 / Math.PI;

/** Latitude of a Mercator y in [-1, 1] (1 = north edge). */
export function mercatorToLat(my: number): number {
  return Math.atan(Math.sinh(Math.PI * my)) * DEG;
}

export function latToMercator(latDeg: number): number {
  const lat = latDeg / DEG;
  return Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI;
}

export function tileBounds(z: number, x: number, y: number): TileBounds {
  const n = 2 ** z;
  return {
    west: (x / n) * 360 - 180,
    east: ((x + 1) / n) * 360 - 180,
    north: mercatorToLat(1 - (2 * y) / n),
    south: mercatorToLat(1 - (2 * (y + 1)) / n),
  };
}

export function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

/** The tile containing a point at zoom z. */
export function tileAt(z: number, lat: number, lon: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - latToMercator(Math.max(-85.05, Math.min(85.05, lat)))) / 2) * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

export interface ImageryProvider {
  id: string;
  minLevel: number;
  maxLevel: number;
  /** Attribution line required by the provider's licence. */
  attribution: string;
  url(z: number, x: number, y: number): string;
}

/** EOX Sentinel-2 cloudless mosaic: 10 m, CC BY-NC-SA 4.0, no key. */
export const EOX: ImageryProvider = {
  id: "eox",
  minLevel: 2,
  maxLevel: 13,
  attribution: "Sentinel-2 cloudless 2024 by EOX IT Services GmbH (CC BY-NC-SA 4.0), Copernicus Sentinel data",
  url: (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/${z}/${y}/${x}.jpg`,
};

/**
 * Esri World Imagery through ArcGIS Location Platform (free tier, key restricted by referrer): sub-metre.
 * The World_Imagery MapServer endpoint is used on purpose: keys from new Location Platform accounts are
 * rejected by the Static Basemap Tiles service (498 "Token Invalid", an Esri-side bug open since 2026-08)
 * but accepted here, and both bill as basemap tiles.
 */
export function esriImagery(apiKey: string): ImageryProvider {
  return {
    id: "esri",
    minLevel: 14,
    maxLevel: 19,
    attribution: "Esri World Imagery: Esri, Vantor, Earthstar Geographics, and the GIS User Community",
    url: (z, x, y) => `https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}?token=${apiKey}`,
  };
}

/** RainViewer radar composite for one frame; the path changes every 10 minutes. */
export function rainRadar(host: string, path: string): ImageryProvider {
  return {
    id: "rainviewer",
    minLevel: 3,
    maxLevel: 7,
    attribution: "Weather radar: RainViewer",
    url: (z, x, y) => `${host}${path}/256/${z}/${x}/${y}/2/1_1.png`,
  };
}

export function providerFor(providers: ImageryProvider[], z: number): ImageryProvider | null {
  return providers.find((p) => z >= p.minLevel && z <= p.maxLevel) ?? null;
}
