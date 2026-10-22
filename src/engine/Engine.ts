import * as THREE from "three";
import { gmst, sunPosition } from "@/lib/astro";
import { haversineKm, latLonToVec, rotateY, vecToLatLon, type Vec3 } from "@/lib/geo";
import type { Pass } from "@/lib/passes";
import type { PlaneInfo } from "./layers/Traffic";
import type { FireGrid } from "@/lib/feeds/fires";
import type { Quake } from "@/lib/feeds/quakes";
import { busiestRegion } from "@/lib/tour";
import type { SearchCandidate } from "@/lib/search";
import { SatGroup } from "@/lib/feeds/satellites";
import { setFeed, useOrbis, type PlaneFilter } from "@/store/orbis";
import { CameraRig } from "./CameraRig";
import { SimClock } from "./SimClock";
import { Ambience } from "./Ambience";
import { Fires } from "./layers/Fires";
import { Planet } from "./layers/Planet";
import { Quakes } from "./layers/Quakes";
import { Satellites } from "./layers/Satellites";
import { planeAltitude, Traffic } from "./layers/Traffic";
import { Tiles } from "./layers/Tiles";
import { Moon } from "./layers/Moon";
import { Aurora } from "./layers/Aurora";
import { SkyBodies } from "./layers/SkyBodies";
import { EXIT_FLOOR_AU, HANDOVER_RADII, SolarSystem, type BodyRef } from "./SolarSystem";
import { EARTH_RADIUS_AU } from "@/lib/orbits";
import type { BodyRecord } from "@/lib/feeds/bodies";
import type { SpacecraftTrack } from "@/lib/feeds/horizons";
import { EOX, esriImagery, rainRadar, type ImageryProvider } from "@/lib/tiles";
import { reticleFragment, reticleVertex, logDepth } from "./shaders";
import type { FeedKey, LayerKey, Selection } from "./types";

const REFRESH_MS: Record<FeedKey, number> = {
  satellites: 2 * 3600_000,
  planes: 45_000,
  ships: 60_000,
  quakes: 60_000,
  fires: 30 * 60_000,
  clouds: 6 * 3600_000,
  aurora: 10 * 60_000,
  rain: 10 * 60_000,
};
const RETRY_MS = 45_000;
/** Scene hand-over with a little hysteresis: out past ENTER radii the heliocentric scene takes over, back inside EXIT the Earth scene does. */
const ENTER_RADII = HANDOVER_RADII * 1.01;
const EXIT_RADII = HANDOVER_RADII / 1.01;
/** How far the Earth camera may be asked to go: past the hand-over, so a fly-out never stalls there. */
const EARTH_MAX_RADII = HANDOVER_RADII * 1.5;
/** The heliocentric overview: the inner planets in one view. */
const OVERVIEW = { lat: 32, distAu: 2.6 };

export interface Overhead {
  at: number;
  planes: (PlaneInfo & { distanceKm: number })[];
  satellites: { index: number; name: string; elevation: number; altKm: number }[];
}

export interface EngineOptions {
  /** Phones and small tablets: lighter textures, geometry and pixel ratio. */
  lite: boolean;
}

