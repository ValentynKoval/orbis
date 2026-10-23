import * as THREE from "three";
import { latLonToVec } from "@/lib/geo";
import {
  atmosphereFragment,
  atmosphereVertex,
  cloudsFragment,
  earthFragment,
  earthVertex,
  logDepth,
} from "../shaders";

/** Top of the atmosphere: 100 km, where the scattering has faded to nothing. */
const ATMOSPHERE_OUTER = 1 + 100 / 6371;

/** The Earth itself: surface, clouds, atmosphere halo, borders, and the star field around it. */
export class Planet {
  /** The Moon's Earth-fixed position (Earth radii), shared by the surface and cloud shaders for solar eclipses. */
  readonly moon = new THREE.Vector3(0, 0, 1e6);
  readonly earth: THREE.Mesh;
  readonly clouds: THREE.Mesh;
  readonly atmosphere: THREE.Mesh;
  readonly borders = new THREE.Group();
  readonly earthMaterial: THREE.ShaderMaterial;
  readonly cloudsMaterial: THREE.ShaderMaterial;
  private atmosphereMaterial: THREE.ShaderMaterial;
  private blank: THREE.DataTexture;

  constructor(segments: number, lite = false) {
    this.blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.blank.needsUpdate = true;
    const sun = new THREE.Vector3(1, 0, 0);
    // Far away until the Moon layer reports in, so no eclipse is drawn by accident.

    const sphere = new THREE.SphereGeometry(1, segments, segments / 2);
    const earthShaders = logDepth(earthVertex, earthFragment);
    this.earthMaterial = new THREE.ShaderMaterial({
      ...earthShaders,
      // Imagery tiles at low zoom levels are coarser polyhedra than this sphere, and the two surfaces cross in rows
      // of facets that would show as dark arcs. This sphere's depth sits 0.2% further back, so wherever a tile is
      // drawn the tile wins; nothing else is near enough behind the surface to notice.
      vertexShader: earthShaders.vertexShader.replace(/\}\s*$/, "  #ifdef USE_LOGARITHMIC_DEPTH_BUFFER\n    vFragDepth *= 1.002;\n  #endif\n}\n"),
      uniforms: {
        uDay: { value: this.blank },
        uNight: { value: this.blank },
        uWater: { value: this.blank },
        uClouds: { value: this.blank },
        uSun: { value: sun },
        uMoon: { value: this.moon },
        uCloudsOn: { value: 1 },
        uLights: { value: 1 },
      },
    });
    this.earth = new THREE.Mesh(sphere, this.earthMaterial);
    this.earth.renderOrder = 0;

    this.cloudsMaterial = new THREE.ShaderMaterial({
      ...logDepth(earthVertex, cloudsFragment),
      uniforms: { uClouds: { value: this.blank }, uSun: { value: sun }, uMoon: { value: this.moon }, uOpacity: { value: 1 } },
      transparent: true,
      depthWrite: false,
    });
    this.clouds = new THREE.Mesh(sphere, this.cloudsMaterial);
    this.clouds.scale.setScalar(1.006);
    this.clouds.renderOrder = 1;

    // uIntensity is the Sun's irradiance in the surface shader's units: it draws sunlit ground as albedo × 1.35 × cos,
    // a radiance of E/π, so E ≈ 1.35π. Sky and ground then keep their real proportions.
    this.atmosphereMaterial = new THREE.ShaderMaterial({
      ...logDepth(atmosphereVertex, atmosphereFragment),
      uniforms: { uSun: { value: sun }, uOuter: { value: ATMOSPHERE_OUTER }, uIntensity: { value: 4.5 } },
      defines: lite ? { STEPS: 8, LIGHT_STEPS: 3 } : {},
      side: THREE.BackSide,
      transparent: true,
      // The ground is found in the shader, so the haze also lies over the planet's disc.
      depthTest: false,
      depthWrite: false,
      // In-scattered light comes premultiplied; alpha is what the air hides of the scene behind it.
      premultipliedAlpha: true,
    });
    this.atmosphere = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), this.atmosphereMaterial);
    this.atmosphere.scale.setScalar(ATMOSPHERE_OUTER);
    // Over the ground, imagery, clouds and wind streaks; under the markers, which stay crisp at any angle.
    this.atmosphere.renderOrder = 1.8;
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
    for (const slot of ["uDay", "uNight", "uWater", "uClouds"]) (this.earthMaterial.uniforms[slot].value as THREE.Texture).dispose();
  }
}
