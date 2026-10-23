/**
 * Compact terrain: heights in metres on a (TERRAIN_GRID+1)² grid per Web
 * Mercator tile, little-endian Int16, rows south → north. The site serves
 * these from /api/terrain/{z}/{x}/{y}, decoded once from Mapzen Terrarium
 * PNGs and cached on the CDN forever: about 8 KB per tile instead of 120 KB.
 */
import { latToMercator, tileBounds } from "./tiles";

export const TERRAIN_GRID = 64;
export const TERRAIN_MIN_LEVEL = 8;
/** Deeper imagery samples this level's grid (~150 m spacing at the equator, ~100 m at 50°). */
export const TERRAIN_MAX_LEVEL = 12;
/** Bumped when the grid format changes, so caches never mix sizes. */
export const TERRAIN_VERSION = 2;

/** Terrarium encoding: (R × 256 + G + B / 256) − 32768 metres. */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Samples a decoded Terrarium image (RGB(A), `size`² pixels, rows north → south) onto the grid. */
export function gridFromTerrarium(pixels: Uint8Array | Uint8ClampedArray, size: number, channels: number): Int16Array {
  const n = TERRAIN_GRID + 1;
  const out = new Int16Array(n * n);
  for (let r = 0; r < n; r++) {
    const py = Math.min(size - 1, Math.round((1 - r / TERRAIN_GRID) * (size - 1)));
    for (let c = 0; c < n; c++) {
      const px = Math.min(size - 1, Math.round((c / TERRAIN_GRID) * (size - 1)));
      const k = (py * size + px) * channels;
      out[r * n + c] = Math.max(-32768, Math.min(32767, Math.round(decodeTerrarium(pixels[k], pixels[k + 1], pixels[k + 2]))));
    }
  }
  return out;
}

/**
 * Bilinear height at a point inside a terrain tile. `u` runs west → east and
 * `v` south → north in Mercator space, both 0…1.
 */
export function sampleGrid(grid: Int16Array, u: number, v: number): number {
  const n = TERRAIN_GRID + 1;
  const gx = Math.max(0, Math.min(1, u)) * TERRAIN_GRID;
  const gy = Math.max(0, Math.min(1, v)) * TERRAIN_GRID;
  const x0 = Math.min(TERRAIN_GRID - 1, Math.floor(gx));
  const y0 = Math.min(TERRAIN_GRID - 1, Math.floor(gy));
  const fx = gx - x0;
  const fy = gy - y0;
  const h = (r: number, c: number) => grid[r * n + c];
  const bottom = h(y0, x0) * (1 - fx) + h(y0, x0 + 1) * fx;
  const top = h(y0 + 1, x0) * (1 - fx) + h(y0 + 1, x0 + 1) * fx;
  return bottom * (1 - fy) + top * fy;
}

/** Where a point falls in tile (z, x, y): u west → east, v south → north (Mercator). */
export function tileUv(z: number, x: number, y: number, lat: number, lon: number): { u: number; v: number } {
  const b = tileBounds(z, x, y);
  const m = (l: number) => latToMercator(Math.max(-85.0511, Math.min(85.0511, l)));
  return { u: (lon - b.west) / (b.east - b.west), v: (m(lat) - m(b.south)) / (m(b.north) - m(b.south)) };
}

/**
 * The terrain tile whose grid serves imagery tile (z, x, y), or null above the terrain range. One grid
 * of 65 × 65 heights serves the 64 imagery tiles three levels down (8 × 8 samples each, close to the
 * 12 × 12 mesh), so ridges keep their shape in a tilted view and a screenful of imagery still needs
 * only a handful of terrain requests.
 */
export function terrainTileFor(z: number, x: number, y: number): { z: number; x: number; y: number } | null {
  if (z < TERRAIN_MIN_LEVEL) return null;
  const tz = Math.max(TERRAIN_MIN_LEVEL, Math.min(z - 3, TERRAIN_MAX_LEVEL));
  const s = 2 ** (z - tz);
  return { z: tz, x: Math.floor(x / s), y: Math.floor(y / s) };
}
