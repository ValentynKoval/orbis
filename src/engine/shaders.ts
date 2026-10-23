/**
 * GLSL for the planet and its overlays. Written GLSL1-style; three.js
 * translates it for WebGL2. Every fragment shader that outputs colour ends
 * with the tone-mapping and colour-space chunks so it matches the renderer.
 */

/**
 * The renderer uses a logarithmic depth buffer (the camera ranges from a few
 * hundred metres above the ground to beyond the Moon); every custom material
 * needs three.js's chunks for it.
 */
export function logDepth(vertexShader: string, fragmentShader: string): { vertexShader: string; fragmentShader: string } {
  const v = vertexShader.trimEnd();
  const closing = v.lastIndexOf("}");
  return {
    vertexShader: "#include <common>\n#include <logdepthbuf_pars_vertex>\n" + v.slice(0, closing) + "  #include <logdepthbuf_vertex>\n" + v.slice(closing),
    fragmentShader:
      "#include <logdepthbuf_pars_fragment>\n" + fragmentShader.replace("void main() {", "void main() {\n    #include <logdepthbuf_fragment>"),
  };
}

const NOISE = /* glsl */ `
  float hash2(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float hash3(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  // Value noise over 3D space: on a sphere it has no seam and no pinching at the poles.
  float noise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    vec2 e = vec2(1.0, 0.0);
    float lo = mix(mix(hash3(i), hash3(i + e.xyy), f.x), mix(hash3(i + e.yxy), hash3(i + e.xxy), f.x), f.y);
    float hi = mix(mix(hash3(i + e.yyx), hash3(i + e.xyx), f.x), mix(hash3(i + e.yxx), hash3(i + e.xxx), f.x), f.y);
    return mix(lo, hi, f.z);
  }
`;

const SURFACE_BASIS = /* glsl */ `
  // Local east/north unit vectors on the sphere, in scene axes (see lib/geo.ts).
  void surfaceBasis(vec3 n, out vec3 east, out vec3 north, out float lat) {
    lat = asin(clamp(n.y, -1.0, 1.0));
    float lon = atan(-n.z, n.x);
    east = vec3(-sin(lon), 0.0, -cos(lon));
    north = vec3(-sin(lat) * cos(lon), cos(lat), sin(lat) * sin(lon));
  }
`;

export const earthVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPosW = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const ECLIPSE = /* glsl */ `
  // Solar eclipse: the share of the Sun's disc the Moon hides from a point on the Earth (Earth radii, Earth-fixed).
  uniform vec3 uMoon;
  float sunVisible(vec3 p) {
    vec3 tm = uMoon - p;
    float dm = length(tm);
    if (dm < 1e-3) return 1.0;
    vec3 dir = tm / dm;
    if (dot(dir, uSun) <= 0.0) return 1.0;
    float rm = 0.27272 / dm;
    const float rs = 0.004653;
    float d = asin(min(length(cross(dir, uSun)), 1.0));
    if (d >= rs + rm) return 1.0;
    float cover;
    if (d <= abs(rm - rs)) {
      cover = rm >= rs ? 1.0 : (rm * rm) / (rs * rs);
    } else {
      float a = rs * rs * acos(clamp((d * d + rs * rs - rm * rm) / (2.0 * d * rs), -1.0, 1.0));
      float b = rm * rm * acos(clamp((d * d + rm * rm - rs * rs) / (2.0 * d * rm), -1.0, 1.0));
      float c = 0.5 * sqrt(max((-d + rs + rm) * (d + rs - rm) * (d - rs + rm) * (d + rs + rm), 0.0));
      cover = (a + b - c) / (3.14159265 * rs * rs);
    }
    return 1.0 - clamp(cover, 0.0, 1.0);
  }
`;

