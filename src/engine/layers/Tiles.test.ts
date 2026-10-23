import { describe, expect, it } from "vitest";
import { earthFragment } from "../shaders";
import { tilesFragment } from "./Tiles";

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
