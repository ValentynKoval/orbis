import * as THREE from "three";
import { rotateY, type Vec3 } from "@/lib/geo";
import { EARTH_RADIUS_AU, moonPosition, toScene } from "@/lib/orbits";
import { bodyVertex, logDepth, moonFragment } from "../shaders";

/** Mean lunar radius in Earth radii. */
export const MOON_RADIUS = 1737.4 / 6371;

/** The Moon in the Earth-centred scene: real distance (~60 Earth radii), real size, lit by the Sun, near side facing us. */
export class Moon {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  position: Vec3 = [0, 0, 0];

  constructor(sun: THREE.Vector3) {
    this.material = new THREE.ShaderMaterial({
      ...logDepth(bodyVertex, moonFragment),
      uniforms: {
        uMap: { value: null },
        uSun: { value: sun },
        uAmbient: { value: 0.015 },
        uEmissive: { value: 0 },
        uOpacity: { value: 1 },
        uEarthPos: { value: new THREE.Vector3() },
        uEarthRadius: { value: 1 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(MOON_RADIUS, 96, 48), this.material);
    this.mesh.visible = false;
    this.mesh.renderOrder = 0;
  }

  setTexture(texture: THREE.Texture) {
    this.material.uniforms.uMap.value = texture;
    this.mesh.visible = true;
  }

  /** `gmst` is the Earth's rotation angle: the Moon's equatorial position must counter-rotate into the Earth-fixed scene. */
  update(simMs: number, gmst: number) {
    const p = toScene(moonPosition(simMs)).map((v) => v / EARTH_RADIUS_AU) as Vec3;
    this.position = rotateY(p, -gmst);
    this.mesh.position.set(...this.position);
    // Tidally locked: the map's prime meridian (+X of the mesh) points at the Earth.
    const d = new THREE.Vector3(...this.position).negate().normalize();
    this.mesh.rotation.set(0, Math.atan2(-d.z, d.x), 0);
  }

  setOpacity(v: number) {
    this.material.uniforms.uOpacity.value = v;
    this.mesh.visible = v > 0.01 && !!this.material.uniforms.uMap.value;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    (this.material.uniforms.uMap.value as THREE.Texture | null)?.dispose();
  }
}
