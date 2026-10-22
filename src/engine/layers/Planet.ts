import * as THREE from "three";
import { latLonToVec } from "@/lib/geo";
import {
  atmosphereFragment,
  atmosphereVertex,
  cloudsFragment,
  earthFragment,
  earthVertex,
  starsFragment,
  starsVertex,
  logDepth,
} from "../shaders";

const ATMOSPHERE_OUTER = 1.065;

/** The Earth itself: surface, clouds, atmosphere halo, borders, and the star field around it. */
export class Planet {
  readonly earth: THREE.Mesh;
  readonly clouds: THREE.Mesh;
  readonly atmosphere: THREE.Mesh;
  readonly stars: THREE.Points;
  readonly borders = new THREE.Group();
  readonly earthMaterial: THREE.ShaderMaterial;
  readonly cloudsMaterial: THREE.ShaderMaterial;
  private atmosphereMaterial: THREE.ShaderMaterial;
  private starsMaterial: THREE.ShaderMaterial;
  private blank: THREE.DataTexture;

  constructor(segments: number, pixelRatio: number) {
    this.blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.blank.needsUpdate = true;
    const sun = new THREE.Vector3(1, 0, 0);

    const sphere = new THREE.SphereGeometry(1, segments, segments / 2);
    this.earthMaterial = new THREE.ShaderMaterial({
      ...logDepth(earthVertex, earthFragment),
      uniforms: {
        uDay: { value: this.blank },
        uNight: { value: this.blank },
        uWater: { value: this.blank },
        uClouds: { value: this.blank },
        uSun: { value: sun },
        uCloudsOn: { value: 1 },
        uLights: { value: 1 },
      },
    });
    this.earth = new THREE.Mesh(sphere, this.earthMaterial);
    this.earth.renderOrder = 0;

    this.cloudsMaterial = new THREE.ShaderMaterial({
      ...logDepth(earthVertex, cloudsFragment),
      uniforms: { uClouds: { value: this.blank }, uSun: { value: sun }, uOpacity: { value: 1 } },
      transparent: true,
      depthWrite: false,
    });
    this.clouds = new THREE.Mesh(sphere, this.cloudsMaterial);
    this.clouds.scale.setScalar(1.006);
    this.clouds.renderOrder = 1;

    this.atmosphereMaterial = new THREE.ShaderMaterial({
      ...logDepth(atmosphereVertex, atmosphereFragment),
      uniforms: { uSun: { value: sun }, uOuter: { value: ATMOSPHERE_OUTER } },
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.atmosphere = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), this.atmosphereMaterial);
    this.atmosphere.scale.setScalar(ATMOSPHERE_OUTER);
    this.atmosphere.renderOrder = 6;

    this.starsMaterial = new THREE.ShaderMaterial({
      ...logDepth(starsVertex, starsFragment),
      uniforms: { uPixelRatio: { value: pixelRatio }, uOpacity: { value: 1 } },
      transparent: true,
      depthWrite: false,
    });
    this.stars = new THREE.Points(makeStarsGeometry(5200, 3000), this.starsMaterial);
    this.stars.renderOrder = -1;
    this.stars.frustumCulled = false;
  }

  setSun(lat: number, lon: number) {
    const [x, y, z] = latLonToVec(lat, lon);
    (this.earthMaterial.uniforms.uSun.value as THREE.Vector3).set(x, y, z);
  }

  get sun(): THREE.Vector3 {
    return this.earthMaterial.uniforms.uSun.value;
  }

  setTexture(slot: "uDay" | "uNight" | "uWater" | "uClouds", texture: THREE.Texture) {
    const previous = this.earthMaterial.uniforms[slot].value as THREE.Texture;
    this.earthMaterial.uniforms[slot].value = texture;
    if (slot === "uClouds") this.cloudsMaterial.uniforms.uClouds.value = texture;
    if (previous !== this.blank) previous.dispose();
  }

