// Listens to the aisstream.io firehose for a short while and writes one compact
// snapshot of every vessel heard: positions and static data in the relay's
// update format. Runs on a schedule in GitHub Actions (.github/workflows/ais.yml)
// and the relay ingests the result, so no always-on process holds the socket.
//
//   AISSTREAM_API_KEY=… node scripts/collect-ais.mjs ships.json.gz [seconds]

import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const out = process.argv[2];
const seconds = Number(process.argv[3] ?? 75);
const key = process.env.AISSTREAM_API_KEY;
if (!out || !key) {
  console.error("usage: AISSTREAM_API_KEY=… node scripts/collect-ais.mjs <out.json.gz> [seconds]");
  process.exit(2);
}

const clean = (s) => (typeof s === "string" ? s.replace(/@+/g, "").trim() : "");

/** Mirrors parseAisMessage in relay/src/ships.ts: one message → a position and/or static update. */
function parse(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  const meta = msg.MetaData;
  const body = msg.Message?.[msg.MessageType];
  if (!meta || !body) return null;
  const name = clean(meta.ShipName);
  if (msg.MessageType === "PositionReport" || msg.MessageType === "StandardClassBPositionReport") {
    const lat = Number(body.Latitude);
    const lon = Number(body.Longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const heading = Number(body.TrueHeading);
    const cog = Number(body.Cog);
    const sog = Number(body.Sog);
    const t = meta.time_utc ? Math.floor(Date.parse(meta.time_utc.slice(0, 19).replace(" ", "T") + "Z") / 1000) : Math.floor(Date.now() / 1000);
    return {
      position: {
        mmsi: meta.MMSI,
        lat: Math.round(lat * 1e5) / 1e5,
        lon: Math.round(lon * 1e5) / 1e5,
        sog: Number.isFinite(sog) && sog < 102.3 ? sog : 0,
        cog: Number.isFinite(cog) && cog < 360 ? cog : 0,
        heading: Number.isFinite(heading) && heading < 360 ? heading : null,
        t: Number.isFinite(t) ? t : Math.floor(Date.now() / 1000),
        name: name || undefined,
      },
    };
  }
  if (msg.MessageType === "ShipStaticData") {
    const dim = body.Dimension ?? {};
    return {
      static: {
        mmsi: meta.MMSI,
        name: clean(body.Name) || name,
        callsign: clean(body.CallSign),
        destination: clean(body.Destination),
        type: Number(body.Type) || 0,
        lengthM: (dim.A ?? 0) + (dim.B ?? 0),
        imo: Number(body.ImoNumber) || 0,
      },
    };
  }
  return null;
}

const positions = new Map();
const statics = new Map();
let messages = 0;
const t0 = Math.floor(Date.now() / 1000);

const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
ws.binaryType = "arraybuffer";
const decoder = new TextDecoder();
ws.addEventListener("open", () => {
  ws.send(
    JSON.stringify({
      APIKey: key,
      BoundingBoxes: [
        [
          [-90, -180],
          [90, 180],
        ],
      ],
      FilterMessageTypes: ["PositionReport", "StandardClassBPositionReport", "ShipStaticData"],
    }),
  );
});
ws.addEventListener("message", (event) => {
  const raw = typeof event.data === "string" ? event.data : decoder.decode(event.data);
  messages++;
  const parsed = parse(raw);
  if (!parsed) return;
  if (parsed.position) {
    const prev = positions.get(parsed.position.mmsi);
    if (!prev || parsed.position.t >= prev.t) positions.set(parsed.position.mmsi, parsed.position);
  }
  if (parsed.static) statics.set(parsed.static.mmsi, parsed.static);
});
ws.addEventListener("error", (e) => console.error("socket error", e.message ?? e));
ws.addEventListener("close", (e) => {
  if (!done) {
    console.error(`socket closed early (${e.code}) after ${messages} messages`);
    finish();
  }
});

let done = false;
function finish() {
  if (done) return;
  done = true;
  const t1 = Math.floor(Date.now() / 1000);
  const snapshot = { t0, t1, messages, positions: [...positions.values()], statics: [...statics.values()] };
  const body = gzipSync(JSON.stringify(snapshot));
  console.log(`${t1 - t0} s, ${messages} messages, ${positions.size} vessels, ${statics.size} static records, ${(body.length / 1024).toFixed(0)} KB gz`);
  if (positions.size < 500) {
    console.error("too few vessels; keeping the previous snapshot");
    process.exit(1);
  }
  writeFileSync(out, body);
  process.exit(0);
}
setTimeout(() => {
  try {
    ws.close();
  } catch {
    // Already closed.
  }
  finish();
}, seconds * 1000);
