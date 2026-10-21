import { describe, expect, it } from "vitest";
import { compass, predictPasses } from "./passes";

// ISS element set from 2026-10-21.
const L1 = "1 25544U 98067A   26294.04791052  .00009575  00000+0  18188-3 0  9995";
const L2 = "2 25544  51.6327  37.2623 0006760 289.5321  70.4938 15.48967427591265";

describe("ISS passes", () => {
  const passes = predictPasses(L1, L2, 50.45, 30.52, Date.UTC(2026, 9, 21, 12), 48);

  it("finds a plausible number of passes over Kyiv in two days", () => {
    expect(passes.length).toBeGreaterThanOrEqual(4);
    expect(passes.length).toBeLessThanOrEqual(16);
  });

  it("orders each pass and keeps elevations and durations sane", () => {
    for (const p of passes) {
      expect(p.start).toBeLessThan(p.max);
      expect(p.max).toBeLessThan(p.end);
      expect(p.maxElevation).toBeGreaterThanOrEqual(10);
      expect(p.maxElevation).toBeLessThanOrEqual(90);
      expect((p.end - p.start) / 1000).toBeGreaterThan(60);
      expect((p.end - p.start) / 1000).toBeLessThan(800);
      expect(typeof p.visible).toBe("boolean");
    }
  });

  it("never reports a pass as visible at local midday", () => {
    const noon = passes.filter((p) => {
      const h = new Date(p.max).getUTCHours() + 2; // Kyiv ≈ UTC+2/+3
      return h % 24 >= 10 && h % 24 <= 14;
    });
    for (const p of noon) expect(p.visible).toBe(false);
  });

  it("names compass points", () => {
    expect(compass(0)).toBe("N");
    expect(compass(44)).toBe("NE");
    expect(compass(181)).toBe("S");
    expect(compass(359)).toBe("N");
  });
});
