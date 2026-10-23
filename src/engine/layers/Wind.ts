import * as THREE from "three";
import { logDepth } from "../shaders";

/** The streaks ride just above the cloud deck (1.006), so storms stay readable under the clouds. */
const SHELL = 1.0065;
/** A tail point is recorded this often, seconds; the tail spans SLICES of them. */
const CAPTURE = 0.05;

/**
 * Particle positions live in a texture, one texel per particle: x = longitude from 0° E as a fraction of
 * the turn, y = latitude from the south pole as a fraction of 180°. Each coordinate takes two 8-bit channels
 * (precision 1/65 025, about 600 m), so the simulation runs on any WebGL device, float targets or not.
 */
const POSITION = /* glsl */ `
  vec2 decodePos(vec4 c) {
    return vec2(c.r / 255.0 + c.b, c.g / 255.0 + c.a);
  }
  vec4 encodePos(vec2 p) {
    return vec4(fract(p * 255.0), floor(p * 255.0) / 255.0);
  }
`;

/** GFS 10 m wind on the 1° grid: R = east, G = north, ±uRange m/s; row 0 is 90° N, column 0 is 0° E. */
const WIND = /* glsl */ `
  uniform sampler2D uWind;
  uniform float uRange;
  vec2 windAt(vec2 p) {
    float lon = p.x * 360.0;
    float lat = p.y * 180.0 - 90.0;
    vec2 uv = vec2((lon + 0.5) / 360.0, (90.5 - lat) / 181.0);
    return (texture2D(uWind, uv).rg * 2.0 - 1.0) * uRange;
  }
`;

const quadVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const copyFragment = /* glsl */ `
  uniform sampler2D uSource;
  varying vec2 vUv;
  void main() {
    gl_FragColor = texture2D(uSource, vUv);
  }
`;

const stepFragment = /* glsl */ `
  ${POSITION}
  ${WIND}
  uniform sampler2D uState;
  uniform float uStep;
  uniform float uSeed;
  uniform float uDrop;
  uniform float uDropBump;
  varying vec2 vUv;

  float rand(vec2 co) {
    float t = dot(vec2(12.9898, 78.233), co);
    return fract(sin(t) * (4375.85453 + t));
  }

  void main() {
    vec2 p = decodePos(texture2D(uState, vUv));
    vec2 w = windAt(p);
    float speed = length(w);
    float lat = p.y * 180.0 - 90.0;
    // Degrees moved this frame; a degree of longitude shrinks toward the poles.
    vec2 d = vec2(w.x / max(cos(radians(lat)), 0.05), w.y) * uStep;
    vec2 q = vec2(fract(p.x + d.x / 360.0 + 1.0), p.y + d.y / 180.0);
    // Particles retire at random (sooner in strong wind, which keeps fast streams from clumping) and near the poles.
    vec2 seed = (p + vUv) * uSeed;
    float drop = step(1.0 - uDrop - speed * uDropBump, rand(seed));
    drop = max(drop, step(0.97, q.y) + step(q.y, 0.03));
    // Reborn anywhere, evenly over the sphere's area.
    vec2 born = vec2(rand(seed + 1.3), asin(rand(seed + 2.1) * 2.0 - 1.0) / 3.14159265 + 0.5);
    gl_FragColor = encodePos(clamp(mix(q, born, drop), 0.0, 0.99998));
  }
`;

/**
 * One instance per particle, one line segment per step back along its recent path: the newest from the
 * live position to the last recorded point, then from each recorded point to the one before it.
 */
