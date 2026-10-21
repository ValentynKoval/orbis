import type { PlaneSnapshot, ShipSnapshot } from "../../src/lib/feeds/live";

/** One frame per kind every 5 minutes, kept for 25 hours: ~600 rows a day, well inside the free SQLite quota. */
export const FRAME_EVERY_S = 300;
const KEEP_S = 25 * 3600;

export type FrameKind = "planes" | "ships";

/** The replay only needs motion, not identity details. */
export function planeFrame(s: PlaneSnapshot): Partial<PlaneSnapshot> {
  return { t: s.t, ids: s.ids, lat: s.lat, lon: s.lon, alt: s.alt, spd: s.spd, trk: s.trk, gnd: s.gnd, emg: s.emg, age: s.age };
}

export function shipFrame(s: ShipSnapshot): ShipSnapshot {
  return s;
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/** 24-hour history in the Durable Object's own SQLite database, stored as gzipped JSON frames. */
export class History {
  constructor(private sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS frames (kind TEXT NOT NULL, t INTEGER NOT NULL, body BLOB NOT NULL, PRIMARY KEY (kind, t))");
  }

  /** Unix seconds of the newest stored frame of a kind (0 if none). */
  latest(kind: FrameKind): number {
    const row = this.sql.exec<{ t: number }>("SELECT MAX(t) AS t FROM frames WHERE kind = ?", kind).toArray()[0];
    return row?.t ?? 0;
  }

  async record(kind: FrameKind, tS: number, frame: unknown) {
    const body = await gzip(JSON.stringify(frame));
    this.sql.exec("INSERT OR REPLACE INTO frames (kind, t, body) VALUES (?, ?, ?)", kind, tS, body);
    this.sql.exec("DELETE FROM frames WHERE t < ?", tS - KEEP_S);
  }

  index(): Record<FrameKind, number[]> {
    const out: Record<FrameKind, number[]> = { planes: [], ships: [] };
    for (const row of this.sql.exec<{ kind: FrameKind; t: number }>("SELECT kind, t FROM frames ORDER BY t")) {
      out[row.kind]?.push(row.t);
    }
    return out;
  }

  /** The stored gzip bytes, served as-is. */
  frame(kind: FrameKind, tS: number): ArrayBuffer | null {
    const row = this.sql.exec<{ body: ArrayBuffer }>("SELECT body FROM frames WHERE kind = ? AND t = ?", kind, tS).toArray()[0];
    return row?.body ?? null;
  }
}
