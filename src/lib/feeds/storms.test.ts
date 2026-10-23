import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseStorm, stormAt, stormCategory } from "./storms";

// GDACS geometry of Tropical Storm Vance, 23 October 2026 (track circles and cone thinned out). Each track
// point is a small circle around the centre, which the parser averages back.
const geometry = JSON.parse(readFileSync(new URL("../fixtures/gdacs-tc-vance.json", import.meta.url), "utf8"));
const event = geometry.features.find((f: { properties: { Class: string } }) => f.properties.Class === "Point_Centroid").properties;

describe("parseStorm", () => {
  const storm = parseStorm(event, geometry)!;

  it("names the storm and keeps its alert, wind and countries", () => {
    expect(storm).toMatchObject({ id: 1001341, name: "Vance", alert: "green", windKmh: 194, countries: ["Mexico"] });
  });

  it("reads the track in time order, with the year from the storm's start", () => {
    expect(storm.track).toHaveLength(14);
    expect(storm.track[0]).toEqual({ t: Date.UTC(2026, 9, 21, 15), lat: 9.5, lon: -99.3 });
    expect(storm.track.at(-1)).toEqual({ t: Date.UTC(2026, 9, 27, 18), lat: 17, lon: -104.5 });
    for (let i = 1; i < storm.track.length; i++) expect(storm.track[i].t).toBeGreaterThan(storm.track[i - 1].t);
  });

  it("keeps a light outline of the forecast cone", () => {
    expect(storm.cone.length).toBeGreaterThan(20);
    expect(storm.cone.length).toBeLessThanOrEqual(121);
  });
});

describe("stormAt", () => {
  const storm = parseStorm(event, geometry)!;

  it("interpolates between track points and is absent outside the track", () => {
    const mid = stormAt(storm, Date.UTC(2026, 9, 21, 18))!;
    expect(mid.lat).toBeCloseTo((9.5 + 9.4) / 2, 2);
    expect(mid.lon).toBeCloseTo((-99.3 + -99.8) / 2, 2);
    expect(stormAt(storm, Date.UTC(2026, 9, 20))).toBeNull();
    expect(stormAt(storm, Date.UTC(2026, 9, 29))).toBeNull();
  });

  it("crosses the date line the short way", () => {
    const pacific = { ...storm, track: [{ t: 0, lat: 10, lon: 179 }, { t: 10, lat: 10, lon: -179 }] };
    expect(stormAt(pacific, 5)!.lon).toBeCloseTo(-180, 5);
  });
});

describe("stormCategory", () => {
  it("follows the Saffir–Simpson scale in km/h", () => {
    expect([50, 63, 118, 119, 153, 154, 178, 209, 251, 252, 296].map(stormCategory)).toEqual([-1, 0, 0, 1, 1, 2, 3, 4, 4, 5, 5]);
  });
});
