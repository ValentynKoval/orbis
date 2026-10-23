import type { Quake } from "@/lib/feeds/quakes";
import type { SatGroup } from "@/lib/feeds/satellites";
import type { Pass } from "@/lib/passes";
import type { PlaceId } from "@/lib/places";

export type LayerKey = "satellites" | "planes" | "ships" | "quakes" | "fires" | "aurora" | "rain" | "wind" | "storms" | "places" | "clouds" | "lights" | "borders" | "constellations";

export type FeedKey = "satellites" | "planes" | "ships" | "quakes" | "fires" | "clouds" | "aurora" | "rain" | "wind" | "storms";
export type FeedState = { status: "idle" | "loading" | "ready" | "error"; count: number; updated: number | null };

export type Selection =
  | { kind: "satellite"; index: number; norad: number; name: string; group: SatGroup; inclination: number; periodMin: number }
  | { kind: "plane"; id: string }
  | { kind: "ship"; id: number }
  | { kind: "quake"; quake: Quake }
  | { kind: "fire"; index: number; lat: number; lon: number; frp: number; time: number }
  | { kind: "place"; id: PlaceId }
  /** A tropical cyclone, by its GDACS event id. */
  | { kind: "storm"; id: number }
  /** Any spot on the globe that was tapped where there is no object. */
  | { kind: "point"; lat: number; lon: number };

export interface SatLive {
  lat: number;
  lon: number;
  altKm: number;
  speedKms: number;
}

export interface CameraPose {
  lat: number;
  lon: number;
  /** Distance from the Earth's centre in Earth radii. */
  dist: number;
}

export type SatWorkerRequest =
  | { type: "load"; text: string }
  | { type: "propagate"; time: number }
  | { type: "detail"; index: number; time: number; tag: string }
  | { type: "orbit"; index: number; time: number }
  | { type: "passes"; lat: number; lon: number; from: number; hours: number; tag: string };

export type SatWorkerResponse =
  | {
      type: "loaded";
      names: string[];
      norad: Uint32Array;
      groups: Uint8Array;
      inclination: Float32Array;
      periodMin: Float32Array;
      issIndex: number;
    }
  | { type: "state"; time: number; pos: Float32Array; vel: Float32Array }
  | { type: "detail"; tag: string; index: number; ok: boolean; lat: number; lon: number; altKm: number; speedKms: number }
  | { type: "orbit"; index: number; time: number; points: Float32Array }
  | { type: "passes"; tag: string; passes: Pass[] };
