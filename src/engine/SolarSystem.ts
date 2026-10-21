import * as THREE from "three";
import { gmst } from "@/lib/astro";
import type { Vec3 } from "@/lib/geo";
import { latLonToVec } from "@/lib/geo";
import type { BodyRecord } from "@/lib/feeds/bodies";
import { AU_KM, EARTH_RADIUS_AU, moonPosition, orbitPath, planetPosition, PLANETS, smallBodyPosition, toScene, type Planet } from "@/lib/orbits";
import { CameraRig } from "./CameraRig";
import { makeStars } from "./layers/Planet";
import { bodyFragment, bodyVertex, logDepth, markerFragment, markerVertex, sunFragment, sunVertex } from "./shaders";

export type MajorBody = "sun" | "moon" | Planet;
export type BodyRef = { kind: "major"; id: MajorBody } | { kind: "comet"; index: number } | { kind: "asteroid"; index: number };

export const RADIUS_KM: Record<MajorBody, number> = {
  sun: 695_700,
  mercury: 2439.7,
  venus: 6051.8,
  earth: 6371,
  mars: 3389.5,
  jupiter: 69_911,
  saturn: 58_232,
  uranus: 25_362,
  neptune: 24_622,
  moon: 1737.4,
};
export const BODY_COLORS: Record<MajorBody, string> = {
  sun: "#ffd27a",
  mercury: "#b8b1a8",
  venus: "#e9c99a",
  earth: "#8ccbff",
  mars: "#e07a4a",
  jupiter: "#d9b48c",
  saturn: "#e8d6a4",
  uranus: "#9fd8e2",
  neptune: "#5f7fe8",
  moon: "#d8d8d8",
};
/** Sidereal rotation periods in hours (negative = retrograde). */
const SPIN_H: Record<MajorBody, number> = {
  sun: 609.1,
  mercury: 1407.6,
  venus: -5832.5,
  earth: 23.934,
  mars: 24.62,
  jupiter: 9.93,
  saturn: 10.66,
  uranus: -17.24,
  neptune: 16.11,
  moon: 655.7,
};
const ORBIT_YEARS: Record<Planet, number> = { mercury: 0.2408, venus: 0.6152, earth: 1, mars: 1.8808, jupiter: 11.862, saturn: 29.457, uranus: 84.02, neptune: 164.8 };
export const MAJOR: MajorBody[] = ["sun", "mercury", "venus", "earth", "moon", "mars", "jupiter", "saturn", "uranus", "neptune"];

export interface SystemLabel {
  ref: BodyRef;
  name: string;
  x: number;
  y: number;
  /** Screen radius of the body's disc, px. */
  px: number;
  distanceAu: number;
}

/**
 * The heliocentric scene, in AU, with a floating origin at the focused body
 * so nearby geometry keeps full float precision at any distance. Planets are
 * real size (tiny from afar: markers and labels keep them findable).
 */
export class SolarSystem {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(32, 1, 1e-6, 1000);
  readonly rig: CameraRig;
  focus: BodyRef = { kind: "major", id: "earth" };
  comets: BodyRecord[] = [];
  asteroids: BodyRecord[] = [];
  selected: BodyRef | null = null;
  private meshes = new Map<MajorBody, THREE.Mesh>();
  private materials = new Map<MajorBody, THREE.ShaderMaterial>();
  private sun: THREE.Mesh;
  private sunMaterial: THREE.ShaderMaterial;
  private ring: THREE.Mesh | null = null;
  private markers: THREE.Points;
  private markerGeometry = new THREE.BufferGeometry();
  private asteroidPoints: THREE.Points;
  private asteroidGeometry = new THREE.BufferGeometry();
  private orbits = new THREE.Group();
  private moonOrbit: THREE.Line | null = null;
  private cometOrbits = new THREE.Group();
  private selectedOrbit: THREE.Line | null = null;
  private stars: THREE.Points;
  /** Heliocentric scene-frame positions (AU) of everything, this frame. */
  private pos = new Map<string, Vec3>();
  private cometPos: Vec3[] = [];
  private asteroidPos: Float32Array = new Float32Array(0);
  private focusPos: Vec3 = [0, 0, 0];
  private clockSeconds = 0;

