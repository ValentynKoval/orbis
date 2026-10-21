import * as THREE from "three";
import { gmst, sunPosition } from "@/lib/astro";
import { latLonToVec, rotateY, type Vec3 } from "@/lib/geo";
import type { FireGrid } from "@/lib/feeds/fires";
import type { Quake } from "@/lib/feeds/quakes";
import { busiestRegion } from "@/lib/tour";
import type { SearchCandidate } from "@/lib/search";
import { SatGroup } from "@/lib/feeds/satellites";
import { setFeed, useOrbis, type PlaneFilter } from "@/store/orbis";
import { CameraRig } from "./CameraRig";
import { SimClock } from "./SimClock";
import { Fires } from "./layers/Fires";
import { Planet } from "./layers/Planet";
import { Quakes } from "./layers/Quakes";
import { Satellites } from "./layers/Satellites";
import { planeAltitude, Traffic } from "./layers/Traffic";
import { reticleFragment, reticleVertex } from "./shaders";
import type { FeedKey, LayerKey, Selection } from "./types";

const REFRESH_MS: Record<FeedKey, number> = {
  satellites: 2 * 3600_000,
  planes: 45_000,
  ships: 60_000,
  quakes: 60_000,
  fires: 30 * 60_000,
  clouds: 6 * 3600_000,
};
const RETRY_MS = 45_000;

export interface EngineOptions {
  /** Phones and small tablets: lighter textures, geometry and pixel ratio. */
  lite: boolean;
}

export class Engine {
  readonly clock = new SimClock();
  readonly rig: CameraRig;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 0.01, 400);
  private inertial = new THREE.Group();
  private planet: Planet;
  private satellites: Satellites;
  private quakes = new Quakes();
  private fires: Fires;
  readonly traffic = new Traffic();
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
    });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, options.lite ? 1.75 : 2);
    this.renderer.setPixelRatio(pixelRatio);
    this.textureSize = !options.lite && this.renderer.capabilities.maxTextureSize >= 4096 ? "4k" : "2k";
    this.coarse = window.matchMedia("(pointer: coarse)").matches;

    this.planet = new Planet(options.lite ? 112 : 192, pixelRatio);
    this.satellites = new Satellites(pixelRatio);
    this.fires = new Fires(pixelRatio);

    this.reticleMaterial = new THREE.ShaderMaterial({
      vertexShader: reticleVertex,
      fragmentShader: reticleFragment,
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
    this.scene.add(
      this.inertial,
      this.planet.earth,
      this.planet.borders,
      this.fires.points,
      this.quakes.mesh,
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
    const jobs: [string, "uDay" | "uNight" | "uWater" | "uClouds", boolean][] = [
      [`/textures/day-${month}-${size}.jpg`, "uDay", true],
      [`/textures/night-${size}.jpg`, "uNight", false],
      ["/textures/water-2k.png", "uWater", false],
      ["/textures/clouds-fallback-2k.jpg", "uClouds", false],
    ];
    let done = 0;
    await Promise.all(
      jobs.map(async ([url, slot, color]) => {
        const texture = await loader.loadAsync(url);
        texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        texture.anisotropy = anisotropy;
        texture.wrapS = THREE.RepeatWrapping;
        if (this.disposed) return texture.dispose();
        this.planet.setTexture(slot, texture);
        this.renderer.initTexture(texture);
        done++;
        useOrbis.setState({ progress: done / jobs.length });
      }),
    );
    if (this.disposed) return;
    this.renderer.compile(this.scene, this.camera);
    this.renderer.setAnimationLoop(this.frame);
    useOrbis.setState({ ready: true });

    this.schedule("satellites", () => this.loadSatellites());
    this.schedule("planes", () => this.loadPlanes());
    this.schedule("ships", () => this.loadShips());
    this.schedule("quakes", () => this.loadQuakes());
    this.schedule("fires", () => this.loadFires());
    this.schedule("clouds", () => this.loadClouds());
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
    this.reticleMaterial.dispose();
    this.reticle.geometry.dispose();
    this.renderer.dispose();
  }

  setInteractive(on: boolean) {
    this.rig.interactive = on;
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
    const t = Math.min(simMs, now);
    if (rate === 1 && now - t < 5000) return this.goLive();
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

  // ---------------------------------------------------------------- frame

  private frame = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.clockSeconds += dt;
    const sim = this.clock.now();

    const sun = sunPosition(sim);
    this.planet.setSun(sun.lat, sun.lon);
    this.inertial.rotation.y = -gmst(sim);

    this.rig.update(dt, this.width, this.height);
    this.animateOpacity(dt);

    this.satellites.update(sim);
    if (this.traffic.replay) {
      // Playback that catches up with the present hands over to the live feeds.
      if (this.clock.rate > 0 && sim >= Date.now()) this.goLive();
      else this.traffic.syncReplay(sim / 1000);
    }
    this.traffic.update(sim / 1000);
    this.quakes.update(sim, this.clockSeconds, this.rig.pose.dist);
    this.fires.update(sim, this.clockSeconds);
    this.updateReticle(sim);
    this.updateLiveDetails(sim, now);

    this.renderer.render(this.scene, this.camera);
  };

  private animateOpacity(dt: number) {
    const k = 1 - Math.exp(-dt * 5);
    for (const key of Object.keys(this.opacity) as LayerKey[]) {
      const o = this.opacity[key];
      const dataLayer = key === "satellites" || key === "planes" || key === "ships" || key === "quakes" || key === "fires";
      const focusScale = this.focus && dataLayer && this.focus !== key ? 0.18 : 1;
      o.value += (o.target * focusScale - o.value) * k;
    }
    this.satellites.setOpacity(this.opacity.satellites.value);
    this.quakes.setOpacity(this.opacity.quakes.value);
    this.fires.setOpacity(this.opacity.fires.value);
    this.traffic.planes.setOpacity(this.opacity.planes.value);
    this.traffic.ships.setOpacity(this.opacity.ships.value);
    this.traffic.track.visible &&= this.opacity.planes.value + this.opacity.ships.value > 0.02;
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
    const res = await fetch(`/api/clouds?w=${this.textureSize === "4k" ? 4096 : 2048}`);
    if (!res.ok) throw new Error(`clouds ${res.status}`);
    const [source, date] = (res.headers.get("X-Orbis-Clouds") ?? "").split(";");
    const url = URL.createObjectURL(await res.blob());
    try {
      const texture = await new THREE.TextureLoader().loadAsync(url);
      texture.colorSpace = THREE.NoColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      if (this.disposed) return texture.dispose();
      this.planet.setTexture("uClouds", texture);
    } finally {
      URL.revokeObjectURL(url);
    }
    useOrbis.setState({ cloudsDate: source === "gibs" ? date : null });
    setFeed("clouds", { status: "ready", count: 1, updated: Date.now() });
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