export class Engine {
  readonly clock = new SimClock();
  readonly rig: CameraRig;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 0.01, 8000);
  private inertial = new THREE.Group();
  private planet: Planet;
  private satellites: Satellites;
  private quakes = new Quakes();
  private fires: Fires;
  readonly traffic = new Traffic();
  private tiles: Tiles;
  private rain: Tiles;
  /** Closest approach to sea level, in Earth radii; terrain under the camera raises it. */
  private baseMinDist = 1.0024;
  private moon: Moon;
  private aurora: Aurora;
  private sky: SkyBodies;
  /** The heliocentric scene; rendered instead of the Earth scene while `space` is "system". */
  readonly system: SolarSystem;
  space: "earth" | "system" = "earth";
  private systemAssets: Promise<void> | null = null;
  private lastLabels = 0;
  private interactive = false;
  /** Where to fly once the next hand-over between scenes has happened. */
  private afterHandover: "overview" | "earth" | BodyRef | null = null;
  readonly ambience = new Ambience();
  /** Adaptive resolution: drops the pixel ratio when frames run long, restores it when there is headroom. */
  private maxPixelRatio = 1;
  private frameTimes: number[] = [];
  private lastQualityCheck = 0;
  private reticle: THREE.Points;
  private reticleMaterial: THREE.ShaderMaterial;
  private observer: ResizeObserver;
  private width = 1;
  private height = 1;
  private last = performance.now();
  private clockSeconds = 0;
  private opacity: Record<LayerKey, { value: number; target: number }>;
  private focus: LayerKey | null = null;
  private timers: number[] = [];
  private lastDetail = 0;
  private lastAttribution = "";
  private disposed = false;
  private textureSize: "2k" | "4k";
  private coarse: boolean;

  constructor(
    private canvas: HTMLCanvasElement,
    private options: EngineOptions,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !options.lite,
      powerPreference: "high-performance",
      logarithmicDepthBuffer: true,
    });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, options.lite ? 1.75 : 2);
    this.renderer.setPixelRatio(pixelRatio);
    this.maxPixelRatio = pixelRatio;
    this.textureSize = !options.lite && this.renderer.capabilities.maxTextureSize >= 4096 ? "4k" : "2k";
    this.coarse = window.matchMedia("(pointer: coarse)").matches;

    this.planet = new Planet(options.lite ? 112 : 192, pixelRatio);
    this.satellites = new Satellites(pixelRatio);
    this.fires = new Fires(pixelRatio);
    const providers: ImageryProvider[] = [EOX];
    const esriKey = process.env.NEXT_PUBLIC_ARCGIS_KEY;
    if (esriKey) providers.push(esriImagery(esriKey));
    const anisotropyMax = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.tiles = new Tiles(providers, this.planet.earthMaterial.uniforms, anisotropyMax, { terrain: true });
    this.rain = new Tiles([], {}, 2, { overlay: true, lift: 6e-5 });
    this.rain.group.renderOrder = 0.6;
    this.moon = new Moon(this.planet.sun);
    this.aurora = new Aurora(this.planet.sun);
    this.sky = new SkyBodies(pixelRatio);
    this.system = new SolarSystem(canvas, pixelRatio);
    this.system.rig.onTap = (x, y) => {
      const rect = this.canvas.getBoundingClientRect();
      useOrbis.getState().selectBody(this.system.pick(x - rect.left, y - rect.top, rect.width, rect.height, this.coarse ? 26 : 16));
    };
    this.system.rig.onHover = (x, y) => {
      const rect = this.canvas.getBoundingClientRect();
      this.canvas.style.cursor = this.system.pick(x - rect.left, y - rect.top, rect.width, rect.height, 14) ? "pointer" : "grab";
    };

    this.reticleMaterial = new THREE.ShaderMaterial({
      ...logDepth(reticleVertex, reticleFragment),
      uniforms: {
        uPixelRatio: { value: pixelRatio },
        uSize: { value: 34 },
        uColor: { value: new THREE.Color("#f2c14e") },
        uClock: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
    });
    const reticleGeometry = new THREE.BufferGeometry();
    reticleGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
    this.reticle = new THREE.Points(reticleGeometry, this.reticleMaterial);
    this.reticle.visible = false;
    this.reticle.frustumCulled = false;
    this.reticle.renderOrder = 10;

    this.inertial.add(this.planet.stars, this.satellites.points, this.satellites.orbit);
    this.scene.add(this.sky.sun, this.sky.markers);
    this.scene.add(
      this.inertial,
      this.planet.earth,
      this.moon.mesh,
      this.tiles.group,
      this.rain.group,
      this.planet.borders,
      this.fires.points,
      this.quakes.mesh,
      this.aurora.mesh,
      this.planet.clouds,
      this.traffic.ships.mesh,
      this.traffic.planes.mesh,
      this.traffic.track,
      this.planet.atmosphere,
      this.reticle,
    );

    const layers = useOrbis.getState().layers;
    this.opacity = Object.fromEntries(
      (Object.keys(layers) as LayerKey[]).map((k) => [k, { value: layers[k] ? 1 : 0, target: layers[k] ? 1 : 0 }]),
    ) as Engine["opacity"];

    this.rig = new CameraRig(this.camera, canvas);
    this.rig.maxDist = EARTH_MAX_RADII;
    // Sub-metre imagery lets the camera descend to a few hundred metres; 10 m imagery stops it ~13 km up.
    this.baseMinDist = esriKey ? 1.0004 : 1.0024;
    this.rig.minDist = this.baseMinDist;
    this.rig.onTap = (x, y) => useOrbis.getState().select(this.pick(x, y));
    this.rig.onHover = (x, y) => {
      this.canvas.style.cursor = this.pick(x, y) ? "pointer" : "grab";
    };

    this.satellites.onLoaded = (catalog) => {
      setFeed("satellites", { status: "ready", count: catalog.names.length, updated: Date.now() });
    };

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.resize();
  }

  /** Loads base textures (reporting progress), then starts rendering and pulling feeds. */
  async start() {
    const loader = new THREE.TextureLoader();
    const anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const month = String(new Date(this.clock.now()).getUTCMonth() + 1).padStart(2, "0");
    const size = this.textureSize;
    type Slot = "uDay" | "uNight" | "uWater" | "uClouds";
    const load = async (url: string, slot: Slot, color: boolean) => {
      const texture = await loader.loadAsync(url);
      texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      texture.anisotropy = anisotropy;
      texture.wrapS = THREE.RepeatWrapping;
      if (this.disposed) return texture.dispose();
      this.planet.setTexture(slot, texture);
      this.renderer.initTexture(texture);
    };
    // First paint with small maps (~200 KB); the full-size ones replace them as they arrive.
    const quick: [string, Slot, boolean][] = [
      [`/textures/day-${month}-1k.jpg`, "uDay", true],
      ["/textures/night-1k.jpg", "uNight", false],
      ["/textures/water-2k.png", "uWater", false],
    ];
    let done = 0;
    await Promise.all(
      quick.map(async ([url, slot, color]) => {
        await load(url, slot, color);
        done++;
        useOrbis.setState({ progress: done / quick.length });
      }),
    );
    if (this.disposed) return;
    this.renderer.compile(this.scene, this.camera);
    this.renderer.setAnimationLoop(this.frame);
    useOrbis.setState({ ready: true });
    (async () => {
      await load(`/textures/day-${month}-${size}.jpg`, "uDay", true);
      await load(`/textures/night-${size}.jpg`, "uNight", false);
      await load("/textures/clouds-fallback-2k.jpg", "uClouds", false);
    })().catch(() => undefined);

    loader
      .loadAsync("/textures/sun-1k.jpg")
      .then((texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.RepeatWrapping;
        if (!this.disposed) this.sky.setSunTexture(texture);
      })
      .catch(() => undefined);
    new THREE.TextureLoader()
      .loadAsync("/textures/moon-2k.jpg")
      .then((texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = anisotropy;
        if (!this.disposed) this.moon.setTexture(texture);
      })
      .catch(() => undefined);
    this.schedule("satellites", () => this.loadSatellites());
    this.schedule("planes", () => this.loadPlanes());
    this.schedule("ships", () => this.loadShips());
    this.schedule("quakes", () => this.loadQuakes());
    this.schedule("fires", () => this.loadFires());
    this.schedule("clouds", () => this.loadClouds());
    this.schedule("aurora", () => this.loadAurora());
    this.schedule("rain", () => this.loadRain());
    this.loadBorders();
  }

  dispose() {
    this.disposed = true;
    window.clearInterval(this.historyTimer);
    this.renderer.setAnimationLoop(null);
    this.timers.forEach((t) => window.clearTimeout(t));
    this.observer.disconnect();
    this.rig.dispose();
    this.planet.dispose();
    this.satellites.dispose();
    this.quakes.dispose();
    this.fires.dispose();
    this.traffic.dispose();
    this.tiles.disposeAll();
    this.rain.disposeAll();
    this.moon.dispose();
    this.aurora.dispose();
    this.sky.dispose();
    this.system.dispose();
    this.ambience.dispose();
    this.reticleMaterial.dispose();
    this.reticle.geometry.dispose();
    this.renderer.dispose();
  }

  setInteractive(on: boolean) {
    this.rig.interactive = on && this.space === "earth";
    this.system.rig.interactive = on && this.space === "system";
    this.interactive = on;
    this.canvas.style.cursor = on ? "grab" : "";
    this.canvas.style.touchAction = on ? "none" : "auto";
  }

  setLayerVisible(key: LayerKey, visible: boolean) {
    this.opacity[key].target = visible ? 1 : 0;
  }

  /** Landing chapters dim every data layer except the one being talked about. */
  setFocus(key: LayerKey | null) {
    this.focus = key;
  }

  select(selection: Selection | null) {
    const now = this.clock.now();
    this.satellites.select(selection?.kind === "satellite" ? selection.index : -1, now);
    this.traffic.planes.select(selection?.kind === "plane" ? this.traffic.planes.indexOf(selection.id) : -1);
    this.traffic.ships.select(selection?.kind === "ship" ? this.traffic.ships.indexOf(selection.id) : -1);
    this.traffic.clearTrack();
    if (selection?.kind === "plane" || selection?.kind === "ship") this.loadTrack(selection);
    this.reticle.visible = !!selection;
    this.lastDetail = 0;
    if (selection) this.ambience.ping();
  }

  private loadTrack(selection: Extract<Selection, { kind: "plane" | "ship" }>) {
    this.traffic
      .showTrack(selection.kind, selection.id, this.clock.now() / 1000)
      .then((detail) => {
        if (detail && useOrbis.getState().selection === selection) useOrbis.setState({ selectionDetail: detail });
      })
      .catch(() => undefined);
  }

  setPlaneFilter(filter: PlaneFilter) {
    this.traffic.planes.setKindVisible(1, filter === "all");
    this.traffic.planes.setMinAlt(filter === "high" ? planeAltitude(9000, false) : -1);
  }

  setShipKind(kind: number, on: boolean) {
    this.traffic.ships.setKindVisible(kind, on);
  }

  /** Points the camera at a place, keeping the current altitude unless given. */
  flyTo(lat: number, lon: number, dist?: number) {
    this.rig.flyTo({ lat, lon, dist: dist ?? Math.min(this.rig.goal.dist, 3) }, 1.4);
  }

  // ---------------------------------------------------------------- time

  private historyTimer = 0;

  /**
   * Moves the simulated clock. Anything other than "now at 1×" is a replay:
   * aircraft and ships switch from live polling to recorded 5-minute frames.
   */
  setTime(simMs: number, rate: number) {
    const now = Date.now();
    const t = this.space === "system" ? simMs : Math.min(simMs, now);
    if (rate === 1 && Math.abs(now - t) < 5000) return this.goLive();
    this.clock.set(t, rate);
    if (!this.traffic.replay) {
      this.traffic.setReplay(true);
      const sel = useOrbis.getState().selection;
      if (sel?.kind === "plane" || sel?.kind === "ship") useOrbis.getState().select(null);
      const refresh = () => this.traffic.loadHistoryIndex().catch(() => undefined);
      refresh();
      window.clearInterval(this.historyTimer);
      this.historyTimer = window.setInterval(refresh, 300_000);
    }
    useOrbis.setState({ time: { live: false, rate } });
  }

  goLive() {
    this.clock.goLive();
    window.clearInterval(this.historyTimer);
    if (this.traffic.replay) {
      this.traffic.setReplay(false);
      const nowS = Date.now() / 1000;
      this.traffic.loadPlanes(nowS, true).catch(() => undefined);
      this.traffic.loadShips(nowS, true).catch(() => undefined);
    }
    useOrbis.setState({ time: { live: true, rate: 1 } });
  }

  /** Oldest moment with recorded aircraft or ships (Unix ms), if any. */
  get historyStart(): number | null {
    const s = this.traffic.historyStart;
    return s === null ? null : s * 1000;
  }

  /** Screen positions of the Sun, Moon and planets as seen from the Earth scene. */
  private skyLabels() {
    const v = new THREE.Vector3();
    const out: ReturnType<SolarSystem["labels"]> = [];
    const sim = this.clock.now();
    const fade = THREE.MathUtils.smoothstep(this.rig.pose.dist, 14, 40);
    if (fade <= 0) return out;
    for (const m of this.sky.positions) {
      const at = m.id === "moon" ? this.moon.position : ([m.dir[0] * 2500, m.dir[1] * 2500, m.dir[2] * 2500] as Vec3);
      v.set(...at).project(this.camera);
      if (v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) continue;
      // Behind the Earth: skip when the direction passes through the planet.
      const cam = this.camera.position;
      if (m.id !== "moon" && occludedByEarth(cam, at[0], at[1], at[2])) continue;
      out.push({ ref: { kind: "major", id: m.id }, name: m.id, x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height, px: 2, distanceAu: 0 });
    }
    void sim;
    return out;
  }

  /** ISS passes over a place for the next two days. */
  issPasses(lat: number, lon: number): Promise<Pass[]> {
    return this.satellites.issPasses(lat, lon, this.clock.now(), 48);
  }

  /** Aircraft within 80 km of a place and satellites more than 45° above its horizon, right now. */
  overhead(lat: number, lon: number): Overhead {
    const sim = this.clock.now();
    const nowS = sim / 1000;
    const obs = latLonToVec(lat, lon);
    const planes: Overhead["planes"] = [];
    for (let i = 0; i < this.traffic.planes.count; i++) {
      if (!this.traffic.planes.visible(i)) continue;
      const p = vecToLatLon(this.traffic.planes.displayed(i, nowS));
      const distanceKm = haversineKm(lat, lon, p.lat, p.lon);
      if (distanceKm > 80) continue;
      const info = this.traffic.planeInfo(this.traffic.planes.ids[i] as string, nowS);
      if (info) planes.push({ ...info, distanceKm: Math.round(distanceKm) });
    }
    planes.sort((a, b) => a.distanceKm - b.distanceKm);
    const satellites: Overhead["satellites"] = [];
    const catalog = this.satellites.catalog;
    if (catalog) {
      const rot = this.inertial.rotation.y;
      for (let i = 0; i < catalog.names.length; i++) {
        const p = this.satellites.positionOf(i, sim);
        if (!p) continue;
        const s = rotateY(p, rot);
        const dx = s[0] - obs[0];
        const dy = s[1] - obs[1];
        const dz = s[2] - obs[2];
        const len = Math.hypot(dx, dy, dz);
        const elevation = (Math.asin((dx * obs[0] + dy * obs[1] + dz * obs[2]) / len) * 180) / Math.PI;
        if (elevation < 45) continue;
        satellites.push({ index: i, name: catalog.names[i], elevation: Math.round(elevation), altKm: Math.round((Math.hypot(...s) - 1) * 6371) });
      }
      satellites.sort((a, b) => b.elevation - a.elevation);
    }
    return { at: Date.now(), planes: planes.slice(0, 12), satellites: satellites.slice(0, 12) };
  }

  /** Everything the search palette can find. Ship names are fetched on first use. */
  async searchCandidates(): Promise<SearchCandidate[]> {
    const out: SearchCandidate[] = [];
    const cat = this.satellites.catalog;
    if (cat) {
      for (let i = 0; i < cat.names.length; i++) {
        out.push({ kind: "satellite", key: i, label: cat.names[i], sub: String(cat.norad[i]), terms: [cat.names[i], String(cat.norad[i])] });
      }
    }
    const p = this.traffic.planeSnap;
    if (p) {
      for (let i = 0; i < p.ids.length; i++) {
        const label = p.callsign[i] || p.reg[i] || p.ids[i].toUpperCase();
        out.push({ kind: "plane", key: p.ids[i], label, sub: [p.reg[i], p.type[i]].filter(Boolean).join(", "), terms: [p.callsign[i], p.reg[i], p.ids[i]] });
      }
    }
    const names = await this.traffic.names();
    for (const id of this.traffic.ships.ids as number[]) {
      const name = names.get(id);
      out.push({ kind: "ship", key: id, label: name || `MMSI ${id}`, sub: String(id), terms: [name ?? "", String(id)] });
    }
    for (const q of useOrbis.getState().quakes) {
      out.push({ kind: "quake", key: q.id, label: q.place, sub: `M${q.mag.toFixed(1)}`, terms: [q.place] });
    }
    return out;
  }

  /** Turns a search hit into a selection, selects it and flies to it. */
  async focusResult(kind: SearchCandidate["kind"], key: string | number) {
    const store = useOrbis.getState();
    const now = this.clock.now();
    if (kind === "satellite") {
      const cat = this.satellites.catalog;
      const i = key as number;
      if (!cat) return;
      store.select({ kind: "satellite", index: i, norad: cat.norad[i], name: cat.names[i], group: cat.groups[i] as SatGroup, inclination: cat.inclination[i], periodMin: cat.periodMin[i] });
      const live = await this.satellites.detail(i, now, "focus");
      if (live) this.rig.flyTo({ lat: live.lat, lon: live.lon, dist: live.altKm > 15000 ? 14 : live.altKm > 3000 ? 7 : 2.8 }, 1.6);
    } else if (kind === "plane") {
      store.select({ kind, id: key as string });
      const info = this.traffic.planeInfo(key as string, now / 1000);
      if (info) this.rig.flyTo({ lat: info.lat, lon: info.lon, dist: 1.6 }, 1.6);
    } else if (kind === "ship") {
      store.select({ kind, id: key as number });
      const info = this.traffic.shipInfo(key as number, now / 1000);
      if (info) this.rig.flyTo({ lat: info.lat, lon: info.lon, dist: 1.5 }, 1.6);
    } else {
      const quake = store.quakes.find((q) => q.id === key);
      if (!quake) return;
      store.select({ kind: "quake", quake });
      this.rig.flyTo({ lat: quake.lat, lon: quake.lon, dist: 2.2 }, 1.6);
    }
  }

  get stats() {
    return { satellites: this.satellites.count };
  }

  /** Called when the visitor takes the controls in either scene (the tour stops itself). */
  watchUser(fn: (() => void) | null) {
    this.rig.onUserMove = fn;
    this.system.rig.onUserMove = fn;
  }

  /** Catalogue index of the ISS, or −1 until the element sets have loaded. */
  get issIndex() {
    return this.satellites.catalog?.issIndex ?? -1;
  }

  // ---------------------------------------------------------------- frame

  private frame = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.clockSeconds += dt;
    const sim = this.clock.now();

    if (this.space === "system") {
      this.systemFrame(sim, dt, now);
      return;
    }
    const sun = sunPosition(sim);
    this.planet.setSun(sun.lat, sun.lon);
    const rotation = gmst(sim);
    this.inertial.rotation.y = -rotation;
    this.moon.update(sim, rotation);
    this.sky.update(sim, this.planet.sun, rotation, this.clockSeconds, this.rig.pose.dist);

    this.rig.update(dt, this.width, this.height);
    // Zooming out past the hand-over point, still heading out, hands over to the heliocentric scene mid-motion.
    if (this.rig.pose.dist > ENTER_RADII && this.rig.goal.dist >= this.rig.pose.dist) {
      this.enterSystem();
      return;
    }
    // Keep the near plane proportional to the altitude so close views don't clip.
    const altitude = this.rig.pose.dist - 1;
    const near = Math.max(2e-6, altitude * 0.05);
    if (Math.abs(near - this.camera.near) / this.camera.near > 0.1) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
    this.animateOpacity(dt);
    this.tiles.update(this.camera, this.height, this.rig.pose.dist);
    this.rain.update(this.camera, this.height, this.rig.pose.dist);
    // Never fly into a mountain: the floor follows the terrain under the camera.
    const foot = vecToLatLon([this.camera.position.x, this.camera.position.y, this.camera.position.z]);
    this.rig.minDist = this.baseMinDist + (this.tiles.heightAt(foot.lat, foot.lon) + 300) / 6_371_000;
    const attributions = [...this.tiles.attributions, ...this.rain.attributions];
    if (attributions.join("|") !== this.lastAttribution) {
      this.lastAttribution = attributions.join("|");
      useOrbis.setState({ imageryAttribution: attributions });
    }

    this.satellites.update(sim);
    if (this.traffic.replay) {
      // Playback that catches up with the present hands over to the live feeds.
      if (this.clock.rate > 0 && sim >= Date.now()) this.goLive();
      else this.traffic.syncReplay(sim / 1000);
    }
    this.traffic.update(sim / 1000);
    this.quakes.update(sim, this.clockSeconds, this.rig.pose.dist);
    this.fires.update(sim, this.clockSeconds);
    this.aurora.update(this.clockSeconds);
    this.updateReticle(sim);
    this.updateLiveDetails(sim, now);
    if (now - this.lastLabels > 120) {
      this.lastLabels = now;
      useOrbis.setState({ systemLabels: this.rig.pose.dist > 14 ? this.skyLabels() : [] });
    }

    this.renderer.render(this.scene, this.camera);
    this.adaptQuality(now, dt);
  };

  // ---------------------------------------------------------------- solar system

  private systemFrame(sim: number, dt: number, now: number) {
    const s = this.system;
    s.update(sim, dt, this.width, this.height);
    // Back inside the hand-over point, still heading in and settled on the Earth: the Earth scene takes over mid-motion.
    if (s.focus.kind === "major" && s.focus.id === "earth" && !s.inTransit && s.rig.pose.dist < EXIT_RADII * EARTH_RADIUS_AU && s.rig.goal.dist <= s.rig.pose.dist) {
      this.exitSystem();
      return;
    }
    if (now - this.lastLabels > 80) {
      this.lastLabels = now;
      useOrbis.setState({ systemLabels: s.labels(this.width, this.height) });
    }
    this.renderer.render(s.scene, s.camera);
    this.adaptQuality(now, dt);
  }

  /** Switches to the heliocentric scene, continuing from the current view of the Earth. */
  enterSystem(overview = false) {
    if (this.space === "system") return;
    this.space = "system";
    const s = this.system;
    const sim = this.clock.now();
    const rotation = THREE.MathUtils.radToDeg(gmst(sim));
    s.setFocus({ kind: "major", id: "earth" }, sim);
    s.rig.pose.lat = s.rig.goal.lat = this.rig.pose.lat;
    s.rig.pose.lon = s.rig.goal.lon = this.rig.pose.lon + rotation;
    // The same distance, goal and easing as the Earth camera: the motion simply carries on in AU.
    s.rig.continueFrom(this.rig, EARTH_RADIUS_AU);
    if (s.rig.pose.dist < ENTER_RADII * EARTH_RADIUS_AU) {
      // Entered directly (a shared link): start just outside the hand-over, heading out.
      s.rig.pose.dist = ENTER_RADII * EARTH_RADIUS_AU;
      s.rig.goal.dist = Math.max(s.rig.goal.dist, s.rig.pose.dist * 1.5);
    }
    this.rig.maxDist = EARTH_MAX_RADII;
    s.rig.setAutoRotate(0);
    s.rig.setOffset(0, 0);
    this.rig.interactive = false;
    s.rig.interactive = this.interactive;
    this.canvas.style.cursor = "grab";
    this.ensureSystemAssets();
    useOrbis.setState({ space: "system", focusBody: s.focus, selectedBody: null });
    const after = this.afterHandover;
    this.afterHandover = null;
    if (overview || (after === "overview" && !s.rig.gliding)) s.rig.flyTo({ lat: OVERVIEW.lat, dist: OVERVIEW.distAu }, 4.5);
    else if (after && typeof after === "object") {
      useOrbis.getState().select(null);
      useOrbis.getState().focusOn(after);
    }
  }

  /**
   * Flies out of the Earth scene toward the heliocentric overview (or a body).
   * The goal lies past the hand-over point, so the camera is still accelerating
   * outward when the heliocentric scene picks the motion up.
   */
  goToSystem(focus?: BodyRef) {
    if (this.space === "system") return;
    this.afterHandover = focus ?? "overview";
    const dist = focus ? HANDOVER_RADII * 1.6 : OVERVIEW.distAu / EARTH_RADIUS_AU;
    this.rig.maxDist = Math.max(EARTH_MAX_RADII, dist);
    this.rig.glide(focus ? { dist } : { lat: OVERVIEW.lat, dist }, focus ? 3 : 7);
  }

  /** Back to the Earth scene, looking the same way the heliocentric camera did, with the same motion. */
  exitSystem() {
    if (this.space === "earth") return;
    this.space = "earth";
    const s = this.system;
    const rotation = THREE.MathUtils.radToDeg(gmst(this.clock.now()));
    this.rig.pose.lat = this.rig.goal.lat = s.rig.pose.lat;
    this.rig.pose.lon = this.rig.goal.lon = s.rig.pose.lon - rotation;
    this.rig.continueFrom(s.rig, 1 / EARTH_RADIUS_AU);
    this.rig.pose.dist = Math.min(this.rig.maxDist, this.rig.pose.dist);
    this.rig.goal.dist = Math.min(this.rig.pose.dist, this.rig.goal.dist);
    s.rig.minDist = EXIT_FLOOR_AU;
    s.rig.interactive = false;
    this.rig.interactive = this.interactive;
    s.select(null);
    if (!useOrbis.getState().time.live && this.clock.now() > Date.now()) this.goLive();
    useOrbis.setState({ space: "earth", selectedBody: null });
    // A "back to Earth" flight was aimed at the usual view; anything else just settles where it is.
    if (this.afterHandover === "earth" && this.rig.goal.dist > 12) this.rig.flyTo({ dist: 4.4 }, 2.6);
    this.afterHandover = null;
  }

  /** The inner solar system from above, centred on the Sun, from wherever the camera is. */
  overview() {
    if (this.space === "earth") return this.goToSystem();
    this.system.flyToBody({ kind: "major", id: "sun" }, this.clock.now(), OVERVIEW.distAu);
    this.system.rig.goal.lat = OVERVIEW.lat;
    useOrbis.setState({ focusBody: this.system.focus });
  }

  /** Flies the heliocentric camera to the Earth; the hand-over to the Earth scene happens on the way in. */
  returnToEarth() {
    if (this.space !== "system") return;
    this.afterHandover = "earth";
    this.system.flyToBody({ kind: "major", id: "earth" }, this.clock.now(), 4.4 * EARTH_RADIUS_AU);
    useOrbis.setState({ focusBody: this.system.focus });
  }

  private ensureSystemAssets() {
    this.systemAssets ??= (async () => {
      await this.system.loadTextures(this.options.lite);
      const res = await fetch("/api/bodies");
      if (!res.ok) throw new Error(`bodies ${res.status}`);
      const data: { comets: BodyRecord[]; asteroids: BodyRecord[] } = await res.json();
      if (!this.disposed) this.system.setBodies(data.comets, data.asteroids);
      const craft = await fetch("/api/spacecraft");
      if (craft.ok && !this.disposed) this.system.setCraft(((await craft.json()) as { craft: SpacecraftTrack[] }).craft);
    })().catch(() => {
      this.systemAssets = null;
    });
  }

  selectBody(ref: BodyRef | null) {
    this.system.select(ref);
    if (ref) this.ambience.ping();
  }

  focusBody(ref: BodyRef) {
    this.system.flyToBody(ref, this.clock.now());
    useOrbis.setState({ focusBody: ref });
  }

  private adaptQuality(now: number, dt: number) {
    this.frameTimes.push(dt);
    if (now - this.lastQualityCheck < 2500) return;
    this.lastQualityCheck = now;
    const times = this.frameTimes.splice(0).sort((a, b) => a - b);
    if (times.length < 30) return;
    const median = times[times.length >> 1];
    const ratio = this.renderer.getPixelRatio();
    if (median > 1 / 45 && ratio > 1) this.setPixelRatio(Math.max(1, ratio - 0.25));
    else if (median < 1 / 58 && ratio < this.maxPixelRatio) this.setPixelRatio(Math.min(this.maxPixelRatio, ratio + 0.25));
  }

  private setPixelRatio(ratio: number) {
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(this.width, this.height, false);
  }

  private animateOpacity(dt: number) {
    const k = 1 - Math.exp(-dt * 5);
    for (const key of Object.keys(this.opacity) as LayerKey[]) {
      const o = this.opacity[key];
      const dataLayer = key === "satellites" || key === "planes" || key === "ships" || key === "quakes" || key === "fires" || key === "aurora" || key === "rain";
      const focusScale = this.focus && dataLayer && this.focus !== key ? 0.18 : 1;
      o.value += (o.target * focusScale - o.value) * k;
    }
    // Far out, the data thins away long before the hand-over, so nothing is left to vanish at the switch.
    const dist = this.rig.pose.dist;
    const farFade = 1 - THREE.MathUtils.smoothstep(dist, 150, HANDOVER_RADII * 0.85);
    const surfaceFade = 1 - THREE.MathUtils.smoothstep(dist, 40, 170);
    this.satellites.setOpacity(this.opacity.satellites.value * farFade);
    this.quakes.setOpacity(this.opacity.quakes.value * surfaceFade);
    this.fires.setOpacity(this.opacity.fires.value * surfaceFade);
    this.traffic.planes.setOpacity(this.opacity.planes.value * surfaceFade);
    this.traffic.ships.setOpacity(this.opacity.ships.value * surfaceFade);
    this.traffic.track.visible &&= (this.opacity.planes.value + this.opacity.ships.value) * surfaceFade > 0.02;
    this.aurora.setOpacity(this.opacity.aurora.value);
    this.rain.opacity = this.opacity.rain.value * 0.85;
    this.planet.setCloudsOpacity(this.opacity.clouds.value);
    this.planet.setLights(this.opacity.lights.value);
    this.planet.setBordersOpacity(this.opacity.borders.value);
  }

  private selectionPosition(sim: number): Vec3 | null {
    const sel = useOrbis.getState().selection;
    if (!sel) return null;
    if (sel.kind === "satellite") {
      const p = this.satellites.positionOf(sel.index, sim);
      return p ? rotateY(p, this.inertial.rotation.y) : null;
    }
    if (sel.kind === "plane" || sel.kind === "ship") {
      const layer = sel.kind === "plane" ? this.traffic.planes : this.traffic.ships;
      const i = layer.indexOf(sel.id);
      return i >= 0 ? layer.displayed(i, sim / 1000) : null;
    }
    if (sel.kind === "quake") return latLonToVec(sel.quake.lat, sel.quake.lon, 1.003);
    return latLonToVec(sel.lat, sel.lon, 1.003);
  }

  private updateReticle(sim: number) {
    this.reticleMaterial.uniforms.uClock.value = this.clockSeconds;
    const p = this.selectionPosition(sim);
    if (!p) {
      this.reticle.visible = false;
      return;
    }
    this.reticle.visible = true;
    const attr = this.reticle.geometry.getAttribute("position") as THREE.BufferAttribute;
    attr.setXYZ(0, p[0], p[1], p[2]);
    attr.needsUpdate = true;
  }

  /** Once a second, ask the worker for exact ISS and selected-satellite telemetry. */
  private updateLiveDetails(sim: number, now: number) {
    if (now - this.lastDetail < 1000) return;
    this.lastDetail = now;
    const catalog = this.satellites.catalog;
    if (!catalog) return;
    if (catalog.issIndex >= 0) {
      this.satellites.detail(catalog.issIndex, sim, "iss").then((iss) => useOrbis.setState({ iss }));
    }
    const sel = useOrbis.getState().selection;
    if (sel?.kind === "satellite") {
      this.satellites.detail(sel.index, sim, "selection").then((live) => {
        if (useOrbis.getState().selection === sel) useOrbis.setState({ selectionLive: live });
      });
    }
  }

  private resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep the globe a similar size on portrait phones.
    this.camera.fov = w < h ? 32 * Math.min(1.6, h / w / 1.1) : 32;
    this.camera.updateProjectionMatrix();
    this.system.camera.aspect = this.camera.aspect;
    this.system.camera.fov = this.camera.fov;
    this.system.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- picking

  private pick(clientX: number, clientY: number): Selection | null {
    const rect = this.canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const w = rect.width;
    const h = rect.height;
    const cam = this.camera.position;
    const v = new THREE.Vector3();
    let bestD = this.coarse ? 24 : 13;
    let best: Selection | null = null;
    const screen = (x: number, y: number, z: number) => {
      v.set(x, y, z).project(this.camera);
      return Math.hypot(((v.x + 1) / 2) * w - px, ((1 - v.y) / 2) * h - py);
    };
    const surfaceVisible = (x: number, y: number, z: number) => x * (cam.x - x) + y * (cam.y - y) + z * (cam.z - z) > 0;

    if (this.opacity.quakes.target > 0) {
      for (const q of this.quakes.quakes) {
        const [x, y, z] = latLonToVec(q.lat, q.lon);
        if (!surfaceVisible(x, y, z)) continue;
        // Quakes are drawn larger than other markers; give them a little more reach.
        const d = screen(x, y, z) - 4;
        if (d < bestD) {
          bestD = d;
          best = { kind: "quake", quake: q };
        }
      }
    }

    if (this.opacity.fires.target > 0 && this.fires.grid) {
      const pos = this.fires.positions;
      const grid = this.fires.grid;
      for (let i = 0; i < grid.lat.length; i++) {
        const x = pos[i * 3];
        const y = pos[i * 3 + 1];
        const z = pos[i * 3 + 2];
        if (!surfaceVisible(x, y, z)) continue;
        const d = screen(x, y, z) + 2;
        if (d < bestD) {
          bestD = d;
          best = {
            kind: "fire",
            index: i,
            lat: grid.lat[i] / 100,
            lon: grid.lon[i] / 100,
            frp: grid.frp[i],
            time: grid.start + grid.minutes[i] * 60_000,
          };
        }
      }
    }

    const nowS = this.clock.now() / 1000;
    for (const kind of ["ship", "plane"] as const) {
      const layer = kind === "plane" ? this.traffic.planes : this.traffic.ships;
      if (this.opacity[kind === "plane" ? "planes" : "ships"].target <= 0) continue;
      for (let i = 0; i < layer.count; i++) {
        if (!layer.visible(i)) continue;
        const [x, y, z] = layer.displayed(i, nowS);
        if (!surfaceVisible(x, y, z) && occludedByEarth(cam, x, y, z)) continue;
        const d = screen(x, y, z) - (kind === "plane" ? 2 : 0);
        if (d < bestD) {
          bestD = d;
          best = kind === "plane" ? { kind, id: layer.ids[i] as string } : { kind, id: layer.ids[i] as number };
        }
      }
    }

    const catalog = this.satellites.catalog;
    if (this.opacity.satellites.target > 0 && catalog) {
      const sim = this.clock.now();
      const rot = this.inertial.rotation.y;
      for (let i = 0; i < catalog.names.length; i++) {
        const p = this.satellites.positionOf(i, sim);
        if (!p) continue;
        const [x, y, z] = rotateY(p, rot);
        if (occludedByEarth(cam, x, y, z)) continue;
        // Stations are what most people look for; let them win close calls.
        const d = screen(x, y, z) - (catalog.groups[i] === SatGroup.Station ? 10 : 0);
        if (d < bestD) {
          bestD = d;
          best = {
            kind: "satellite",
            index: i,
            norad: catalog.norad[i],
            name: catalog.names[i],
            group: catalog.groups[i] as SatGroup,
            inclination: catalog.inclination[i],
            periodMin: catalog.periodMin[i],
          };
        }
      }
    }
    return best;
  }


  // ---------------------------------------------------------------- feeds

  private schedule(key: FeedKey, load: () => Promise<void>) {
    const run = async () => {
      if (this.disposed) return;
      let ok = true;
      try {
        await load();
      } catch {
        ok = false;
        setFeed(key, { status: useOrbis.getState().feeds[key].count ? "ready" : "error" });
      }
      if (!this.disposed) this.timers.push(window.setTimeout(run, ok ? REFRESH_MS[key] : RETRY_MS));
    };
    if (useOrbis.getState().feeds[key].status === "idle") setFeed(key, { status: "loading" });
    run();
  }

  private async loadSatellites() {
    const res = await fetch("/api/satellites");
    if (!res.ok) throw new Error(`satellites ${res.status}`);
    this.satellites.load(await res.text());
    // Status turns "ready" when the worker reports the parsed catalogue.
  }

  private async loadPlanes() {
    const n = await this.traffic.loadPlanes(this.clock.now() / 1000);
    if (n === null) return;
    setFeed("planes", { status: "ready", count: n, updated: Date.now() });
    this.refreshSelection("plane");
  }

  private async loadShips() {
    const n = await this.traffic.loadShips(this.clock.now() / 1000);
    if (n === null) return;
    setFeed("ships", { status: "ready", count: n, updated: Date.now() });
    this.refreshSelection("ship");
  }

  /** Instance indices change with every snapshot: re-point the highlight and redraw the track. */
  private refreshSelection(kind: "plane" | "ship") {
    const sel = useOrbis.getState().selection;
    if (sel?.kind !== kind) return;
    const layer = kind === "plane" ? this.traffic.planes : this.traffic.ships;
    layer.select(layer.indexOf(sel.id));
    this.loadTrack(sel);
  }

  private async loadQuakes() {
    const res = await fetch("/api/quakes");
    if (!res.ok) throw new Error(`quakes ${res.status}`);
    const data: { updated: number; quakes: Quake[] } = await res.json();
    this.quakes.set(data.quakes);
    useOrbis.setState({ quakes: data.quakes });
    const dayAgo = Date.now() - 86_400_000;
    setFeed("quakes", { status: "ready", count: data.quakes.filter((q) => q.time > dayAgo).length, updated: data.updated });
  }

  private async loadFires() {
    const res = await fetch("/api/fires");
    if (!res.ok) throw new Error(`fires ${res.status}`);
    const data: FireGrid & { updated: number } = await res.json();
    this.fires.set(data);
    useOrbis.setState({ fireSpot: busiestRegion(data) });
    setFeed("fires", { status: "ready", count: data.lat.length, updated: data.updated });
  }

  private async loadClouds() {
    const res = await fetch("/api/clouds");
    if (!res.ok) throw new Error(`clouds ${res.status}`);
    const meta: { date: string | null; urls: Record<"4k" | "2k", string> } = await res.json();
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    const texture = await loader.loadAsync(meta.urls[this.textureSize]);
    texture.colorSpace = THREE.NoColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    if (this.disposed) return texture.dispose();
    this.planet.setTexture("uClouds", texture);
    useOrbis.setState({ cloudsDate: meta.date });
    setFeed("clouds", { status: "ready", count: 1, updated: Date.now() });
  }

  private async loadAurora() {
    const res = await fetch("/api/aurora");
    if (!res.ok) throw new Error(`aurora ${res.status}`);
    const meta = JSON.parse(res.headers.get("X-Orbis-Aurora") ?? "{}") as { kp?: number | null; forecast?: string };
    const url = URL.createObjectURL(await res.blob());
    try {
      const texture = await new THREE.TextureLoader().loadAsync(url);
      texture.colorSpace = THREE.NoColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.minFilter = texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      if (this.disposed) return texture.dispose();
      this.aurora.setTexture(texture, meta.kp ?? null);
    } finally {
      URL.revokeObjectURL(url);
    }
    useOrbis.setState({ auroraKp: meta.kp ?? null });
    setFeed("aurora", { status: "ready", count: 1, updated: Date.now() });
  }

  private async loadRain() {
    const res = await fetch("/api/rain");
    if (!res.ok) throw new Error(`rain ${res.status}`);
    const frame: { host: string; path: string; time: number } = await res.json();
    if (this.disposed) return;
    this.rain.setProviders([rainRadar(frame.host, frame.path)]);
    setFeed("rain", { status: "ready", count: 1, updated: frame.time });
  }

  /** Numbers for the debug readout. */
  perf() {
    const r = this.renderer.info.render;
    const times = this.frameTimes.slice(-60);
    const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
    return { fps: avg ? Math.round(1 / avg) : 0, calls: r.calls, triangles: r.triangles, pixelRatio: this.renderer.getPixelRatio(), tiles: this.tiles.attributions.length ? this.tiles.group.children.filter((c) => c.visible).length : 0 };
  }

  private async loadBorders() {
    try {
      const res = await fetch("/data/borders.json");
      if (res.ok && !this.disposed) this.planet.setBorders(await res.json());
    } catch {
      // Borders are decoration; the globe works without them.
    }
  }
}

/** True when the segment from the camera to the point passes through the unit sphere. */
function occludedByEarth(cam: THREE.Vector3, x: number, y: number, z: number) {
  const dx = x - cam.x;
  const dy = y - cam.y;
  const dz = z - cam.z;
  const len = Math.hypot(dx, dy, dz);
  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;
  const b = cam.x * ux + cam.y * uy + cam.z * uz;
  const c = cam.x * cam.x + cam.y * cam.y + cam.z * cam.z - 1;
  const disc = b * b - c;
  if (disc < 0) return false;
  const t = -b - Math.sqrt(disc);
  return t > 0 && t < len;
}