export const earthFragment = /* glsl */ `
  uniform sampler2D uDay;
  uniform sampler2D uNight;
  uniform sampler2D uWater;
  uniform sampler2D uClouds;
  uniform vec3 uSun;
  uniform float uCloudsOn;
  uniform float uLights;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  ${SURFACE_BASIS}
  ${ECLIPSE}

  void main() {
    vec3 n = normalize(vNormalW);
    vec3 v = normalize(cameraPosition - vPosW);
    float sunlight = sunVisible(normalize(vPosW));
    float ndl = dot(n, uSun);
    float day = smoothstep(-0.08, 0.22, ndl);
    float twilight = smoothstep(-0.22, 0.0, ndl) * (1.0 - smoothstep(0.0, 0.3, ndl));

    vec3 albedo = texture2D(uDay, vUv).rgb;
    float water = texture2D(uWater, vUv).r;
    float cloud = texture2D(uClouds, vUv).r * uCloudsOn;

    // Cloud shadows: look up the cloud that sits between this point and the Sun.
    vec3 east; vec3 north; float lat;
    surfaceBasis(n, east, north, lat);
    vec2 sunT = vec2(dot(uSun, east), dot(uSun, north));
    vec2 offset = sunT * vec2(0.5 / max(cos(lat), 0.15), 1.0) * 0.0021;
    float shadow = texture2D(uClouds, vUv + offset).r * uCloudsOn;

    // Oceans read deeper and slightly bluer than the Blue Marble original.
    albedo = mix(albedo, albedo * vec3(0.55, 0.75, 1.05), water * 0.6);
    // Close to the ground the night side gets a soft ambient so streets stay readable, and the
    // 10 km-per-texel city-lights map, which would smear into a blob, fades out.
    float close = 1.0 - smoothstep(1.02, 1.45, length(cameraPosition));
    vec3 lit = albedo * (max(ndl, 0.0) * 1.35 * sunlight + mix(0.012, 0.32, close)) * (1.0 - 0.5 * shadow);
    lit += albedo * vec3(1.0, 0.42, 0.12) * twilight * 0.22 * sunlight;

    // Sun glint on open water.
    vec3 h = normalize(uSun + v);
    float spec = pow(max(dot(n, h), 0.0), 320.0) * 0.7 + pow(max(dot(n, h), 0.0), 60.0) * 0.02;
    lit += vec3(1.0, 0.86, 0.68) * spec * water * day * (1.0 - cloud) * sunlight;

    // City lights: Black Marble luminance, sodium-warm, dimmed by cloud cover.
    float lights = texture2D(uNight, vUv).r;
    lights = pow(lights, 2.4) * 3.2;
    vec3 night = vec3(1.0, 0.68, 0.36) * lights * max(1.0 - day, 1.0 - sunlight) * uLights * (1.0 - 0.75 * cloud) * (1.0 - 0.9 * close);

    // Thin atmosphere seen through the limb.
    float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    vec3 sky = mix(vec3(0.28, 0.52, 1.0), vec3(1.0, 0.48, 0.18), twilight);
    // The limb glow now comes from the scattering pass; keep only a whisper so the edge never looks cut out.
    vec3 atmosphere = sky * rim * smoothstep(-0.3, 0.35, ndl) * 0.15 * sunlight;

    gl_FragColor = vec4(lit + night + atmosphere, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export const cloudsFragment = /* glsl */ `
  ${NOISE}
  uniform sampler2D uClouds;
  uniform vec3 uSun;
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  ${ECLIPSE}

  void main() {
    vec3 n = normalize(vNormalW);
    vec3 v = normalize(cameraPosition - vPosW);
    float ndl = dot(n, uSun);
    float sunlight = sunVisible(normalize(vPosW));
    float mask = texture2D(uClouds, vUv).r;
    // Break the mask's soft edges with value noise so clouds read as texture rather than blur.
    vec3 dir = normalize(vPosW);
    float detail = noise3(dir * 223.0) * 0.6 + noise3(dir * 493.0) * 0.4;
    float edge = mask * (1.0 - mask) * 4.0;
    mask = clamp(mask + (detail - 0.5) * 0.35 * edge, 0.0, 1.0);
    float density = pow(smoothstep(0.08, 1.0, mask), 1.6) * 0.82;
    // Thin the deck as the camera descends, and remove it once the camera is below cloud height.
    float camDist = length(cameraPosition);
    density *= smoothstep(1.012, 1.09, camDist) * mix(0.5, 1.0, smoothstep(1.3, 3.0, camDist));
    float twilight = smoothstep(-0.22, 0.0, ndl) * (1.0 - smoothstep(0.0, 0.3, ndl));
    vec3 color = vec3(1.0) * (max(ndl, 0.0) * 1.15 * sunlight + 0.035);
    color += vec3(1.0, 0.45, 0.2) * twilight * 0.35 * sunlight;
    // Clouds thicken toward the limb, as they do in orbital photos.
    float limb = 1.0 + pow(1.0 - max(dot(n, v), 0.0), 2.0) * 0.35;
    float alpha = density * uOpacity * mix(0.35, 0.95, smoothstep(-0.25, 0.15, ndl)) * limb;
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Back-face shell; brightness follows the closest approach of each view ray to the planet. */
export const atmosphereVertex = /* glsl */ `
  varying vec3 vPosW;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPosW = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

/**
 * The atmosphere, ray-marched: Rayleigh and Mie single scattering (Earth radii as the unit, real scale
 * heights and coefficients). From orbit it draws the thin blue limb and the haze over the disc; from a
 * leaning camera near the ground, a blue sky that pales toward the horizon; at the terminator, sunset
 * colours. Additive, over everything drawn before it, with the ground found analytically.
 */
export const atmosphereFragment = /* glsl */ `
  uniform vec3 uSun;
  uniform float uOuter;
  uniform float uIntensity;
  varying vec3 vPosW;
  #ifndef STEPS
  #define STEPS 12
  #endif
  #ifndef LIGHT_STEPS
  #define LIGHT_STEPS 5
  #endif
  const vec3 BETA_R = vec3(36.95, 86.0, 210.9);
  const float BETA_M = 133.8;
  const float H_R = 0.00125;
  const float H_M = 0.00019;
  const float G = 0.76;
  const float PI = 3.14159265;

  vec2 sphere(vec3 o, vec3 d, float r) {
    float b = dot(o, d);
    float c = dot(o, o) - r * r;
    float h = b * b - c;
    if (h < 0.0) return vec2(1e9, -1e9);
    h = sqrt(h);
    return vec2(-b - h, -b + h);
  }

  void main() {
    vec3 o = cameraPosition;
    vec3 d = normalize(vPosW - o);
    vec2 a = sphere(o, d, uOuter);
    float t0 = max(a.x, 0.0);
    float t1 = a.y;
    vec2 g = sphere(o, d, 1.0);
    if (g.x < g.y && g.x > 0.0) t1 = min(t1, g.x);
    if (t1 <= t0) discard;
    float seg = (t1 - t0) / float(STEPS);
    vec3 sumR = vec3(0.0);
    vec3 sumM = vec3(0.0);
    float odR = 0.0;
    float odM = 0.0;
    // Interleaved-gradient jitter of the sample points (along the view and toward the Sun) turns the steps'
    // banding, which near the terminator would draw arcs across the land, into fine, invisible grain.
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    for (int i = 0; i < STEPS; i++) {
      vec3 p = o + d * (t0 + seg * (float(i) + jitter));
      float h = max(length(p) - 1.0, 0.0);
      float dR = exp(-h / H_R) * seg;
      float dM = exp(-h / H_M) * seg;
      odR += dR;
      odM += dM;
      // In the Earth's shadow no sunlight reaches this sample.
      vec2 ground = sphere(p, uSun, 1.0);
      if (ground.x < ground.y && ground.x > 0.0) continue;
      float ls = sphere(p, uSun, uOuter).y / float(LIGHT_STEPS);
      float lR = 0.0;
      float lM = 0.0;
      for (int j = 0; j < LIGHT_STEPS; j++) {
        float hq = max(length(p + uSun * ls * (float(j) + jitter)) - 1.0, 0.0);
        lR += exp(-hq / H_R) * ls;
        lM += exp(-hq / H_M) * ls;
      }
      vec3 att = exp(-(BETA_R * (odR + lR) + BETA_M * 1.1 * (odM + lM)));
      sumR += att * dR;
      sumM += att * dM;
    }
    float mu = dot(d, uSun);
    float phaseR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
    float phaseM = 3.0 / (8.0 * PI) * ((1.0 - G * G) * (1.0 + mu * mu)) / ((2.0 + G * G) * pow(1.0 + G * G - 2.0 * G * mu, 1.5));
    vec3 color = uIntensity * (sumR * BETA_R * phaseR + sumM * BETA_M * phaseM);
    // Whatever lies behind is seen through the air, dimmed by the path's transmittance. The frame is already
    // display-encoded, where adding light would wash a sunlit desert out; so the air is laid on as a veil of
    // its own colour (the in-scatter a fully hazed path would reach), as opaque as the share of light it hides.
    vec3 transmittance = exp(-(BETA_R * odR + BETA_M * 1.1 * odM));
    float veil = clamp(1.0 - dot(transmittance, vec3(1.0 / 3.0)), 0.0, 1.0);
    gl_FragColor = vec4(color / max(veil, 1e-3), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    gl_FragColor = vec4(gl_FragColor.rgb * veil, veil);
  }
`;

export const satellitesVertex = /* glsl */ `
  attribute vec3 aVel;
  attribute float aGroup;
  uniform float uDt;
  uniform float uPixelRatio;
  uniform float uSelected;
  uniform vec3 uColors[7];
  uniform float uSizes[7];
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec3 p = position;
    float r2 = dot(p, p);
    vec3 h = cross(p, aVel);
    float hl = length(h);
    if (hl > 0.0 && r2 > 0.0) {
      vec3 k = h / hl;
      float a = hl / r2 * uDt;
      float c = cos(a);
      float s = sin(a);
      p = p * c + cross(k, p) * s + k * dot(k, p) * (1.0 - c);
    }
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    int g = int(aGroup + 0.5);
    bool selected = abs(float(gl_VertexID) - uSelected) < 0.5;
    vColor = selected ? vec3(1.0, 0.82, 0.42) : uColors[g];
    vAlpha = g == 1 ? 0.6 : 1.0;
    float zoom = clamp(3.2 / -mv.z, 0.7, 1.5);
    gl_PointSize = r2 < 0.5 ? 0.0 : (selected ? 9.0 : uSizes[g]) * uPixelRatio * zoom;
  }
`;

export const satellitesFragment = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.18, d);
    if (a <= 0.0) discard;
    gl_FragColor = vec4(vColor, a * vAlpha * uOpacity);
    #include <colorspace_fragment>
  }
`;

export const quakesVertex = /* glsl */ `
  attribute vec3 iPos;
  attribute float iMag;
  attribute float iTime;
  attribute float iDepth;
  uniform float uNow;
  uniform float uZoom;
  varying vec2 vUv;
  varying float vAge;
  varying float vMag;
  varying float vDepth;
  void main() {
    vUv = uv;
    vAge = (uNow - iTime) / 3600.0;
    vMag = iMag;
    vDepth = iDepth;
    vec3 n = normalize(iPos);
    vec3 t = normalize(cross(abs(n.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0), n));
    vec3 b = cross(n, t);
    float size = (0.004 + 0.0032 * pow(1.65, iMag)) * uZoom;
    vec3 p = n * 1.0025 + (t * position.x + b * position.y) * size * 2.0;
    if (vAge < 0.0) p = vec3(0.0);
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(p, 1.0);
  }
`;

export const quakesFragment = /* glsl */ `
  uniform float uClock;
  uniform float uOpacity;
  varying vec2 vUv;
  varying float vAge;
  varying float vMag;
  varying float vDepth;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    if (r > 1.0) discard;
    float fresh = exp(-vAge / 8.0);
    vec3 shallow = vec3(1.0, 0.31, 0.43);
    vec3 mid = vec3(0.84, 0.36, 1.0);
    vec3 deep = vec3(0.56, 0.48, 1.0);
    vec3 color = vDepth < 70.0 ? shallow : (vDepth < 300.0 ? mid : deep);
    float core = smoothstep(0.2, 0.08, r);
    float speed = 0.22 + 0.06 * vMag;
    float wave = fract(r * 1.4 - uClock * speed);
    float rings = smoothstep(0.0, 0.06, wave) * smoothstep(0.22, 0.06, wave) * (1.0 - r);
    float outline = smoothstep(0.03, 0.0, abs(r - 0.5)) * 0.35;
    float a = core * (0.55 + 0.45 * fresh) + rings * (0.15 + 0.85 * fresh) + outline * fresh;
    gl_FragColor = vec4(color * (1.0 + core), a * uOpacity);
    #include <colorspace_fragment>
  }
`;

export const firesVertex = /* glsl */ `
  attribute float aFrp;
  attribute float aTime;
  uniform float uNow;
  uniform float uPixelRatio;
  uniform float uClock;
  varying float vHeat;
  varying float vFresh;
  void main() {
    float age = (uNow - aTime) / 3600.0;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    vHeat = clamp(log2(1.0 + aFrp) / 9.0, 0.0, 1.0);
    vFresh = exp(-max(age, 0.0) / 10.0);
    float flicker = 0.85 + 0.15 * sin(uClock * 7.0 + float(gl_VertexID) * 1.7);
    float zoom = clamp(2.6 / -mv.z, 0.45, 3.5);
    gl_PointSize = age < 0.0 ? 0.0 : (1.4 + vHeat * 5.0) * flicker * zoom * uPixelRatio;
  }
`;

export const firesFragment = /* glsl */ `
  uniform float uOpacity;
  varying float vHeat;
  varying float vFresh;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    vec3 ember = mix(vec3(0.9, 0.1, 0.02), vec3(1.0, 0.38, 0.06), vHeat);
    ember = mix(ember, vec3(1.0, 0.8, 0.5), smoothstep(0.12, 0.0, d) * vHeat * vHeat);
    gl_FragColor = vec4(ember * a, a * (0.3 + 0.5 * vFresh) * uOpacity);
    #include <colorspace_fragment>
  }
`;

/** Screen-space selection reticle: a ring with four ticks. */
export const reticleVertex = /* glsl */ `
  uniform float uPixelRatio;
  uniform float uSize;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * uPixelRatio;
  }
`;

export const reticleFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uClock;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float r = length(p) * 2.0;
    float ring = smoothstep(0.05, 0.0, abs(r - 0.72));
    float ang = atan(p.y, p.x) + uClock * 0.6;
    float ticks = step(0.92, abs(cos(ang * 2.0))) * smoothstep(0.06, 0.0, abs(r - 0.9));
    float a = max(ring * 0.9, ticks);
    if (a <= 0.01) discard;
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }
`;

/**
 * The reticle for a spot on the ground, drawn on a quad that lies on the terrain: seen at an angle it is an
 * ellipse in perspective. Its depth is pulled toward the camera by a few percent, so a slope under the ring or
 * the ring's own tilt never cuts it, while a ridge in front of it still hides it.
 */
export const groundReticleVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const groundReticleFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uClock;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv - 0.5;
    float r = length(p) * 2.0;
    float aa = max(fwidth(r), 1e-4) * 1.2;
    float ring = 1.0 - smoothstep(0.035, 0.035 + aa, abs(r - 0.72));
    float ang = atan(p.y, p.x) + uClock * 0.6;
    float ticks = step(0.92, abs(cos(ang * 2.0))) * (1.0 - smoothstep(0.05, 0.05 + aa, abs(r - 0.9)));
    float centre = 1.0 - smoothstep(0.07, 0.07 + aa, r);
    // A faint disc marks the ground the ring stands for.
    float fill = (1.0 - smoothstep(0.7, 0.72, r)) * 0.16;
    float a = max(max(ring * 0.95, ticks), max(centre, fill)) * uOpacity;
    if (a <= 0.01) discard;
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
    #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
      gl_FragDepth = log2(1.0 + (vFragDepth - 1.0) * 0.96) * logDepthBufFC * 0.5;
    #endif
  }
`;

