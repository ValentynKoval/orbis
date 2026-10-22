import { describe, expect, it } from "vitest";
import { horizonsUrl, parseHorizonsVectors, trackPosition } from "./horizons";

const SAMPLE = `*******
$$SOE
2461334.500000000, A.D. 2026-Oct-21 00:00:00.0000, -3.218693110229948E+01, -1.651015810173552E+02,  3.644230658715838E+01,
2461335.500000000, A.D. 2026-Oct-22 00:00:00.0000, -3.218812646886934E+01, -1.651110522139306E+02,  3.644438934092317E+01,
$$EOE
*******`;

describe("Horizons", () => {
  it("builds a heliocentric vector query", () => {
    const url = horizonsUrl("-31", "2026-01-01", "2026-02-01");
    expect(url).toContain("COMMAND=%27-31%27");
    expect(url).toContain("CENTER=%27500%4010%27");
    expect(url).toContain("REF_PLANE=%27FRAME%27");
  });

  it("parses the vector table", () => {
    const t = parseHorizonsVectors(SAMPLE);
    expect(t.times).toHaveLength(2);
    expect(new Date(t.times[0]).toISOString()).toBe("2026-10-21T00:00:00.000Z");
    expect(t.xyz[1]).toBeCloseTo(-165.1, 1);
  });

  it("interpolates and clamps", () => {
    const t = parseHorizonsVectors(SAMPLE);
    const mid = trackPosition(t, Date.UTC(2026, 9, 21, 12))!;
    expect(mid[0]).toBeCloseTo((t.xyz[0] + t.xyz[3]) / 2, 9);
    expect(trackPosition(t, Date.UTC(2020, 0, 1))![2]).toBeCloseTo(t.xyz[2], 12);
    expect(trackPosition({ times: [], xyz: [] }, 0)).toBeNull();
  });
});
