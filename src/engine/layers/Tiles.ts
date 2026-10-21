import * as THREE from "three";
import { latLonToVec, vecToLatLon } from "@/lib/geo";
import { providerFor, tileBounds, tileKey, type ImageryProvider } from "@/lib/tiles";
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

/**
 * Streams Web Mercator imagery tiles onto the globe as the camera closes in.
 * A quadtree is refined by screen-space size; a parent stays drawn while its
 * children fade in, so refinement never pops. One material serves every tile:
 * the texture is swapped just before each draw.
 */
export class Tiles {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  /** Attribution lines of the providers drawn in the last frame. */
  attributions: string[] = [];
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

  constructor(
    private providers: ImageryProvider[],
    sharedUniforms: Record<string, THREE.IUniform>,
    anisotropy: number,
  ) {
    this.anisotropy = anisotropy;
    this.loader.setCrossOrigin("anonymous");
    this.material = new THREE.ShaderMaterial({
      ...logDepth(tilesVertex, tilesFragment),
      uniforms: { ...sharedUniforms, uDay: { value: null }, uFade: { value: 1 } },
      transparent: true,
      depthWrite: true,
    });
    this.group.renderOrder = 0.5;
  }

  get maxLevel() {
    return Math.max(...this.providers.map((p) => p.maxLevel));
  }

  setProviders(providers: ImageryProvider[]) {
    this.providers = providers;
  }

  /** Call every frame; `dist` is the camera distance from the Earth's centre. */
  update(camera: THREE.PerspectiveCamera, viewportHeight: number, dist: number) {
    const now = performance.now();
    this.layerFade = THREE.MathUtils.clamp((TILES_FROM_DIST - dist) / (TILES_FROM_DIST - TILES_FULL_DIST), 0, 1);
    for (const n of this.drawn) if (n.mesh) n.mesh.visible = false;
    this.drawn.clear();
    this.wanted.length = 0;
    this.usedProviders.clear();
    if (this.layerFade <= 0) {
      this.group.visible = false;
      this.attributions = [];
      return;
    }
    this.group.visible = true;
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const pxPerRadian = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    const root = 2;
    const n = 2 ** root;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) this.visit(root, x, y, camera.position, pxPerRadian, now);
    this.pump(now);
    this.evict(now);
    this.attributions = this.providers.filter((p) => this.usedProviders.has(p.id)).map((p) => p.attribution);
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
    const radius = Math.max(...corners.map((c) => c.distanceTo(center))) * 1.05;
    node = { z, x, y, key, corners, center, radius, texture: null, loadedAt: 0, loading: false, failedAt: 0, mesh: null, lastUsed: 0, priority: 0 };
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
    const lift = 1 + 1e-5 + node.z * 2e-7;
    const count = (SEGMENTS + 1) ** 2;
    const pos = new Float32Array(count * 3);
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
        pos.set(latLonToVec(lat, lon, lift), i * 3);
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
    geometry.setAttribute("normal", new THREE.BufferAttribute(pos.map((v) => v / lift), 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geometry.setAttribute("aGlobalUv", new THREE.BufferAttribute(guv, 2));
    geometry.setIndex(index);
    geometry.boundingSphere = new THREE.Sphere(node.center.clone(), node.radius);
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.frustumCulled = false;
    mesh.renderOrder = node.z;
    this.group.add(mesh);
    return mesh;
  }

  private pump(now: number) {
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
        },
        undefined,
        () => {
          node.failedAt = performance.now();
          node.loading = false;
          this.inFlight--;
        },
      );
    }
    void now;
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
