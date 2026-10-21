import { describe, expect, it } from "vitest";
import { parseApproaches, pickComets } from "./bodies";

describe("small bodies", () => {
  it("keeps famous comets first, then the ones active now", () => {
    const now = Date.UTC(2026, 9, 21);
    const jd = now / 86_400_000 + 2440587.5;
    const row = (name: string, tp: number, q = "0.8", m1 = "9") => [name, "0.97", q, "10", "20", "30", String(tp), String(jd), "70", m1];
    const rows = [
      row("    C/2030 X1 (Nobody)", jd + 2000, "0.5", "5"),
      row("    C/2026 Z9 (Bright)", jd + 100, "0.6", "4"),
      row("    1P/Halley", jd - 14000),
      row("    C/2026 Z8 (Faint)", jd + 50, "0.9", "12"),
      row("    C/2026 Z7 (Far)", jd + 30, "4.0", "3"),
    ];
    const picked = pickComets(rows, now).map((c) => c.name);
    expect(picked[0]).toBe("1P/Halley");
    expect(picked.slice(1)).toEqual(["C/2026 Z9 (Bright)", "C/2026 Z8 (Faint)"]);
  });

  it("converts close approaches to lunar distances and size ranges", () => {
    const [a] = parseApproaches([["2026 TV8", "5", "2461335.491150368", "2026-Oct-21 23:47", "0.0122120539960712", "0.012", "0.0123", "9.2043", "9.18", "< 00:01", "25.766"]]);
    expect(a.name).toBe("2026 TV8");
    expect(a.distanceLd).toBeCloseTo(4.75, 1);
    expect(a.distanceKm).toBeGreaterThan(1_800_000);
    expect(a.velocityKms).toBe(9.2);
    expect(a.diameterM[0]).toBeLessThan(a.diameterM[1]);
    expect(a.diameterM[0]).toBeGreaterThan(10);
    expect(a.diameterM[1]).toBeLessThan(100);
    expect(new Date(a.time).toISOString()).toMatch(/^2026-10-21T23:4/);
  });
});
