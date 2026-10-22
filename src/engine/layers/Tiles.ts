import * as THREE from "three";
import { latLonToVec, vecToLatLon } from "@/lib/geo";
import { providerFor, tileAt, tileBounds, tileKey, type ImageryProvider } from "@/lib/tiles";
import { earthFragment, logDepth } from "../shaders";

const SEGMENTS = 12;
const TILE_PX = 256;
/** Subdivide when a tile would cover more than this many screen pixels. */
const SPLIT_PX = TILE_PX * 1.15;
const MAX_IN_FLIGHT = 8;
const MAX_CACHED = 320;
const FADE_MS = 350;
/** Tiles are used only when the camera is closer than this (Earth radii from the centre). */
export const TILES_FROM_DIST = 3.4;
const TILES_FULL_DIST = 2.6;
/** Elevation is applied from this level; Terrarium tiles exist up to level 15. */
const TERRAIN_FROM = 8;
const TERRAIN_MAX = 15;
export const TERRAIN_EXAGGERATION = 1.6;
const EARTH_M = 6_371_000;
/** Everest with the exaggeration applied, in Earth radii: the most any tile can rise above the base sphere. */
const TERRAIN_MARGIN = (8849 * TERRAIN_EXAGGERATION) / EARTH_M;
const TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";

interface Node {
  z: number;
  x: number;
  y: number;
  key: string;
  corners: THREE.Vector3[];
  center: THREE.Vector3;
  radius: number;
  texture: THREE.Texture | null;
  loadedAt: number;
  loading: boolean;
  failedAt: number;
  mesh: THREE.Mesh | null;
  lastUsed: number;
  priority: number;
  /** Metres above sea level at the (SEGMENTS+1)² grid points, south-west first. */
  heights: Float32Array | null;
  heightsLoading: boolean;
  /** Distance from the centre to the farthest corner, Earth radii. */
  extent: number;
}

