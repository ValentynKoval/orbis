import { DurableObject } from "cloudflare:workers";
import { ADSB_ALL_URL, buildPlaneSnapshot, type AdsbAircraft } from "../../src/lib/feeds/adsb";
import type { PlaneSnapshot, PlaneTrack } from "../../src/lib/feeds/live";
import { FRAME_EVERY_S, History, planeFrame, shipFrame, type FrameKind } from "./history";
import { ShipStore, type PositionUpdate, type ShipUpdates, type StaticUpdate } from "../../src/lib/feeds/ships";

export interface Env {
  HUB: DurableObjectNamespace<Hub>;
  RELAY_TOKEN: string;
  /** GitHub token allowed to dispatch workflows on this repo (the ships collector). */
  GH_DISPATCH_TOKEN?: string;
}

/** One aircraft list every 90 s: fresh enough with client-side extrapolation, gentle on adsb.lol. */
const POLL_MS = 90_000;
const DIGITRAFFIC_META_MS = 30 * 60_000;
const QUOTA_PER_VISITOR = 15;
const QUOTA_TOTAL = 300;
const PLANE_TRACK_POINTS = 48;
const PLANE_STALE_S = 20 * 60;
/**
 * Ships: a GitHub Action listens to aisstream.io for about a minute every ten
 * minutes and publishes the vessels it heard as a release asset (see
 * .github/workflows/ais.yml). Holding the socket here would count every
 * message against the Durable Objects free tier.
 */
const SHIPS_SNAPSHOT_URL = "https://github.com/ValentynKoval/orbis/releases/download/ais/ships.json.gz";
const SHIPS_POLL_MS = 5 * 60_000;
const DIGITRAFFIC = "https://meri.digitraffic.fi/api/ais/v1";
const DT_HEADERS = { "Digitraffic-User": "Orbis/1.0", "Accept-Encoding": "gzip" };

/**
 * The single always-on relay object: polls adsb.lol, the ships snapshot and
 * Digitraffic on an alarm, and serves compact snapshots.
 */
