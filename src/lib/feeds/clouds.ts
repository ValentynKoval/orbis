/**
 * Turns a true-colour satellite mosaic into a cloud opacity mask. Clouds are
 * bright, nearly colourless, and brighter than the cloud-free surface under
 * them; comparing against the Blue Marble base keeps ice sheets, snow and
 * deserts from reading as cloud. Black pixels mean "no data" and take the
 * fallback value instead.
 */
export function cloudMask(rgb: Uint8Array, base: Uint8Array, fallback: Uint8Array): Uint8Array {
  const n = fallback.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    if (r + g + b < 18) {
      out[i] = fallback[i];
      continue;
    }
    const lum = 0.3 * r + 0.59 * g + 0.11 * b;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    const brighter = smooth(18, 150, lum - base[i]);
    const bright = smooth(80, 235, lum);
    const grey = 1 - smooth(16, 60, chroma);
    out[i] = Math.round(255 * brighter * bright * grey);
  }
  return out;
}

/** GIBS daily mosaics are complete for yesterday (UTC); today's is still filling in. */
export function gibsDate(now = Date.now()): string {
  return new Date(now - 86_400_000).toISOString().slice(0, 10);
}

function smooth(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
