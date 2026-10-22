import * as THREE from "three";
import type { Vec3 } from "@/lib/geo";
import { AU_KM, moonPosition, planetPosition, PLANETS, toScene, type Planet } from "@/lib/orbits";
import { logDepth, markerFragment, markerVertex, sunFragment, sunVertex } from "../shaders";
import { BODY_COLORS } from "../SolarSystem";

/** Distance of the sky sphere in Earth radii: beyond the stars' parallax, inside the far plane. */
const SKY = 2500;
const SUN_RADIUS_KM = 695_700;

export interface SkyMarker {
  id: Planet | "sun" | "moon";
  /** Earth-fixed scene direction (unit vector). */
  dir: Vec3;
}

/**
 * The Sun and the planets as seen from the Earth: a billboard Sun that the
 * planet can eclipse, and markers for the planets on a distant sky sphere.
 * They make the hand-over to the heliocentric scene seamless: the same
 * bodies are already in the same directions.
 */
export class SkyBodies {
  readonly sun: THREE.Mesh;
  readonly markers: THREE.Points;
  private sunMaterial: THREE.ShaderMaterial;
  private markerMaterial: THREE.ShaderMaterial;
  private geometry = new THREE.BufferGeometry();
  /** Current markers, for labels. */
  positions: SkyMarker[] = [];

  constructor(pixelRatio: number) {
    this.sunMaterial = new THREE.ShaderMaterial({
      ...logDepth(sunVertex, sunFragment),
      uniforms: { uSize: { value: (SKY * Math.tan((SUN_RADIUS_KM / AU_KM) * 1.0)) / 0.18 }, uClock: { value: 0 }, uMap: { value: null } },
      transparent: true,
      depthWrite: false,
    });
    this.sun = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.sunMaterial);
    this.sun.frustumCulled = false;
    this.sun.renderOrder = -0.5;
    this.sun.visible = false;

    const n = PLANETS.length - 1;
    this.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const colors = new Float32Array(n * 3);
    const sizes = new Float32Array(n);
    let i = 0;
    for (const p of PLANETS) {
      if (p === "earth") continue;
      const c = new THREE.Color(BODY_COLORS[p]);
      colors.set([c.r, c.g, c.b], i * 3);
      sizes[i] = p === "jupiter" || p === "venus" ? 4 : 3;
      i++;
    }
    this.geometry.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    this.geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    this.markerMaterial = new THREE.ShaderMaterial({
      ...logDepth(markerVertex, markerFragment),
      uniforms: { uPixelRatio: { value: pixelRatio }, uOpacity: { value: 0 } },
      transparent: true,
      depthWrite: false,
    });
    this.markers = new THREE.Points(this.geometry, this.markerMaterial);
    this.markers.frustumCulled = false;
    this.markers.renderOrder = -0.5;
  }

  setSunTexture(texture: THREE.Texture) {
    this.sunMaterial.uniforms.uMap.value = texture;
    this.sun.visible = true;
  }

  /**
   * `sun` is the Earth-fixed unit vector toward the Sun; `rotation` the GMST
   * (radians) that turns inertial directions into the Earth-fixed frame.
   */
  update(simMs: number, sun: THREE.Vector3, rotation: number, clock: number, cameraDist: number) {
    this.sun.position.copy(sun).multiplyScalar(SKY);
    this.sunMaterial.uniforms.uClock.value = clock;
    const earth = toScene(planetPosition("earth", simMs));
    const pos = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    const c = Math.cos(-rotation);
    const s = Math.sin(-rotation);
    this.positions = [{ id: "sun", dir: [sun.x, sun.y, sun.z] }];
    const place = (p: Vec3, id: SkyMarker["id"], index: number | null) => {
      const d: Vec3 = [p[0] - earth[0], p[1] - earth[1], p[2] - earth[2]];
      const len = Math.hypot(...d);
      // Inertial → Earth-fixed (the same rotation the inertial group applies).
      const x = (d[0] * c + d[2] * s) / len;
      const z = (-d[0] * s + d[2] * c) / len;
      const dir: Vec3 = [x, d[1] / len, z];
      this.positions.push({ id, dir });
      if (index !== null) pos.setXYZ(index, dir[0] * SKY, dir[1] * SKY, dir[2] * SKY);
    };
    let i = 0;
    for (const p of PLANETS) {
      if (p === "earth") continue;
      place(toScene(planetPosition(p, simMs)), p, i++);
    }
    const moon = toScene(moonPosition(simMs));
    place([earth[0] + moon[0], earth[1] + moon[1], earth[2] + moon[2]], "moon", null);
    pos.needsUpdate = true;
    // Planet markers only matter once the Earth is small on screen.
    this.markerMaterial.uniforms.uOpacity.value = THREE.MathUtils.smoothstep(cameraDist, 12, 60);
  }

  dispose() {
    this.sun.geometry.dispose();
    this.sunMaterial.dispose();
    this.geometry.dispose();
    this.markerMaterial.dispose();
  }
}