const tailVertex = /* glsl */ `
  ${POSITION}
  ${WIND}
  attribute float aParticle;
  uniform sampler2D uCurrent;
  uniform sampler2D uHistory;
  uniform float uSide;
  uniform float uSlices;
  uniform float uHead;
  varying float vAlpha;
  varying float vSpeed;

  vec2 pointAt(vec2 st, float k) {
    if (k < 0.5) return decodePos(texture2D(uCurrent, st));
    float slice = mod(uHead - k + 1.0 + uSlices, uSlices);
    return decodePos(texture2D(uHistory, vec2(st.x, (slice + st.y) / uSlices)));
  }
  vec3 onSphere(vec2 p) {
    float lon = p.x * 6.2831853;
    float lat = (p.y - 0.5) * 3.14159265;
    return vec3(cos(lat) * cos(lon), sin(lat), -cos(lat) * sin(lon));
  }

  void main() {
    // position.x: which segment back along the tail; position.y: its near (0) or far (1) end.
    vec2 st = (vec2(mod(aParticle, uSide), floor(aParticle / uSide)) + 0.5) / uSide;
    // Most particles are behind the planet or off screen: test the head once and skip the whole tail.
    vec3 headDir = onSphere(pointAt(st, 0.0));
    vec4 head = projectionMatrix * viewMatrix * modelMatrix * vec4(headDir * ${SHELL}, 1.0);
    vec3 toCamera = cameraPosition - headDir;
    if (dot(headDir, toCamera) < -0.05 * length(toCamera) || any(greaterThan(abs(head.xy), vec2(head.w * 1.25)))) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vAlpha = 0.0;
      vSpeed = 0.0;
      return;
    }
    vec2 near = pointAt(st, position.x);
    vec3 a = onSphere(near);
    vec3 b = onSphere(pointAt(st, position.x + 1.0));
    // A rebirth leaves a gap of thousands of kilometres: no segment across it.
    vec3 p = position.y > 0.5 && dot(a, b) > 0.9986 ? b : a;
    vec4 world = modelMatrix * vec4(p * ${SHELL}, 1.0);
    vSpeed = length(windAt(near));
    // Bright at the head, gone at the end of the tail; thinned toward the limb, where tails bunch up edge-on.
    float along = 1.0 - (position.x + position.y) / uSlices;
    vAlpha = along * along * smoothstep(0.0, 0.3, dot(p, normalize(cameraPosition - world.xyz)));
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const tailFragment = /* glsl */ `
  uniform float uOpacity;
  varying float vAlpha;
  varying float vSpeed;
  void main() {
    // Calm air in cool silver, trades in white, gales in gold and storm-force wind in coral.
    vec3 c = mix(vec3(0.62, 0.76, 0.95), vec3(1.0), smoothstep(2.0, 9.0, vSpeed));
    c = mix(c, vec3(1.0, 0.82, 0.42), smoothstep(10.0, 17.0, vSpeed));
    c = mix(c, vec3(1.0, 0.42, 0.42), smoothstep(18.0, 26.0, vSpeed));
    float a = vAlpha * mix(0.3, 1.0, smoothstep(0.8, 7.0, vSpeed)) * uOpacity;
    gl_FragColor = vec4(c * a, a);
  }
`;

const veilVertex = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPosW = world.xyz;
    vNormalW = normalize(position);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const veilFragment = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    // A light shade under the streaks keeps them legible over bright desert and cloud.
    float facing = smoothstep(0.0, 0.35, dot(normalize(vNormalW), normalize(cameraPosition - vPosW)));
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.18 * uOpacity * facing);
  }
`;

export interface WindField {
  cycle: string;
  /** m/s that the 0…255 channel range spans each way. */
  range: number;
  width: number;
  height: number;
  /** RGBA pixels, row 0 at 90° N. */
  pixels: Uint8Array;
}

/**
 * The global wind as streaming particles, in the manner of earth.nullschool: tens of thousands of particles
 * advected through NOAA's GFS 10 m wind entirely on the GPU. Every few frames their positions are copied into
 * a ring of history slices, and each particle's tail is drawn from that history as real line segments on a
 * shell around the planet, so streaks stay sharp at any zoom and glued to the ground however the camera moves.
 */
