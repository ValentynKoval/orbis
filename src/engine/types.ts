import type { Quake } from "@/lib/feeds/quakes";
import type { SatGroup } from "@/lib/feeds/satellites";

export type LayerKey = "satellites" | "quakes" | "fires" | "clouds" | "lights" | "borders";

export type FeedKey = "satellites" | "quakes" | "fires" | "clouds";
export type FeedState = { status: "idle" | "loading" | "ready" | "error"; count: number; updated: number | null };

export type Selection =
  | { kind: "satellite"; index: number; norad: number; name: string; group: SatGroup; inclination: number; periodMin: number }
  | { kind: "quake"; quake: Quake }
  | { kind: "fire"; index: number; lat: number; lon: number; frp: number; time: number };

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
  | { type: "orbit"; index: number; time: number };

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
  | { type: "orbit"; index: number; time: number; points: Float32Array };
