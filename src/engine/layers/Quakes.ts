import * as THREE from "three";
import { latLonToVec } from "@/lib/geo";
import type { Quake } from "@/lib/feeds/quakes";
import { quakesFragment, quakesVertex, logDepth } from "../shaders";

/** Instanced surface decals: a bright epicentre and rings that ripple outward, fading with age. */
export class Quakes {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  quakes: Quake[] = [];
  /** Unix ms that instance times are relative to (keeps float32 precise). */
  private base = 0;
  private geometry = new THREE.InstancedBufferGeometry();

  constructor() {
    const plane = new THREE.PlaneGeometry(1, 1);
    this.geometry.index = plane.index;
    this.geometry.setAttribute("position", plane.getAttribute("position"));
    this.geometry.setAttribute("uv", plane.getAttribute("uv"));
    this.material = new THREE.ShaderMaterial({
      ...logDepth(quakesVertex, quakesFragment),
      uniforms: { uNow: { value: 0 }, uClock: { value: 0 }, uOpacity: { value: 1 }, uZoom: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  set(quakes: Quake[]) {
    // Draw small ones first so big events sit on top.
    this.quakes = [...quakes].sort((a, b) => a.mag - b.mag);
    const n = this.quakes.length;
    this.base = Date.now() - 8 * 86_400_000;
    const pos = new Float32Array(n * 3);
    const mag = new Float32Array(n);
    const time = new Float32Array(n);
    const depth = new Float32Array(n);
    this.quakes.forEach((q, i) => {
      pos.set(latLonToVec(q.lat, q.lon), i * 3);
      mag[i] = Math.max(q.mag, 0.5);
      time[i] = (q.time - this.base) / 1000;
      depth[i] = q.depthKm;
    });
    this.geometry.setAttribute("iPos", new THREE.InstancedBufferAttribute(pos, 3));
    this.geometry.setAttribute("iMag", new THREE.InstancedBufferAttribute(mag, 1));
    this.geometry.setAttribute("iTime", new THREE.InstancedBufferAttribute(time, 1));
    this.geometry.setAttribute("iDepth", new THREE.InstancedBufferAttribute(depth, 1));
    this.geometry.instanceCount = n;
  }

  update(simMs: number, clock: number, cameraDist: number) {
    this.material.uniforms.uNow.value = (simMs - this.base) / 1000;
    this.material.uniforms.uClock.value = clock;
    // Shrink decals as the camera closes in so neighbouring events separate.
    this.material.uniforms.uZoom.value = THREE.MathUtils.clamp((cameraDist - 1) / 2.2, 0.18, 1.3);
  }

  setOpacity(v: number) {
    this.material.uniforms.uOpacity.value = v;
    this.mesh.visible = v > 0.01;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
