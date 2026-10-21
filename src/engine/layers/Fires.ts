import * as THREE from "three";
import { latLonToVec } from "@/lib/geo";
import type { FireGrid } from "@/lib/feeds/fires";
import { firesFragment, firesVertex, logDepth } from "../shaders";

export class Fires {
  readonly points: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  grid: FireGrid | null = null;
  /** Scene positions, kept for picking. */
  positions = new Float32Array(0);
  private geometry = new THREE.BufferGeometry();

  constructor(pixelRatio: number) {
    this.material = new THREE.ShaderMaterial({
      ...logDepth(firesVertex, firesFragment),
      uniforms: { uNow: { value: 0 }, uClock: { value: 0 }, uPixelRatio: { value: pixelRatio }, uOpacity: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
  }

  set(grid: FireGrid) {
    this.grid = grid;
    const n = grid.lat.length;
    const pos = new Float32Array(n * 3);
    const frp = new Float32Array(n);
    const time = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos.set(latLonToVec(grid.lat[i] / 100, grid.lon[i] / 100, 1.0015), i * 3);
      frp[i] = grid.frp[i];
      time[i] = grid.minutes[i] * 60;
    }
    this.positions = pos;
    this.geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.geometry.setAttribute("aFrp", new THREE.BufferAttribute(frp, 1));
    this.geometry.setAttribute("aTime", new THREE.BufferAttribute(time, 1));
  }

  update(simMs: number, clock: number) {
    if (!this.grid) return;
    this.material.uniforms.uNow.value = (simMs - this.grid.start) / 1000;
    this.material.uniforms.uClock.value = clock;
  }

  setOpacity(v: number) {
    this.material.uniforms.uOpacity.value = v;
    this.points.visible = v > 0.01;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
