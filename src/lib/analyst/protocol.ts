/** What the analyst route returns: an answer and camera/UI actions for the browser to perform. */

export type AnalystAction =
  | { type: "fly_to"; lat: number; lon: number; zoom: "close" | "region" | "globe" }
  | { type: "select"; kind: "plane" | "ship" | "quake"; id: string }
  | { type: "select_satellite"; name: string }
  | { type: "layers"; show: string[]; hide: string[] };

export interface AnalystRequest {
  question: string;
  locale: "uk" | "en";
  view: { lat: number; lon: number };
  /** The two previous exchanges, for follow-up questions. */
  history?: { q: string; a: string }[];
}

export interface AnalystResponse {
  answer: string;
  actions: AnalystAction[];
  /** Questions left today for this visitor. */
  left: number;
}

export const LAYER_NAMES = ["satellites", "planes", "ships", "quakes", "fires", "clouds", "lights", "borders"] as const;
