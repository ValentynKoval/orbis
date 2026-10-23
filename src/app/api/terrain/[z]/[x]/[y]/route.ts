import sharp from "sharp";
import { fetchUpstream, upstreamError } from "@/lib/http";
import { gridFromTerrarium, TERRAIN_MAX_LEVEL, TERRAIN_MIN_LEVEL } from "@/lib/terrain";

/**
 * One terrain tile as a 65 × 65 Int16 height grid (~8 KB), decoded from the
 * Mapzen Terrarium PNG (~120 KB) on AWS Open Data. Elevation never changes,
 * so the CDN keeps each answer for a year and the PNG is fetched once.
 */
const TERRARIUM = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium";
export const maxDuration = 20;

export async function GET(_request: Request, { params }: RouteContext<"/api/terrain/[z]/[x]/[y]">) {
  const p = await params;
  const z = Number(p.z);
  const x = Number(p.x);
  const y = Number(p.y);
  const n = 2 ** z;
  if (![z, x, y].every(Number.isInteger) || z < TERRAIN_MIN_LEVEL || z > TERRAIN_MAX_LEVEL || x < 0 || y < 0 || x >= n || y >= n) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  try {
    const png = Buffer.from(await (await fetchUpstream(`${TERRARIUM}/${z}/${x}/${y}.png`)).arrayBuffer());
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const grid = gridFromTerrarium(data, info.width, info.channels);
    return new Response(new Uint8Array(grid.buffer as ArrayBuffer), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
        "CDN-Cache-Control": "public, s-maxage=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return upstreamError(err);
  }
}
