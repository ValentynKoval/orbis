import { connection } from "next/server";
import { cacheHeaders, fetchUpstream, upstreamError } from "@/lib/http";

/** NASA SDO's latest AIA 304 Å frame (the chromosphere, ~50,000 K), refreshed every 15 minutes upstream. */
const SDO_LATEST = "https://sdo.gsfc.nasa.gov/assets/img/latest/latest_512_0304.jpg";

export async function GET() {
  await connection();
  try {
    const res = await fetchUpstream(SDO_LATEST);
    const body = await res.arrayBuffer();
    return new Response(body, { headers: { "Content-Type": "image/jpeg", ...cacheHeaders(900) } });
  } catch (err) {
    return upstreamError(err);
  }
}
