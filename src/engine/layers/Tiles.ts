import * as THREE from "three";
import { latLonToVec, vecToLatLon } from "@/lib/geo";
import { providerFor, tileAt, tileBounds, tileKey, type ImageryProvider } from "@/lib/tiles";
import { sampleGrid, TERRAIN_MAX_LEVEL, TERRAIN_MIN_LEVEL, TERRAIN_VERSION, terrainTileFor, tileUv } from "@/lib/terrain";
import { earthFragment, logDepth } from "../shaders";

const SEGMENTS = 12;
const TILE_PX = 256;
/** Subdivide when a tile would cover more than this many screen pixels. */
const SPLIT_PX = TILE_PX * 1.15;
const FADE_MS = 350;
/** A request nobody has asked for in this long is cancelled (the camera moved on for good; shorter waits re-requested the same tiles during a dive). */
const STALE_REQUEST_MS = 3000;
/** Tiles are used only when the camera is closer than this (Earth radii from the centre). */
export const TILES_FROM_DIST = 3.4;
const TILES_FULL_DIST = 2.6;
export const TERRAIN_EXAGGERATION = 1.6;
const EARTH_M = 6_371_000;
/** Everest with the exaggeration applied, in Earth radii: the most any tile can rise above the base sphere. */
const TERRAIN_MARGIN = (8849 * TERRAIN_EXAGGERATION) / EARTH_M;
/** Parents drawn under partly loaded children sink by this fraction of their size, so coarser relief never pokes through. */
const UNDERLAY_SINK = 0.02;

interface Node {
  z: number;
  x: number;
  y: number;
  key: string;
  center: THREE.Vector3;
  radius: number;
  /** Distance from the centre to the farthest corner, Earth radii. */
  extent: number;
  texture: THREE.Texture | null;
  loadedAt: number;
  loading: AbortController | null;
  failedAt: number;
  mesh: THREE.Mesh | null;
  lastUsed: number;
  /** Last frame anything asked for this tile's image; requests left behind are cancelled. */
  lastWanted: number;
  priority: number;
  /** The terrain grid this patch takes its relief from, and whether the mesh already has it. */
  terrainKey: string | null;
  raised: boolean;
  /** Highest relief of the patch's height grid (exaggerated, Earth radii); 0 until the grid arrives. */
  top: number;
}

export const tilesVertex = /* glsl */ `
  attribute vec2 aGlobalUv;
  uniform float uSink;
  varying vec2 vUv;
  varying vec2 vTileUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vUv = aGlobalUv;
    vTileUv = uv;
    vec4 world = modelMatrix * vec4(position * (1.0 - uSink), 1.0);
    vPosW = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

/** The planet shader with the day albedo read from the tile and the rest from the global maps. */
export const tilesFragment = earthFragment
  .replace("varying vec2 vUv;", "varying vec2 vUv;\n  varying vec2 vTileUv;\n  uniform float uFade;\n  uniform sampler2D uBase;\n  uniform float uOpenSea;")
  // Sentinel-2 mosaics are muted; lift them toward the Blue Marble look. Their open ocean is a dark mosaic with
  // swath seams, so out at sea, until coastal zoom levels, the planet's own Blue Marble ocean shows instead.
  .replace(
    "vec3 albedo = texture2D(uDay, vUv).rgb;\n    float water = texture2D(uWater, vUv).r;",
    "float water = texture2D(uWater, vUv).r;\n    vec3 albedo = mix(pow(texture2D(uDay, vTileUv).rgb, vec3(0.78)) * 1.5, texture2D(uBase, vUv).rgb, smoothstep(0.85, 1.0, water) * uOpenSea);",
  )
  .replace("gl_FragColor = vec4(lit + night + atmosphere, 1.0);", "gl_FragColor = vec4(lit + night + atmosphere, uFade);");

/** Overlays (weather radar): the tile's own colours and alpha, nothing else. */
const overlayFragment = /* glsl */ `
  uniform sampler2D uDay;
  uniform float uFade;
  varying vec2 vTileUv;
  void main() {
    vec4 c = texture2D(uDay, vTileUv);
    if (c.a < 0.02) discard;
    gl_FragColor = vec4(c.rgb, c.a * uFade);
    #include <colorspace_fragment>
  }