/** Aircraft and ships: instanced icons moving along great circles (see lib/geo.ts#moveAlong). */
export const moversVertex = (kinds: number) => /* glsl */ `
  attribute vec2 iLatLon;
  attribute float iT0;
  attribute vec2 iMotion;
  attribute float iAlt;
  attribute float iKind;
  attribute vec3 iFrom;
  uniform float uNow;
  uniform float uSwitch;
  uniform float uBlend;
  uniform float uMaxDt;
  uniform float uSize;
  uniform float uSelected;
  uniform float uMinAlt;
  uniform float uAltColor;
  uniform vec3 uColors[${kinds}];
  uniform float uKindOn[${kinds}];
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vSelected;

  void main() {
    vUv = uv;
    int kind = int(iKind + 0.5);
    float lat = iLatLon.x;
    float lon = iLatLon.y;
    vec3 p0 = vec3(cos(lat) * cos(lon), sin(lat), -cos(lat) * sin(lon));
    vec3 east = vec3(-sin(lon), 0.0, -cos(lon));
    vec3 north = vec3(-sin(lat) * cos(lon), cos(lat), sin(lat) * sin(lon));
    vec3 dir = north * cos(iMotion.y) + east * sin(iMotion.y);
    float a = iMotion.x * clamp(uNow - iT0, 0.0, uMaxDt);
    vec3 pos = (p0 * cos(a) + dir * sin(a)) * (1.0 + iAlt);
    vec3 fwd = normalize(-p0 * sin(a) + dir * cos(a));
    float blend = clamp((uNow - uSwitch) / uBlend, 0.0, 1.0);
    blend = blend * blend * (3.0 - 2.0 * blend);
    if (dot(iFrom, iFrom) > 0.5) pos = mix(iFrom, pos, blend);

    bool selected = abs(float(gl_InstanceID) - uSelected) < 0.5;
    bool hidden = uKindOn[kind] < 0.5 || iAlt < uMinAlt;
    vSelected = selected ? 1.0 : 0.0;
    vec3 color = uColors[kind];
    // Aircraft: warm white at cruise, amber close to the ground.
    if (uAltColor > 0.5 && kind == 0) color = mix(vec3(1.0, 0.72, 0.36), color, smoothstep(0.0008, 0.006, iAlt));
    vColor = selected ? vec3(1.0, 0.82, 0.42) : color;

    vec3 n = normalize(pos);
    vec3 side = normalize(cross(fwd, n));
    float size = uSize * length(cameraPosition - pos) * (selected ? 1.7 : 1.0);
    vec3 world = pos + (side * position.x + fwd * position.y) * size;
    gl_Position = hidden && !selected ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

export const moversFragment = (icon: "plane" | "ship") => /* glsl */ `
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vSelected;

  float box(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  }

  void main() {
    vec2 p = vUv - 0.5;
    float d;
    ${
      icon === "plane"
        ? `
    // Fuselage, swept wings, tailplane.
    float fuselage = box(p - vec2(0.0, 0.0), vec2(0.045, 0.42)) - 0.02;
    vec2 w = vec2(abs(p.x), p.y + abs(p.x) * 0.55 - 0.06);
    float wings = box(w - vec2(0.2, 0.0), vec2(0.26, 0.045));
    vec2 tl = vec2(abs(p.x), p.y + abs(p.x) * 0.45 + 0.34);
    float tail = box(tl - vec2(0.08, 0.0), vec2(0.11, 0.03));
    d = min(fuselage, min(wings, tail));`
        : `
    // Pointed hull.
    float halfWidth = 0.17 * (1.0 - smoothstep(0.05, 0.46, p.y));
    d = max(abs(p.x) - halfWidth, abs(p.y - 0.02) - 0.42);`
    }
    float edge = 0.035;
    float shape = 1.0 - smoothstep(-edge, edge, d);
    float halo = vSelected * (1.0 - smoothstep(0.0, 0.5, length(p))) * 0.35;
    float a = max(shape, halo);
    if (a < 0.02) discard;
    gl_FragColor = vec4(vColor, a * uOpacity);
    #include <colorspace_fragment>
  }
