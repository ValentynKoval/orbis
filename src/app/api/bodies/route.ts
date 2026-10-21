import { connection } from "next/server";
import { cacheHeaders, fetchUpstream, upstreamError } from "@/lib/http";
import { pickComets, type BodyRecord } from "@/lib/feeds/bodies";

/**
 * Comets and the larger asteroids from NASA/JPL's Small-Body Database, one
 * query each, cached for a day. Positions are computed in the browser from
 * these elements (lib/orbits.ts).
 */
const SBDB = "https://ssd-api.jpl.nasa.gov/sbdb_query.api";

export const maxDuration = 60;

export async function GET() {
  await connection();
  try {
    const cometFields = "full_name,e,q,i,om,w,tp,epoch,per_y,M1";
    const asteroidFields = "full_name,diameter,e,a,i,om,w,ma,epoch";
    const [comets, asteroids] = await Promise.all([
      fetchUpstream(`${SBDB}?fields=${cometFields}&sb-kind=c&sb-xfrag=1`, {}, 50_000).then((r) => r.json()),
      fetchUpstream(
        `${SBDB}?fields=${asteroidFields}&sb-kind=a&sb-ns=n&sb-cdata=${encodeURIComponent('{"AND":["diameter|GT|45"]}')}&limit=1200`,
        {},
        50_000,
      ).then((r) => r.json()),
    ]);
    const body: { updated: number; comets: BodyRecord[]; asteroids: BodyRecord[] } = {
      updated: Date.now(),
      comets: pickComets(comets.data as string[][], Date.now()),
      asteroids: (asteroids.data as string[][]).map((r) => ({
        name: r[0].trim(),
        diameterKm: Number(r[1]) || 0,
        el: { e: Number(r[2]), a: Number(r[3]), i: Number(r[4]), om: Number(r[5]), w: Number(r[6]), ma: Number(r[7]), epoch: Number(r[8]) },
      })),
    };
    return Response.json(body, { headers: cacheHeaders(86_400) });
  } catch (err) {
    return upstreamError(err);
  }
}
