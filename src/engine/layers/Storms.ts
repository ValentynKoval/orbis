import * as THREE from "three";
import { latLonToVec } from "@/lib/geo";
import { ALERT_COLORS, stormAt, type Storm } from "@/lib/feeds/storms";
import { logDepth } from "../shaders";

/** Just over the cloud deck (1.006): a storm is the one thing that must read through its own clouds. */
const LIFT = 1.0068;

const swirlVertex = /* glsl */ `
  uniform vec3 uCenter;
  uniform float uSize;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec3 n = normalize(uCenter);
    vec3 t = normalize(cross(abs(n.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0), n));
    vec3 b = cross(n, t);
    vec3 p = n * ${LIFT} + (t * position.x + b * position.y) * uSize * 2.0;
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(p, 1.0);
  }
`;

const swirlFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uClock;
  uniform float uSpin;
  uniform float uOpacity;
  uniform float uSelected;
  varying vec2 vUv;
  void main() {
    vec2 q = (vUv - 0.5) * 2.0;
    float r = length(q);
    if (r > 1.0) discard;
    // Two arms that wind inward and turn: anticlockwise north of the equator, clockwise south of it.
    float angle = atan(q.y, q.x);
    float arms = sin(2.0 * angle + uSpin * (log(max(r, 0.02)) * 5.0 + uClock * 1.6));
    float band = smoothstep(0.15, 1.0, arms) * smoothstep(1.0, 0.45, r) * smoothstep(0.1, 0.24, r);
    float eye = smoothstep(0.05, 0.0, abs(r - 0.13)) * 0.9;
    float ring = uSelected * smoothstep(0.03, 0.0, abs(r - 0.92)) * 0.8;
    float a = (band * 0.75 + eye + ring) * uOpacity;
    gl_FragColor = vec4(uColor * a, a);
    #include <colorspace_fragment>
  }
`;

const pathVertex = /* glsl */ `
  attribute float aTime;
  attribute float aAlong;
  varying float vTime;
  varying float vAlong;
  void main() {
    vTime = aTime;
    vAlong = aAlong;
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
  }
`;

const pathFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uNow;
  uniform float uOpacity;
  uniform float uDashes;
  uniform float uForecast;
  varying float vTime;
  varying float vAlong;
  void main() {
    // The path it took is solid; the forecast ahead (and the whole cone) is dashed and fainter.
    float ahead = max(step(uNow, vTime), uForecast);
    float dash = mix(1.0, step(0.45, fract(vAlong * uDashes)), ahead);
    float a = mix(0.85, 0.45, ahead) * dash * uOpacity;
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor * a, a);
    #include <colorspace_fragment>
  }
`;

interface Drawn {
  storm: Storm;
  swirl: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  path: THREE.Line<THREE.BufferGeometry, THREE.ShaderMaterial>;
  cone: THREE.LineLoop<THREE.BufferGeometry, THREE.ShaderMaterial> | null;
  /** Where the centre is at the current time, Earth-fixed; null outside the storm's track. */
  at: THREE.Vector3 | null;
}

/** Points along the great circle from a to b (both unit vectors), excluding b. */
function arc(a: THREE.Vector3, b: THREE.Vector3, steps: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const angle = a.angleTo(b);
  for (let i = 0; i < steps; i++) {
    const k = i / steps;
    if (angle < 1e-6) out.push(a.clone());
    else out.push(a.clone().multiplyScalar(Math.sin((1 - k) * angle)).add(b.clone().multiplyScalar(Math.sin(k * angle))).divideScalar(Math.sin(angle)));
  }
  return out;
}

/**
 * Active tropical cyclones: a turning swirl at each storm's centre (sized by its strongest wind, coloured by
 * GDACS's alert level), the track it took, the official forecast track and the forecast cone. Everything
 * follows the simulation clock, so scrubbing the timeline moves each storm along its path.
 */
export class Storms {
  readonly group = new THREE.Group();
  private drawn: Drawn[] = [];
  /** Times are seconds from this Unix ms, which keeps float32 attributes precise. */
  private base = 0;
  private plane = new THREE.PlaneGeometry(1, 1);
  private opacity = 1;
  private selected: number | null = null;

  constructor() {
    this.group.renderOrder = 2.5;
  }

  get storms(): Storm[] {
    return this.drawn.map((d) => d.storm);
  }