`;

/** Any textured body lit by the Sun: the Moon, the planets, the Earth seen from afar. */
export const bodyVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPosW = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

export const bodyFragment = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uSun;
  uniform float uAmbient;
  uniform float uEmissive;
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vec3 n = normalize(vNormalW);
    vec3 albedo = texture2D(uMap, vUv).rgb;
    float ndl = max(dot(n, uSun), 0.0);
    // A touch of terminator softening so the day/night line isn't a hard edge.
    float lit = smoothstep(-0.02, 0.12, dot(n, uSun)) * ndl * 1.25 + uAmbient;
    vec3 color = mix(albedo * lit, albedo * 1.35, uEmissive);
    gl_FragColor = vec4(color, uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * The Moon in the Earth-centred scene: the body shader plus the Earth's shadow. Inside the umbra only
 * sunlight bent through the Earth's atmosphere arrives, red from every sunset on the planet at once.
 */
export const moonFragment = bodyFragment
  .replace(
    "varying vec3 vPosW;",
    `varying vec3 vPosW;
  uniform vec3 uEarthPos;
  uniform float uEarthRadius;
  float earthShadow(vec3 world) {
    vec3 q = (world - uEarthPos) / uEarthRadius;
    vec3 anti = -uSun;
    float x = dot(q, anti);
    if (x <= 0.0) return 1.0;
    float d = length(q - anti * x);
    // Cone radii at the Moon's distance (Earth radii), widened 2 % by the atmosphere.
    float umbra = 1.02 * (1.0 - x * 0.004612);
    float penumbra = 1.02 * (1.0 + x * 0.004697);
    if (d >= penumbra) return 1.0;
    if (d <= umbra) return 0.0;
    return smoothstep(0.0, 1.0, (d - umbra) / (penumbra - umbra));
  }`,
  )
  .replace(
    "vec3 color = mix(albedo * lit, albedo * 1.35, uEmissive);",
    `float light = earthShadow(vPosW);
    vec3 umbral = albedo * vec3(0.55, 0.16, 0.06) * (ndl * 0.9 + 0.05);
    vec3 color = mix(umbral, albedo * lit, light);`,
  );

/** The Sun as a billboard: a hot disc with a soft corona, sized in world units. */
export const sunVertex = /* glsl */ `
  uniform float uSize;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 center = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    center.xy += position.xy * uSize;
    gl_Position = projectionMatrix * center;
  }
