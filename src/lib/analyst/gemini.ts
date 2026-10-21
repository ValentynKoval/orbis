/**
 * The analyst's agent loop on Gemini (free tier). Data tools run here on the
 * server; UI tools are collected as actions for the browser. A question costs
 * at most MAX_TURNS model calls.
 */
import type { AnalystAction, AnalystRequest } from "./protocol";
import { LAYER_NAMES } from "./protocol";
import { queryAircraft, queryFires, queryQuakes, queryShips, SHIP_KIND_NAMES, type BBox } from "./tools";
import type { PlaneSnapshot, ShipSnapshot } from "../feeds/live";
import type { Quake } from "../feeds/quakes";
import type { FireGrid } from "../feeds/fires";
import type { TleRecord } from "../feeds/satellites";
import { findSatellite, satelliteState } from "./satellites";

const API = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_TURNS = 4;

export interface AnalystData {
  satellites(): Promise<TleRecord[]>;
  planes(): Promise<PlaneSnapshot>;
  ships(): Promise<{ snap: ShipSnapshot; names: Map<number, string> }>;
  quakes(): Promise<Quake[]>;
  fires(): Promise<FireGrid>;
}

const bbox = {
  type: "OBJECT",
  description: "Area in degrees. Leave out for the whole world. west > east means the box crosses the 180° meridian.",
  properties: { south: { type: "NUMBER" }, west: { type: "NUMBER" }, north: { type: "NUMBER" }, east: { type: "NUMBER" } },
  required: ["south", "west", "north", "east"],
};

const TOOLS = [
  {
    name: "get_satellite",
    description: "Current position, altitude and speed of a satellite by name or NORAD id (ISS, TIANGONG, HUBBLE, STARLINK-1007 …).",
    parameters: { type: "OBJECT", properties: { name: { type: "STRING" } }, required: ["name"] },
  },
  {
    name: "get_aircraft",
    description: "Live aircraft (ADS-B). Returns the top matches and how many matched.",
    parameters: {
      type: "OBJECT",
      properties: {
        bbox,
        sort_by: { type: "STRING", enum: ["altitude", "speed", "climb", "descent"] },
        limit: { type: "INTEGER", description: "1–10" },
        include_ground: { type: "BOOLEAN" },
      },
    },
  },
  {
    name: "get_ships",
    description: "Live vessels (AIS), sorted by speed. Returns counts by kind and the top matches.",
    parameters: {
      type: "OBJECT",
      properties: {
        bbox,
        kind: { type: "STRING", enum: [...SHIP_KIND_NAMES] },
        moving_only: { type: "BOOLEAN", description: "Only vessels faster than 1 knot" },
        limit: { type: "INTEGER", description: "1–10" },
      },
    },
  },
  {
    name: "get_earthquakes",
    description: "USGS earthquakes of the past hours (all magnitudes for the last day, M4.5+ for the week).",
    parameters: {
      type: "OBJECT",
      properties: {
        bbox,
        min_magnitude: { type: "NUMBER" },
        hours: { type: "INTEGER", description: "1–168, default 24" },
        sort_by: { type: "STRING", enum: ["magnitude", "time"] },
        limit: { type: "INTEGER", description: "1–10" },
      },
    },
  },
  {
    name: "get_fires",
    description: "Satellite fire detections (NASA FIRMS, last 24 h): count, total power and the strongest hotspots.",
    parameters: { type: "OBJECT", properties: { bbox, limit: { type: "INTEGER", description: "1–5" } } },
  },
  {
    name: "fly_to",
    description: "Move the camera to a place on the globe. Use it whenever the answer is about a place or object.",
    parameters: {
      type: "OBJECT",
      properties: {
        lat: { type: "NUMBER" },
        lon: { type: "NUMBER" },
        zoom: { type: "STRING", enum: ["close", "region", "globe"] },
      },
      required: ["lat", "lon"],
    },
  },
  {
    name: "select_object",
    description: "Open the info card of an aircraft (id = ICAO hex), ship (id = MMSI) or earthquake (id) and centre on it.",
    parameters: {
      type: "OBJECT",
      properties: { kind: { type: "STRING", enum: ["plane", "ship", "quake"] }, id: { type: "STRING" } },
      required: ["kind", "id"],
    },
  },
  {
    name: "select_satellite",
    description: "Find a satellite by name (e.g. ISS, HUBBLE, STARLINK-1007), open its card and centre on it.",
    parameters: { type: "OBJECT", properties: { name: { type: "STRING" } }, required: ["name"] },
  },
  {
    name: "set_layers",
    description: "Show or hide map layers.",
    parameters: {
      type: "OBJECT",
      properties: {
        show: { type: "ARRAY", items: { type: "STRING", enum: [...LAYER_NAMES] } },
        hide: { type: "ARRAY", items: { type: "STRING", enum: [...LAYER_NAMES] } },
      },
    },
  },
];

