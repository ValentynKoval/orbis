import { describe, expect, it } from "vitest";
import { EOX, esriImagery, latToMercator, mercatorToLat, providerFor, tileAt, tileBounds } from "./tiles";

describe("tiles", () => {
  it("covers the world at zoom 0 and halves each level", () => {
    const root = tileBounds(0, 0, 0);
    expect(root.west).toBe(-180);
    expect(root.east).toBe(180);
    expect(root.north).toBeCloseTo(85.0511, 3);
    const { x, y } = tileAt(10, 50.45, 30.52);
    const kyiv = tileBounds(10, x, y);
    expect(kyiv.east - kyiv.west).toBeCloseTo(360 / 1024, 9);
    expect(kyiv.north - kyiv.south).toBeLessThan(0.25);
  });

  it("round-trips latitude through Mercator", () => {
    for (const lat of [-80, -45, 0, 30, 66.5]) expect(mercatorToLat(latToMercator(lat))).toBeCloseTo(lat, 9);
  });

  it("finds the tile under a point", () => {
    const { x, y } = tileAt(10, 50.45, 30.52);
    const b = tileBounds(10, x, y);
    expect(b.west).toBeLessThanOrEqual(30.52);
    expect(b.east).toBeGreaterThan(30.52);
    expect(b.south).toBeLessThanOrEqual(50.45);
    expect(b.north).toBeGreaterThan(50.45);
  });

  it("picks the provider by level and keeps Esri behind a key", () => {
    expect(providerFor([EOX], 5)?.id).toBe("eox");
    expect(providerFor([EOX], 15)).toBeNull();
    const esri = esriImagery("k");
    expect(providerFor([EOX, esri], 15)?.id).toBe("esri");
    expect(esri.url(15, 2, 3)).toContain("/15/3/2?token=k");
    expect(EOX.url(5, 10, 17)).toBe("https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/5/17/10.jpg");
  });
});