`;

export const sunFragment = /* glsl */ `
  uniform float uClock;
  uniform sampler2D uMap;
  varying vec2 vUv;
  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    // The photosphere fills the inner 18% of the billboard; the rest is corona.
    float disc = 1.0 - smoothstep(0.17, 0.19, r);
    float corona = exp(-r * 4.5) * 0.9 + exp(-r * 1.6) * 0.18;
    float ang = atan(p.y, p.x);
    float rays = 0.5 + 0.5 * sin(ang * 9.0 + uClock * 0.15) * sin(ang * 5.0 - uClock * 0.1);
    corona *= 0.85 + 0.3 * rays;
    // Granulation from the texture inside the disc; limb darkening toward its edge.
    vec2 discUv = p / 0.19 * 0.5 + 0.5;
    vec3 surface = texture2D(uMap, vec2(discUv.x * 0.5 + uClock * 0.002, discUv.y)).rgb;
    float limbDark = 1.0 - 0.35 * smoothstep(0.1, 0.19, r);
    vec3 color = (surface * 0.6 + 0.55) * vec3(1.0, 0.93, 0.8) * 3.6 * limbDark * disc + vec3(1.0, 0.72, 0.38) * corona * 1.5;
    float a = max(disc, min(1.0, corona * 1.2));
    gl_FragColor = vec4(color, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Fixed-pixel markers with per-vertex colour, used for bodies too small to see at system scale. */
export const markerVertex = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  uniform float uPixelRatio;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPixelRatio;
  }
