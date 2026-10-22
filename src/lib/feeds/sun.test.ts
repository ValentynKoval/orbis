import { describe, expect, it } from "vitest";
import { parseSolarWind } from "./sun";

describe("parseSolarWind", () => {
  it("reads the SWPC summaries", () => {
    const w = parseSolarWind([{ proton_speed: 430, time_tag: "2026-10-22T12:29:00Z" }], [{ bt: 6, bz_gsm: -2.5, time_tag: "2026-10-22T12:29:00Z" }]);
    expect(w).toEqual({ speed: 430, bt: 6, bz: -2.5, time: Date.UTC(2026, 9, 22, 12, 29) });
  });

  it("returns null for anything malformed", () => {
    expect(parseSolarWind([], [])).toBeNull();
    expect(parseSolarWind([{ proton_speed: "n/a", time_tag: "x" }], [{ bt: 1, bz_gsm: 1 }])).toBeNull();
    expect(parseSolarWind({ proton_speed: 1 }, [{ bt: 1, bz_gsm: 1, time_tag: "2026-10-22T12:29:00Z" }])).toBeNull();
  });
});
