import { connection, type NextRequest } from "next/server";
import sharp from "sharp";
import { cacheHeaders, fetchUpstream } from "@/lib/http";
import { cloudMask, gibsDate } from "@/lib/feeds/clouds";

/**
 * Yesterday's real cloud cover. NASA GIBS serves a daily VIIRS true-colour
 * mosaic; clouds are the bright, colourless pixels in it. Gaps (polar night,
 * missing swaths) are filled from the Blue Marble cloud composite.
 */
const GIBS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi";

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  await connection();
  const width = request.nextUrl.searchParams.get("w") === "4096" ? 4096 : 2048;
  const height = width / 2;
  const date = gibsDate();

  const month = date.slice(5, 7);
  const grey = async (path: string) => {
    const res = await fetch(new URL(path, request.url));
    return sharp(Buffer.from(await res.arrayBuffer())).resize(width, height).greyscale().raw().toBuffer();
  };
  const [fallback, base] = await Promise.all([grey("/textures/clouds-fallback-2k.jpg"), grey(`/textures/day-${month}-2k.jpg`)]);

  let mask: Buffer = fallback;
  let source = "blue-marble";
  try {
    const params = new URLSearchParams({
      SERVICE: "WMS",
      REQUEST: "GetMap",
      VERSION: "1.3.0",
      LAYERS: "VIIRS_NOAA20_CorrectedReflectance_TrueColor",
      CRS: "EPSG:4326",
      BBOX: "-90,-180,90,180",
      WIDTH: String(width),
      HEIGHT: String(height),
      FORMAT: "image/jpeg",
      TIME: date,
    });
    const jpeg = Buffer.from(await (await fetchUpstream(`${GIBS}?${params}`, {}, 25_000)).arrayBuffer());
    const rgb = await sharp(jpeg).resize(width, height).removeAlpha().raw().toBuffer();
    mask = Buffer.from(cloudMask(rgb, base, fallback));
    source = "gibs";
  } catch {
    // Keep the static composite; the globe still gets clouds.
  }

  const body = await sharp(mask, { raw: { width, height, channels: 1 } }).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
  return new Response(new Uint8Array(body), {
    headers: cacheHeaders(source === "gibs" ? 21_600 : 600, {
      "Content-Type": "image/jpeg",
      "X-Orbis-Clouds": `${source};${date}`,
      "Access-Control-Expose-Headers": "X-Orbis-Clouds",
    }),
  });
}
