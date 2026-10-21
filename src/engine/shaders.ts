/**
 * GLSL for the planet and its overlays. Written GLSL1-style; three.js
 * translates it for WebGL2. Every fragment shader that outputs colour ends
 * with the tone-mapping and colour-space chunks so it matches the renderer.
 */

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

  void main() {
    vec3 n = normalize(vNormalW);
    vec3 v = normalize(cameraPosition - vPosW);
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
    vec3 lit = albedo * (max(ndl, 0.0) * 1.35 + 0.012) * (1.0 - 0.5 * shadow);
    lit += albedo * vec3(1.0, 0.42, 0.12) * twilight * 0.22;

    // Sun glint on open water.
    vec3 h = normalize(uSun + v);
    float spec = pow(max(dot(n, h), 0.0), 260.0) * 1.1 + pow(max(dot(n, h), 0.0), 40.0) * 0.035;
    lit += vec3(1.0, 0.86, 0.68) * spec * water * day * (1.0 - cloud);

    // City lights: Black Marble luminance, sodium-warm, dimmed by cloud cover.
    float lights = texture2D(uNight, vUv).r;
    lights = pow(lights, 2.4) * 3.2;
    vec3 night = vec3(1.0, 0.68, 0.36) * lights * (1.0 - day) * uLights * (1.0 - 0.75 * cloud);

    // Thin atmosphere seen through the limb.
    float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    vec3 sky = mix(vec3(0.28, 0.52, 1.0), vec3(1.0, 0.48, 0.18), twilight);
    vec3 atmosphere = sky * rim * smoothstep(-0.3, 0.35, ndl) * 0.9;

    gl_FragColor = vec4(lit + night + atmosphere, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export const cloudsFragment = /* glsl */ `
  uniform sampler2D uClouds;
  uniform vec3 uSun;
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  void main() {
    vec3 n = normalize(vNormalW);
    vec3 v = normalize(cameraPosition - vPosW);
    float ndl = dot(n, uSun);
    float mask = texture2D(uClouds, vUv).r;
    float density = pow(smoothstep(0.06, 1.0, mask), 1.4) * 0.88;
    // Thin the deck as the camera descends so traffic and coastlines stay readable.
    density *= mix(0.45, 1.0, smoothstep(1.35, 3.2, length(cameraPosition)));
    float twilight = smoothstep(-0.22, 0.0, ndl) * (1.0 - smoothstep(0.0, 0.3, ndl));
    vec3 color = vec3(1.0) * (max(ndl, 0.0) * 1.15 + 0.035);
    color += vec3(1.0, 0.45, 0.2) * twilight * 0.35;
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

export const atmosphereFragment = /* glsl */ `
  uniform vec3 uSun;
  uniform float uOuter;
  varying vec3 vPosW;
  void main() {
    vec3 d = normalize(vPosW - cameraPosition);
    vec3 q = cameraPosition - d * dot(cameraPosition, d);
    float b = length(q);
    if (b < 1.0) discard;
    float h = (b - 1.0) / (uOuter - 1.0);
    float density = exp(-h * 5.5) * (1.0 - smoothstep(0.85, 1.0, h));
    float s = dot(normalize(q), uSun);
    vec3 dayColor = vec3(0.32, 0.6, 1.0);
    vec3 duskColor = vec3(1.0, 0.45, 0.16);
    vec3 color = mix(vec3(0.0), dayColor, smoothstep(-0.25, 0.35, s));
    color += duskColor * exp(-s * s / 0.018) * 0.9;
    gl_FragColor = vec4(color * density * 1.25, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export const starsVertex = /* glsl */ `
  attribute float aMag;
  attribute vec3 aColor;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vMag;
  void main() {
    vColor = aColor;
    vMag = aMag;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (0.9 + aMag * 2.2) * uPixelRatio;
  }
`;

export const starsFragment = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vMag;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vColor * (0.25 + vMag * 0.9), a * uOpacity);
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
    float zoom = clamp(3.2 / -mv.z, 0.7, 2.4);
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
