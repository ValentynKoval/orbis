import { describe, expect, it } from "vitest";
import { moonNow, skyFor, toHorizontal } from "./skyview";
import { sunPosition } from "./astro";

describe("sky for an observer", () => {
  it("puts the Sun high at local noon and below the horizon at midnight", () => {
    // Kyiv, 21 June 2026: noon sun about 63° up (90 − 50.45 + 23.4), around 09:00 UTC.
    const noon = Date.UTC(2026, 5, 21, 9, 0);
    const s = toHorizontal(sunPosition(noon).eci, 50.45, 30.52, noon);
    expect(s.alt).toBeGreaterThan(58);
    expect(s.alt).toBeLessThan(64);
    expect(s.az).toBeGreaterThan(150);
    expect(s.az).toBeLessThan(210);
    const midnight = Date.UTC(2026, 5, 21, 21, 0);
    expect(skyFor(50.45, 30.52, midnight).sun.alt).toBeLessThan(-10);
  });

  it("names the Moon's phase", () => {
    // Full moon of 31 December 2028 (the total lunar eclipse), new moon of 2 August 2027 (the total solar eclipse).
    expect(moonNow(Date.UTC(2028, 11, 31, 16, 52)).name).toBe("full");
    expect(moonNow(Date.UTC(2027, 7, 2, 10, 7)).name).toBe("new");
    expect(moonNow(Date.UTC(2028, 11, 31, 16, 52)).illuminated).toBeGreaterThan(0.99);
  });

  it("lists the Moon and seven planets, highest first", () => {
    const { objects } = skyFor(0, 0, Date.UTC(2026, 9, 22, 20));
    expect(objects).toHaveLength(8);
    for (let i = 1; i < objects.length; i++) expect(objects[i - 1].alt).toBeGreaterThanOrEqual(objects[i].alt);
  });
});
