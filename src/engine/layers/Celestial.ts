import * as THREE from "three";
import { logDepth } from "../shaders";
import { loadTexture, type UploadQueue } from "../textures";

/**
 * The real sky: 5,044 stars to magnitude 6 at their catalogue positions and
 * colours, the 88 constellation figures with their IAU names, and the Milky
 * Way from Gaia (NASA SVS Deep Star Maps). Everything is in the equatorial
 * frame (scene axes: y = celestial north, x = the March equinox), so in the
 * Earth scene it sits in the group that turns with sidereal time, and the
 * planets, the Moon and the Sun appear among the right stars.
 */

interface Figure {
  name: string;
  rank: number;
  label: [number, number];
  lines: [number, number][][];
}

let shared: Promise<{ stars: Float32Array; figures: Record<string, Figure> }> | null = null;
function loadCatalogue() {
  shared ??= Promise.all([
    fetch("/data/stars.bin").then((r) => {
      if (!r.ok) throw new Error(`stars ${r.status}`);
      return r.arrayBuffer();
    }),
    fetch("/data/constellations.json").then((r) => {
      if (!r.ok) throw new Error(`constellations ${r.status}`);
      return r.json() as Promise<Record<string, Figure>>;
    }),
  ]).then(([buf, figures]) => ({ stars: new Float32Array(buf), figures }));
  shared.catch(() => (shared = null));
  return shared;
}

/** Scene direction of a right ascension and declination (radians). */
function sky(ra: number, dec: number, r: number): [number, number, number] {
  const c = Math.cos(dec);
  return [r * c * Math.cos(ra), r * Math.sin(dec), -r * c * Math.sin(ra)];
}

const starVertex = /* glsl */ `
  attribute float aBright;
  attribute vec3 aColor;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vBright;
  void main() {
    vColor = aColor;
    vBright = aBright;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (1.5 + aBright * 4.2) * uPixelRatio;
  }
`;
const starFragment = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vBright;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float core = smoothstep(0.5, 0.0, d);
    float a = core * (0.55 + vBright * 0.45);
    gl_FragColor = vec4(vColor * (0.8 + vBright * 1.8), a * uOpacity);
  }
`;

const milkyVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const milkyFragment = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uIntensity;
  varying vec3 vDir;
  const float PI = 3.141592653589793;
  void main() {
    // Scene axes back to equatorial: x → equinox, y → RA 6h, z → north.
    vec3 e = normalize(vec3(vDir.x, -vDir.z, vDir.y));
    float ra = atan(e.y, e.x);
    float dec = asin(clamp(e.z, -1.0, 1.0));
    // The map has RA 0 at the centre, increasing to the left.
    vec2 uv = vec2(fract(0.5 - ra / (2.0 * PI)), 0.5 + dec / PI);
    vec3 c = texture2D(uMap, uv).rgb;
    // Drop the haze floor so the sky between the arms stays black.
    c = max(c - vec3(0.09), 0.0) * 1.4;
    gl_FragColor = vec4(c * uIntensity, 1.0);
    #include <colorspace_fragment>
  }
`;

export class Celestial {
  readonly group = new THREE.Group();
  private stars: THREE.Points;
  private starMaterial: THREE.ShaderMaterial;
  private figures: THREE.LineSegments;
  private figureMaterial = new THREE.LineBasicMaterial({ color: "#8ccbff", transparent: true, opacity: 0.2, depthWrite: false });
  private labels = new THREE.Group();
  private milky: THREE.Mesh;
  private milkyMaterial: THREE.ShaderMaterial;
  private labelOpacity = 0;

  constructor(
    private radius: number,
    pixelRatio: number,
  ) {
    this.starMaterial = new THREE.ShaderMaterial({
      ...logDepth(starVertex, starFragment),
      uniforms: { uPixelRatio: { value: pixelRatio }, uOpacity: { value: 1 } },
      transparent: true,
      depthWrite: false,
    });
    this.stars = new THREE.Points(new THREE.BufferGeometry(), this.starMaterial);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -1;

    this.figures = new THREE.LineSegments(new THREE.BufferGeometry(), this.figureMaterial);
    this.figures.frustumCulled = false;
    this.figures.renderOrder = -1;

    this.milkyMaterial = new THREE.ShaderMaterial({
      ...logDepth(milkyVertex, milkyFragment),
      uniforms: { uMap: { value: null }, uIntensity: { value: 0.8 } },
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.milky = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.02, 64, 32), this.milkyMaterial);
    this.milky.frustumCulled = false;
    this.milky.renderOrder = -2;
    this.milky.visible = false;

    this.group.add(this.milky, this.stars, this.figures, this.labels);
  }

