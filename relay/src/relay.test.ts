import { describe, expect, it } from "vitest";
import { buildPlaneSnapshot } from "../../src/lib/feeds/adsb";
import { ShipKind, shipKind } from "../../src/lib/feeds/live";
import { parseAisMessage, ShipStore } from "./ships";

describe("adsb.lol snapshot", () => {
  it("converts units, flags emergencies and drops stale or anonymous aircraft", () => {
    const snap = buildPlaneSnapshot(1000, [
      { hex: "508035", flight: "PS751  ", r: "UR-PSR", t: "B738", lat: 50.4, lon: 30.5, alt_baro: 35000, gs: 450, track: 270.5, baro_rate: -1000, seen_pos: 1.2, squawk: "7700", category: "A3" },
      { hex: "4b1805", lat: 47, lon: 8, alt_baro: "ground", gs: 3, seen_pos: 0 },
      { hex: "abc123", lat: 1, lon: 1, seen_pos: 500 },
      { hex: "~0a1b2c", lat: 1, lon: 1, seen_pos: 1 },
    ]);
    expect(snap.ids).toEqual(["508035", "4b1805"]);
    expect(snap.callsign[0]).toBe("PS751");
    expect(snap.alt[0]).toBe(10668);
    expect(snap.spd[0]).toBe(2315);
    expect(snap.trk[0]).toBe(2705);
    expect(snap.vr[0]).toBe(-51);
    expect(snap.emg).toEqual([1, 0]);
    expect(snap.gnd).toEqual([0, 1]);
    expect(snap.alt[1]).toBe(0);
  });
});

describe("AIS", () => {
  const position = (mmsi: number, lat: number, time: string) =>
    JSON.stringify({
      MessageType: "PositionReport",
      MetaData: { MMSI: mmsi, ShipName: "INFINITY   ", time_utc: `${time}.123456 +0000 UTC` },
      Message: { PositionReport: { Latitude: lat, Longitude: 23.6, Sog: 12.3, Cog: 231.4, TrueHeading: 511 } },
    });

  it("parses position reports and treats 511 heading as unknown", () => {
    const p = parseAisMessage(position(339000037, 37.9, "2026-10-21 13:00:50"))?.position;
    expect(p).toMatchObject({ mmsi: 339000037, lat: 37.9, sog: 12.3, heading: null, name: "INFINITY" });
    expect(p?.t).toBe(Date.UTC(2026, 9, 21, 13, 0, 50) / 1000);
  });

  it("rejects the AIS 'not available' position", () => {
    expect(parseAisMessage(position(1, 91, "2026-10-21 13:00:50"))).toBeNull();
  });

  it("keeps the newest fix, samples a track and maps ship types", () => {
    const store = new ShipStore();
    store.position(parseAisMessage(position(7, 10, "2026-10-21 13:00:00"))!.position!);
    store.position(parseAisMessage(position(7, 11, "2026-10-21 13:01:00"))!.position!);
    store.position(parseAisMessage(position(7, 12, "2026-10-21 13:05:00"))!.position!);
    store.position(parseAisMessage(position(7, 9, "2026-10-21 12:00:00"))!.position!);
    store.static({ mmsi: 7, name: "EVER GIVEN", callsign: "H3RC", destination: "ROTTERDAM", type: 71, lengthM: 400, imo: 9811000 });
    const d = store.detail(7)!;
    expect(d.lat).toBe(12);
    expect(d.track.length / 3).toBe(2);
    expect(d.kind).toBe(ShipKind.Cargo);
    const snap = store.snapshot(Date.UTC(2026, 9, 21, 13, 6));
    expect(snap.ids).toEqual([7]);
    expect(snap.age).toEqual([60]);
    expect(store.names()).toEqual({ ids: [7], names: ["EVER GIVEN"] });
  });

  it("groups AIS type codes", () => {
    expect([shipKind(84), shipKind(60), shipKind(30), shipKind(37), shipKind(52), shipKind(0)]).toEqual([
      ShipKind.Tanker,
      ShipKind.Passenger,
      ShipKind.Fishing,
      ShipKind.Leisure,
      ShipKind.Service,
      ShipKind.Other,
    ]);
  });
});
