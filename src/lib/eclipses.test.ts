import { describe, expect, it } from "vitest";
import { discOverlap, findEclipses, sunCovered } from "./eclipses";

const at = (iso: string) => Date.parse(iso);

describe("eclipses", () => {
  // NASA Five Millennium Canon, greatest eclipse (UT) and type.
  const list = findEclipses(at("2026-01-01T00:00Z"), at("2029-01-01T00:00Z"));
  const expected: [string, string, string][] = [
    ["solar", "annular", "2026-02-17T12:13Z"],
    ["lunar", "total", "2026-03-03T11:34Z"],
    ["solar", "total", "2026-08-12T17:47Z"],
    ["lunar", "partial", "2026-08-28T04:13Z"],
    ["solar", "annular", "2027-02-06T16:00Z"],
    ["lunar", "penumbral", "2027-02-20T23:13Z"],
    ["solar", "total", "2027-08-02T10:07Z"],
    ["solar", "total", "2028-07-22T02:56Z"],
    ["lunar", "total", "2028-12-31T16:52Z"],
  ];

  it.each(expected)("finds the %s %s eclipse of %s within five minutes", (kind, type, iso) => {
    const hit = list.find((e) => e.kind === kind && Math.abs(e.time - at(iso)) < 5 * 60_000);
    expect(hit?.type).toBe(type);
  });

  it("puts the 2 August 2027 shadow over Luxor", () => {
    const e = list.find((x) => x.kind === "solar" && Math.abs(x.time - at("2027-08-02T10:07Z")) < 3_600_000)!;
    // Within about 100 km of the catalogue (25.5° N, 33.2° E): a spherical Earth and a truncated lunar series.
    expect(Math.abs(e.lat - 25.5)).toBeLessThan(1);
    expect(e.lon).toBeGreaterThan(31);
    expect(e.lon).toBeLessThan(35);
    expect(sunCovered(e.time, e.lat, e.lon)).toBe(1);
    expect(sunCovered(e.time, 50.45, 30.52)).toBeLessThan(0.7);
  });

  it("measures disc overlap", () => {
    expect(discOverlap(2, 1, 0.5)).toBe(0);
    expect(discOverlap(0, 1, 1.05)).toBe(1);
    expect(discOverlap(0, 1, 0.9)).toBeCloseTo(0.81, 5);
    expect(discOverlap(1, 1, 1)).toBeGreaterThan(0.3);
  });
});
