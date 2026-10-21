import * as THREE from "three";
import { auroraFragment, earthVertex, logDepth } from "../shaders";

/** Height of the auroral curtains above the surface, in Earth radii (~110 km). */
const SHELL = 1.017;

/**
 * NOAA's OVATION forecast as a glowing shell on the night side: a 1° grid of
 * aurora probability wrapped around the planet, animated into curtains.
 */
export class Aurora {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  kp: number | null = null;

  constructor(sun: THREE.Vector3) {
    this.material = new THREE.ShaderMaterial({
      ...logDepth(earthVertex, auroraFragment),
      uniforms: { uMap: { value: null }, uSun: { value: sun }, uClock: { value: 0 }, uOpacity: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(SHELL, 128, 64), this.material);
    this.mesh.visible = false;
    this.mesh.renderOrder = 2;
  }

  setTexture(texture: THREE.Texture, kp: number | null) {
    (this.material.uniforms.uMap.value as THREE.Texture | null)?.dispose();
    this.material.uniforms.uMap.value = texture;
    this.kp = kp;
    this.mesh.visible = this.material.uniforms.uOpacity.value > 0.01;
  }

  update(clock: number) {
    this.material.uniforms.uClock.value = clock;
  }

  setOpacity(v: number) {
    this.material.uniforms.uOpacity.value = v;
    this.mesh.visible = v > 0.01 && !!this.material.uniforms.uMap.value;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.material.uniforms.uMap.value as THREE.Texture | null)?.dispose();
    this.material.dispose();
  }
}