export class Hub extends DurableObject<Env> {
  private ships = new ShipStore();
  private planes: PlaneSnapshot | null = null;
  private planesJson = "";
  private planeTracks = new Map<string, number[]>();
  private shipsJson = "";
  private shipsJsonAt = 0;
  private lastMeta = 0;
  private history: History;
  private stats = { startedAt: Date.now(), shipsSnapshotAt: 0, shipsSnapshotT: 0, shipsSnapshotError: "", ingests: 0, planeErrors: 0, planeError: "", lastPoll: 0 };
  private lastShipsPoll = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.history = new History(ctx.storage.sql);
    ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + 1000);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const json = (body: string, status = 200) =>
      new Response(body, { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

    if (path === "/planes") {
      if (!this.planesJson) await this.pollAircraft();
      return this.planesJson ? json(this.planesJson) : json('{"error":"no data yet"}', 503);
    }
    const planeTrack = path.match(/^\/planes\/([0-9a-f]{6})\/track$/);
    if (planeTrack) {
      const body: PlaneTrack = { id: planeTrack[1], track: this.planeTracks.get(planeTrack[1]) ?? [] };
      return json(JSON.stringify(body));
    }
    if (path === "/ships") {
      const now = Date.now();
      if (now - this.shipsJsonAt > 10_000) {
        this.shipsJson = JSON.stringify(this.ships.snapshot(now));
        this.shipsJsonAt = now;
      }
      return json(this.shipsJson);
    }
    if (path === "/ships/names") return json(JSON.stringify(this.ships.names()));
    // The site samples the AIS stream on demand and posts what it heard; the hub keeps the sum.
    if (path === "/ships/ingest" && request.method === "POST") {
      const body = (await new Response(request.body!.pipeThrough(new DecompressionStream("gzip"))).json()) as ShipUpdates;
      this.ships.apply(body);
      this.stats.ingests++;
      this.shipsJsonAt = 0;
      return json(JSON.stringify({ ok: true, ships: this.ships.size }));
    }
    if (path === "/ships/dump") {
      this.ships.prune(Math.floor(Date.now() / 1000));
      const body = new Response(JSON.stringify(this.ships.dump())).body!.pipeThrough(new CompressionStream("gzip"));
      return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "gzip" }, encodeBody: "manual" });
    }
    const ship = path.match(/^\/ships\/(\d{6,9})$/);
    if (ship) {
      const detail = this.ships.detail(Number(ship[1]));
      return detail ? json(JSON.stringify(detail)) : json('{"error":"unknown vessel"}', 404);
    }
    const quota = path.match(/^\/quota\/([0-9a-f]{16,64})$/);
    if (quota) return json(JSON.stringify(this.takeQuota(quota[1])));
    if (path === "/history") return json(JSON.stringify(this.history.index()));
    const frame = path.match(/^\/history\/(planes|ships)\/(\d+)$/);
    if (frame) {
      const body = this.history.frame(frame[1] as FrameKind, Number(frame[2]));
      if (!body) return json('{"error":"no such frame"}', 404);
      return new Response(body, {
        headers: { "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "gzip" },
        encodeBody: "manual",
      });
    }
    if (path === "/health") {
      return json(JSON.stringify({ ...this.stats, ships: this.ships.size, planes: this.planes?.ids.length ?? 0 }));
    }
    return json('{"error":"not found"}', 404);
  }

  async alarm() {
    await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
    await Promise.allSettled([this.pollAircraft(), this.pollShipsSnapshot(), this.pollDigitraffic()]);
    const nowS = Math.floor(Date.now() / 1000);
    this.ships.prune(nowS);
    await this.recordHistory(nowS).catch((err) => console.error("history", err instanceof Error ? err.message : err));
  }

  /**
   * Daily question allowance for the AI analyst, shared by every Vercel
   * instance: per visitor (hashed IP) and in total, so the free Gemini quota
   * cannot be exhausted by one person.
   */
  private quotaDay = "";
  private quotaUsed = new Map<string, number>();
  private quotaTotal = 0;

  private takeQuota(visitor: string): { ok: boolean; left: number } {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.quotaDay) {
      this.quotaDay = day;
      this.quotaUsed.clear();
      this.quotaTotal = 0;
    }
    const used = this.quotaUsed.get(visitor) ?? 0;
    if (used >= QUOTA_PER_VISITOR || this.quotaTotal >= QUOTA_TOTAL) return { ok: false, left: 0 };
    this.quotaUsed.set(visitor, used + 1);
    this.quotaTotal++;
    return { ok: true, left: QUOTA_PER_VISITOR - used - 1 };
  }

  /** Keyframes for the replay timeline, aligned to 5-minute boundaries. */
  private async recordHistory(nowS: number) {
    const slot = nowS - (nowS % FRAME_EVERY_S);
    if (this.planes && this.history.latest("planes") < slot) await this.history.record("planes", slot, planeFrame(this.planes));
    // Right after a restart the ship map is still filling up; a partial frame would make the replay flicker.
    if (this.ships.size > 5000 && this.history.latest("ships") < slot) {
      await this.history.record("ships", slot, shipFrame(this.ships.snapshot(Date.now())));
    }
  }

  private async pollAircraft() {
    try {
      const res = await fetch(ADSB_ALL_URL, {
        headers: { "User-Agent": "Orbis/1.0 (+https://github.com/ValentynKoval/orbis)", "Accept-Encoding": "gzip" },
        signal: AbortSignal.timeout(40_000),
      });
      if (!res.ok) throw new Error(`adsb.lol responded ${res.status}`);
      const data = (await res.json()) as { now: number; aircraft: AdsbAircraft[] };
      this.planes = buildPlaneSnapshot(data.now, data.aircraft);
      this.planesJson = JSON.stringify(this.planes);
      this.stats.lastPoll = Date.now();
      this.recordPlaneTracks(this.planes);
    } catch (err) {
      this.stats.planeErrors++;
      this.stats.planeError = err instanceof Error ? err.message : String(err);
      console.error("aircraft", this.stats.planeError);
    }
  }

  private recordPlaneTracks(snap: PlaneSnapshot) {
    const t = Math.floor(snap.t / 1000);
    for (let i = 0; i < snap.ids.length; i++) {
      if (snap.gnd[i]) continue;
      let track = this.planeTracks.get(snap.ids[i]);
      if (!track) this.planeTracks.set(snap.ids[i], (track = []));
      track.push(t - snap.age[i], snap.lat[i] / 1e4, snap.lon[i] / 1e4, snap.alt[i]);
      if (track.length > PLANE_TRACK_POINTS * 4) track.splice(0, track.length - PLANE_TRACK_POINTS * 4);
    }
    for (const [id, track] of this.planeTracks) {
      if (t - track[track.length - 4] > PLANE_STALE_S) this.planeTracks.delete(id);
    }
  }

  private async pollDigitraffic() {
    try {
      const now = Date.now();
      if (now - this.lastMeta > DIGITRAFFIC_META_MS) {
        const res = await fetch(`${DIGITRAFFIC}/vessels`, { headers: DT_HEADERS });
        if (res.ok) {
          const vessels = (await res.json()) as {
            mmsi: number;
            name: string;
            callSign: string;
            destination: string;
            shipType: number;
            imo: number;
            referencePointA: number;
            referencePointB: number;
          }[];
          for (const v of vessels) {
            this.ships.static({
              mmsi: v.mmsi,
              name: v.name?.trim() ?? "",
              callsign: v.callSign?.trim() ?? "",
              destination: v.destination?.trim() ?? "",
              type: v.shipType ?? 0,
              lengthM: (v.referencePointA ?? 0) + (v.referencePointB ?? 0),
              imo: v.imo ?? 0,
            });
          }
          this.lastMeta = now;
        }
      }
      const res = await fetch(`${DIGITRAFFIC}/locations`, { headers: DT_HEADERS });
      if (!res.ok) return;
      const fc = (await res.json()) as {
        features: { mmsi: number; geometry: { coordinates: [number, number] }; properties: { sog: number; cog: number; heading: number; timestampExternal: number } }[];
      };
      for (const f of fc.features) {
        const p = f.properties;
        this.ships.position({
          mmsi: f.mmsi,
          lon: f.geometry.coordinates[0],
          lat: f.geometry.coordinates[1],
          sog: p.sog ?? 0,
          cog: p.cog < 360 ? p.cog : 0,
          heading: p.heading < 360 ? p.heading : null,
          t: Math.floor(p.timestampExternal / 1000),
        });
      }
    } catch (err) {
      console.error("digitraffic", err instanceof Error ? err.message : err);
    }
  }

  /** Ingests the latest ships snapshot when a new one has been published. */
  private async pollShipsSnapshot() {
    const now = Date.now();
    if (now - this.lastShipsPoll < SHIPS_POLL_MS) return;
    this.lastShipsPoll = now;
    try {
      const res = await fetch(SHIPS_SNAPSHOT_URL, { headers: { "User-Agent": "Orbis/1.0 (+https://github.com/ValentynKoval/orbis)" }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`snapshot responded ${res.status}`);
      const snapshot = (await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).json()) as {
        t1: number;
        positions: PositionUpdate[];
        statics: StaticUpdate[];
      };
      if (snapshot.t1 <= this.stats.shipsSnapshotT) return;
      for (const p of snapshot.positions) this.ships.position(p);
      for (const st of snapshot.statics) this.ships.static(st);
      this.stats.shipsSnapshotT = snapshot.t1;
      this.stats.shipsSnapshotAt = now;
      this.stats.shipsSnapshotError = "";
    } catch (err) {
      this.stats.shipsSnapshotError = err instanceof Error ? err.message : String(err);
      console.error("ships snapshot", this.stats.shipsSnapshotError);
    }
  }
}