`;

export const markerFragment = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.25, d);
    if (a <= 0.0) discard;
    gl_FragColor = vec4(vColor, a * uOpacity);
    #include <colorspace_fragment>
  }
`;

/** Aurora shell: NOAA probability (red channel, 1° grid starting at lon 0) → green curtains on the night side. */
export const auroraFragment = /* glsl */ `
  ${NOISE}
  uniform sampler2D uMap;
  uniform vec3 uSun;
  uniform float uClock;
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vec3 n = normalize(vNormalW);
    float night = 1.0 - smoothstep(-0.18, 0.05, dot(n, uSun));
    if (night <= 0.0) discard;
    vec2 uv = vec2(fract(vUv.x - 0.5), vUv.y);
    float p = texture2D(uMap, uv).r;
    float band = smoothstep(0.06, 0.55, p);
    if (band <= 0.001) discard;
    // Curtains drift slowly along the oval; a second octave adds flicker.
    float curtain = noise2(vec2(vUv.x * 520.0 + uClock * 0.03, vUv.y * 60.0)) * 0.7 + noise2(vec2(vUv.x * 1600.0 - uClock * 0.05, vUv.y * 160.0 + uClock * 0.02)) * 0.3;
    curtain = 0.45 + 0.55 * curtain;
    vec3 v = normalize(cameraPosition - vPosW);
    float limb = 1.0 + pow(1.0 - max(dot(n, v), 0.0), 2.5) * 2.5;
    vec3 green = vec3(0.35, 0.95, 0.5);
    vec3 violet = vec3(0.75, 0.35, 1.0);
    vec3 color = mix(green, violet, smoothstep(0.45, 1.0, p) * 0.55);
    float a = band * night * curtain * limb * 0.55 * uOpacity;
    gl_FragColor = vec4(color * a, a);
    #include <colorspace_fragment>
  }
`;
