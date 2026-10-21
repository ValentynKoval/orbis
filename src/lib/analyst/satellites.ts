/** Server-side satellite lookup for the analyst: current position of a named satellite via SGP4. */
import { eciToGeodetic, gstime, sgp4, twoline2satrec } from "../../engine/workers/sgp4-core";
import { parseTle, type TleRecord } from "../feeds/satellites";
import { search } from "../search";

export function findSatellite(records: TleRecord[], name: string): TleRecord | null {
  const hits = search(
    name,
    records.map((r, i) => ({ kind: "satellite" as const, key: i, label: r.name, sub: "", terms: [r.name, String(r.norad)] })),
    1,
  );
  return hits.length ? records[hits[0].key as number] : null;
}

export function satelliteState(rec: TleRecord, now: number) {
  const sat = twoline2satrec(rec.line1, rec.line2);
  const minutes = (now / 86_400_000 + 2440587.5 - sat.jdsatepoch) * 1440;
  const pv = sgp4(sat, minutes);
  if (!pv || typeof pv.position !== "object") return null;
  const geo = eciToGeodetic(pv.position, gstime(new Date(now)));
  const v = pv.velocity;
  return {
    name: rec.name,
    norad: rec.norad,
    lat: Math.round(((geo.latitude * 180) / Math.PI) * 100) / 100,
    lon: Math.round(((geo.longitude * 180) / Math.PI) * 100) / 100,
    altitude_km: Math.round(geo.height),
    speed_kms: Math.round(Math.hypot(v.x, v.y, v.z) * 100) / 100,
    time_utc: new Date(now).toISOString(),
  };
}

export { parseTle };