`;

export interface TilesOptions {
  /** Draw the tile images as a translucent overlay instead of as the planet's surface. */
  overlay?: boolean;
  /** Raise patches by real elevation (compact grids from /api/terrain). */
  terrain?: boolean;
  /** Extra lift above the surface in Earth radii (overlays sit above imagery). */
  lift?: number;
  /** Phones: fewer parallel requests and textures. */
  lite?: boolean;
}

/** Decodes an image off the main thread where the browser can. Rows stay north-first: meshes flip v instead. */
async function decodeImage(blob: Blob, alpha: boolean): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob, alpha ? { premultiplyAlpha: "none" } : {});
    } catch {
      // Older Safari rejects the options bag: fall through.
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Streams Web Mercator tiles onto the globe as the camera closes in.
 *
 * Loading is target-first: the quadtree is walked down to the level the view
 * needs and those tiles are requested at once, nearest the screen centre
 * first, instead of descending one level per round trip. Whatever is already
 * loaded at any level is drawn meanwhile, coarser tiles underneath. Requests
 * the camera has moved away from are cancelled; images are decoded off the
 * main thread. With `terrain`, each patch is raised by a compact height grid
 * shared by every tile it covers.
 */
export class Tiles {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  /** Attribution lines of the providers drawn in the last frame. */
  attributions: string[] = [];
  opacity = 1;
  private nodes = new Map<string, Node>();
  private inFlight = new Set<Node>();
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  private drawn = new Set<Node>();
  private wanted: Node[] = [];
  private prefetched: Node[] = [];
  private usedProviders = new Set<string>();
  private layerFade = 0;
  private anisotropy = 4;
  private camera: THREE.PerspectiveCamera | null = null;
  private pxPerRadian = 800;
  private readonly terrain: boolean;
  private readonly lift: number;
  private readonly overlay: boolean;
  private readonly maxInFlight: number;
  /** New textures shown per frame: spreads GPU uploads so a burst of arrivals never stalls a frame. */
  private readonly revealPerFrame: number;
  private arrived: { node: Node; texture: THREE.Texture }[] = [];
  private diving = false;
  private readonly maxTextures: number;
  private grids = new Map<string, Int16Array | "loading" | "failed">();
  /** Highest point of each loaded grid, Earth radii (exaggerated). */
  private gridTops = new Map<string, number>();
  private v = new THREE.Vector3();
  private sphere = new THREE.Sphere();

  constructor(
    private providers: ImageryProvider[],
    sharedUniforms: Record<string, THREE.IUniform>,
    anisotropy: number,
    options: TilesOptions = {},
  ) {
    this.anisotropy = anisotropy;
    this.terrain = !!options.terrain;
    this.lift = options.lift ?? 0;
    this.overlay = !!options.overlay;
    // Every tile host speaks HTTP/2, so requests share one connection: many can be in flight at once.
    this.maxInFlight = options.lite ? 14 : 28;
    this.revealPerFrame = options.lite ? 4 : 8;
    this.maxTextures = options.lite ? 220 : 420;
    const own = { uDay: { value: null }, uFade: { value: 1 }, uSink: { value: 0 } };
    this.material = options.overlay
      ? new THREE.ShaderMaterial({ ...logDepth(tilesVertex, overlayFragment), uniforms: own, transparent: true, depthWrite: false })
      : new THREE.ShaderMaterial({
          ...logDepth(tilesVertex, tilesFragment),
          // The planet's day map stays reachable as uBase: the same uniform object, so it follows texture swaps.
          uniforms: { ...sharedUniforms, ...own, uBase: sharedUniforms.uDay, uOpenSea: { value: 0 } },
          transparent: true,
          depthWrite: true,
        });
  }

  get maxLevel() {
    return Math.max(-1, ...this.providers.map((p) => p.maxLevel));
  }

  /** Swaps providers (e.g. a new radar frame) and forgets every cached tile. */
  setProviders(providers: ImageryProvider[]) {
    this.providers = providers;
    for (const n of [...this.nodes.values()]) this.dispose(n);
  }

  /** Call every frame; `dist` is the camera distance from the Earth's centre. */
  update(camera: THREE.PerspectiveCamera, viewportHeight: number, dist: number, goalDist = dist) {
    const now = performance.now();
    // Diving fast toward a much closer goal: the levels passed on the way are obsolete in a moment.
    this.diving = goalDist < dist * 0.6;
    this.camera = camera;
    this.layerFade = THREE.MathUtils.clamp((TILES_FROM_DIST - dist) / (TILES_FROM_DIST - TILES_FULL_DIST), 0, 1) * this.opacity;
    for (const n of this.drawn) if (n.mesh) n.mesh.visible = false;
    this.drawn.clear();
    this.wanted.length = 0;
    this.usedProviders.clear();
    // No providers yet (the radar frame has not arrived) or faded out: nothing to walk. Without the first
    // guard the root level is Math.min() = Infinity and the loop below never ends.
    if (!this.providers.length || this.layerFade <= 0.005) {
      this.group.visible = false;
      this.attributions = [];
      this.cancelStale(now);
      return;
    }
    this.group.visible = true;
    this.reveal(now);
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    this.pxPerRadian = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    const root = Math.min(...this.providers.map((p) => p.minLevel));
    const n = 2 ** root;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) this.visit(root, x, y, camera.position, now);
    this.cancelStale(now);
    this.pump(now);
    this.evict(now);
    this.attributions = this.providers.filter((p) => this.usedProviders.has(p.id)).map((p) => p.attribution);
  }

  /**
   * Starts loading what a view of (lat, lon) from `dist` will need, before the camera gets there:
   * the tiles around the point at the level that view resolves, and two levels coarser.
   */
  prefetch(lat: number, lon: number, dist: number) {
    if (!this.providers.length) return;
    const altitude = Math.max(1e-5, dist - 1);
    const cos = Math.max(0.05, Math.cos(THREE.MathUtils.degToRad(lat)));
    const ideal = Math.log2((2 * Math.PI * cos * this.pxPerRadian) / (altitude * SPLIT_PX));
    const minLevel = Math.min(...this.providers.map((p) => p.minLevel));
    const target = THREE.MathUtils.clamp(Math.ceil(ideal), minLevel, this.maxLevel);
    const until = performance.now() + 6000;
    this.prefetched = [];
    for (const [z, r] of [
      [Math.max(minLevel, target - 3), 0],
      [target, 1],
      [Math.max(minLevel, target - 1), 0],
    ] as const) {
      if (!providerFor(this.providers, z)) continue;
      const { x, y } = tileAt(z, lat, lon);
      const n = 2 ** z;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const ty = y + dy;
          if (ty < 0 || ty >= n) continue;
          const node = this.node(z, (((x + dx) % n) + n) % n, ty);
          node.lastWanted = node.lastUsed = until;
          // The coarse preview first, then the target level, then the one between.
          node.priority = z === Math.max(minLevel, target - 3) ? 2e6 : 1e6 - z;
          this.prefetched.push(node);
          if (this.terrain) this.ensureTerrain(node);
        }
      }
    }
  }

  /** Terrain height (metres, exaggerated) under a point, from the finest grid loaded; 0 when unknown. */
  heightAt(lat: number, lon: number): number {
    if (!this.terrain) return 0;
    for (let z = TERRAIN_MAX_LEVEL; z >= TERRAIN_MIN_LEVEL; z--) {
      const { x, y } = tileAt(z, lat, lon);
      const grid = this.grids.get(tileKey(z, x, y));
      if (!(grid instanceof Int16Array)) continue;
      const { u, v } = tileUv(z, x, y, lat, lon);
      return Math.max(0, sampleGrid(grid, u, v)) * TERRAIN_EXAGGERATION;
    }
    return 0;
  }

  private node(z: number, x: number, y: number): Node {
    const key = tileKey(z, x, y);
    let node = this.nodes.get(key);
    if (node) return node;
    const b = tileBounds(z, x, y);
    const corners = [latLonToVec(b.north, b.west), latLonToVec(b.north, b.east), latLonToVec(b.south, b.west), latLonToVec(b.south, b.east)].map(
      (p) => new THREE.Vector3(...p),
    );
    const center = new THREE.Vector3(...latLonToVec((b.north + b.south) / 2, (b.west + b.east) / 2));
    const extent = Math.max(...corners.map((c) => c.distanceTo(center)));
    // Room for relief above the base sphere, in proportion to the tile: a fixed margin made hundreds
    // of street-level tiles count as visible and starved the ones on screen.
    const radius = extent * 1.05 + Math.min(TERRAIN_MARGIN, extent * 2);
    const t = this.terrain ? terrainTileFor(z, x, y) : null;
    node = {
      z,
      x,
      y,
      key,
      center,
      radius,
      extent,
      texture: null,
      loadedAt: 0,
      loading: null,
      failedAt: 0,
      mesh: null,
      lastUsed: 0,
      lastWanted: 0,
      priority: 0,
      terrainKey: t ? tileKey(t.z, t.x, t.y) : null,
      raised: false,
      top: 0,
    };
    // A grid other tiles already loaded: bound the relief now, or a tile made after the grid arrived would keep
    // flat bounds and drop out of view while its mountain is still on screen.
    const top = node.terrainKey ? this.gridTops.get(node.terrainKey) : undefined;
    if (top !== undefined) this.fitRelief(node, top);
    this.nodes.set(key, node);
    return node;
  }

  /** The point of the tile closest to the camera's foot point (tiles never cross the antimeridian). */
  private nearest(node: Node, cam: THREE.Vector3): THREE.Vector3 {
    const b = tileBounds(node.z, node.x, node.y);
    const c = vecToLatLon([cam.x, cam.y, cam.z]);
    const lat = Math.max(b.south, Math.min(b.north, c.lat));
    let lon = c.lon;
    if (lon < b.west || lon > b.east) {
      const dw = Math.abs(((c.lon - b.west + 540) % 360) - 180);
      const de = Math.abs(((c.lon - b.east + 540) % 360) - 180);
      lon = dw < de ? b.west : b.east;
    }
    return new THREE.Vector3(...latLonToVec(lat, lon));
  }

  /** Bounds a patch raised by relief up to `top` (Earth radii): the sphere around it reaches over the peaks. */
  private fitRelief(node: Node, top: number) {
    node.top = top;
    node.radius = node.extent * 1.15 + top;
  }

  private visible(node: Node, cam: THREE.Vector3): boolean {
    // Beyond the horizon when even the tile's nearest point is hidden by the sea-level sphere. Peaks show over
    // the horizon from further round the globe: up to acos(1 / (1 + top)) past the camera's own horizon.
    const p = this.nearest(node, cam);
    const d = cam.length();
    const reach = Math.acos(Math.min(1, 1 / d)) + (node.top > 0 ? Math.acos(1 / (1 + node.top)) : 0);
    if (p.dot(cam) / d <= Math.cos(reach)) return false;
    return this.frustum.intersectsSphere(this.sphere.set(node.center, node.radius));
  }

  /** Requests are ordered by screen size and closeness to the centre of the view. */
  private focus(node: Node): number {
    if (!this.camera) return 1;
    this.v.copy(node.center).project(this.camera);
    return 1 / (0.35 + Math.min(2, Math.hypot(this.v.x, this.v.y)));
  }

  /**
   * Walks down to the level the view needs, wanting every missing tile there and drawing whatever
   * exists on the way. Returns true when this tile's area is fully covered by opaque tiles.
   */
  private visit(z: number, x: number, y: number, cam: THREE.Vector3, now: number): boolean {
    const node = this.node(z, x, y);
    if (!this.visible(node, cam)) return true;
    node.lastUsed = now;
    const b = tileBounds(z, x, y);
    const widthRad = ((2 * Math.PI) / 2 ** z) * Math.cos(THREE.MathUtils.degToRad((b.north + b.south) / 2));
    const near = this.nearest(node, cam);
    const d = Math.max(1e-5, cam.distanceTo(near));
    // Seen at a grazing angle a tile is foreshortened, so it needs less detail than its width suggests.
    const facing = THREE.MathUtils.clamp(this.v.copy(cam).sub(near).normalize().dot(near.normalize()), 0.12, 1);
    const px = ((widthRad / d) * this.pxPerRadian) * Math.sqrt(facing);
    const fade = node.texture ? Math.min(1, (now - node.loadedAt) / FADE_MS) : 0;
    const split = z < this.maxLevel && px > SPLIT_PX && !!providerFor(this.providers, z + 1);
    if (!split) {
      // Relief only for the tiles that will be drawn: the coarser ones on the way down never need it.
      if (this.terrain) this.ensureTerrain(node);
      if (node.texture) {
        this.draw(node, fade, now, 0);
        return fade >= 1;
      }
      this.want(node, px * this.focus(node) * 4, now);
      return false;
    }
    let covered = true;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) if (!this.visit(z + 1, 2 * x + dx, 2 * y + dy, cam, now)) covered = false;
    if (covered) return true;
    if (node.texture) {
      // Under partly loaded children: sunk a little so its coarser relief stays beneath theirs.
      this.draw(node, fade, now, Math.min(4e-5, node.extent * UNDERLAY_SINK));
      return fade >= 1;
    }
    // Coarse levels on the way down are worth having only while the target tiles are still coming.
    this.want(node, px * this.focus(node) * 0.25, now);
    return false;
  }

  private want(node: Node, priority: number, now: number) {
    node.lastWanted = Math.max(node.lastWanted, now);
    if (node.loading || node.texture) return;
    if (node.failedAt && now - node.failedAt < 60_000) return;
    node.priority = priority;
    this.wanted.push(node);
  }

  private draw(node: Node, fade: number, now: number, sink: number) {
    node.lastUsed = now;
    if (!node.mesh) node.mesh = this.makeMesh(node);
    const mesh = node.mesh;
    const material = this.material;
    const texture = node.texture;
    const alpha = fade * this.layerFade;
    // Open sea keeps the Blue Marble ocean up to level 7 and hands over to the imagery by level 9.
    const openSea = 1 - THREE.MathUtils.smoothstep(node.z, 7, 9);
    mesh.onBeforeRender = () => {
      material.uniforms.uDay.value = texture;
      material.uniforms.uFade.value = alpha;
      material.uniforms.uSink.value = sink;
      if (material.uniforms.uOpenSea) material.uniforms.uOpenSea.value = openSea;
      // One material serves every tile: force the renderer to upload the changed uniforms.
      material.uniformsNeedUpdate = true;
    };
    mesh.visible = true;
    this.drawn.add(node);
    const provider = providerFor(this.providers, node.z);
    if (provider) this.usedProviders.add(provider.id);
  }

  /** Height at grid vertex (lat, lon) of a node from its terrain grid, metres (0 when not loaded). */
  private heightOf(node: Node, lat: number, lon: number): number {
    if (!node.terrainKey) return 0;
    const grid = this.grids.get(node.terrainKey);
    if (!(grid instanceof Int16Array)) return 0;
    const [tz, tx, ty] = node.terrainKey.split("/").map(Number);
    const { u, v } = tileUv(tz, tx, ty, lat, lon);
    return Math.max(0, sampleGrid(grid, u, v)) * TERRAIN_EXAGGERATION;
  }

  private makeMesh(node: Node): THREE.Mesh {
    const b = tileBounds(node.z, node.x, node.y);
    const my0 = latToMercatorSafe(b.south);
    const my1 = latToMercatorSafe(b.north);
    // Polygon offset has no effect with a logarithmic depth buffer, so tiles sit a few tens of
    // metres above the base sphere, deeper levels slightly higher than their parents.
    const lift = 1 + 1e-5 + node.z * 2e-7 + this.lift;
    const count = (SEGMENTS + 1) ** 2;
    const pos = new Float32Array(count * 3);
    const normal = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    const guv = new Float32Array(count * 2);
    const raised = !!node.terrainKey && this.grids.get(node.terrainKey) instanceof Int16Array;
    let i = 0;
    for (let r = 0; r <= SEGMENTS; r++) {
      const v = r / SEGMENTS;
      // Linear in Mercator y so the image maps without distortion.
      const lat = mercatorToLatDeg(my0 + (my1 - my0) * v);
      for (let c = 0; c <= SEGMENTS; c++) {
        const u = c / SEGMENTS;
        const lon = b.west + (b.east - b.west) * u;
        const dir = latLonToVec(lat, lon);
        const radius = lift + (raised ? this.heightOf(node, lat, lon) / EARTH_M : 0);
        pos.set([dir[0] * radius, dir[1] * radius, dir[2] * radius], i * 3);
        normal.set(dir, i * 3);
        // Images keep their rows north-first (no flip on upload), so v runs north → south.
        uv[i * 2] = u;
        uv[i * 2 + 1] = 1 - v;
        guv[i * 2] = 0.5 + lon / 360;
        guv[i * 2 + 1] = 0.5 + lat / 180;
        i++;
      }
    }
    const index: number[] = [];
    for (let r = 0; r < SEGMENTS; r++) {
      for (let c = 0; c < SEGMENTS; c++) {
        const a = r * (SEGMENTS + 1) + c;
        const bI = a + 1;
        const cI = a + SEGMENTS + 1;
        const dI = cI + 1;
        // Counter-clockwise seen from outside the sphere (east is right, north is up).
        index.push(a, bI, cI, bI, dI, cI);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geometry.setAttribute("aGlobalUv", new THREE.BufferAttribute(guv, 2));
    geometry.setIndex(index);
    if (raised) geometry.computeVertexNormals();
    node.raised = raised;
    geometry.boundingSphere = new THREE.Sphere(node.center.clone(), node.radius);
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.frustumCulled = false;
    // Between the base globe (0) and the clouds (1): imagery first, overlays above it, deeper levels last.
    mesh.renderOrder = (this.overlay ? 0.9 : 0.1) + node.z * 0.001;
    this.group.add(mesh);
    return mesh;
  }

  /** Loads the height grid a node uses (once per grid; many tiles share it). */
  private ensureTerrain(node: Node) {
    const key = node.terrainKey;
    if (!key || this.grids.has(key)) return;
    this.grids.set(key, "loading");
    fetch(`/api/terrain/${key}?v=${TERRAIN_VERSION}`)
      .then((res) => {
        if (!res.ok) throw new Error(`terrain ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buf) => {
        this.grids.set(key, new Int16Array(buf));
        let top = 0;
        for (const h of new Int16Array(buf)) if (h > top) top = h;
        const relief = (top * TERRAIN_EXAGGERATION) / EARTH_M;
        this.gridTops.set(key, relief);
        for (const n of this.nodes.values()) {
          if (n.terrainKey !== key) continue;
          this.fitRelief(n, relief);
          if (n.mesh && !n.raised) this.applyHeights(n);
        }
      })
      .catch(() => this.grids.set(key, "failed"));
  }

  /** Raises an existing flat patch once its height grid arrives. */
  private applyHeights(node: Node) {
    if (!node.mesh) return;
    const geometry = node.mesh.geometry;
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const lift = 1 + 1e-5 + node.z * 2e-7 + this.lift;
    for (let i = 0; i < position.count; i++) {
      const p = vecToLatLon([position.getX(i), position.getY(i), position.getZ(i)]);
      const dir = latLonToVec(p.lat, p.lon);
      const radius = lift + this.heightOf(node, p.lat, p.lon) / EARTH_M;
      position.setXYZ(i, dir[0] * radius, dir[1] * radius, dir[2] * radius);
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();
    node.raised = true;
  }

  private reveal(now: number) {
    if (!this.arrived.length) return;
    this.arrived.sort((a, b) => b.node.priority - a.node.priority);
    for (const { node, texture } of this.arrived.splice(0, this.revealPerFrame)) {
      if (!this.nodes.has(node.key)) {
        texture.dispose();
        continue;
      }
      node.texture = texture;
      node.loadedAt = now;
    }
  }

  /** Cancels requests for tiles the view no longer needs. */
  private cancelStale(now: number) {
    for (const node of this.inFlight) {
      if (now - node.lastWanted > STALE_REQUEST_MS) {
        node.loading?.abort();
        node.loading = null;
        this.inFlight.delete(node);
      }
    }
  }

  private pump(now: number) {
    const queue = this.wanted;
    for (const n of this.prefetched) if (!n.texture && !n.loading && now < n.lastWanted) queue.push(n);
    if (!queue.length) return;
    queue.sort((a, b) => b.priority - a.priority);
    // While diving, most slots go to the destination (prefetched) tiles; passing levels get a third.
    const passing = this.diving ? Math.floor(this.maxInFlight / 3) : this.maxInFlight;
    let busy = 0;
    for (const n of this.inFlight) if (!this.prefetched.includes(n)) busy++;
    for (const node of queue) {
      if (this.inFlight.size >= this.maxInFlight) break;
      const destination = this.prefetched.includes(node);
      if (!destination && busy >= passing) continue;
      if (!destination) busy++;
      if (node.loading || node.texture) continue;
      const provider = providerFor(this.providers, node.z);
      if (!provider) continue;
      this.load(node, provider.url(node.z, node.x, node.y));
    }
  }

  private load(node: Node, url: string) {
    const ctrl = new AbortController();
    node.loading = ctrl;
    this.inFlight.add(node);
    fetch(url, { signal: ctrl.signal, mode: "cors", credentials: "omit" })
      .then((res) => {
        if (!res.ok) throw new Error(`tile ${res.status}`);
        return res.blob();
      })
      .then((blob) => decodeImage(blob, this.overlay))
      .then((image) => {
        if (node.loading !== ctrl || !this.nodes.has(node.key)) {
          if ("close" in image) image.close();
          return;
        }
        const texture = new THREE.Texture(image as THREE.Texture["image"]);
        texture.flipY = false;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = this.anisotropy;
        texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.needsUpdate = true;
        this.arrived.push({ node, texture });
      })
      .catch(() => {
        if (node.loading === ctrl && !ctrl.signal.aborted) node.failedAt = performance.now();
      })
      .finally(() => {
        if (node.loading === ctrl) {
          node.loading = null;
          this.inFlight.delete(node);
        }
      });
  }

  private evict(now: number) {
    // Textures first: the least recently drawn go once over budget.
    const textured = [...this.nodes.values()].filter((n) => n.texture && !this.drawn.has(n));
    const over = textured.length + this.drawn.size - this.maxTextures;
    if (over > 0) {
      textured.sort((a, b) => a.lastUsed - b.lastUsed);
      for (const n of textured.slice(0, over)) if (now - n.lastUsed > 2000) this.dispose(n);
    }
    // Then bookkeeping for tiles nobody has looked at in a while.
    if (this.nodes.size > this.maxTextures * 4) {
      for (const n of this.nodes.values()) if (!n.texture && !n.loading && now - n.lastUsed > 8000) this.nodes.delete(n.key);
    }
    if (this.grids.size > 600) {
      const live = new Set([...this.nodes.values()].map((n) => n.terrainKey));
      for (const k of this.grids.keys()) {
        if (live.has(k)) continue;
        this.grids.delete(k);
        this.gridTops.delete(k);
      }
    }
  }

  private dispose(n: Node) {
    n.loading?.abort();
    n.loading = null;
    this.inFlight.delete(n);
    const image = n.texture?.image as { close?: () => void } | undefined;
    n.texture?.dispose();
    image?.close?.();
    n.texture = null;
    if (n.mesh) {
      this.group.remove(n.mesh);
      n.mesh.geometry.dispose();
      n.mesh = null;
    }
    this.nodes.delete(n.key);
  }

  disposeAll() {
    for (const n of [...this.nodes.values()]) this.dispose(n);
    this.material.dispose();
  }
}

function latToMercatorSafe(latDeg: number) {
  const lat = THREE.MathUtils.degToRad(Math.max(-85.0511, Math.min(85.0511, latDeg)));
  return Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI;
}

function mercatorToLatDeg(my: number) {
  return THREE.MathUtils.radToDeg(Math.atan(Math.sinh(Math.PI * my)));
}