  setCloudsOpacity(v: number) {
    this.earthMaterial.uniforms.uCloudsOn.value = v;
    this.cloudsMaterial.uniforms.uOpacity.value = v;
    this.clouds.visible = v > 0.01;
  }

  setLights(v: number) {
    this.earthMaterial.uniforms.uLights.value = v;
  }

  setStarsOpacity(v: number) {
    this.starsMaterial.uniforms.uOpacity.value = v;
  }

  /** Country borders and coastlines from quantised Natural Earth polylines. */
  setBorders(data: { borders: number[][]; coast: number[][] }) {
    const build = (lines: number[][], radius: number, opacity: number) => {
      const verts: number[] = [];
      for (const line of lines) {
        for (let i = 0; i + 3 < line.length; i += 2) {
          verts.push(...latLonToVec(line[i + 1] / 100, line[i] / 100, radius));
          verts.push(...latLonToVec(line[i + 3] / 100, line[i + 2] / 100, radius));
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
      const material = new THREE.LineBasicMaterial({ color: "#e9c77b", transparent: true, opacity, depthWrite: false });
      material.userData.baseOpacity = opacity;
      const lineSegments = new THREE.LineSegments(geometry, material);
      lineSegments.renderOrder = 1;
      return lineSegments;
    };
    this.borders.clear();
    this.borders.add(build(data.coast, 1.0012, 0.22), build(data.borders, 1.0014, 0.42));
  }

  setBordersOpacity(v: number) {
    this.borders.visible = v > 0.01;
    for (const child of this.borders.children) {
      const material = (child as THREE.LineSegments).material as THREE.LineBasicMaterial;
      material.opacity = material.userData.baseOpacity * v;
    }
  }

  dispose() {
    this.earth.geometry.dispose();
    this.earthMaterial.dispose();
    this.cloudsMaterial.dispose();
    this.atmosphere.geometry.dispose();
    this.atmosphereMaterial.dispose();
    this.stars.geometry.dispose();
    this.starsMaterial.dispose();
    for (const slot of ["uDay", "uNight", "uWater", "uClouds"]) (this.earthMaterial.uniforms[slot].value as THREE.Texture).dispose();
  }
}

/** Procedural sky: a few bright stars, many faint ones, a hint of the galactic band. */
export function makeStarsGeometry(count: number, radius: number) {
  const pos = new Float32Array(count * 3);
  const mag = new Float32Array(count);
  const color = new Float32Array(count * 3);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const tints = [
    [0.75, 0.82, 1.0],
    [1.0, 1.0, 1.0],
    [1.0, 0.93, 0.82],
    [1.0, 0.8, 0.62],
  ];
  for (let i = 0; i < count; i++) {
    let u = rand() * 2 - 1;
    const t = rand() * Math.PI * 2;
    // Bias a third of the stars toward a tilted band.
    if (i % 3 === 0) u = u * 0.18;
    const s = Math.sqrt(1 - u * u);
    const v = new THREE.Vector3(s * Math.cos(t), u, s * Math.sin(t)).applyAxisAngle(new THREE.Vector3(1, 0, 0.3).normalize(), 1.05);
    pos.set([v.x * radius, v.y * radius, v.z * radius], i * 3);
    mag[i] = Math.pow(rand(), 9);
    color.set(tints[Math.floor(rand() * tints.length)], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("aMag", new THREE.BufferAttribute(mag, 1));
  g.setAttribute("aColor", new THREE.BufferAttribute(color, 3));
  return g;
}

/** A ready-to-add star field for another scene. */
export function makeStars(count: number, radius: number): THREE.Points {
  const material = new THREE.ShaderMaterial({
    ...logDepth(starsVertex, starsFragment),
    uniforms: { uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) }, uOpacity: { value: 1 } },
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(makeStarsGeometry(count, radius), material);
  points.frustumCulled = false;
  points.renderOrder = -1;
  return points;
}