export class Wind {
  readonly group = new THREE.Group();
  private side: number;
  private slices: number;
  private head = 0;
  private sinceCapture = 0;
  private current: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private history: THREE.WebGLRenderTarget;
  private windTexture: THREE.DataTexture | null = null;
  private seed: THREE.DataTexture;
  private camera = new THREE.Camera();
  private stepScene = new THREE.Scene();
  private copyScene = new THREE.Scene();
  private stepMaterial: THREE.ShaderMaterial;
  private copyMaterial: THREE.ShaderMaterial;
  private tailMaterial: THREE.ShaderMaterial;
  private veilMaterial: THREE.ShaderMaterial;
  private quad = new THREE.PlaneGeometry(2, 2);
  private tails: THREE.LineSegments;
  private veil: THREE.Mesh;
  /** Seeded into the targets before the first step. */
  private fresh = true;
  /** Was drawing last frame; tails restart from the current positions when it resumes. */
  private running = false;

  constructor(lite: boolean) {
    this.side = lite ? 96 : 192;
    this.slices = lite ? 12 : 16;
    const target = (height: number) =>
      new THREE.WebGLRenderTarget(this.side, height, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false });
    this.current = [target(this.side), target(this.side)];
    this.history = target(this.side * this.slices);
    this.history.scissorTest = true;

