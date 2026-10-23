import * as THREE from "three";
import { gmst, sunPosition } from "@/lib/astro";
import { bearingDeg, haversineKm, latLonToVec, rotateY, vecToLatLon, type Vec3 } from "@/lib/geo";
import type { Pass } from "@/lib/passes";
import type { PlaneInfo } from "./layers/Traffic";
import type { FireGrid } from "@/lib/feeds/fires";
import type { Quake } from "@/lib/feeds/quakes";
import { busiestRegion } from "@/lib/tour";
import type { Eclipse } from "@/lib/eclipses";
import { PLACES, placeById } from "@/lib/places";
import type { SearchCandidate } from "@/lib/search";
import { SatGroup } from "@/lib/feeds/satellites";
import { setFeed, useOrbis, type PlaneFilter } from "@/store/orbis";
import { CameraRig } from "./CameraRig";
import { RideAlong, rideable, type Locate } from "./RideAlong";
import { SimClock } from "./SimClock";
import { Ambience } from "./Ambience";
import { Fires } from "./layers/Fires";
import { Planet } from "./layers/Planet";
import { Quakes } from "./layers/Quakes";
import { Satellites } from "./layers/Satellites";
import { planeAltitude, Traffic } from "./layers/Traffic";
import { Tiles, TILES_FROM_DIST } from "./layers/Tiles";
import { Moon } from "./layers/Moon";
import { Aurora } from "./layers/Aurora";
import { SkyBodies } from "./layers/SkyBodies";
import { Celestial } from "./layers/Celestial";
import { Wind } from "./layers/Wind";
import { Storms } from "./layers/Storms";
import { stormAt, type Storm } from "@/lib/feeds/storms";
import { EXIT_FLOOR_AU, HANDOVER_RADII, SolarSystem, type BodyRef } from "./SolarSystem";
import { EARTH_RADIUS_AU } from "@/lib/orbits";
import type { BodyRecord } from "@/lib/feeds/bodies";
import type { SpacecraftTrack } from "@/lib/feeds/horizons";
import { EOX, esriImagery, rainRadar, type ImageryProvider } from "@/lib/tiles";
import { loadTexture, UploadQueue } from "./textures";
import { groundReticleFragment, groundReticleVertex, reticleFragment, reticleVertex, logDepth } from "./shaders";
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
  // GFS runs every six hours.
  wind: 3 * 3600_000,
  // GDACS updates advisories every six hours; the data workflow collects them every two.
  storms: 30 * 60_000,
};
const RETRY_MS = 45_000;
/** Scene hand-over with a little hysteresis: out past ENTER radii the heliocentric scene takes over, back inside EXIT the Earth scene does. */
const ENTER_RADII = HANDOVER_RADII * 1.01;
const EXIT_RADII = HANDOVER_RADII / 1.01;
/** How far the Earth camera may be asked to go: past the hand-over, so a fly-out never stalls there. */
const EARTH_MAX_RADII = HANDOVER_RADII * 1.5;
/** The heliocentric overview: the inner planets in one view. */
const OVERVIEW = { lat: 32, distAu: 2.6 };
/** The ground reticle's quad faces +Z. */
const Z_AXIS = new THREE.Vector3(0, 0, 1);
/** How long the opening swing-in plays; big texture uploads wait until it is over. */
const ENTRANCE_MS = 2800;
/** Geometry for compiling materials that no object uses yet. */
const STAND_IN = new THREE.PlaneGeometry(1e-6, 1e-6);

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
  private ride: RideAlong;
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
  private wind: Wind;
  private storms = new Storms();
  /** The wind field downloads the first time the layer is switched on. */
  private windScheduled = false;
  /** Closest approach to sea level, in Earth radii; terrain under the camera raises it. */
  private baseMinDist = 1.0024;
  private moon: Moon;
  private aurora: Aurora;
  private sky: SkyBodies;
  private celestial: Celestial;
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
  /** The reticle for spots on the ground (places, quakes, tapped points, storms): a ring lying on the terrain. */
  private groundReticle: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  /** Big textures go to the GPU one per frame slot (see textures.ts). */
  private uploads: UploadQueue;
  /** The day's cloud mask is on the globe (the bundled fallback must not replace it). */
  private cloudsLive = false;
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
    // Reading back link status after every compile blocks until the driver is done; the shaders are known good.
    this.renderer.debug.checkShaderErrors = process.env.NODE_ENV !== "production";
    this.uploads = new UploadQueue(this.renderer);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, options.lite ? 1.75 : 2);
    this.renderer.setPixelRatio(pixelRatio);
    this.maxPixelRatio = pixelRatio;
    this.textureSize = !options.lite && this.renderer.capabilities.maxTextureSize >= 4096 ? "4k" : "2k";
    this.coarse = window.matchMedia("(pointer: coarse)").matches;

    this.planet = new Planet(options.lite ? 112 : 192, options.lite);
    this.satellites = new Satellites(pixelRatio);
    this.fires = new Fires(pixelRatio);
    const providers: ImageryProvider[] = [EOX];
    const esriKey = process.env.NEXT_PUBLIC_ARCGIS_KEY;
    if (esriKey) providers.push(esriImagery(esriKey));
    const anisotropyMax = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.tiles = new Tiles(providers, this.planet.earthMaterial.uniforms, anisotropyMax, { terrain: true, lite: options.lite });
    this.rain = new Tiles([], {}, 2, { overlay: true, lift: 6e-5, lite: true });
    this.wind = new Wind(options.lite);
    this.moon = new Moon(this.planet.sun);
    this.aurora = new Aurora(this.planet.sun);
    this.sky = new SkyBodies(pixelRatio);
    this.celestial = new Celestial(3000, pixelRatio);
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
    this.groundReticle = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        ...logDepth(groundReticleVertex, groundReticleFragment),
        uniforms: { uColor: { value: new THREE.Color("#f2c14e") }, uClock: { value: 0 }, uOpacity: { value: 1 } },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.groundReticle.visible = false;
    this.groundReticle.frustumCulled = false;
    this.groundReticle.renderOrder = 10;

    this.inertial.add(this.celestial.group, this.satellites.points, this.satellites.orbit);
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
      this.storms.group,
      this.planet.clouds,
      this.wind.group,
      this.traffic.ships.mesh,
      this.traffic.planes.mesh,
      this.traffic.track,
      this.planet.atmosphere,
      this.reticle,
      this.groundReticle,
    );

    const layers = useOrbis.getState().layers;
    this.opacity = Object.fromEntries(
      (Object.keys(layers) as LayerKey[]).map((k) => [k, { value: layers[k] ? 1 : 0, target: layers[k] ? 1 : 0 }]),
    ) as Engine["opacity"];

    this.rig = new CameraRig(this.camera, canvas);
    this.ride = new RideAlong(this.rig, this.locate);
    this.rig.maxDist = EARTH_MAX_RADII;
    // Sub-metre imagery lets the camera descend to a few hundred metres; 10 m imagery stops it ~13 km up.
    this.baseMinDist = esriKey ? 1.0004 : 1.0024;
    this.rig.minDist = this.baseMinDist;
    this.rig.onUserMove = this.handleUserMove;
    this.system.rig.onUserMove = this.handleUserMove;
    this.rig.onTap = (x, y) => {
      const hit = this.pick(x, y);
      const ground = hit ? null : this.groundAt(x, y);
      useOrbis.getState().select(hit ?? (ground ? { kind: "point", ...ground } : null));
    };
    this.rig.ground = (lat, lon) => this.tiles.heightAt(lat, lon) / 6_371_000;
    this.rig.onFly = (goal) => {
      if (goal.dist < TILES_FROM_DIST) this.tiles.prefetch(goal.lat, goal.lon, goal.dist);
    };
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
    const anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const month = String(new Date(this.clock.now()).getUTCMonth() + 1).padStart(2, "0");
    const size = this.textureSize;
    type Slot = "uDay" | "uNight" | "uWater" | "uClouds";
    const map = async (url: string, color: boolean) => {
      const texture = await loadTexture(url);
      texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      texture.anisotropy = anisotropy;
      texture.wrapS = THREE.RepeatWrapping;
      return texture;
    };
    // First paint with small maps (~200 KB); the full-size ones replace them after the entrance.
    const quick: [string, Slot, boolean][] = [
      [`/textures/day-${month}-1k.jpg`, "uDay", true],
      ["/textures/night-1k.jpg", "uNight", false],
      ["/textures/water-2k.png", "uWater", false],
    ];
    let done = 0;
    await Promise.all(
      quick.map(async ([url, slot, color]) => {
        const texture = await map(url, color);
        if (this.disposed) return texture.dispose();
        this.planet.setTexture(slot, texture);
        this.renderer.initTexture(texture);
        done++;
        useOrbis.setState({ progress: done / quick.length });
      }),
    );
    if (this.disposed) return;
    await this.compileAll(this.scene, this.camera, [this.tiles.material, this.rain.material]);
    if (this.disposed) return;
    this.renderer.setAnimationLoop(this.frame);
    useOrbis.setState({ ready: true });

    // Everything below arrives while the Earth swings in; the GPU gets it one map at a time once it has.
    this.uploads.hold(ENTRANCE_MS);
    const upgrade = (url: string, slot: Slot, color: boolean) =>
      map(url, color).then((texture) => {
        if (this.disposed) return texture.dispose();
        // The live cloud mask may have come first: the fallback never replaces it.
        this.uploads.push(texture, () => (slot === "uClouds" && this.cloudsLive ? texture.dispose() : this.planet.setTexture(slot, texture)));
      });
    (async () => {
      await upgrade(`/textures/day-${month}-${size}.jpg`, "uDay", true);
      await upgrade(`/textures/night-${size}.jpg`, "uNight", false);
      await upgrade("/textures/clouds-fallback-2k.jpg", "uClouds", false);
    })().catch(() => undefined);
    this.celestial.load(this.options.lite ? "2k" : "4k", this.uploads).catch(() => undefined);
    loadTexture("/textures/sun-1k.jpg")
      .then((texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.RepeatWrapping;
        if (!this.disposed) this.uploads.push(texture, () => this.sky.setSunTexture(texture));
      })
      .catch(() => undefined);
    loadTexture("/textures/moon-2k.jpg")
      .then((texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = anisotropy;
        if (!this.disposed) this.uploads.push(texture, () => this.moon.setTexture(texture));
      })
      .catch(() => undefined);
    // Feeds start a beat apart: each one parses and uploads its buffers, and together they cost several frames.
    const feeds: [FeedKey, () => Promise<void>][] = [
      ["satellites", () => this.loadSatellites()],
      ["quakes", () => this.loadQuakes()],
      ["planes", () => this.loadPlanes()],
      ["storms", () => this.loadStorms()],
      ["ships", () => this.loadShips()],
      ["fires", () => this.loadFires()],
      ["clouds", () => this.loadClouds()],
      ["aurora", () => this.loadAurora()],
      ["rain", () => this.loadRain()],
    ];
    for (const [key] of feeds) if (useOrbis.getState().feeds[key].status === "idle") setFeed(key, { status: "loading" });
    feeds.forEach(([key, load], i) => this.timers.push(window.setTimeout(() => this.schedule(key, load), i * 140)));
    if (useOrbis.getState().layers.wind) this.scheduleWind();
    this.loadBorders();
    // The heliocentric scene is ready before anyone zooms out to it: shaders compiled and, on desktops, its maps
    // and bodies loaded, so the hand-over never waits for them.
    this.timers.push(
      window.setTimeout(() => {
        void this.compileAll(this.system.scene, this.system.camera);
        if (!this.options.lite) this.ensureSystemAssets();
      }, ENTRANCE_MS + 4000),
    );
  }

  /**
   * Compiles every shader a scene can use, hidden layers included, without blocking: the driver links them in
   * parallel where it can (KHR_parallel_shader_compile) instead of stalling the frame that first draws them.
   * `extra` are materials no object uses yet (tiles are made on demand).
   */
  private async compileAll(scene: THREE.Scene, camera: THREE.Camera, extra: THREE.Material[] = []) {
    const hidden: THREE.Object3D[] = [];
    scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    const stand = extra.map((m) => new THREE.Mesh(STAND_IN, m));
    for (const m of stand) scene.add(m);
    // Programs are created synchronously inside compileAsync; only the wait for the driver is deferred.
    const ready = this.renderer.compileAsync(scene, camera).catch(() => undefined);
    for (const m of stand) scene.remove(m);
    for (const o of hidden) o.visible = false;
    await ready;
  }

  dispose() {
    this.disposed = true;
    window.clearInterval(this.historyTimer);
    this.renderer.setAnimationLoop(null);
    this.timers.forEach((t) => window.clearTimeout(t));
    this.uploads.clear();
    this.observer.disconnect();
    this.rig.dispose();
    this.planet.dispose();
    this.satellites.dispose();
    this.quakes.dispose();
    this.fires.dispose();
    this.traffic.dispose();
    this.tiles.disposeAll();
    this.rain.disposeAll();
    this.wind.dispose();
    this.storms.dispose();
    this.moon.dispose();
    this.aurora.dispose();
    this.sky.dispose();
    this.celestial.dispose();
    this.system.dispose();
    this.ambience.dispose();
    this.reticleMaterial.dispose();
    this.reticle.geometry.dispose();
    this.groundReticle.geometry.dispose();
    this.groundReticle.material.dispose();
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
    if (key === "wind" && visible) this.scheduleWind();
  }

  private scheduleWind() {
    if (this.windScheduled) return;
    this.windScheduled = true;
    this.schedule("wind", () => this.loadWind());
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
    this.storms.select(selection?.kind === "storm" ? selection.id : null);
    this.traffic.clearTrack();
    if (selection?.kind === "plane" || selection?.kind === "ship") this.loadTrack(selection);
    // The next frame shows the right reticle for the kind (on the ground or in the air).
    this.reticle.visible = this.groundReticle.visible = false;
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
  private replayFromPast = false;

  /**
   * Moves the simulated clock. Anything other than "now at 1×" is a replay:
   * aircraft and ships switch from live polling to recorded 5-minute frames.
   */
  setTime(simMs: number, rate: number) {
    const now = Date.now();
    // The future is open too (eclipses, the sky ahead); only a replay of the past hands back to live when it catches up.
    const t = simMs;
    if (rate === 1 && Math.abs(now - t) < 5000) return this.goLive();
    this.replayFromPast = t < now - 5000;
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
    for (const s of this.storms.storms) {
      out.push({ kind: "storm", key: s.id, label: s.name, sub: `${s.windKmh} km/h`, terms: [s.name] });
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
    } else if (kind === "place") {
      this.flyToPlace(String(key));
    } else if (kind === "storm") {
      const storm = this.storms.storms.find((s) => s.id === key);
      if (!storm) return;
      store.select({ kind: "storm", id: storm.id });
      // A storm outside the shown time is flown to where it was last (or will first be) tracked.
      const at = stormAt(storm, now) ?? storm.track[now < storm.track[0].t ? 0 : storm.track.length - 1];
      this.rig.flyTo({ lat: at.lat, lon: at.lon, dist: 2.2 }, 1.6);
    } else {
      const quake = store.quakes.find((q) => q.id === key);
      if (!quake) return;
      store.select({ kind: "quake", quake });
      this.rig.flyTo({ lat: quake.lat, lon: quake.lon, dist: 2.2 }, 1.6);
    }
  }

  /**
   * A storm as the card shows it: its record, where its centre is at the shown time, and its motion over
   * the next three hours (bearing in degrees, speed in km/h). Null when the storm is unknown.
   */
  stormNow(id: number): { storm: Storm; lat: number; lon: number; heading: number | null; speedKmh: number | null } | null {
    const storm = this.storms.storms.find((s) => s.id === id);
    if (!storm) return null;
    const now = this.clock.now();
    const at = stormAt(storm, now);
    if (!at) {
      const last = storm.track[now < storm.track[0].t ? 0 : storm.track.length - 1];
      return { storm, lat: last.lat, lon: last.lon, heading: null, speedKmh: null };
    }
    const ahead = stormAt(storm, now + 3 * 3600_000) ?? stormAt(storm, now - 3 * 3600_000);
    if (!ahead) return { storm, ...at, heading: null, speedKmh: null };
    const forward = stormAt(storm, now + 3 * 3600_000) !== null;
    const [from, to] = forward ? [at, ahead] : [ahead, at];
    const heading = bearingDeg(from.lat, from.lon, to.lat, to.lon);
    return { storm, ...at, heading, speedKmh: haversineKm(from.lat, from.lon, to.lat, to.lon) / 3 };
  }

  /** The strongest tropical cyclone active at the shown time, for the tour; null when there is none. */
  get strongestStorm(): { id: number; lat: number; lon: number } | null {
    let best: { id: number; lat: number; lon: number; wind: number } | null = null;
    for (const { storm, at } of this.storms.positions()) {
      if (best && storm.windKmh <= best.wind) continue;
      const p = vecToLatLon([at.x, at.y, at.z]);
      best = { id: storm.id, lat: p.lat, lon: p.lon, wind: storm.windKmh };
    }
    return best && { id: best.id, lat: best.lat, lon: best.lon };
  }

  get stats() {
    return { satellites: this.satellites.count };
  }

  /** Called when the visitor takes the controls in either scene (the tour stops itself). */
  watchUser(fn: (() => void) | null) {
    this.userMove = fn;
  }

  private userMove: (() => void) | null = null;
  /** Any drag, pinch, wheel or key ends a ride-along and tells whoever is watching (the tour). */
  private handleUserMove = () => {
    if (this.ride.active) this.follow(null);
    this.userMove?.();
  };

  /**
   * Rides along with a satellite, aircraft or ship (see RideAlong). Anything else, or null, hands the camera back.
   */
  follow(selection: Selection | null) {
    this.ride.ride(rideable(selection) ? selection : null);
    useOrbis.setState({ following: this.ride.active });
  }

  private updateFollow(sim: number) {
    if (!this.ride.active) return;
    if (!this.ride.rides(useOrbis.getState().selection)) return this.follow(null);
    this.ride.update(sim);
  }

  /** Where a ridden object is, Earth-fixed: satellites from their propagated orbit, traffic as drawn. */
  private locate: Locate = (target, sim) => {
    if (target.kind === "satellite") {
      const p = this.satellites.positionOf(target.index, sim);
      return p ? rotateY(p, -gmst(sim)) : null;
    }
    const layer = target.kind === "plane" ? this.traffic.planes : this.traffic.ships;
    const i = layer.indexOf(target.id);
    return i >= 0 ? layer.displayed(i, sim / 1000) : null;
  };

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

    this.uploads.pump(now);
    if (this.space === "system") {
      this.systemFrame(sim, dt, now);
      return;
    }
    const sun = sunPosition(sim);
    this.planet.setSun(sun.lat, sun.lon);
    const rotation = gmst(sim);
    this.inertial.rotation.y = -rotation;
    this.moon.update(sim, rotation);
    this.planet.moon.set(...this.moon.position);
    this.sky.update(sim, this.planet.sun, rotation, this.clockSeconds, this.rig.pose.dist);

    this.updateFollow(sim);
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
    this.tiles.update(this.camera, this.height, this.rig.pose.dist, this.rig.goal.dist);
    this.rain.update(this.camera, this.height, this.rig.pose.dist);
    // The streaks are a view of the weather system: they bow out in close, where the 1° field has no more to tell.
    const windRange = THREE.MathUtils.smoothstep(this.rig.pose.dist, 1.1, 1.3) * (1 - THREE.MathUtils.smoothstep(this.rig.pose.dist, 12, 30));
    this.wind.update(this.renderer, dt, this.opacity.wind.value * windRange);
    // Never fly into a mountain: the floor follows the terrain under the camera.
    const foot = vecToLatLon([this.camera.position.x, this.camera.position.y, this.camera.position.z]);
    // Leaning views pivot on the ground under the pose; keep the camera itself clear of the terrain beneath it.
    const under = this.tiles.heightAt(foot.lat, foot.lon) / 6_371_000;
    const pivot = this.tiles.heightAt(this.rig.pose.lat, this.rig.pose.lon) / 6_371_000;
    const clearance = Math.max(this.baseMinDist - 1, under - pivot + 300 / 6_371_000);
    // Riding along, the follower keeps the camera at the object's height; only the imagery floor applies.
    this.rig.minDist = this.ride.active ? 1.0002 : 1 + pivot + clearance / Math.max(0.25, Math.cos(THREE.MathUtils.degToRad(this.rig.tilt)));
    const attributions = [...this.tiles.attributions, ...this.rain.attributions];
    if (attributions.join("|") !== this.lastAttribution) {
      this.lastAttribution = attributions.join("|");
      useOrbis.setState({ imageryAttribution: attributions });
    }

    this.satellites.update(sim);
    if (this.traffic.replay) {
      // Playback that catches up with the present hands over to the live feeds.
      if (this.replayFromPast && this.clock.rate > 0 && sim >= Date.now()) this.goLive();
      else this.traffic.syncReplay(sim / 1000);
    }
    this.traffic.update(sim / 1000);
    this.quakes.update(sim, this.clockSeconds, this.rig.pose.dist);
    this.storms.update(sim, this.clockSeconds, this.rig.pose.dist);
    this.fires.update(sim, this.clockSeconds);
    this.aurora.update(this.clockSeconds);
    this.updateReticle(sim);
    this.updatePlaces();
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
    // Out among the planets the figures are background: faint, so orbits and names read first.
    s.celestial.setOpacity(1, this.opacity.constellations.value * 0.45);
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
    if (after === "overview" && s.rig.gliding) s.recentre({ kind: "major", id: "sun" }, sim, s.rig.glideRemaining);
    else if (overview || after === "overview") s.flyToBody({ kind: "major", id: "sun" }, sim, OVERVIEW.distAu, OVERVIEW.lat);
    else if (after && typeof after === "object") {
      useOrbis.getState().select(null);
      useOrbis.getState().focusOn(after);
    }
    useOrbis.setState({ focusBody: s.focus });
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
    this.system.flyToBody({ kind: "major", id: "sun" }, this.clock.now(), OVERVIEW.distAu, OVERVIEW.lat);
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
      await this.system.loadTextures(this.options.lite, this.uploads);
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
    const view = this.pendingView && this.pendingView.ref.kind === ref.kind && JSON.stringify(this.pendingView.ref) === JSON.stringify(ref) ? this.pendingView : null;
    this.pendingView = null;
    if (view) this.system.flyToBody(ref, this.clock.now(), view.dist, view.lat, view.lon);
    else this.system.flyToBody(ref, this.clock.now());
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
      const dataLayer = key === "satellites" || key === "planes" || key === "ships" || key === "quakes" || key === "fires" || key === "aurora" || key === "rain" || key === "wind" || key === "storms";
      const focusScale = this.focus && dataLayer && this.focus !== key ? 0.18 : 1;
      o.value += (o.target * focusScale - o.value) * k;
    }
    // Far out, the data thins away long before the hand-over, so nothing is left to vanish at the switch.
    const dist = this.rig.pose.dist;
    const farFade = 1 - THREE.MathUtils.smoothstep(dist, 150, HANDOVER_RADII * 0.85);
    const surfaceFade = 1 - THREE.MathUtils.smoothstep(dist, 40, 170);
    this.satellites.setOpacity(this.opacity.satellites.value * farFade);
    // Constellation figures belong to the open sky: they come in as the globe shrinks.
    // Beside the bright planet the Milky Way stays a faint backdrop (its 4k map turns blotchy when magnified);
    // out in the solar system it comes up.
    this.celestial.setOpacity(1, this.opacity.constellations.value * THREE.MathUtils.smoothstep(this.rig.pose.dist, 5, 14), 0.14 + 0.56 * THREE.MathUtils.smoothstep(this.rig.pose.dist, 3, 40));
    this.quakes.setOpacity(this.opacity.quakes.value * surfaceFade);
    this.storms.setOpacity(this.opacity.storms.value * surfaceFade);
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
    if (sel.kind === "quake") return this.surfacePoint(sel.quake.lat, sel.quake.lon);
    if (sel.kind === "storm") {
      const at = this.storms.positions().find((s) => s.storm.id === sel.id)?.at;
      return at ? [at.x * 1.007, at.y * 1.007, at.z * 1.007] : null;
    }
    if (sel.kind === "place") {
      const p = placeById(sel.id);
      return p ? this.surfacePoint(p.lat, p.lon) : null;
    }
    return this.surfacePoint(sel.lat, sel.lon);
  }

  /**
   * A marker's anchor on the ground: the real terrain height plus a lift that shrinks with the camera's altitude
   * (a few kilometres from orbit, tens of metres near the ground), so a marker never floats off its spot in a
   * close, tilted view and never sinks into a ridge from afar.
   */
  private surfacePoint(lat: number, lon: number): Vec3 {
    // From high up the lift (kilometres) dwarfs what relief changes on screen: skip the grid lookups.
    const ground = this.rig.pose.dist < 1.3 ? Math.max(0, this.tiles.heightAt(lat, lon)) / 6_371_000 : 0;
    const lift = THREE.MathUtils.clamp((this.rig.pose.dist - 1) * 0.0015, 3e-6, 0.003);
    return latLonToVec(lat, lon, 1 + ground + lift);
  }

  private updateReticle(sim: number) {
    this.reticleMaterial.uniforms.uClock.value = this.clockSeconds;
    const p = this.selectionPosition(sim);
    const kind = useOrbis.getState().selection?.kind;
    const ground = kind === "quake" || kind === "storm" || kind === "place" || kind === "point";
    this.reticle.visible = !!p && !ground;
    this.groundReticle.visible = !!p && ground;
    if (!p) return;
    if (ground) {
      this.layGroundReticle(p, kind !== "storm");
      return;
    }
    const attr = this.reticle.geometry.getAttribute("position") as THREE.BufferAttribute;
    attr.setXYZ(0, p[0], p[1], p[2]);
    attr.needsUpdate = true;
  }

  /**
   * Lays the ground reticle on the terrain at `p`, about 52 px across at any distance: from straight above it is
   * a circle, from a tilted view an ellipse that shows the angle of the ground. `terrain` follows the slope
   * (storms sit on the cloud deck, which is level).
   */
  private layGroundReticle(p: Vec3, terrain: boolean) {
    const m = this.groundReticle;
    m.material.uniforms.uClock.value = this.clockSeconds;
    m.position.set(p[0], p[1], p[2]);
    const cam = this.camera.position;
    const half = (26 / this.height) * 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * cam.distanceTo(m.position);
    m.scale.setScalar(half);
    const up = new THREE.Vector3(p[0], p[1], p[2]).normalize();
    const n = up.clone();
    if (terrain) {
      // The slope across the ring's footprint, from the same height grids the terrain is built from.
      const { lat, lon } = vecToLatLon(p);
      const dLat = THREE.MathUtils.radToDeg(half);
      const dLon = dLat / Math.max(0.05, Math.cos(THREE.MathUtils.degToRad(lat)));
      const h = (la: number, lo: number) => this.tiles.heightAt(la, lo) / 6_371_000;
      const slopeE = (h(lat, lon + dLon) - h(lat, lon - dLon)) / (2 * half);
      const slopeN = (h(lat + dLat, lon) - h(lat - dLat, lon)) / (2 * half);
      const phi = THREE.MathUtils.degToRad(lat);
      const lam = THREE.MathUtils.degToRad(lon);
      const east = new THREE.Vector3(-Math.sin(lam), 0, -Math.cos(lam));
      const north = new THREE.Vector3(-Math.sin(phi) * Math.cos(lam), Math.cos(phi), Math.sin(phi) * Math.sin(lam));
      // Most of the slope, not all of it: on exaggerated relief a ring fully along a cliff reads as a wall sign.
      n.addScaledVector(east, -slopeE * 0.7).addScaledVector(north, -slopeN * 0.7).normalize();
    }
    // Never edge-on: at grazing views it leans toward the camera just enough to stay readable.
    const view = new THREE.Vector3().subVectors(cam, m.position).normalize();
    const facing = n.dot(view);
    if (facing < 0.3) n.addScaledVector(view, (0.3 - facing) * 1.4).normalize();
    m.quaternion.setFromUnitVectors(Z_AXIS, n);
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
      // Behind the camera a point projects mirrored onto the screen; it can never be what was tapped.
      if (v.z > 1) return Infinity;
      return Math.hypot(((v.x + 1) / 2) * w - px, ((1 - v.y) / 2) * h - py);
    };
    const surfaceVisible = (x: number, y: number, z: number) => x * (cam.x - x) + y * (cam.y - y) + z * (cam.z - z) > 0;

    if (this.opacity.storms.target > 0) {
      for (const { storm, at } of this.storms.positions()) {
        if (!surfaceVisible(at.x, at.y, at.z)) continue;
        // A storm's swirl is wide; anywhere near its eye counts.
        const d = screen(at.x, at.y, at.z) - 12;
        if (d < bestD) {
          bestD = d;
          best = { kind: "storm", id: storm.id };
        }
      }
    }

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


  /** Where a screen point meets the globe, or null for space. */
  private groundAt(clientX: number, clientY: number): { lat: number; lon: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    // The ground is the sea-level sphere raised by the terrain under the hit; a few rounds of re-intersecting
    // with the sphere at that height land on the hillside that was tapped, not on sea level behind it.
    const sphere = new THREE.Sphere(new THREE.Vector3(), 1);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectSphere(sphere, hit)) return null;
    for (let i = 0; i < 3; i++) {
      const at = vecToLatLon([hit.x, hit.y, hit.z]);
      sphere.radius = 1 + Math.max(0, this.tiles.heightAt(at.lat, at.lon)) / 6_371_000;
      if (!ray.ray.intersectSphere(sphere, hit)) break;
    }
    const p = vecToLatLon([hit.x, hit.y, hit.z]);
    return { lat: Math.round(p.lat * 1e4) / 1e4, lon: Math.round(p.lon * 1e4) / 1e4 };
  }

  /** Landmark pins: the HTML layer registers here and is told, every frame, where each one is on screen. */
  /** Receives the screen position of every landmark pin and storm name each frame. */
  placesListener: ((items: { id: string; x: number; y: number; alpha: number; r?: number }[]) => void) | null = null;
  watchPlaces(fn: Engine["placesListener"]) {
    this.placesListener = fn;
  }

  private placeItems: { id: string; x: number; y: number; alpha: number; v: THREE.Vector3; r?: number; lat?: number; lon?: number }[] = PLACES.map((p) => ({
    id: p.id as string,
    x: 0,
    y: 0,
    alpha: 0,
    v: new THREE.Vector3(...latLonToVec(p.lat, p.lon, 1.0005)),
    lat: p.lat,
    lon: p.lon,
  }));
  /** Storm names follow their centres; ids are "storm:<GDACS id>". */
  private stormItems: Engine["placeItems"] = [];
  private pinItems: Engine["placeItems"] = this.placeItems;

  private updatePlaces() {
    if (!this.placesListener) return;
    const cam = this.camera.position;
    const layer = this.opacity.places.value;
    // Pins appear as the globe fills the view and stay until the camera is on the ground.
    const far = 1 - THREE.MathUtils.smoothstep(this.rig.pose.dist, 3.2, 4.6);
    const v = new THREE.Vector3();
    for (const it of this.placeItems) {
      if (layer * far < 0.001) {
        it.alpha = 0;
        continue;
      }
      // Pins stand on the terrain under them, as the selection marker does.
      it.v.set(...this.surfacePoint(it.lat!, it.lon!));
      const facing = it.v.x * (cam.x - it.v.x) + it.v.y * (cam.y - it.v.y) + it.v.z * (cam.z - it.v.z);
      v.copy(it.v).project(this.camera);
      const onScreen = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      // Fade out near the limb rather than vanish.
      const limb = THREE.MathUtils.smoothstep(facing / (it.v.length() * cam.distanceTo(it.v) || 1), 0, 0.12);
      it.alpha = onScreen && facing > 0 ? layer * far * limb : 0;
      it.x = ((v.x + 1) / 2) * this.width;
      it.y = ((1 - v.y) / 2) * this.height;
    }
    if (this.stormItems.length) {
      const centres = new Map(this.storms.positions().map((p) => [`storm:${p.storm.id}`, p]));
      // Storm names hold out further than landmark pins: a typhoon is worth naming from orbit.
      const named = this.opacity.storms.value * (1 - THREE.MathUtils.smoothstep(this.rig.pose.dist, 6, 9));
      for (const it of this.stormItems) {
        const centre = centres.get(it.id);
        if (!centre) {
          it.alpha = 0;
          continue;
        }
        it.v.copy(centre.at).multiplyScalar(1.0068);
        // The swirl's radius on screen, so the name can sit just outside it: the eye's distance to the camera
        // turns the swirl's size in Earth radii into pixels.
        const fovScale = this.height / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
        it.r = (centre.radius / Math.max(1e-6, this.camera.position.distanceTo(it.v))) * fovScale;
        const facing = it.v.x * (cam.x - it.v.x) + it.v.y * (cam.y - it.v.y) + it.v.z * (cam.z - it.v.z);
        v.copy(it.v).project(this.camera);
        const onScreen = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
        const limb = THREE.MathUtils.smoothstep(facing / (it.v.length() * cam.distanceTo(it.v) || 1), 0, 0.12);
        it.alpha = onScreen && facing > 0 ? named * limb : 0;
        it.x = ((v.x + 1) / 2) * this.width;
        it.y = ((1 - v.y) / 2) * this.height;
      }
    }
    this.placesListener(this.pinItems);
  }

  /**
   * Takes the globe to an eclipse. Solar: an hour and a half before greatest eclipse at 600×, over the
   * point the shadow crosses, so the Moon's shadow sweeps the disc in under a minute. Lunar: paused at
   * greatest eclipse, the camera behind the Moon looking back at the Earth.
   */
  watchEclipse(e: Eclipse) {
    if (e.kind === "solar") {
      if (this.space === "system") this.returnToEarth();
      this.setTime(e.time - 90 * 60_000, 600);
      this.rig.glide({ lat: e.lat, lon: e.lon, dist: 3.4 }, 2.6);
    } else {
      // From near the Earth, looking at the Moon: its lit face, red in the umbra.
      this.setTime(e.time, 0);
      const moon: BodyRef = { kind: "major", id: "moon" };
      this.pendingView = { ref: moon, ...this.moonViewFromEarth(e.time) };
      if (this.space === "system") this.focusBody(moon);
      else this.goToSystem(moon);
      useOrbis.setState({ focusBody: moon });
    }
  }

  /** A flight's arrival view, used once by the next flight to that body. */
  private pendingView: { ref: BodyRef; lat: number; lon: number; dist: number } | null = null;

  /** Camera direction around the Moon that looks at it from the Earth's side, 25 lunar radii out. */
  private moonViewFromEarth(ms: number): { lat: number; lon: number; dist: number } {
    const m = this.system.heliocentric({ kind: "major", id: "moon" }, ms)!;
    const e = this.system.heliocentric({ kind: "major", id: "earth" }, ms)!;
    const p = vecToLatLon([e[0] - m[0], e[1] - m[1], e[2] - m[2]]);
    // A little off the Earth–Moon line so the Earth is not hidden straight behind the camera.
    return { lat: p.lat + 8, lon: p.lon + 8, dist: 25 * (1737.4 / 149_597_870.7) };
  }

  /** Selects a landmark and flies to its best view. */
  flyToPlace(id: string) {
    const p = placeById(id);
    if (!p) return;
    useOrbis.getState().select({ kind: "place", id: p.id });
    if (this.space === "system") {
      this.afterHandover = null;
      this.returnToEarth();
    }
    this.rig.glide({ lat: p.lat, lon: p.lon, dist: p.view }, Math.min(6, 2.2 + Math.abs(Math.log(this.rig.pose.dist / p.view)) * 0.9));
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
    const texture = await loadTexture(meta.urls[this.textureSize], { crossOrigin: true });
    texture.colorSpace = THREE.NoColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    if (this.disposed) return texture.dispose();
    this.uploads.push(texture, () => {
      this.cloudsLive = true;
      this.planet.setTexture("uClouds", texture);
    });
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

  private async loadWind() {
    const res = await fetch("/api/wind");
    if (!res.ok) throw new Error(`wind ${res.status}`);
    const meta = (await res.json()) as {
      cycle: string;
      range: number;
      url: string;
    };
    const image = await fetch(meta.url);
    if (!image.ok) throw new Error(`wind field ${image.status}`);
    // Decode to raw pixels: the particles need exact channel values, and the cards read the same numbers.
    const bitmap = await createImageBitmap(await image.blob(), {
      colorSpaceConversion: "none",
      premultiplyAlpha: "none",
    });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0);
    const pixels = new Uint8Array(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data.buffer);
    bitmap.close();
    if (this.disposed) return;
    this.wind.setField({
      cycle: meta.cycle,
      range: meta.range,
      width: canvas.width,
      height: canvas.height,
      pixels,
    });
    setFeed("wind", {
      status: "ready",
      count: 1,
      updated: Date.parse(meta.cycle),
    });
  }

  private async loadStorms() {
    const res = await fetch("/api/storms");
    if (!res.ok) throw new Error(`storms ${res.status}`);
    const { storms } = (await res.json()) as { storms: Storm[] };
    if (this.disposed) return;
    this.storms.set(storms);
    this.stormItems = storms.map((s) => ({ id: `storm:${s.id}`, x: 0, y: 0, alpha: 0, v: new THREE.Vector3() }));
    this.pinItems = [...this.placeItems, ...this.stormItems];
    useOrbis.setState({ stormPins: storms.map((s) => ({ id: s.id, name: s.name, alert: s.alert })) });
    const now = this.clock.now();
    setFeed("storms", { status: "ready", count: storms.filter((s) => stormAt(s, now)).length, updated: Date.now() });
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