  constructor(
    canvas: HTMLCanvasElement,
    private pixelRatio: number,
  ) {
    this.rig = new CameraRig(this.camera, canvas);
    this.rig.radius = 0;
    this.rig.minDist = 70 * EARTH_RADIUS_AU;
    this.rig.maxDist = 90;
    this.rig.pose.dist = this.rig.goal.dist = 0.01;

    this.sunMaterial = new THREE.ShaderMaterial({
      ...logDepth(sunVertex, sunFragment),
      uniforms: { uSize: { value: (RADIUS_KM.sun / AU_KM) / 0.18 }, uClock: { value: 0 }, uMap: { value: null } },
      transparent: true,
      depthWrite: false,
    });
    this.sun = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.sunMaterial);
    this.sun.frustumCulled = false;
    this.sun.renderOrder = 1;
    this.scene.add(this.sun);

    for (const id of MAJOR) {
      if (id === "sun") continue;
      const material = new THREE.ShaderMaterial({
        ...logDepth(bodyVertex, bodyFragment),
        uniforms: {
          uMap: { value: null },
          uSun: { value: new THREE.Vector3(1, 0, 0) },
          uAmbient: { value: 0.012 },
          uEmissive: { value: 0 },
          uOpacity: { value: 1 },
        },
      });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(RADIUS_KM[id] / AU_KM, 96, 48), material);
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.meshes.set(id, mesh);
      this.materials.set(id, material);
      this.scene.add(mesh);
    }

    this.markers = new THREE.Points(
      this.markerGeometry,
      new THREE.ShaderMaterial({
        ...logDepth(markerVertex, markerFragment),
        uniforms: { uPixelRatio: { value: pixelRatio }, uOpacity: { value: 1 } },
        transparent: true,
        depthWrite: false,
        depthTest: false,
      }),
    );
    this.markers.frustumCulled = false;
    this.markers.renderOrder = 8;
    this.scene.add(this.markers);

    this.asteroidPoints = new THREE.Points(
      this.asteroidGeometry,
      new THREE.ShaderMaterial({
        ...logDepth(markerVertex, markerFragment),
        uniforms: { uPixelRatio: { value: pixelRatio }, uOpacity: { value: 0.75 } },
        transparent: true,
        depthWrite: false,
        depthTest: false,
      }),
    );
    this.asteroidPoints.frustumCulled = false;
    this.asteroidPoints.renderOrder = 7;
    this.scene.add(this.asteroidPoints);

    this.scene.add(this.orbits, this.cometOrbits);
    this.stars = makeStars(5200, 900);
    this.scene.add(this.stars);
    this.buildPlanetOrbits(Date.now());
  }

  // ---------------------------------------------------------------- assets

  async loadTextures(lite: boolean) {
    const loader = new THREE.TextureLoader();
    const jobs: [MajorBody, string][] = [
      ["earth", `/textures/day-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}-2k.jpg`],
      ["moon", "/textures/moon-2k.jpg"],
      ...(["mercury", "venus", "mars", "jupiter", "saturn", "uranus", "neptune"] as MajorBody[]).map((p) => [p, `/textures/${p}-1k.jpg`] as [MajorBody, string]),
    ];
    await Promise.all(
      jobs.map(async ([id, url]) => {
        const texture = await loader.loadAsync(url);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = lite ? 2 : 8;
        const material = this.materials.get(id);
        if (material) material.uniforms.uMap.value = texture;
        const mesh = this.meshes.get(id);
        if (mesh) mesh.visible = true;
      }),
    );
    const sunTexture = await loader.loadAsync("/textures/sun-1k.jpg");
    sunTexture.colorSpace = THREE.SRGBColorSpace;
    sunTexture.wrapS = THREE.RepeatWrapping;
    this.sunMaterial.uniforms.uMap.value = sunTexture;
    const ringTexture = await loader.loadAsync("/textures/saturn-ring-1k.png");
    ringTexture.colorSpace = THREE.SRGBColorSpace;
    const saturnR = RADIUS_KM.saturn / AU_KM;
    const geometry = new THREE.RingGeometry(saturnR * 1.24, saturnR * 2.27, 128, 1);
    // The strip texture runs along the radius.
    const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      const r = Math.hypot(position.getX(i), position.getY(i));
      uv.setXY(i, (r - saturnR * 1.24) / (saturnR * (2.27 - 1.24)), 0.5);
    }
    this.ring = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: ringTexture, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
    this.ring.rotation.x = Math.PI / 2 - THREE.MathUtils.degToRad(26.7);
    this.scene.add(this.ring);
  }

  setBodies(comets: BodyRecord[], asteroids: BodyRecord[]) {
    this.comets = comets;
    this.asteroids = asteroids;
    this.asteroidPos = new Float32Array(asteroids.length * 3);
    const color = new Float32Array(asteroids.length * 3);
    const size = new Float32Array(asteroids.length);
    const grey = new THREE.Color("#9fb3c8");
    for (let i = 0; i < asteroids.length; i++) {
      color.set([grey.r, grey.g, grey.b], i * 3);
      size[i] = 1.6 + Math.min(2.2, (asteroids[i].diameterKm ?? 50) / 250);
    }
    this.asteroidGeometry.setAttribute("position", new THREE.BufferAttribute(this.asteroidPos, 3));
    this.asteroidGeometry.setAttribute("aColor", new THREE.BufferAttribute(color, 3));
    this.asteroidGeometry.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    this.cometOrbits.clear();
    const material = new THREE.LineBasicMaterial({ color: "#7ee7e1", transparent: true, opacity: 0.22, depthWrite: false });
    for (const c of comets) {
      const points = orbitPath(c.el, 240, 80).map((p) => new THREE.Vector3(...toScene(p)));
      if (points.length < 2) continue;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material);
      line.frustumCulled = false;
      this.cometOrbits.add(line);
    }
  }

  private buildPlanetOrbits(ms: number) {
    this.orbits.clear();
    for (const p of PLANETS) {
      const steps = 256;
      const points: THREE.Vector3[] = [];
      const period = ORBIT_YEARS[p] * 365.25 * 86_400_000;
      for (let k = 0; k <= steps; k++) points.push(new THREE.Vector3(...toScene(planetPosition(p, ms + (period * k) / steps))));
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: BODY_COLORS[p], transparent: true, opacity: p === "earth" ? 0.5 : 0.3, depthWrite: false }),
      );
      line.frustumCulled = false;
      this.orbits.add(line);
    }
    const moonPts: THREE.Vector3[] = [];
    for (let k = 0; k <= 128; k++) moonPts.push(new THREE.Vector3(...toScene(moonPosition(ms + (27.32 * 86_400_000 * k) / 128))));
    this.moonOrbit = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(moonPts),
      new THREE.LineBasicMaterial({ color: BODY_COLORS.moon, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.moonOrbit.frustumCulled = false;
    this.scene.add(this.moonOrbit);
  }

  // ---------------------------------------------------------------- state

  /** Heliocentric position of a body in scene axes, AU. */
  heliocentric(ref: BodyRef, ms: number): Vec3 | null {
    if (ref.kind === "major") {
      if (ref.id === "sun") return [0, 0, 0];
      if (ref.id === "moon") {
        const e = toScene(planetPosition("earth", ms));
        const m = toScene(moonPosition(ms));
        return [e[0] + m[0], e[1] + m[1], e[2] + m[2]];
      }
      return toScene(planetPosition(ref.id, ms));
    }
    const rec = ref.kind === "comet" ? this.comets[ref.index] : this.asteroids[ref.index];
    const p = rec && smallBodyPosition(rec.el, ms);
    return p ? toScene(p) : null;
  }

  radiusAu(ref: BodyRef): number {
    if (ref.kind === "major") return RADIUS_KM[ref.id] / AU_KM;
    const rec = ref.kind === "comet" ? this.comets[ref.index] : this.asteroids[ref.index];
    return Math.max(1, rec?.diameterKm ?? 2) / 2 / AU_KM;
  }

  name(ref: BodyRef): string {
    if (ref.kind === "major") return ref.id;
    return (ref.kind === "comet" ? this.comets[ref.index] : this.asteroids[ref.index])?.name ?? "";
  }

  setFocus(ref: BodyRef, ms: number) {
    this.focus = ref;
    const r = this.radiusAu(ref);
    this.rig.minDist = ref.kind === "major" && ref.id === "earth" ? 70 * EARTH_RADIUS_AU : Math.max(r * 2.6, 1e-5);
    if (this.rig.goal.dist < this.rig.minDist) this.rig.flyTo({ dist: Math.max(this.rig.minDist, r * 8) }, 1.2);
    void ms;
  }

  /** Flies toward a body and makes it the orbit centre. */
  flyToBody(ref: BodyRef, ms: number) {
    const r = this.radiusAu(ref);
    this.setFocus(ref, ms);
    this.rig.flyTo({ dist: Math.max(this.rig.minDist, r * 9) }, 2.2);
  }

  update(simMs: number, dt: number, width: number, height: number) {
    this.clockSeconds += dt;
    // Positions, heliocentric.
    this.pos.clear();
    this.pos.set("sun", [0, 0, 0]);
    for (const p of PLANETS) this.pos.set(p, toScene(planetPosition(p, simMs)));
    const earth = this.pos.get("earth")!;
    const moon = toScene(moonPosition(simMs));
    this.pos.set("moon", [earth[0] + moon[0], earth[1] + moon[1], earth[2] + moon[2]]);
    this.cometPos = this.comets.map((c) => {
      const p = smallBodyPosition(c.el, simMs);
      return p ? toScene(p) : [1e6, 1e6, 1e6];
    });
    for (let i = 0; i < this.asteroids.length; i++) {
      const p = smallBodyPosition(this.asteroids[i].el, simMs);
      const s = p ? toScene(p) : [1e6, 1e6, 1e6];
      this.asteroidPos[i * 3] = s[0];
      this.asteroidPos[i * 3 + 1] = s[1];
      this.asteroidPos[i * 3 + 2] = s[2];
    }
    const f = this.heliocentric(this.focus, simMs) ?? [0, 0, 0];
    this.focusPos = f;

    // Place everything relative to the focus.
    const rel = (p: Vec3): [number, number, number] => [p[0] - f[0], p[1] - f[1], p[2] - f[2]];
    this.sun.position.set(...rel([0, 0, 0]));
    this.sunMaterial.uniforms.uClock.value = this.clockSeconds;
    for (const [id, mesh] of this.meshes) {
      const p = this.pos.get(id)!;
      mesh.position.set(...rel(p));
      const toSun = new THREE.Vector3(-p[0], -p[1], -p[2]).normalize();
      this.materials.get(id)!.uniforms.uSun.value.copy(toSun);
      if (id === "earth") mesh.rotation.set(0, gmst(simMs), 0);
      else if (id === "moon") {
        const d = new THREE.Vector3(earth[0] - p[0], earth[1] - p[1], earth[2] - p[2]).normalize();
        mesh.rotation.set(0, Math.atan2(-d.z, d.x), 0);
      } else mesh.rotation.set(0, ((simMs / 3_600_000) * 2 * Math.PI) / SPIN_H[id], 0);
    }
    if (this.ring) this.ring.position.copy(this.meshes.get("saturn")!.position);
    this.orbits.position.set(...rel([0, 0, 0]));
    this.cometOrbits.position.copy(this.orbits.position);
    this.moonOrbit?.position.set(...rel(earth));
    this.stars.position.set(0, 0, 0);

    // Markers for major bodies and comets.
    const n = MAJOR.length + this.comets.length;
    let mp = this.markerGeometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!mp || mp.count !== n) {
      this.markerGeometry.setAttribute("position", (mp = new THREE.BufferAttribute(new Float32Array(n * 3), 3)));
      this.markerGeometry.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      this.markerGeometry.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(n), 1));
    }
    const mc = this.markerGeometry.getAttribute("aColor") as THREE.BufferAttribute;
    const msz = this.markerGeometry.getAttribute("aSize") as THREE.BufferAttribute;
    const cometColor = new THREE.Color("#7ee7e1");
    const gold = new THREE.Color("#f2c14e");
    MAJOR.forEach((id, i) => {
      const p = rel(this.pos.get(id)!);
      mp.setXYZ(i, p[0], p[1], p[2]);
      const sel = this.selected?.kind === "major" && this.selected.id === id;
      const c = sel ? gold : new THREE.Color(BODY_COLORS[id]);
      mc.setXYZ(i, c.r, c.g, c.b);
      msz.setX(i, id === "sun" ? 0 : sel ? 9 : id === "moon" ? 3 : 4.5);
    });
    this.cometPos.forEach((p, i) => {
      const r = rel(p);
      const k = MAJOR.length + i;
      mp.setXYZ(k, r[0], r[1], r[2]);
      const sel = this.selected?.kind === "comet" && this.selected.index === i;
      const c = sel ? gold : cometColor;
      mc.setXYZ(k, c.r, c.g, c.b);
      msz.setX(k, sel ? 9 : 4);
    });
    mp.needsUpdate = mc.needsUpdate = msz.needsUpdate = true;
    const ap = this.asteroidGeometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (ap) {
      for (let i = 0; i < this.asteroids.length; i++) ap.setXYZ(i, this.asteroidPos[i * 3] - f[0], this.asteroidPos[i * 3 + 1] - f[1], this.asteroidPos[i * 3 + 2] - f[2]);
      ap.needsUpdate = true;
    }
    if (this.selectedOrbit) this.selectedOrbit.position.copy(this.orbits.position);
    // Seen from a planet's surface the orbit lines fill the sky; show them only from a distance.
    const d = this.rig.pose.dist;
    const far = THREE.MathUtils.smoothstep(d, 0.015, 0.25);
    this.orbits.visible = far > 0.01;
    this.cometOrbits.visible = far > 0.01;
    for (const g of [this.orbits, this.cometOrbits]) for (const line of g.children) ((line as THREE.Line).material as THREE.LineBasicMaterial).opacity = ((line as THREE.Line).userData.baseOpacity ??= ((line as THREE.Line).material as THREE.LineBasicMaterial).opacity) * far;
    if (this.moonOrbit) this.moonOrbit.visible = d > 0.0012 && d < 0.3 && this.focus.kind === "major" && (this.focus.id === "earth" || this.focus.id === "moon");

    this.rig.update(dt, width, height);
    const near = Math.max(1e-7, this.rig.pose.dist * 0.002);
    if (Math.abs(near - this.camera.near) / this.camera.near > 0.2) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
  }

  // ---------------------------------------------------------------- selection

  select(ref: BodyRef | null) {
    this.selected = ref;
    if (this.selectedOrbit) {
      this.scene.remove(this.selectedOrbit);
      this.selectedOrbit.geometry.dispose();
      this.selectedOrbit = null;
    }
    if (ref && ref.kind !== "major") {
      const rec = ref.kind === "comet" ? this.comets[ref.index] : this.asteroids[ref.index];
      const points = orbitPath(rec.el, 360, 80).map((p) => new THREE.Vector3(...toScene(p)));
      if (points.length > 1) {
        this.selectedOrbit = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(points),
          new THREE.LineBasicMaterial({ color: "#f2c14e", transparent: true, opacity: 0.8, depthWrite: false }),
        );
        this.selectedOrbit.frustumCulled = false;
        this.scene.add(this.selectedOrbit);
      }
    }
  }

  /** Nearest body to a screen point, within `radiusPx`. */
  pick(px: number, py: number, width: number, height: number, radiusPx: number): BodyRef | null {
    const v = new THREE.Vector3();
    const f = this.focusPos;
    let best: BodyRef | null = null;
    let bestD = radiusPx;
    const test = (p: Vec3, ref: BodyRef, bonus = 0) => {
      v.set(p[0] - f[0], p[1] - f[1], p[2] - f[2]).project(this.camera);
      if (v.z > 1) return;
      const d = Math.hypot(((v.x + 1) / 2) * width - px, ((1 - v.y) / 2) * height - py) - bonus;
      if (d < bestD) {
        bestD = d;
        best = ref;
      }
    };
    for (const id of MAJOR) test(this.pos.get(id)!, { kind: "major", id }, id === "sun" ? 10 : 3);
    this.cometPos.forEach((p, index) => test(p, { kind: "comet", index }, 2));
    for (let index = 0; index < this.asteroids.length; index++) {
      test([this.asteroidPos[index * 3], this.asteroidPos[index * 3 + 1], this.asteroidPos[index * 3 + 2]], { kind: "asteroid", index });
    }
    return best;
  }

  /** Screen positions for the HUD's labels. */
  labels(width: number, height: number): SystemLabel[] {
    const out: SystemLabel[] = [];
    const v = new THREE.Vector3();
    const f = this.focusPos;
    const earth = this.pos.get("earth")!;
    const fovScale = height / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    const add = (p: Vec3, ref: BodyRef, name: string, radiusAu: number) => {
      const r: Vec3 = [p[0] - f[0], p[1] - f[1], p[2] - f[2]];
      v.set(...r).project(this.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) return;
      const dist = Math.hypot(r[0] - this.camera.position.x, r[1] - this.camera.position.y, r[2] - this.camera.position.z);
      out.push({
        ref,
        name,
        x: ((v.x + 1) / 2) * width,
        y: ((1 - v.y) / 2) * height,
        px: (radiusAu / dist) * fovScale,
        distanceAu: Math.hypot(p[0] - earth[0], p[1] - earth[1], p[2] - earth[2]),
      });
    };
    for (const id of MAJOR) add(this.pos.get(id)!, { kind: "major", id }, id, RADIUS_KM[id] / AU_KM);
    this.cometPos.forEach((p, index) => add(p, { kind: "comet", index }, this.comets[index].name, 1e-6));
    if (this.selected?.kind === "asteroid") {
      const i = this.selected.index;
      add([this.asteroidPos[i * 3], this.asteroidPos[i * 3 + 1], this.asteroidPos[i * 3 + 2]], this.selected, this.asteroids[i].name, 1e-6);
    }
    return out;
  }

  /** Camera direction as lat/lon around the focus (for the hand-over with the Earth scene). */
  get viewLatLon() {
    return { lat: this.rig.pose.lat, lon: this.rig.pose.lon };
  }

  cameraVector(): Vec3 {
    return latLonToVec(this.rig.pose.lat, this.rig.pose.lon, this.rig.pose.dist);
  }

  dispose() {
    this.rig.dispose();
    for (const mesh of this.meshes.values()) mesh.geometry.dispose();
    for (const material of this.materials.values()) {
      (material.uniforms.uMap.value as THREE.Texture | null)?.dispose();
      material.dispose();
    }
    this.sunMaterial.dispose();
    this.markerGeometry.dispose();
    this.asteroidGeometry.dispose();
    this.stars.geometry.dispose();
  }
}