    // Starting positions, spread evenly over the sphere.
    const n = this.side * this.side;
    const seed = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const x = Math.random();
      const y = Math.asin(Math.random() * 2 - 1) / Math.PI + 0.5;
      for (const [k, v] of [[0, x], [1, y]] as const) {
        const hi = Math.floor(v * 255);
        seed[i * 4 + k] = Math.round((v * 255 - hi) * 255);
        seed[i * 4 + 2 + k] = hi;
      }
    }
    this.seed = new THREE.DataTexture(seed, this.side, this.side, THREE.RGBAFormat);
    this.seed.needsUpdate = true;

    // Shared by both programs, so one assignment updates the field everywhere.
    const windUniforms = { uWind: { value: null as THREE.Texture | null }, uRange: { value: 40 } };
    const pass = { blending: THREE.NoBlending, depthTest: false, depthWrite: false };
    this.stepMaterial = new THREE.ShaderMaterial({
      vertexShader: quadVertex,
      fragmentShader: stepFragment,
      uniforms: { ...windUniforms, uState: { value: null }, uStep: { value: 0 }, uSeed: { value: 0 }, uDrop: { value: 0 }, uDropBump: { value: 0 } },
      ...pass,
    });
    this.copyMaterial = new THREE.ShaderMaterial({ vertexShader: quadVertex, fragmentShader: copyFragment, uniforms: { uSource: { value: null } }, ...pass });
    for (const [scene, material] of [[this.stepScene, this.stepMaterial], [this.copyScene, this.copyMaterial]] as const) {
      const quad = new THREE.Mesh(this.quad, material);
      quad.frustumCulled = false;
      scene.add(quad);
    }

    // A template of the tail's segments, drawn once per particle.
    const ends = new Float32Array(this.slices * 2 * 3);
    for (let j = 0; j < this.slices; j++) {
      ends[j * 6] = j;
      ends[j * 6 + 3] = j;
      ends[j * 6 + 4] = 1;
    }
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(ends, 3));
    geometry.setAttribute("aParticle", new THREE.InstancedBufferAttribute(Float32Array.from({ length: n }, (_, i) => i), 1));
    geometry.instanceCount = n;
    this.tailMaterial = new THREE.ShaderMaterial({
      ...logDepth(tailVertex, tailFragment),
      uniforms: {
        ...windUniforms,
        uCurrent: { value: null },
        uHistory: { value: this.history.texture },
        uSide: { value: this.side },
        uSlices: { value: this.slices },
        uHead: { value: 0 },
        uOpacity: { value: 0 },
      },
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
    });
    this.tails = new THREE.LineSegments(geometry, this.tailMaterial);
    this.tails.frustumCulled = false;

    this.veilMaterial = new THREE.ShaderMaterial({ ...logDepth(veilVertex, veilFragment), uniforms: { uOpacity: { value: 0 } }, transparent: true, depthWrite: false });
    this.veil = new THREE.Mesh(new THREE.SphereGeometry(SHELL, lite ? 64 : 96, lite ? 32 : 48), this.veilMaterial);
    this.group.add(this.veil, this.tails);
    this.group.visible = false;
    // Over the clouds and tiles, under ships, aircraft, satellites and quakes; the shade first, then the streaks.
    this.veil.renderOrder = 1.4;
    this.tails.renderOrder = 1.5;
  }

  setField(field: WindField) {
    this.windTexture?.dispose();
    const texture = new THREE.DataTexture(field.pixels, field.width, field.height, THREE.RGBAFormat);
    texture.wrapS = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    this.windTexture = texture;
    this.stepMaterial.uniforms.uWind.value = texture;
    this.stepMaterial.uniforms.uRange.value = field.range;
  }

  private copy(renderer: THREE.WebGLRenderer, source: THREE.Texture, target: THREE.WebGLRenderTarget, slice = 0) {
    this.copyMaterial.uniforms.uSource.value = source;
    if (target === this.history) {
      target.viewport.set(0, slice * this.side, this.side, this.side);
      target.scissor.copy(target.viewport);
    }
    renderer.setRenderTarget(target);
    renderer.render(this.copyScene, this.camera);
  }

  /**
   * Advances the particles one frame and records a tail point when one is due. Runs only while the layer
   * shows; the opacity covers fading in and out with the camera distance.
   */
  update(renderer: THREE.WebGLRenderer, dt: number, opacity: number) {
    const shown = opacity > 0.01 && !!this.windTexture;
    this.group.visible = shown;
    this.tailMaterial.uniforms.uOpacity.value = opacity;
    this.veilMaterial.uniforms.uOpacity.value = opacity;
    if (!shown) {
      this.running = false;
      return;
    }
    const target = renderer.getRenderTarget();
    if (this.fresh) {
      this.copy(renderer, this.seed, this.current[0]);
      this.fresh = false;
    }
    if (!this.running) {
      // Fresh tails: every recorded point at the particle itself, so no segment has length yet.
      for (let s = 0; s < this.slices; s++) this.copy(renderer, this.current[0].texture, this.history, s);
      this.running = true;
    }
    const seconds = Math.min(dt, 1 / 20);
    const u = this.stepMaterial.uniforms;
    // 0.6° per second for each m/s: trade winds cross a continent in a few seconds of streaks.
    u.uStep.value = 0.6 * seconds;
    // A particle lives about five seconds in calm air, two in a gale.
    u.uDrop.value = 0.2 * seconds;
    u.uDropBump.value = 0.025 * seconds;
    u.uSeed.value = Math.random() + 0.5;
    u.uState.value = this.current[0].texture;
    renderer.setRenderTarget(this.current[1]);
    renderer.render(this.stepScene, this.camera);
    this.current.reverse();

    this.sinceCapture += seconds;
    if (this.sinceCapture >= CAPTURE) {
      this.sinceCapture = 0;
      this.head = (this.head + 1) % this.slices;
      this.copy(renderer, this.current[0].texture, this.history, this.head);
    }
    this.tailMaterial.uniforms.uCurrent.value = this.current[0].texture;
    this.tailMaterial.uniforms.uHead.value = this.head;
    renderer.setRenderTarget(target);
  }

  dispose() {
    for (const rt of [...this.current, this.history]) rt.dispose();
    this.windTexture?.dispose();
    this.seed.dispose();
    this.quad.dispose();
    this.tails.geometry.dispose();
    this.veil.geometry.dispose();
    for (const m of [this.stepMaterial, this.copyMaterial, this.tailMaterial, this.veilMaterial]) m.dispose();
  }
}
