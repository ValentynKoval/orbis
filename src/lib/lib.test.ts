import { describe, expect, it } from "vitest";
import { gmst, julianDate, normalizeLon, sunPosition } from "./astro";
import { advanceOrbit, haversineKm, latLonToVec, moveAlong, vecToLatLon, type Vec3 } from "./geo";
import { parseUsgs } from "./feeds/quakes";
import { parseFirmsCsv } from "./feeds/fires";
import { classify, parseTle, SatGroup } from "./feeds/satellites";

const DEG = Math.PI / 180;

describe("astro", () => {
  it("computes the Julian date of the J2000 epoch", () => {
    expect(julianDate(Date.UTC(2000, 0, 1, 12))).toBeCloseTo(2451545.0, 6);
  });

  it("matches the published GMST at J2000", () => {
    expect(gmst(Date.UTC(2000, 0, 1, 12)) / DEG).toBeCloseTo(280.46061837, 3);
  });

  it("puts the sub-solar point on the tropic at the June solstice", () => {
    const sun = sunPosition(Date.UTC(2024, 5, 20, 20, 51));
    expect(sun.lat).toBeCloseTo(23.44, 1);
  });

  it("puts the sub-solar point on the equator near Greenwich at an equinox noon", () => {
    const sun = sunPosition(Date.UTC(2024, 2, 20, 12));
    expect(Math.abs(sun.lat)).toBeLessThan(0.5);
    expect(Math.abs(sun.lon)).toBeLessThan(3);
  });

  it("wraps longitudes into [-180, 180)", () => {
    expect(normalizeLon(190)).toBe(-170);
    expect(normalizeLon(-190)).toBe(170);
    expect(normalizeLon(540)).toBe(-180);
  });
});

describe("geo", () => {
  it("maps longitude 0 to +X and 90°E to −Z", () => {
    const a = latLonToVec(0, 0);
    const b = latLonToVec(0, 90);
    expect(a[0]).toBeCloseTo(1);
    expect(b[2]).toBeCloseTo(-1);
    expect(latLonToVec(90, 0)[1]).toBeCloseTo(1);
  });

  it("round-trips lat/lon through scene vectors", () => {
    const { lat, lon, r } = vecToLatLon(latLonToVec(50.45, 30.52, 1.2));
    expect(lat).toBeCloseTo(50.45, 6);
    expect(lon).toBeCloseTo(30.52, 6);
    expect(r).toBeCloseTo(1.2, 6);
  });

  it("measures Kyiv–Chernihiv as ~125 km", () => {
    expect(haversineKm(50.45, 30.52, 51.49, 31.29)).toBeGreaterThan(120);
    expect(haversineKm(50.45, 30.52, 51.49, 31.29)).toBeLessThan(135);
  });

  it("advances a circular orbit by exactly ω·dt", () => {
    const r = 1.066; // ~420 km altitude in Earth radii
    const speed = 7.66 / 6371; // radii per second
    const p: Vec3 = [r, 0, 0];
    const v: Vec3 = [0, 0, -speed];
    const quarter = (Math.PI / 2) * (r / speed);
    const q = advanceOrbit(p, v, quarter);
    expect(q[0]).toBeCloseTo(0, 6);
    expect(q[2]).toBeCloseTo(-r, 6);
    expect(Math.hypot(...q)).toBeCloseTo(r, 9);
  });
});

describe("feeds", () => {
  it("parses USGS GeoJSON, de-duplicates and sorts newest first", () => {
    const feature = (id: string, time: number, mag: number | null, type = "earthquake") => ({
      id,
      properties: { mag, place: "Somewhere", time, url: `https://x/${id}`, tsunami: 0, alert: null, type },
      geometry: { coordinates: [10, 20, 33.3] as [number, number, number] },
    });
    const quakes = parseUsgs(
      { features: [feature("a", 1, 4.55), feature("b", 3, 2), feature("c", 2, null)] },
      { features: [feature("a", 1, 4.55), feature("d", 4, 1.2, "quarry blast")] },
    );
    expect(quakes.map((q) => q.id)).toEqual(["b", "a"]);
    expect(quakes[1]).toMatchObject({ lat: 20, lon: 10, depthKm: 33.3, mag: 4.6 });
  });

  it("grids FIRMS detections and drops low confidence", () => {
    const csv = [
      "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight",
      "10.001,20.001,300,0.5,0.5,2026-10-20,0105,N20,nominal,2.0NRT,290,3.5,N",
      "10.002,20.002,300,0.5,0.5,2026-10-20,0230,N20,high,2.0NRT,290,1.5,N",
      "10.002,20.002,300,0.5,0.5,2026-10-20,0230,N20,low,2.0NRT,290,100,N",
      "-33.9,151.2,300,0.5,0.5,2026-10-20,1200,N20,nominal,2.0NRT,290,12,D",
      "",
    ].join("\n");
    const grid = parseFirmsCsv(csv);
    expect(grid.lat).toHaveLength(2);
    expect(grid.frp[0]).toBe(5);
    expect(grid.minutes[0]).toBe(85);
    expect(grid.start).toBe(Date.UTC(2026, 9, 20, 1, 5));
    expect(grid.end).toBe(Date.UTC(2026, 9, 20, 12, 0));
  });

  it("parses three-line elements and classifies families", () => {
    const tle = [
      "ISS (ZARYA)             ",
      "1 25544U 98067A   26294.04791052  .00009575  00000+0  18188-3 0  9995",
      "2 25544  51.6327  37.2623 0006760 289.5321  70.4938 15.48967427591265",
      "STARLINK-1007",
      "1 44713U 19074A   26294.50000000  .00001000  00000+0  10000-3 0  9990",
      "2 44713  53.0540 100.0000 0001000  90.0000 270.0000 15.06400000300000",
      "INTELSAT 901",
      "1 26824U 01024A   26294.50000000  .00000000  00000+0  00000+0 0  9990",
      "2 26824   0.0100 100.0000 0002000  90.0000 270.0000  1.00270000 90000",
    ].join("\r\n");
    const recs = parseTle(tle);
    expect(recs.map((r) => r.norad)).toEqual([25544, 44713, 26824]);
    expect(recs.map(classify)).toEqual([SatGroup.Station, SatGroup.Starlink, SatGroup.Geostationary]);
  });
});

describe("great-circle motion", () => {
  it("moves north from the equator to the pole after a quarter turn", () => {
    const [x, y] = moveAlong(0, 0, 0, Math.PI / 2);
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBeCloseTo(1, 9);
  });

  it("moves east along the equator", () => {
    const p = moveAlong(0, 0, Math.PI / 2, Math.PI / 2, 2);
    expect(p[2]).toBeCloseTo(-2, 9);
  });
});