  set(storms: Storm[]) {
    this.clear();
    this.base = Date.now() - 30 * 86_400_000;
    for (const storm of storms) {
      const color = new THREE.Color(ALERT_COLORS[storm.alert]);
      const swirl = new THREE.Mesh(
        this.plane,
        new THREE.ShaderMaterial({
          ...logDepth(swirlVertex, swirlFragment),
          uniforms: {
            uCenter: { value: new THREE.Vector3() },
            // 200 km across for a tropical storm, up to about 560 km for the strongest typhoons.
            uSize: { value: (100 + Math.min(180, Math.max(0, storm.windKmh - 60) * 0.75)) / 6371 },
            uColor: { value: color },
            uClock: { value: 0 },
            uSpin: { value: storm.track[0].lat >= 0 ? 1 : -1 },
            uOpacity: { value: 1 },
            uSelected: { value: 0 },
          },
          transparent: true,
          depthWrite: false,
          premultipliedAlpha: true,
        }),
      );
      swirl.frustumCulled = false;
      swirl.renderOrder = 2.6;

      const points: number[] = [];
      const times: number[] = [];
      const along: number[] = [];
      let dist = 0;
      let prev: THREE.Vector3 | null = null;
      const track = storm.track.map((p) => new THREE.Vector3(...latLonToVec(p.lat, p.lon)));
      for (let i = 0; i < track.length; i++) {
        const next = i + 1 < track.length ? track[i + 1] : null;
        const steps = next ? Math.max(1, Math.ceil(track[i].angleTo(next) / 0.004)) : 1;
        const pts = next ? arc(track[i], next, steps) : [track[i]];
        pts.forEach((p, k) => {
          if (prev) dist += prev.distanceTo(p);
          prev = p;
          points.push(p.x * LIFT, p.y * LIFT, p.z * LIFT);
          const t0 = storm.track[i].t;
          const t1 = next ? storm.track[i + 1].t : t0;
          times.push((t0 + ((t1 - t0) * k) / steps - this.base) / 1000);
          along.push(dist);
        });
      }
      const pathGeometry = new THREE.BufferGeometry();
      pathGeometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
      pathGeometry.setAttribute("aTime", new THREE.Float32BufferAttribute(times, 1));
      pathGeometry.setAttribute("aAlong", new THREE.Float32BufferAttribute(along, 1));
      const pathMaterial = (forecast: number) =>
        new THREE.ShaderMaterial({
          ...logDepth(pathVertex, pathFragment),
          uniforms: { uColor: { value: color }, uNow: { value: 0 }, uOpacity: { value: 1 }, uDashes: { value: 20 }, uForecast: { value: forecast } },
          transparent: true,
          depthWrite: false,
          premultipliedAlpha: true,
        });
      const path = new THREE.Line(pathGeometry, pathMaterial(0));
      path.frustumCulled = false;
      path.renderOrder = 2.5;

      let cone: Drawn["cone"] = null;
      if (storm.cone.length > 2) {
        const ring = storm.cone.map(([lon, lat]) => new THREE.Vector3(...latLonToVec(lat, lon)).multiplyScalar(LIFT - 0.0004));
        const coneGeometry = new THREE.BufferGeometry().setFromPoints(ring);
        let d = 0;
        coneGeometry.setAttribute("aAlong", new THREE.Float32BufferAttribute(ring.map((p, i) => (d += i ? p.distanceTo(ring[i - 1]) : 0)), 1));
        coneGeometry.setAttribute("aTime", new THREE.Float32BufferAttribute(ring.map(() => 0), 1));
        cone = new THREE.LineLoop(coneGeometry, pathMaterial(1));
        cone.frustumCulled = false;
        cone.renderOrder = 2.5;
      }
      this.group.add(path, swirl);
      if (cone) this.group.add(cone);
      this.drawn.push({ storm, swirl, path, cone, at: null });
    }
    this.select(this.selected);
  }

  /** Moves each storm to where it is at `simMs` and hides storms outside their track's span. */
  update(simMs: number, clock: number, cameraDist: number) {
    const now = (simMs - this.base) / 1000;
    // Dashes about 20 px long at any distance: their count per Earth radius grows as the camera closes in.
    const dashes = THREE.MathUtils.clamp(60 / (cameraDist - 1), 10, 4000);
    for (const d of this.drawn) {
      const p = stormAt(d.storm, simMs);
      const live = !!p;
      d.swirl.visible = live && this.opacity > 0.01;
      d.path.visible = live && this.opacity > 0.01;
      if (d.cone) d.cone.visible = live && this.opacity > 0.01;
      if (!p) {
        d.at = null;
        continue;
      }
      d.at = (d.at ?? new THREE.Vector3()).set(...latLonToVec(p.lat, p.lon));
      d.swirl.material.uniforms.uCenter.value.copy(d.at);
      d.swirl.material.uniforms.uClock.value = clock;
      d.path.material.uniforms.uNow.value = now;
      d.path.material.uniforms.uDashes.value = dashes;
      if (d.cone) d.cone.material.uniforms.uDashes.value = dashes;
    }
  }

  /** Storms now on their track, with their centres (Earth-fixed unit vectors), for picking and labels. */
  positions(): { storm: Storm; at: THREE.Vector3; radius: number }[] {
    return this.drawn.filter((d) => d.at).map((d) => ({ storm: d.storm, at: d.at!, radius: d.swirl.material.uniforms.uSize.value as number }));
  }

  select(id: number | null) {
    this.selected = id;
    for (const d of this.drawn) d.swirl.material.uniforms.uSelected.value = d.storm.id === id ? 1 : 0;
  }

  setOpacity(v: number) {
    this.opacity = v;
    for (const d of this.drawn) {
      for (const m of [d.swirl.material, d.path.material, d.cone?.material]) if (m) m.uniforms.uOpacity.value = v;
    }
    this.group.visible = v > 0.01;
  }

  private clear() {
    for (const d of this.drawn) {
      this.group.remove(d.swirl, d.path);
      d.swirl.material.dispose();
      d.path.geometry.dispose();
      d.path.material.dispose();
      if (d.cone) {
        this.group.remove(d.cone);
        d.cone.geometry.dispose();
        d.cone.material.dispose();
      }
    }
    this.drawn = [];
  }

  dispose() {
    this.clear();
    this.plane.dispose();
  }
}
