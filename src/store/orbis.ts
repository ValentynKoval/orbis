"use client";

import { create } from "zustand";
import type { Quake } from "@/lib/feeds/quakes";
import { SHIP_KINDS, type ShipDetail } from "@/lib/feeds/live";
import type { Spot } from "@/lib/tour";
import type { FeedKey, FeedState, LayerKey, SatLive, Selection } from "@/engine/types";
import type { Engine } from "@/engine/Engine";
import type { BodyRef, SystemLabel } from "@/engine/SolarSystem";

export type Mode = "landing" | "live";
export type PlaneFilter = "all" | "airborne" | "high";

interface OrbisState {
  engine: Engine | null;
  mode: Mode;
  /** 0…1 while textures stream in. */
  progress: number;
  ready: boolean;
  webglError: boolean;
  layers: Record<LayerKey, boolean>;
  feeds: Record<FeedKey, FeedState>;
  selection: Selection | null;
  selectionLive: SatLive | null;
  /** Extra facts fetched for the selected ship (name, destination, size). */
  selectionDetail: ShipDetail | null;
  planeFilter: PlaneFilter;
  /** Timeline state; the clock itself lives in the engine. */
  time: { live: boolean; rate: number };
  shipKinds: boolean[];
  iss: SatLive | null;
  quakes: Quake[];
  cloudsDate: string | null;
  /** Planetary K index from NOAA, when the aurora feed has loaded. */
  auroraKp: number | null;
  /** Credits for the imagery tiles currently on screen. */
  imageryAttribution: string[];
  /** Which scene is on screen. */
  space: "earth" | "system";
  systemLabels: SystemLabel[];
  focusBody: BodyRef;
  selectedBody: BodyRef | null;
  observer: { lat: number; lon: number } | null;
  setObserver(observer: { lat: number; lon: number } | null): void;
  selectBody(ref: BodyRef | null): void;
  focusOn(ref: BodyRef): void;
  /** Centre of the busiest fire region, for the landing tour. */
  fireSpot: Spot | null;
  setEngine(engine: Engine | null): void;
  setMode(mode: Mode): void;
  toggleLayer(key: LayerKey): void;
  select(selection: Selection | null): void;
  sound: boolean;
  toggleSound(): void;
  /** The guided tour is running. */
  tour: boolean;
  /** The camera is riding along with the selected object. */
  following: boolean;
  /** Storms the labels layer names on the globe. */
  stormPins: { id: number; name: string; alert: "green" | "orange" | "red" }[];
  /**
   * The panel in the right dock (on phones, the bottom sheet). Cards for a selection take the same
   * place, so opening a panel clears the selection and selecting something closes the panel.
   */
  panel: "sky" | "analyst" | "layers" | null;
  openPanel(panel: "sky" | "analyst" | "layers" | null): void;
  /** The browser's IANA time zone ("UTC" until the client has mounted, so server and first render agree). */
  timeZone: string;
  /** Show times in UTC instead of the visitor's zone. */
  utc: boolean;
  toggleUtc(): void;
  setTour(on: boolean): void;
  setPlaneFilter(filter: PlaneFilter): void;
  toggleShipKind(kind: number): void;
}

const idle: FeedState = { status: "idle", count: 0, updated: null };

export const useOrbis = create<OrbisState>()((set, get) => ({
  engine: null,
  mode: "landing",
  progress: 0,
  ready: false,
  webglError: false,
  layers: { satellites: true, planes: true, ships: true, quakes: true, fires: true, aurora: true, rain: true, wind: false, storms: true, places: true, clouds: true, lights: true, borders: false, constellations: true },
  feeds: { satellites: idle, planes: idle, ships: idle, quakes: idle, fires: idle, clouds: idle, aurora: idle, rain: idle, wind: idle, storms: idle },
  selection: null,
  selectionLive: null,
  selectionDetail: null,
  planeFilter: "all",
  time: { live: true, rate: 1 },
  sound: false,
  tour: false,
  following: false,
  stormPins: [],
  setTour: (tour) => set({ tour, ...(tour ? { panel: null } : {}) }),
  panel: null,
  openPanel: (panel) => {
    if (panel && get().selection) get().select(null);
    if (panel && get().selectedBody) get().selectBody(null);
    set({ panel });
  },
  timeZone: "UTC",
  utc: false,
  toggleUtc: () => {
    const utc = !get().utc;
    set({ utc });
    try {
      localStorage.setItem("orbis-utc", utc ? "1" : "0");
    } catch {
      // Private mode: the choice lasts for this visit.
    }
  },
  toggleSound: () => {
    const sound = !get().sound;
    set({ sound });
    const ambience = get().engine?.ambience;
    if (sound) ambience?.start();
    else ambience?.stop();
  },
  shipKinds: Array.from({ length: SHIP_KINDS }, () => true),
  iss: null,
  quakes: [],
  cloudsDate: null,
  auroraKp: null,
  imageryAttribution: [],
  space: "earth",
  systemLabels: [],
  focusBody: { kind: "major", id: "earth" },
  selectedBody: null,
  observer: null,
  setObserver: (observer) => set({ observer }),
  selectBody: (ref) => {
    set({ selectedBody: ref, ...(ref ? { panel: null } : {}) });
    get().engine?.selectBody(ref);
  },
  focusOn: (ref) => {
    set({ selectedBody: ref });
    get().engine?.selectBody(ref);
    get().engine?.focusBody(ref);
  },
  fireSpot: null,
  setEngine: (engine) => set({ engine }),
  setMode: (mode) => set({ mode }),
  toggleLayer: (key) => {
    const layers = { ...get().layers, [key]: !get().layers[key] };
    set({ layers });
    get().engine?.setLayerVisible(key, layers[key]);
  },
  select: (selection) => {
    set({ selection, selectionLive: null, selectionDetail: null, ...(selection ? { panel: null } : {}) });
    get().engine?.select(selection);
  },
  setPlaneFilter: (planeFilter) => {
    set({ planeFilter });
    get().engine?.setPlaneFilter(planeFilter);
  },
  toggleShipKind: (kind) => {
    const shipKinds = get().shipKinds.map((on, i) => (i === kind ? !on : on));
    set({ shipKinds });
    get().engine?.setShipKind(kind, shipKinds[kind]);
  },
}));

export function setFeed(key: FeedKey, patch: Partial<FeedState>) {
  useOrbis.setState((s) => ({ feeds: { ...s.feeds, [key]: { ...s.feeds[key], ...patch } } }));
}
