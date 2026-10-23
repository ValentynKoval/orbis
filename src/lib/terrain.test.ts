import { describe, expect, it } from "vitest";
import { decodeTerrarium, gridFromTerrarium, sampleGrid, TERRAIN_GRID, terrainTileFor, tileUv } from "./terrain";
import { tileAt } from "./tiles";

describe("terrain grids", () => {
  it("decodes Terrarium colours", () => {
    expect(decodeTerrarium(128, 0, 0)).toBe(0);
    // Everest: 8849 m → 32768 + 8849 = 41617 = 162 × 256 + 145.
    expect(decodeTerrarium(162, 145, 0)).toBe(8849);
  });

  it("samples an image onto the grid with rows south → north", () => {
    const size = 4;
    const px = new Uint8Array(size * size * 3);
    // Top image row (north) at 1000 m, the rest at sea level.
    for (let i = 0; i < size * size; i++) {
      const north = i < size;
      const h = (north ? 1000 : 0) + 32768;
      px.set([Math.floor(h / 256), h % 256, 0], i * 3);
    }
    const grid = gridFromTerrarium(px, size, 3);
    const n = TERRAIN_GRID + 1;
    expect(grid[0]).toBe(0); // south-west
    expect(grid[(n - 1) * n]).toBe(1000); // north-west
    expect(sampleGrid(grid, 0.5, 1)).toBe(1000);
    expect(sampleGrid(grid, 0.5, 0)).toBe(0);
  });

  it("maps imagery tiles to the grid three levels up, at least 8 and at most 12", () => {
    expect(terrainTileFor(7, 1, 1)).toBeNull();
    expect(terrainTileFor(9, 300, 150)).toEqual({ z: 8, x: 150, y: 75 });
    expect(terrainTileFor(14, 4004, 3212)).toEqual({ z: 11, x: 500, y: 401 });
    expect(terrainTileFor(18, 64064, 51392)).toEqual({ z: 12, x: 1001, y: 803 });
  });

  it("puts a point inside its own tile", () => {
    const { x, y } = tileAt(12, 27.9881, 86.925);
    const { u, v } = tileUv(12, x, y, 27.9881, 86.925);
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThanOrEqual(1);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});
