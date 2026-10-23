import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readGrib2 } from "./grib2";

/** One GRIB2 message with simple packing (data template 5.0) on a 2×2 grid. */
function simpleMessage(values: number[], R: number, D: number) {
  const sections: number[][] = [];
  const sec = (num: number, len: number, fill: (b: DataView) => void) => {
    const b = new DataView(new ArrayBuffer(len));
    b.setUint32(0, len);
    b.setUint8(4, num);
    fill(b);
    sections.push([...new Uint8Array(b.buffer)]);
  };
  sec(1, 21, () => undefined);
  sec(3, 72, (b) => {
    b.setUint16(12, 0);
    b.setUint32(30, 2);
    b.setUint32(34, 2);
    b.setInt32(46, 10_000_000);
    b.setInt32(50, 20_000_000);
    b.setInt32(55, 9_000_000);
    b.setInt32(59, 21_000_000);
  });
  sec(4, 34, (b) => {
    b.setUint8(9, 2);
    b.setUint8(10, 2);
  });
  sec(5, 21, (b) => {
    b.setUint32(5, values.length);
    b.setUint16(9, 0);
    b.setFloat32(11, R);
    b.setUint16(15, 0);
    b.setUint16(17, D);
    b.setUint8(19, 8);
  });
  sec(6, 6, (b) => b.setUint8(5, 255));
  sections.push([0, 0, 0, 5 + values.length, 7, ...values]);
  const body = sections.flat();
  const total = 16 + body.length + 4;
  const head = [0x47, 0x52, 0x49, 0x42, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, total];
  return new Uint8Array([...head, ...body, 0x37, 0x37, 0x37, 0x37]);
}

describe("readGrib2", () => {
  it("unpacks simple packing with the reference value and decimal scale", () => {
    const [f] = readGrib2(simpleMessage([0, 5, 10, 255], 100, 1));
    expect(f).toMatchObject({ discipline: 0, category: 2, number: 2, ni: 2, nj: 2, la1: 10, lo1: 20, la2: 9, lo2: 21 });
    expect([...f.values]).toEqual([10, 10.5, 11, 35.5]);
  });

  it("decodes GFS 10 m wind with complex packing and second-order differencing (5.3)", () => {
    // NOMADS GRIB filter, gfs.t18z.pgrb2.1p00.f000 of 2026-10-22, 40–60° N × 20–40° E; rows run south to north.
    const fields = readGrib2(new Uint8Array(readFileSync(new URL("./fixtures/gfs-wind-20n40e.grb2", import.meta.url))));
    expect(fields.map((f) => f.number)).toEqual([2, 3]);
    const [u, v] = fields;
    expect(u).toMatchObject({ ni: 21, nj: 21, la1: 40, lo1: 20, la2: 60, lo2: 40 });
    // 50° N 30° E, matching the same point of the global field to the last bit.
    expect(u.values[10 * 21 + 10]).toBeCloseTo(-5.354, 3);
    expect(v.values[10 * 21 + 10]).toBeCloseTo(2.684, 3);
    for (const x of [...u.values, ...v.values]) expect(Math.abs(x)).toBeLessThan(40);
  });
});