export const tilesVertex = /* glsl */ `
  attribute vec2 aGlobalUv;
  varying vec2 vUv;
  varying vec2 vTileUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vUv = aGlobalUv;
    vTileUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPosW = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

/** The planet shader with the day albedo read from the tile and the rest from the global maps. */
export const tilesFragment = earthFragment
  .replace("varying vec2 vUv;", "varying vec2 vUv;\n  varying vec2 vTileUv;\n  uniform float uFade;")
  // Sentinel-2 mosaics are muted; lift them toward the Blue Marble look.
  .replace("texture2D(uDay, vUv).rgb", "pow(texture2D(uDay, vTileUv).rgb, vec3(0.78)) * 1.5")
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
  /** Displace vertices with Mapzen Terrarium elevation tiles. */
  terrain?: boolean;
  /** Extra lift above the surface in Earth radii (overlays sit above imagery). */
  lift?: number;
}

/**
 * Streams Web Mercator tiles onto the globe as the camera closes in.
 * A quadtree is refined by screen-space size; a parent stays drawn while its
 * children fade in, so refinement never pops. One material serves every tile:
 * the texture is swapped just before each draw. With `terrain`, each patch is
 * raised by real elevation and lit by its slopes.
 */
export class Tiles {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  /** Attribution lines of the providers drawn in the last frame. */
  attributions: string[] = [];
  opacity = 1;
  private nodes = new Map<string, Node>();
  private inFlight = 0;
  private loader = new THREE.TextureLoader();
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  private drawn = new Set<Node>();
  private wanted: Node[] = [];
  private usedProviders = new Set<string>();
  private layerFade = 0;
  private anisotropy = 4;
  private readonly terrain: boolean;
  private readonly lift: number;
  private scratch = document.createElement("canvas");

  constructor(
    private providers: ImageryProvider[],
    sharedUniforms: Record<string, THREE.IUniform>,
    anisotropy: number,
    options: TilesOptions = {},
  ) {
    this.anisotropy = anisotropy;
    this.terrain = !!options.terrain;
    this.lift = options.lift ?? 0;
    this.loader.setCrossOrigin("anonymous");
    this.scratch.width = this.scratch.height = TILE_PX;
    this.material = options.overlay
      ? new THREE.ShaderMaterial({
          ...logDepth(tilesVertex, overlayFragment),
          uniforms: { uDay: { value: null }, uFade: { value: 1 } },
          transparent: true,
          depthWrite: false,
        })
      : new THREE.ShaderMaterial({
          ...logDepth(tilesVertex, tilesFragment),
          uniforms: { ...sharedUniforms, uDay: { value: null }, uFade: { value: 1 } },
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
  update(camera: THREE.PerspectiveCamera, viewportHeight: number, dist: number) {
    const now = performance.now();
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
      return;
    }
    this.group.visible = true;
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const pxPerRadian = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    const root = Math.min(...this.providers.map((p) => p.minLevel));
    const n = 2 ** root;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) this.visit(root, x, y, camera.position, pxPerRadian, now);
    this.pump();
    this.evict(now);
    this.attributions = this.providers.filter((p) => this.usedProviders.has(p.id)).map((p) => p.attribution);
  }

  /** Terrain height (metres, exaggerated) under a point, from the finest loaded tile; 0 when unknown. */
  heightAt(lat: number, lon: number): number {
    if (!this.terrain) return 0;
    for (let z = TERRAIN_MAX; z >= TERRAIN_FROM; z--) {
      const { x, y } = tileAt(z, lat, lon);
      const node = this.nodes.get(tileKey(z, x, y));
      if (!node?.heights) continue;
      const b = tileBounds(z, x, y);
      const u = (lon - b.west) / (b.east - b.west);
      const v = (latToMercatorSafe(lat) - latToMercatorSafe(b.south)) / (latToMercatorSafe(b.north) - latToMercatorSafe(b.south));
      const gx = THREE.MathUtils.clamp(u, 0, 1) * SEGMENTS;
      const gy = THREE.MathUtils.clamp(v, 0, 1) * SEGMENTS;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const x1 = Math.min(SEGMENTS, x0 + 1);
      const y1 = Math.min(SEGMENTS, y0 + 1);
      const fx = gx - x0;
      const fy = gy - y0;
      const h = (r: number, c: number) => node.heights![r * (SEGMENTS + 1) + c];
      const top = h(y0, x0) * (1 - fx) + h(y0, x1) * fx;
      const bottom = h(y1, x0) * (1 - fx) + h(y1, x1) * fx;
      return (top * (1 - fy) + bottom * fy) * TERRAIN_EXAGGERATION;
    }
    return 0;
  }

  private node(z: number, x: number, y: number): Node {
    const key = tileKey(z, x, y);
    let node = this.nodes.get(key);
    if (node) return node;
    const b = tileBounds(z, x, y);
    const corners = [
      latLonToVec(b.north, b.west),
      latLonToVec(b.north, b.east),
      latLonToVec(b.south, b.west),
      latLonToVec(b.south, b.east),
    ].map((p) => new THREE.Vector3(...p));
    const center = new THREE.Vector3(...latLonToVec((b.north + b.south) / 2, (b.west + b.east) / 2));
    const extent = Math.max(...corners.map((c) => c.distanceTo(center)));
    // Room for terrain above the base sphere, in proportion to the tile: a fixed margin of 12 km made
    // hundreds of street-level tiles count as visible and the loader never caught up. Loaded heights refine it.
    const radius = extent * 1.05 + Math.min(TERRAIN_MARGIN, extent * 2);
    node = {
      z,
      x,
      y,
      key,
      corners,
      center,
      radius,
      texture: null,
      loadedAt: 0,
      loading: false,
      failedAt: 0,
      mesh: null,
      lastUsed: 0,
      priority: 0,
      heights: null,
      heightsLoading: false,
      extent,
    };
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

  private visible(node: Node, cam: THREE.Vector3): boolean {
    // Beyond the horizon when even the tile's nearest point faces away from the camera.
    const p = this.nearest(node, cam);
    if (p.dot(cam) - p.lengthSq() <= 0) return false;
    return this.frustum.intersectsSphere(new THREE.Sphere(node.center, node.radius));
  }

  private visit(z: number, x: number, y: number, cam: THREE.Vector3, pxPerRadian: number, now: number) {
    const node = this.node(z, x, y);
    if (!this.visible(node, cam)) return;
    node.lastUsed = now;
    const b = tileBounds(z, x, y);
    const widthRad = ((2 * Math.PI) / 2 ** z) * Math.cos(THREE.MathUtils.degToRad((b.north + b.south) / 2));
    const d = Math.max(1e-5, cam.distanceTo(this.nearest(node, cam)));
    const px = (widthRad / d) * pxPerRadian;
    node.priority = px;
    const deeper = z < this.maxLevel && px > SPLIT_PX && providerFor(this.providers, z + 1);
    if (deeper) {
      const kids: Node[] = [];
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) kids.push(this.node(z + 1, 2 * x + dx, 2 * y + dy));
      const shown = kids.filter((k) => this.visible(k, cam));
      const ready = shown.every((k) => k.texture);
      if (ready && shown.length) {
        for (const k of shown) this.visit(k.z, k.x, k.y, cam, pxPerRadian, now);
        // Keep the parent underneath until every child has faded in.
        if (node.texture && shown.some((k) => now - k.loadedAt < FADE_MS)) this.draw(node, 1, now);
        return;
      }
      for (const k of shown) if (!k.texture) this.want(k, px * 2);
    }
    if (node.texture) this.draw(node, Math.min(1, (now - node.loadedAt) / FADE_MS), now);
    else this.want(node, px * 4);
  }

  private want(node: Node, priority: number) {
    if (node.loading || node.texture) return;
    if (node.failedAt && performance.now() - node.failedAt < 60_000) return;
    node.priority = Math.max(node.priority, priority);
    this.wanted.push(node);
  }

  private draw(node: Node, fade: number, now: number) {
    node.lastUsed = now;
    if (!node.mesh) node.mesh = this.makeMesh(node);
    const mesh = node.mesh;
    const material = this.material;
    const texture = node.texture;
    const alpha = fade * this.layerFade;
    mesh.onBeforeRender = () => {
      material.uniforms.uDay.value = texture;
      material.uniforms.uFade.value = alpha;
      // One material serves every tile: force the renderer to upload the changed uniforms.
      material.uniformsNeedUpdate = true;
    };
    mesh.visible = true;
    this.drawn.add(node);
    const provider = providerFor(this.providers, node.z);
    if (provider) this.usedProviders.add(provider.id);
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
    let i = 0;
    for (let r = 0; r <= SEGMENTS; r++) {
      const v = r / SEGMENTS;
      // Linear in Mercator y so the image maps without distortion.
      const lat = mercatorToLatDeg(my0 + (my1 - my0) * v);
      for (let c = 0; c <= SEGMENTS; c++) {
        const u = c / SEGMENTS;
        const lon = b.west + (b.east - b.west) * u;
        const dir = latLonToVec(lat, lon);
        const h = node.heights ? node.heights[i] * TERRAIN_EXAGGERATION : 0;
        const radius = lift + Math.max(0, h) / EARTH_M;
        pos.set([dir[0] * radius, dir[1] * radius, dir[2] * radius], i * 3);
        normal.set(dir, i * 3);
        uv[i * 2] = u;
        uv[i * 2 + 1] = v;
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
    if (node.heights) geometry.computeVertexNormals();
    geometry.boundingSphere = new THREE.Sphere(node.center.clone(), node.radius);
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.frustumCulled = false;
    mesh.renderOrder = node.z;
    this.group.add(mesh);
    return mesh;
  }

  /** Raises an existing patch once its elevation arrives. */
  private applyHeights(node: Node) {
    if (!node.mesh || !node.heights) return;
    const geometry = node.mesh.geometry;
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const lift = 1 + 1e-5 + node.z * 2e-7 + this.lift;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      const len = Math.hypot(x, y, z);
      const radius = lift + Math.max(0, node.heights[i] * TERRAIN_EXAGGERATION) / EARTH_M;
      position.setXYZ(i, (x / len) * radius, (y / len) * radius, (z / len) * radius);
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();
  }

  private pump() {
    if (!this.wanted.length) return;
    this.wanted.sort((a, b) => b.priority - a.priority);
    for (const node of this.wanted) {
      if (this.inFlight >= MAX_IN_FLIGHT) break;
      if (node.loading || node.texture) continue;
      const provider = providerFor(this.providers, node.z);
      if (!provider) continue;
      node.loading = true;
      this.inFlight++;
      this.loader.load(
        provider.url(node.z, node.x, node.y),
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.anisotropy = this.anisotropy;
          texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
          node.texture = texture;
          node.loadedAt = performance.now();
          node.loading = false;
          this.inFlight--;
          if (this.terrain && node.z >= TERRAIN_FROM) this.loadHeights(node);
        },
        undefined,
        () => {
          node.failedAt = performance.now();
          node.loading = false;
          this.inFlight--;
        },
      );
    }
  }

  /** Samples a Terrarium tile (or the enclosing level-15 one) at the patch's grid points. */
  private loadHeights(node: Node) {
    if (node.heightsLoading || node.heights) return;
    node.heightsLoading = true;
    const tz = Math.min(node.z, TERRAIN_MAX);
    const scale = 2 ** (node.z - tz);
    const tx = Math.floor(node.x / scale);
    const ty = Math.floor(node.y / scale);
    const u0 = (node.x - tx * scale) / scale;
    const v0 = (node.y - ty * scale) / scale;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      node.heightsLoading = false;
      if (!this.nodes.has(node.key)) return;
      const ctx = this.scratch.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, TILE_PX, TILE_PX);
      const data = ctx.getImageData(0, 0, TILE_PX, TILE_PX).data;
      const heights = new Float32Array((SEGMENTS + 1) ** 2);
      let i = 0;
      for (let r = 0; r <= SEGMENTS; r++) {
        // Grid rows run south → north; image rows run north → south.
        const py = Math.min(TILE_PX - 1, Math.round((v0 + (1 - r / SEGMENTS) / scale) * (TILE_PX - 1)));
        for (let c = 0; c <= SEGMENTS; c++) {
          const px = Math.min(TILE_PX - 1, Math.round((u0 + c / SEGMENTS / scale) * (TILE_PX - 1)));
          const k = (py * TILE_PX + px) * 4;
          heights[i++] = data[k] * 256 + data[k + 1] + data[k + 2] / 256 - 32768;
        }
      }
      node.heights = heights;
      let top = 0;
      for (const h of heights) if (h > top) top = h;
      node.radius = node.extent * 1.05 + (top * TERRAIN_EXAGGERATION) / EARTH_M + node.extent * 0.1;
      this.applyHeights(node);
    };
    img.onerror = () => {
      node.heightsLoading = false;
    };
    img.src = `${TERRARIUM}/${tz}/${tx}/${ty}.png`;
  }

  private evict(now: number) {
    if (this.nodes.size <= MAX_CACHED) return;
    const stale = [...this.nodes.values()].filter((n) => n.texture && now - n.lastUsed > 10_000 && !this.drawn.has(n));
    stale.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const n of stale.slice(0, this.nodes.size - MAX_CACHED)) this.dispose(n);
  }

  private dispose(n: Node) {
    n.texture?.dispose();
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