function systemPrompt(req: AnalystRequest, now: number) {
  const language = req.locale === "uk" ? "Ukrainian" : "English";
  return [
    "You are the analyst of Orbis, a live 3D globe showing satellites, aircraft, ships, earthquakes, fires, clouds and city lights.",
    `Answer in ${language}, in at most three short sentences, plain text without markdown.`,
    "For any question about what is happening now, call the data tools first and answer only from their results; never invent objects or numbers.",
    "When the answer points at one object, call select_object (or select_satellite) so the user sees it; when it is about an area, call fly_to.",
    "For a satellite, call get_satellite for its position, then select_satellite. МКС is Ukrainian for the ISS (International Space Station).",
    "Always finish with a short spoken answer, even after moving the camera.",
    "Convert regions to bounding boxes yourself, e.g. Europe 35..71N −25..45E, Ukraine 44..52.5N 22..40.5E, North Atlantic 35..65N −60..−10E, Japan 30..46N 129..146E.",
    "Altitudes are metres, aircraft speeds km/h, ship speeds knots. Mention callsigns or names, not internal ids.",
    "If the question has nothing to do with the globe's data, say briefly what you can help with.",
    `Current UTC time: ${new Date(now).toISOString()}. The user is looking at lat ${req.view.lat.toFixed(1)}, lon ${req.view.lon.toFixed(1)} (use it for "here" or "this area").`,
  ].join("\n");
}

type Part = { text?: string; functionCall?: { name: string; args?: Record<string, unknown>; id?: string }; thoughtSignature?: string };
type Content = { role: "user" | "model"; parts: (Part | { functionResponse: { name: string; id?: string; response: unknown } })[] };

export async function runAnalyst(
  req: AnalystRequest,
  data: AnalystData,
  opts: { apiKey: string; model: string; now?: number },
): Promise<{ answer: string; actions: AnalystAction[] }> {
  const now = opts.now ?? Date.now();
  const actions: AnalystAction[] = [];
  const contents: Content[] = [];
  for (const h of req.history?.slice(-2) ?? []) {
    contents.push({ role: "user", parts: [{ text: h.q }] }, { role: "model", parts: [{ text: h.a }] });
  }
  contents.push({ role: "user", parts: [{ text: req.question }] });

  const call = async (allowTools: boolean): Promise<Part[]> => {
    const res = await fetch(`${API}/${opts.model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt(req, now) }] },
        contents,
        tools: [{ functionDeclarations: TOOLS }],
        toolConfig: { functionCallingConfig: { mode: allowTools ? "AUTO" : "NONE" } },
        generationConfig: { temperature: 0.2, maxOutputTokens: 700 },
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { candidates?: { content?: { parts?: Part[] } }[] };
    return json.candidates?.[0]?.content?.parts ?? [];
  };
  const text = (parts: Part[]) =>
    parts
      .map((p) => p.text ?? "")
      .join("")
      .trim();

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const parts = await call(turn < MAX_TURNS - 1);
    const calls = parts.filter((p) => p.functionCall);
    if (!calls.length) {
      const answer = text(parts);
      if (answer || turn === 0) return { answer, actions };
      // The model acted but said nothing: ask once more, words only.
      return { answer: text(await call(false)), actions };
    }
    contents.push({ role: "model", parts });
    const responses: Content["parts"] = [];
    for (const { functionCall } of calls) {
      const { name, args = {}, id } = functionCall!;
      let result: unknown;
      try {
        result = await execute(name, args, data, actions, now);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : "failed" };
      }
      responses.push({ functionResponse: { name, ...(id ? { id } : {}), response: { result } } });
    }
    contents.push({ role: "user", parts: responses });
  }
  return { answer: "", actions };
}

async function execute(name: string, args: Record<string, unknown>, data: AnalystData, actions: AnalystAction[], now: number) {
  const box = args.bbox as BBox | undefined;
  switch (name) {
    case "get_satellite": {
      const rec = findSatellite(await data.satellites(), String(args.name ?? ""));
      return rec ? (satelliteState(rec, now) ?? { error: "no valid orbit" }) : { error: "not found" };
    }
    case "get_aircraft":
      return queryAircraft(await data.planes(), { ...args, bbox: box });
    case "get_ships": {
      const { snap, names } = await data.ships();
      return queryShips(snap, names, { ...args, bbox: box });
    }
    case "get_earthquakes":
      return queryQuakes(await data.quakes(), now, { ...args, bbox: box });
    case "get_fires":
      return queryFires(await data.fires(), { ...args, bbox: box });
    case "fly_to": {
      const zoom = (["close", "region", "globe"] as const).find((z) => z === args.zoom) ?? "region";
      actions.push({ type: "fly_to", lat: Number(args.lat), lon: Number(args.lon), zoom });
      return { status: "done" };
    }
    case "select_object": {
      const kind = (["plane", "ship", "quake"] as const).find((k) => k === args.kind);
      if (!kind) return { error: "unknown kind" };
      actions.push({ type: "select", kind, id: String(args.id) });
      return { status: "done" };
    }
    case "select_satellite":
      actions.push({ type: "select_satellite", name: String(args.name) });
      return { status: "done" };
    case "set_layers": {
      const pick = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => (LAYER_NAMES as readonly string[]).includes(x)) : []);
      actions.push({ type: "layers", show: pick(args.show), hide: pick(args.hide) });
      return { status: "done" };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}
