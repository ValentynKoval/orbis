import { describe, expect, it } from "vitest";
import { sunPosition } from "./astro";
import { moonPhase, moonPosition, orbitPath, planetPosition, smallBodyPosition, solveKepler } from "./orbits";

const angleBetween = (a: number[], b: number[]) => {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return (Math.acos(Math.max(-1, Math.min(1, dot / (Math.hypot(...a) * Math.hypot(...b))))) * 180) / Math.PI;
};

describe("Kepler solver", () => {
  it("solves elliptic and hyperbolic cases", () => {
    const E = solveKepler(1.2, 0.3);
    expect(E - 0.3 * Math.sin(E)).toBeCloseTo(1.2, 10);
    const F = solveKepler(2.5, 1.4);
    expect(1.4 * Math.sinh(F) - F).toBeCloseTo(2.5, 9);
  });
});

describe("planets", () => {
  it("puts the Sun where the solar ephemeris does", () => {
    for (const ms of [Date.UTC(2024, 2, 20, 3), Date.UTC(2026, 9, 21, 12), Date.UTC(2030, 6, 1)]) {
      const earth = planetPosition("earth", ms);
      const sunFromEarth = [-earth[0], -earth[1], -earth[2]];
      expect(angleBetween(sunFromEarth, sunPosition(ms).eci)).toBeLessThan(0.5);
    }
  });

  it("keeps planets at their known distances", () => {
    const ms = Date.UTC(2026, 9, 21);
    expect(Math.hypot(...planetPosition("earth", ms))).toBeCloseTo(1, 1);
    expect(Math.hypot(...planetPosition("jupiter", ms))).toBeGreaterThan(4.9);
    expect(Math.hypot(...planetPosition("jupiter", ms))).toBeLessThan(5.5);
    expect(Math.hypot(...planetPosition("neptune", ms))).toBeGreaterThan(29.5);
  });
});

describe("Moon", () => {
  it("is opposite the Sun at full moon and with it at new moon", () => {
    expect(moonPhase(Date.UTC(2024, 0, 25, 17, 54)).illuminated).toBeGreaterThan(0.99);
    expect(moonPhase(Date.UTC(2024, 0, 11, 11, 57)).illuminated).toBeLessThan(0.01);
    expect(moonPhase(Date.UTC(2024, 0, 18, 3, 53)).phase).toBeCloseTo(0.25, 1);
  });

  it("stays between 356,000 and 407,000 km", () => {
    for (let d = 0; d < 60; d += 3) {
      const km = Math.hypot(...moonPosition(Date.UTC(2026, 0, 1 + d))) * 149_597_870.7;
      expect(km).toBeGreaterThan(356_000);
      expect(km).toBeLessThan(407_000);
    }
  });
});

describe("small bodies", () => {
  // 1P/Halley, JPL SBDB osculating elements (epoch 1968, last perihelion 1986-02-09).
  const halley = { e: 0.9679, q: 0.575, i: 162.19, om: 59.1, w: 112.24, tp: 2446469.97, epoch: 2439875.5 };

  it("places Halley near perihelion distance at its 1986 passage", () => {
    const ms = (halley.tp - 2440587.5) * 86_400_000;
    const p = smallBodyPosition(halley, ms)!;
    expect(Math.hypot(...p)).toBeCloseTo(0.575, 2);
  });

  it("has Halley far out in 2026", () => {
    const r = Math.hypot(...smallBodyPosition(halley, Date.UTC(2026, 9, 21))!);
    expect(r).toBeGreaterThan(30);
    expect(r).toBeLessThan(36);
  });

  it("handles asteroids given by mean anomaly", () => {
    const ceres = { e: 0.0797, a: 2.766, i: 10.59, om: 80.25, w: 73.29, ma: 274.42, epoch: 2461200.5 };
    const r = Math.hypot(...smallBodyPosition(ceres, Date.UTC(2026, 9, 21))!);
    expect(r).toBeGreaterThan(2.5);
    expect(r).toBeLessThan(3.0);
  });

  it("draws a closed ellipse and an open hyperbola", () => {
    const ellipse = orbitPath(halley, 90);
    expect(ellipse).toHaveLength(91);
    expect(angleBetween(ellipse[0], ellipse[90])).toBeLessThan(1e-6);
    const hyper = orbitPath({ e: 1.0008, q: 1.2, i: 10, om: 20, w: 30, tp: 2461000, epoch: 2461000 }, 40, 20);
    expect(hyper).toHaveLength(41);
    expect(Math.hypot(...hyper[0])).toBeGreaterThan(15);
  });
});
