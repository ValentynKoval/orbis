import { describe, expect, it } from "vitest";
import { inBox, queryAircraft, queryQuakes, queryShips } from "./tools";
import type { PlaneSnapshot, ShipSnapshot } from "../feeds/live";
import { frameAtOrBefore } from "../../engine/layers/Traffic";

const planes: PlaneSnapshot = {
  t: Date.UTC(2026, 9, 21, 12),
  ids: ["a", "b", "c", "d"],
  callsign: ["LOW1", "HIGH1", "GROUND1", "FAR1"],
  reg: ["", "", "", ""],
  type: ["", "", "", ""],
  lat: [500000, 510000, 505000, -335000],
  lon: [100000, 120000, 110000, 1510000],
  alt: [3000, 12000, 0, 13000],
  spd: [1500, 2400, 50, 2500],
  trk: [0, 0, 0, 0],
  vr: [50, 0, 0, -80],
  gnd: [0, 0, 1, 0],
  age: [0, 0, 0, 0],
  cat: ["", "", "", ""],
  squawk: ["", "", "", ""],
  emg: [0, 0, 0, 0],
};

describe("analyst tools", () => {
  it("handles boxes across the antimeridian", () => {
    const box = { south: -10, west: 170, north: 10, east: -170 };
    expect(inBox(0, 175, box)).toBe(true);
    expect(inBox(0, -175, box)).toBe(true);
    expect(inBox(0, 0, box)).toBe(false);
  });

  it("finds the highest airborne aircraft in a box", () => {
    const europe = { south: 35, west: -25, north: 71, east: 45 };
    const r = queryAircraft(planes, { bbox: europe, sort_by: "altitude", limit: 1 });
    expect(r.matched).toBe(2);
    expect(r.aircraft[0]).toMatchObject({ callsign: "HIGH1", altitude_m: 12000, speed_kmh: 864 });
  });

  it("can include aircraft on the ground and sort by descent", () => {
    expect(queryAircraft(planes, { include_ground: true }).matched).toBe(4);
    expect(queryAircraft(planes, { sort_by: "descent", limit: 1 }).aircraft[0].callsign).toBe("FAR1");
  });

  it("counts ships by kind and filters moving ones", () => {
    const ships: ShipSnapshot = { t: 0, ids: [1, 2, 3], lat: [12000, 12500, 400000], lon: [1038000, 1039000, 0], sog: [0, 125, 80], cog: [0, 0, 0], kind: [2, 2, 1], age: [0, 0, 0] };
    const singapore = { south: 0.5, west: 103, north: 2, east: 105 };
    const r = queryShips(ships, new Map([[2, "MAERSK TAHITI"]]), { bbox: singapore, kind: "tanker" });
    expect(r.matched).toBe(2);
    expect(r.by_kind).toEqual({ tanker: 2 });
    expect(r.ships[0]).toMatchObject({ id: 2, name: "MAERSK TAHITI", speed_knots: 12.5 });
    expect(queryShips(ships, new Map(), { moving_only: true }).matched).toBe(2);
  });

  it("keeps quakes inside the time window", () => {
    const now = Date.UTC(2026, 9, 21, 12);
    const q = (id: string, mag: number, hoursAgo: number) => ({ id, mag, time: now - hoursAgo * 3600_000, lat: 0, lon: 0, depthKm: 10, place: id, url: "", tsunami: false, alert: null });
    const r = queryQuakes([q("old", 7, 30), q("a", 5, 2), q("b", 6, 5)], now, {});
    expect(r.earthquakes.map((x) => x.id)).toEqual(["b", "a"]);
  });
});

describe("replay frames", () => {
  it("picks the frame at or before a moment", () => {
    const frames = [100, 400, 700];
    expect(frameAtOrBefore(frames, 50)).toBeNull();
    expect(frameAtOrBefore(frames, 400)).toBe(400);
    expect(frameAtOrBefore(frames, 699)).toBe(400);
    expect(frameAtOrBefore(frames, 9999)).toBe(700);
  });
});
