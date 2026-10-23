import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { latLonToVec } from "@/lib/geo";
import { TERRAIN_GRID } from "@/lib/terrain";
import { tileAt, type ImageryProvider } from "@/lib/tiles";
import { earthFragment } from "../shaders";
import { TERRAIN_EXAGGERATION, Tiles, tilesFragment } from "./Tiles";

describe("tilesFragment", () => {
  // The tile shader is the planet shader with a few lines swapped; a change to the planet shader must not
  // silently leave a swap behind.
  it("reads the albedo from the tile, with the Blue Marble ocean out at sea", () => {
    expect(tilesFragment).not.toBe(earthFragment);
    expect(tilesFragment).toContain("texture2D(uDay, vTileUv)");
    expect(tilesFragment).toContain("texture2D(uBase, vUv).rgb, smoothstep(0.85, 1.0, water) * uOpenSea)");
    expect(tilesFragment).not.toContain("texture2D(uDay, vUv)");
    expect(tilesFragment).toContain("uFade);");
  });
});

describe("Tiles bounds over relief", () => {
  const provider: ImageryProvider = { id: "test", minLevel: 2, maxLevel: 15, attribution: "", url: () => "" };
  type Probe = {
    node(z: number, x: number, y: number): { radius: number; extent: number; top: number; terrainKey: string | null };
    ensureTerrain(node: unknown): void;
    visible(node: unknown, cam: THREE.Vector3): boolean;
  };
  const peak = 4000;

  afterEach(() => vi.unstubAllGlobals());

  // A tile made after its height grid arrived kept flat bounds: it was culled while its mountain was still on screen.
  it("bounds a tile made after its grid arrived over the peaks", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, arrayBuffer: async () => new Int16Array(TERRAIN_GRID * TERRAIN_GRID).fill(peak).buffer }));
    const tiles = new Tiles([provider], {}, 1, { terrain: true }) as unknown as Probe;
    const first = tiles.node(12, 2136, 1452);
    tiles.ensureTerrain(first);
    await new Promise((r) => setTimeout(r, 0));
    const later = tiles.node(12, 2137, 1452);
    expect(later.terrainKey).toBe(first.terrainKey);
    const relief = (peak * TERRAIN_EXAGGERATION) / 6_371_000;
    expect(later.top).toBeCloseTo(relief);
    expect(later.radius).toBeGreaterThan(later.extent + relief);
  });

  // From a kilometre up the sea-level horizon is ~110 km away, but peaks 200 km off still show over it.
  it("keeps raised tiles beyond the sea-level horizon", () => {
    const tiles = new Tiles([provider], {}, 1, { terrain: true }) as unknown as Probe;
    const lat = 46;
    const z = 12;
    const { x, y } = tileAt(z, lat + 200 / 111, 7.66);
    const node = tiles.node(z, x, y);
    const cam = new THREE.Vector3(...latLonToVec(lat, 7.66, 1 + 1000 / 6_371_000));
    expect(tiles.visible(node, cam)).toBe(false);
    node.top = (peak * TERRAIN_EXAGGERATION) / 6_371_000;
    expect(tiles.visible(node, cam)).toBe(true);
  });
});
