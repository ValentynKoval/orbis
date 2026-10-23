/**
 * A small GRIB2 reader: enough for NOAA GFS fields on a regular latitude/
 * longitude grid (grid template 3.0) packed simply (5.0) or with complex
 * packing and spatial differencing (5.3), which is what the NOMADS GRIB
 * filter returns. It turns the wind messages into plain arrays for the wind
 * layer's texture; anything else throws.
 */

export interface GribField {
  /** Parameter discipline, category and number (wind: 0, 2, 2 = U; 0, 2, 3 = V). */
  discipline: number;
  category: number;
  number: number;
  ni: number;
  nj: number;
  /** First and last grid point, degrees. */
  la1: number;
  lo1: number;
  la2: number;
  lo2: number;
  values: Float32Array;
}

/** Reads big-endian bit fields; plain fields (no parameter properties) so Node can run it as-is in scripts. */
class Bits {
  private pos = 0;
  private buf: Uint8Array;
  private start: number;
  constructor(buf: Uint8Array, start: number) {
    this.buf = buf;
    this.start = start;
  }
  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.buf[this.start + (this.pos >> 3)];
      v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  /** Skip to the next whole octet. */
  align() {
    this.pos = (this.pos + 7) & ~7;
  }
}

const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32 = (b: Uint8Array, o: number) => (b[o] * 2 ** 24 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3])) >>> 0;
/** GRIB's signed integers are sign and magnitude, not two's complement. */
const s16 = (b: Uint8Array, o: number) => (b[o] & 0x80 ? -1 : 1) * (((b[o] & 0x7f) << 8) | b[o + 1]);
const s32 = (b: Uint8Array, o: number) => (b[o] & 0x80 ? -1 : 1) * ((b[o] & 0x7f) * 2 ** 24 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]));
const f32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, false);
/** An n-octet sign-and-magnitude integer. */
function sn(b: Uint8Array, o: number, n: number): number {
  let v = b[o] & 0x7f;
  for (let i = 1; i < n; i++) v = v * 256 + b[o + i];
  return b[o] & 0x80 ? -v : v;
}

export function readGrib2(buf: Uint8Array): GribField[] {
  const out: GribField[] = [];
  let off = 0;
  while (off + 16 <= buf.length && buf[off] === 0x47 && buf[off + 1] === 0x52 && buf[off + 2] === 0x49 && buf[off + 3] === 0x42) {
    const discipline = buf[off + 6];
    const total = u32(buf, off + 8) * 2 ** 32 + u32(buf, off + 12);
    const end = off + total;
    let p = off + 16;
    let grid: Omit<GribField, "discipline" | "category" | "number" | "values"> | null = null;
    let category = -1;
    let number = -1;
    let rep: { template: number; n: number; sec: number } | null = null;
    while (p < end - 4) {
      const len = u32(buf, p);
      const num = buf[p + 4];
      if (num === 3) {
        if (u16(buf, p + 12) !== 0) throw new Error("only regular lat/lon grids are supported");
        const ni = u32(buf, p + 30);
        const nj = u32(buf, p + 34);
        grid = { ni, nj, la1: s32(buf, p + 46) / 1e6, lo1: s32(buf, p + 50) / 1e6, la2: s32(buf, p + 55) / 1e6, lo2: s32(buf, p + 59) / 1e6 };
      } else if (num === 4) {
        category = buf[p + 9];
        number = buf[p + 10];
      } else if (num === 5) {
        rep = { template: u16(buf, p + 9), n: u32(buf, p + 5), sec: p };
      } else if (num === 6) {
        if (buf[p + 5] !== 255) throw new Error("bitmaps are not supported");
      } else if (num === 7) {
        if (!grid || !rep) throw new Error("malformed message");
        out.push({ discipline, category, number, ...grid, values: unpack(buf, rep.sec, p + 5, rep.template, rep.n) });
      }
      p += len;
    }
    off = end;
  }
  return out;
}

function unpack(b: Uint8Array, s5: number, data: number, template: number, n: number): Float32Array {
  const R = f32(b, s5 + 11);
  const E = s16(b, s5 + 15);
  const D = s16(b, s5 + 17);
  const nbits = b[s5 + 19];
  const scale = (x: number) => (R + x * 2 ** E) / 10 ** D;
  const out = new Float32Array(n);
  if (template === 0) {
    const bits = new Bits(b, data);
    for (let i = 0; i < n; i++) out[i] = scale(nbits ? bits.read(nbits) : 0);
    return out;
  }
  if (template !== 3) throw new Error(`data template 5.${template} is not supported`);
  if (b[s5 + 22] !== 0) throw new Error("missing-value management is not supported");
  const ng = u32(b, s5 + 31);
  const widthRef = b[s5 + 35];
  const widthBits = b[s5 + 36];
  const lengthRef = u32(b, s5 + 37);
  const lengthInc = b[s5 + 41];
  const lastLength = u32(b, s5 + 42);
  const lengthBits = b[s5 + 46];
  const order = b[s5 + 47];
  const extra = b[s5 + 48];

  let o = data;
  const ival1 = sn(b, o, extra);
  o += extra;
  const ival2 = order === 2 ? sn(b, o, extra) : 0;
  if (order === 2) o += extra;
  const minsd = sn(b, o, extra);
  o += extra;

  const bits = new Bits(b, o);
  const refs = new Array<number>(ng);
  for (let g = 0; g < ng; g++) refs[g] = nbits ? bits.read(nbits) : 0;
  bits.align();
  const widths = new Array<number>(ng);
  for (let g = 0; g < ng; g++) widths[g] = widthRef + (widthBits ? bits.read(widthBits) : 0);
  bits.align();
  const lengths = new Array<number>(ng);
  for (let g = 0; g < ng; g++) lengths[g] = lengthRef + (lengthBits ? bits.read(lengthBits) : 0) * lengthInc;
  lengths[ng - 1] = lastLength;
  bits.align();

  const ifld = new Float64Array(n);
  let k = 0;
  for (let g = 0; g < ng; g++) {
    for (let i = 0; i < lengths[g] && k < n; i++) ifld[k++] = refs[g] + (widths[g] ? bits.read(widths[g]) : 0);
  }
  if (order === 1) {
    ifld[0] = ival1;
    for (let i = 1; i < n; i++) ifld[i] = ifld[i] + minsd + ifld[i - 1];
  } else if (order === 2) {
    ifld[0] = ival1;
    ifld[1] = ival2;
    for (let i = 2; i < n; i++) ifld[i] = ifld[i] + minsd + 2 * ifld[i - 1] - ifld[i - 2];
  }
  for (let i = 0; i < n; i++) out[i] = scale(ifld[i]);
  return out;
}