  async load(milkyWay: "2k" | "4k", uploads: UploadQueue) {
    const { stars, figures } = await loadCatalogue();
    const n = stars.length / 4;
    const pos = new Float32Array(n * 3);
    const bright = new Float32Array(n);
    const color = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos.set(sky(stars[i * 4], stars[i * 4 + 1], this.radius), i * 3);
      bright[i] = stars[i * 4 + 2];
      const rgb = stars[i * 4 + 3];
      color.set([((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255], i * 3);
    }
    const g = this.stars.geometry;
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aBright", new THREE.BufferAttribute(bright, 1));
    g.setAttribute("aColor", new THREE.BufferAttribute(color, 3));

    const segs: number[] = [];
    const deg = Math.PI / 180;
    const r = this.radius * 0.995;
    for (const f of Object.values(figures)) {
      for (const line of f.lines) {
        for (let i = 0; i + 1 < line.length; i++) {
          segs.push(...sky(line[i][0] * deg, line[i][1] * deg, r), ...sky(line[i + 1][0] * deg, line[i + 1][1] * deg, r));
        }
      }
      this.labels.add(this.makeLabel(f.name, sky(f.label[0] * deg, f.label[1] * deg, r)));
    }
    this.figures.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(segs), 3));

    const texture = await loadTexture(`/textures/milkyway-${milkyWay}.jpg`);
    texture.colorSpace = THREE.SRGBColorSpace;
    // No mipmaps: the map is magnified on screen anyway, and this keeps the RA seam invisible.
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.wrapS = THREE.RepeatWrapping;
    uploads.push(texture, () => {
      this.milkyMaterial.uniforms.uMap.value = texture;
      this.milky.visible = true;
    });
  }

  /** A constellation name, drawn once into a small texture and kept a fixed size on screen. */
  private makeLabel(text: string, at: [number, number, number]): THREE.Sprite {
    const canvas = document.createElement("canvas");
    const h = 48;
    const ctx = canvas.getContext("2d")!;
    ctx.font = `500 ${h * 0.5}px ui-sans-serif, system-ui, sans-serif`;
    canvas.width = Math.ceil(ctx.measureText(text).width + 16);
    canvas.height = h;
    ctx.font = `500 ${h * 0.5}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = "rgba(160, 200, 240, 1)";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 8, h / 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, sizeAttenuation: false, opacity: 0 }));
    // With size attenuation off, scale is in units at distance 1: about 16 px tall on a 900 px view.
    const height = 0.013;
    sprite.scale.set((height * canvas.width) / canvas.height, height, 1);
    sprite.position.set(...at);
    sprite.renderOrder = -1;
    return sprite;
  }

  /** Stars always; figures and names by the layer switch, scaled by how much sky is in view. */
  setOpacity(stars: number, figures: number, milkyWay = 0.8) {
    this.starMaterial.uniforms.uOpacity.value = stars;
    this.milkyMaterial.uniforms.uIntensity.value = milkyWay * stars;
    this.figureMaterial.opacity = 0.2 * figures;
    this.figures.visible = figures > 0.01;
    if (Math.abs(figures - this.labelOpacity) > 0.005) {
      this.labelOpacity = figures;
      for (const s of this.labels.children) ((s as THREE.Sprite).material as THREE.SpriteMaterial).opacity = 0.75 * figures;
      this.labels.visible = figures > 0.01;
    }
  }

  dispose() {
    this.stars.geometry.dispose();
    this.starMaterial.dispose();
    this.figures.geometry.dispose();
    this.figureMaterial.dispose();
    this.milky.geometry.dispose();
    (this.milkyMaterial.uniforms.uMap.value as THREE.Texture | null)?.dispose();
    this.milkyMaterial.dispose();
    for (const s of this.labels.children) {
      const m = (s as THREE.Sprite).material as THREE.SpriteMaterial;
      m.map?.dispose();
      m.dispose();
    }
  }
}
