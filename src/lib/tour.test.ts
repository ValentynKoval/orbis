import { describe, expect, it } from "vitest";
import { busiestRegion, nightSpot, strongestQuake } from "./tour";
import type { Quake } from "./feeds/quakes";

const quake = (id: string, mag: number, time: number): Quake => ({
  id,
  mag,
  time,
  lat: 0,
  lon: 0,
  depthKm: 10,
  place: "",
  url: "",
  tsunami: false,
  alert: null,
});

describe("tour", () => {
  it("picks the strongest quake inside the window only", () => {
    const now = 10 * 86_400_000;
    const q = strongestQuake([quake("old", 7, now - 2 * 86_400_000), quake("a", 4.1, now - 1000), quake("b", 5.2, now - 5000)], now);
    expect(q?.id).toBe("b");
  });

  it("finds the box with most fire cells", () => {
    const spot = busiestRegion({ lat: [-1050, -1060, -1070, 4000], lon: [2550, 2560, 2570, 1000] });
    expect(spot?.lat).toBeCloseTo(-10.6, 5);
    expect(spot?.lon).toBeCloseTo(25.6, 5);
  });

  it("chooses a lit region on the night side", () => {
    // Sun over the Pacific: Europe and South Asia are in night; pick one of the dark ones.
    const spot = nightSpot({ lat: 0, lon: -150 });
    expect([12, 80, 115, 35]).toContain(spot.lon);
  });
});
