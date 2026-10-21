import * as THREE from "three";
import { moveAlong, type Vec3 } from "@/lib/geo";
import { moversFragment, moversVertex } from "../shaders";

/** One moving object as the layer needs it; layers convert from wire formats into this. */
export interface MoverInput {
  /** Radians. */
  lat: number;
  lon: number;
  /** Unix seconds of the position. */
  t: number;
  /** Ground speed in Earth radii per second. */
  speed: number;
  /** Track, radians clockwise from north. */
  track: number;
  /** Height above the surface in Earth radii (already exaggerated for display). */
  alt: number;
  /** Colour/filter class. */
  kind: number;
}

export interface MoversOptions {
  /** Icon size relative to the camera distance. */
  size: number;
  /** Longest extrapolation from the last fix, seconds. */
  maxExtrapolation: number;
  colors: string[];
  icon: "plane" | "ship";
  renderOrder: number;
}

const BLEND_S = 2.5;

/**
 * Instanced icons that move along great circles on the GPU. Each update
 * starts a short blend from where an object was drawn to its new track, so
 * fresh positions never make anything jump.
 */
export class Movers {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  ids: (string | number)[] = [];
  private index = new Map<string | number, number>();
  private items: MoverInput[] = [];
  private geometry = new THREE.InstancedBufferGeometry();
  /** Unix seconds that per-instance times are relative to (keeps float32 precise). */
  private base = 0;
  private switchedAt = -1e9;
  private kindOn: number[];

  constructor(private options: MoversOptions) {
    const plane = new THREE.PlaneGeometry(1, 1);
    this.geometry.index = plane.index;
    this.geometry.setAttribute("position", plane.getAttribute("position"));
    this.geometry.setAttribute("uv", plane.getAttribute("uv"));
    this.kindOn = options.colors.map(() => 1);
    this.material = new THREE.ShaderMaterial({
      vertexShader: moversVertex(options.colors.length),
      fragmentShader: moversFragment(options.icon),
      uniforms: {
        uNow: { value: 0 },
        uSwitch: { value: -1e9 },
        uBlend: { value: BLEND_S },
        uMaxDt: { value: options.maxExtrapolation },
        uSize: { value: options.size },
        uSelected: { value: -1 },
        uOpacity: { value: 1 },
        uColors: { value: options.colors.map((c) => new THREE.Color(c)) },
        uKindOn: { value: this.kindOn },
        uMinAlt: { value: -1 },
        uAltColor: { value: options.icon === "plane" ? 1 : 0 },
      },
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = options.renderOrder;
  }

  get count() {
    return this.ids.length;
  }

  indexOf(id: string | number): number {
    return this.index.get(id) ?? -1;
  }

  item(i: number): MoverInput | undefined {
    return this.items[i];
  }

  /** Replaces the data set, blending objects that already existed from where they were drawn. */
  set(ids: (string | number)[], items: MoverInput[], nowS: number, blend = true) {
    const from = new Float32Array(items.length * 3);
    if (blend && this.items.length) {
      for (let i = 0; i < ids.length; i++) {
        const prev = this.index.get(ids[i]);
        if (prev === undefined) continue;
        const p = this.displayed(prev, nowS);
        from[i * 3] = p[0];
        from[i * 3 + 1] = p[1];
        from[i * 3 + 2] = p[2];
      }
    }
    this.base = Math.floor(nowS) - 3600;
    const n = items.length;
    const latLon = new Float32Array(n * 2);
    const t0 = new Float32Array(n);
    const motion = new Float32Array(n * 2);
    const alt = new Float32Array(n);
    const kind = new Float32Array(n);
    items.forEach((m, i) => {
      latLon[i * 2] = m.lat;
      latLon[i * 2 + 1] = m.lon;
      t0[i] = m.t - this.base;
      motion[i * 2] = m.speed;
      motion[i * 2 + 1] = m.track;
      alt[i] = m.alt;
      kind[i] = m.kind;
    });
    this.geometry.setAttribute("iLatLon", new THREE.InstancedBufferAttribute(latLon, 2));
    this.geometry.setAttribute("iT0", new THREE.InstancedBufferAttribute(t0, 1));
    this.geometry.setAttribute("iMotion", new THREE.InstancedBufferAttribute(motion, 2));
    this.geometry.setAttribute("iAlt", new THREE.InstancedBufferAttribute(alt, 1));
    this.geometry.setAttribute("iKind", new THREE.InstancedBufferAttribute(kind, 1));
    this.geometry.setAttribute("iFrom", new THREE.InstancedBufferAttribute(from, 3));
    this.geometry.instanceCount = n;

    this.ids = ids;
    this.items = items;
    this.index = new Map(ids.map((id, i) => [id, i]));
    this.switchedAt = nowS;
    this.material.uniforms.uSwitch.value = nowS - this.base;
  }

  /** Where object `i` sits at `nowS`, exactly as the shader places it (including the blend). */
  displayed(i: number, nowS: number): Vec3 {
    const p = this.extrapolated(i, nowS);
    const blend = smoothstep(Math.min(1, Math.max(0, (nowS - this.switchedAt) / BLEND_S)));
    const fromAttr = this.geometry.getAttribute("iFrom") as THREE.BufferAttribute | undefined;
    if (!fromAttr || blend >= 1) return p;
    const f: Vec3 = [fromAttr.getX(i), fromAttr.getY(i), fromAttr.getZ(i)];
    if (f[0] * f[0] + f[1] * f[1] + f[2] * f[2] < 0.5) return p;
    return [f[0] + (p[0] - f[0]) * blend, f[1] + (p[1] - f[1]) * blend, f[2] + (p[2] - f[2]) * blend];
  }

  private extrapolated(i: number, nowS: number): Vec3 {
    const m = this.items[i];
    const dt = Math.min(Math.max(nowS - m.t, 0), this.options.maxExtrapolation);
    return moveAlong(m.lat, m.lon, m.track, m.speed * dt, 1 + m.alt);
  }

  visible(i: number): boolean {
    const m = this.items[i];
    if (!m || !this.kindOn[m.kind]) return false;
    return m.alt >= this.material.uniforms.uMinAlt.value;
  }

  setKindVisible(kind: number, on: boolean) {
    this.kindOn[kind] = on ? 1 : 0;
  }

  /** Hide objects below this display altitude (Earth radii). Negative shows everything. */
  setMinAlt(alt: number) {
    this.material.uniforms.uMinAlt.value = alt;
  }

  setMaxExtrapolation(seconds: number) {
    this.options.maxExtrapolation = seconds;
    this.material.uniforms.uMaxDt.value = seconds;
  }

  select(i: number) {
    this.material.uniforms.uSelected.value = i;
  }

  update(nowS: number) {
    this.material.uniforms.uNow.value = nowS - this.base;
  }

  setOpacity(v: number) {
    this.material.uniforms.uOpacity.value = v;
    this.mesh.visible = v > 0.01 && this.count > 0;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

function smoothstep(x: number) {
  return x * x * (3 - 2 * x);
}
