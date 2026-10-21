/// <reference lib="webworker" />
/**
 * Propagates every catalogued satellite with SGP4 off the main thread. The
 * main thread receives inertial positions and velocities in scene units
 * (Earth radii) and extrapolates between updates on the GPU.
 */
import { eciToGeodetic, gstime, sgp4, twoline2satrec, type SatRec } from "@/lib/sgp4";
import { predictPasses } from "@/lib/passes";
import { classify, ISS_NORAD, parseTle } from "@/lib/feeds/satellites";
import type { SatWorkerRequest, SatWorkerResponse } from "../types";

const R = 6371;
const MS_PER_DAY = 86_400_000;
let sats: SatRec[] = [];
let issLines: [string, string] | null = null;

const post = (msg: SatWorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

function minutesSinceEpoch(sat: SatRec, ms: number): number {
  const jd = ms / MS_PER_DAY + 2440587.5;
  return (jd - sat.jdsatepoch) * 1440;
}

function stateAt(sat: SatRec, ms: number) {
  const pv = sgp4(sat, minutesSinceEpoch(sat, ms));
  if (!pv || typeof pv.position !== "object") return null;
  return pv;
}

self.onmessage = (event: MessageEvent<SatWorkerRequest>) => {
  const msg = event.data;
  switch (msg.type) {
    case "load": {
      const records = parseTle(msg.text);
      issLines = null;
      const kept: SatRec[] = [];
      const names: string[] = [];
      const norad: number[] = [];
      const groups: number[] = [];
      const inclination: number[] = [];
      const periodMin: number[] = [];
      for (const rec of records) {
        try {
          const sat = twoline2satrec(rec.line1, rec.line2);
          if (sat.error) continue;
          if (rec.norad === ISS_NORAD) issLines = [rec.line1, rec.line2];
          kept.push(sat);
          names.push(rec.name);
          norad.push(rec.norad);
          groups.push(classify(rec));
          inclination.push((sat.inclo * 180) / Math.PI);
          periodMin.push((2 * Math.PI) / sat.no);
        } catch {
          // Malformed element set: skip it.
        }
      }
      sats = kept;
      post({
        type: "loaded",
        names,
        norad: Uint32Array.from(norad),
        groups: Uint8Array.from(groups),
        inclination: Float32Array.from(inclination),
        periodMin: Float32Array.from(periodMin),
        issIndex: norad.indexOf(ISS_NORAD),
      });
      break;
    }
    case "propagate": {
      const n = sats.length;
      const pos = new Float32Array(n * 3);
      const vel = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const pv = stateAt(sats[i], msg.time);
        if (!pv) continue; // stays at the origin: hidden inside the Earth
        const p = pv.position;
        const v = pv.velocity;
        // Equatorial (z north) → scene (y north).
        pos[i * 3] = p.x / R;
        pos[i * 3 + 1] = p.z / R;
        pos[i * 3 + 2] = -p.y / R;
        vel[i * 3] = v.x / R;
        vel[i * 3 + 1] = v.z / R;
        vel[i * 3 + 2] = -v.y / R;
      }
      post({ type: "state", time: msg.time, pos, vel }, [pos.buffer, vel.buffer]);
      break;
    }
    case "detail": {
      const sat = sats[msg.index];
      const pv = sat && stateAt(sat, msg.time);
      if (!pv) {
        post({ type: "detail", tag: msg.tag, index: msg.index, ok: false, lat: 0, lon: 0, altKm: 0, speedKms: 0 });
        break;
      }
      const geo = eciToGeodetic(pv.position, gstime(new Date(msg.time)));
      const v = pv.velocity;
      post({
        type: "detail",
        tag: msg.tag,
        index: msg.index,
        ok: true,
        lat: (geo.latitude * 180) / Math.PI,
        lon: (geo.longitude * 180) / Math.PI,
        altKm: geo.height,
        speedKms: Math.hypot(v.x, v.y, v.z),
      });
      break;
    }
    case "passes": {
      const passes = issLines ? predictPasses(issLines[0], issLines[1], msg.lat, msg.lon, msg.from, msg.hours) : [];
      post({ type: "passes", tag: msg.tag, passes });
      break;
    }
    case "orbit": {
      const sat = sats[msg.index];
      if (!sat) break;
      const steps = 180;
      const periodMs = ((2 * Math.PI) / sat.no) * 60_000;
      const points = new Float32Array((steps + 1) * 3);
      for (let k = 0; k <= steps; k++) {
        const pv = stateAt(sat, msg.time + (periodMs * k) / steps);
        if (!pv) continue;
        const p = pv.position;
        points[k * 3] = p.x / R;
        points[k * 3 + 1] = p.z / R;
        points[k * 3 + 2] = -p.y / R;
      }
      post({ type: "orbit", index: msg.index, time: msg.time, points }, [points.buffer]);
      break;
    }
  }
};
