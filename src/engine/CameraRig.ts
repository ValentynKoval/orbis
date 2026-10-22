import * as THREE from "three";
import { latLonToVec } from "@/lib/geo";
import type { CameraPose } from "./types";


function wrap(lon: number) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Orbits the camera around the Earth in lat/lon/distance. Input moves a goal
 * pose; the camera eases toward it every frame, which gives inertia, smooth
 * fly-tos and scroll-driven choreography from one mechanism.
 */
export class CameraRig {
  /** Closest approach to the centre, in Earth radii; set from the deepest imagery available. */
  minDist = 1.0012;
  maxDist = 400;
  /** Radius of the body being orbited: zoom and drag speeds scale with the altitude above it. */
  radius = 1;
  readonly pose: CameraPose = { lat: 18, lon: 20, dist: 4.4 };
  readonly goal: CameraPose = { lat: 18, lon: 20, dist: 4.4 };
  /** Horizontal shift of the globe as a fraction of the viewport width (positive = right). */
  offset = 0;
  offsetGoal = 0;
  /** Vertical shift as a fraction of the viewport height (positive = down). */
  offsetY = 0;
  offsetYGoal = 0;
  /** Degrees per second of idle drift in longitude. */
  autoRotate = 0;
  interactive = false;
  /** Higher = snappier. Fly-tos temporarily lower it. */
  stiffness = 6;
  /**
   * Near the ground the camera leans toward the horizon so relief reads in 3D (degrees from straight
   * down). It follows the altitude on its own; the visitor can add to it and turn the view
   * (right-drag or Ctrl-drag, Q/E and R/F keys, a two-finger twist).
   */
  tilt = 0;
  heading = 0;
  private tiltUser = 0;
  private headingGoal = 0;
  /** Ground height under a point in Earth radii, so a tilted view pivots on the terrain, not on sea level. */
  ground: ((lat: number, lon: number) => number) | null = null;

  onTap: ((x: number, y: number) => void) | null = null;
  onHover: ((x: number, y: number) => void) | null = null;
  onUserMove: (() => void) | null = null;
  /** Told where every programmed flight is heading, so the destination can start loading early. */
  onFly: ((goal: CameraPose) => void) | null = null;

  private velocity = { lat: 0, lon: 0 };
  private pointers = new Map<number, { x: number; y: number }>();
  private down: { x: number; y: number; t: number } | null = null;
  private pinchDist = 0;
  private pinchAngle = 0;
  /** Right button or Ctrl/Shift held: the drag turns and tilts instead of panning. */
  private orbitDrag = false;
  private flyUntil = 0;
  private lastHover = 0;
  /** A timed flight: the pose follows an ease-in-out curve from `from` to `to` (distance in log space). */
  private glideState: { from: CameraPose; to: CameraPose; start: number; duration: number } | null = null;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private el: HTMLElement,
  ) {
    el.addEventListener("pointerdown", this.handleDown);
    el.addEventListener("pointermove", this.handleMove);
    el.addEventListener("pointerup", this.handleUp);
    el.addEventListener("pointercancel", this.handleUp);
    el.addEventListener("wheel", this.handleWheel, { passive: false });
    el.addEventListener("contextmenu", this.handleContextMenu);
    window.addEventListener("keydown", this.handleKey);
  }

  dispose() {
    this.el.removeEventListener("pointerdown", this.handleDown);
    this.el.removeEventListener("pointermove", this.handleMove);
    this.el.removeEventListener("pointerup", this.handleUp);
    this.el.removeEventListener("pointercancel", this.handleUp);
    this.el.removeEventListener("wheel", this.handleWheel);
    this.el.removeEventListener("contextmenu", this.handleContextMenu);
    window.removeEventListener("keydown", this.handleKey);
  }

  /** Eases to a pose. `duration` is approximate: it sets how soft the approach is. */
  flyTo(target: Partial<CameraPose>, duration = 1.6) {
    if (target.lat !== undefined) this.goal.lat = target.lat;
    if (target.lon !== undefined) this.goal.lon = this.pose.lon + wrap(target.lon - this.pose.lon);
    if (target.dist !== undefined) this.goal.dist = target.dist;
    this.velocity.lat = this.velocity.lon = 0;
    this.glideState = null;
    this.stiffness = 4.2 / Math.max(0.3, duration);
    this.flyUntil = performance.now() + duration * 1000 * 1.6;
    this.onFly?.(this.goal);
  }

  /**
   * A cinematic flight: ease-in-out over exactly `duration` seconds, with the
   * distance interpolated in log space so a long zoom moves at a steady visual
   * pace. Any input cancels it. Longitude takes the short way round.
   */
  glide(target: Partial<CameraPose>, duration: number) {
    const to: CameraPose = {
      lat: target.lat ?? this.pose.lat,
      lon: target.lon === undefined ? this.pose.lon : this.pose.lon + wrap(target.lon - this.pose.lon),
      dist: target.dist ?? this.pose.dist,
    };
    this.velocity.lat = this.velocity.lon = 0;
    this.glideState = { from: { ...this.pose }, to, start: performance.now(), duration: Math.max(0.05, duration) * 1000 };
    Object.assign(this.goal, to);
    this.flyUntil = 0;
    this.onFly?.(this.goal);
  }

  get gliding() {
    return this.glideState !== null;
  }

  /** Seconds left in the current timed flight (0 when none). */
  get glideRemaining() {
    const g = this.glideState;
    return g ? Math.max(0, (g.start + g.duration - performance.now()) / 1000) : 0;
  }

  /**
   * Takes over another rig's motion mid-flight: the same distance (times
   * `scale`), the same goal, the same easing or the same timed flight, so a
   * scene hand-over neither stops nor kicks the camera.
   */
  continueFrom(other: CameraRig, scale: number) {
    this.pose.dist = other.pose.dist * scale;
    this.goal.dist = other.goal.dist * scale;
    this.stiffness = other.stiffness;
    this.flyUntil = other.flyUntil;
    this.velocity.lat = other.velocity.lat;
    this.velocity.lon = other.velocity.lon;
    const g = other.glideState;
    this.glideState = g
      ? { from: { ...g.from, dist: g.from.dist * scale }, to: { ...g.to, dist: g.to.dist * scale }, start: g.start, duration: g.duration }
      : null;
    // The other rig's longitude frame differs by a constant; keep the flight's endpoints consistent with the pose we were given.
    if (this.glideState) {
      const shift = this.pose.lon - other.pose.lon;
      this.glideState.from.lon += shift;
      this.glideState.to.lon += shift;
      this.goal.lon = this.glideState.to.lon;
    }
    other.glideState = null;
  }

  /** North up and the automatic lean only. */
  resetOrientation() {
    this.tiltUser = 0;
    this.headingGoal = Math.round(this.heading / 360) * 360;
  }

  /** The lean the altitude asks for: none from orbit, up to 55° a few kilometres up. */
  private autoTilt() {
    if (this.radius <= 0) return 0;
    return 55 * (1 - THREE.MathUtils.smoothstep(this.pose.dist, 1.004, 1.09));
  }

  /** Sets the goal directly (scroll scrubbing); the camera still eases. */
  setAutoRotate(degPerSecond: number) {
    this.autoRotate = degPerSecond;
  }

  setOffset(x: number, y = 0) {
    this.offsetGoal = x;
    this.offsetYGoal = y;
  }

  update(dt: number, width: number, height: number) {
    if (this.flyUntil && performance.now() > this.flyUntil) {
      this.flyUntil = 0;
      this.stiffness = 6;
    }
    if (!this.pointers.size) {
      this.goal.lat += this.velocity.lat * dt;
      this.goal.lon += this.velocity.lon * dt;
      const decay = Math.exp(-dt * 3.5);
      this.velocity.lat *= decay;
      this.velocity.lon *= decay;
      if (!this.flyUntil) this.goal.lon += this.autoRotate * dt;
    }
    this.goal.lat = THREE.MathUtils.clamp(this.goal.lat, -84, 84);
    this.goal.dist = THREE.MathUtils.clamp(this.goal.dist, this.minDist, this.maxDist);

    const g = this.glideState;
    if (g) {
      const t = Math.min(1, (performance.now() - g.start) / g.duration);
      const s = t * t * t * (t * (t * 6 - 15) + 10);
      this.pose.lat = g.from.lat + (g.to.lat - g.from.lat) * s;
      this.pose.lon = g.from.lon + (g.to.lon - g.from.lon) * s;
      this.pose.dist = Math.exp(Math.log(g.from.dist) + (Math.log(g.to.dist) - Math.log(g.from.dist)) * s);
      if (t >= 1) {
        this.glideState = null;
        Object.assign(this.goal, { lat: this.pose.lat, lon: this.pose.lon, dist: this.pose.dist });
      }
    } else {
      const k = 1 - Math.exp(-dt * this.stiffness);
      this.pose.lat += (this.goal.lat - this.pose.lat) * k;
      this.pose.lon += (this.goal.lon - this.pose.lon) * k;
      // Zoom eases in log space so far and near moves feel the same.
      this.pose.dist = Math.exp(Math.log(this.pose.dist) + (Math.log(this.goal.dist) - Math.log(this.pose.dist)) * k);
    }
    const ko = 1 - Math.exp(-dt * 3);
    this.offset += (this.offsetGoal - this.offset) * ko;
    this.offsetY += (this.offsetYGoal - this.offsetY) * ko;
    if (Math.abs(this.pose.lon) > 720) {
      const shift = Math.round(this.pose.lon / 360) * 360;
      this.pose.lon -= shift;
      this.goal.lon -= shift;
    }

    const ka = 1 - Math.exp(-dt * 5);
    this.heading += (this.headingGoal - this.heading) * ka;
    // The visitor's extra lean fades out with altitude, so leaving the ground always ends looking straight down.
    const lean = this.radius > 0 ? this.tiltUser * (1 - THREE.MathUtils.smoothstep(this.pose.dist, 1.05, 1.4)) : 0;
    const tiltGoal = THREE.MathUtils.clamp(this.autoTilt() + lean, 0, 75);
    this.tilt += (tiltGoal - this.tilt) * ka;

    if (this.tilt < 0.05 && Math.abs(this.heading % 360) < 0.05) {
      const [x, y, z] = latLonToVec(this.pose.lat, this.pose.lon, this.pose.dist);
      this.camera.position.set(x, y, z);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(0, 0, 0);
    } else {
      // Pivot on the ground point under the pose; the camera stays the same distance from it, leaning
      // back against the heading by the tilt angle.
      const ground = this.radius + (this.ground?.(this.pose.lat, this.pose.lon) ?? 0);
      const t = latLonToVec(this.pose.lat, this.pose.lon, ground);
      const target = new THREE.Vector3(t[0], t[1], t[2]);
      const up = target.clone().normalize();
      const east = new THREE.Vector3(0, 1, 0).cross(up);
      if (east.lengthSq() < 1e-10) east.set(1, 0, 0);
      east.normalize();
      const north = up.clone().cross(east).normalize();
      const h = THREE.MathUtils.degToRad(this.heading);
      const forward = north.multiplyScalar(Math.cos(h)).add(east.multiplyScalar(Math.sin(h)));
      const range = Math.max(1e-6, this.pose.dist - ground);
      const a = THREE.MathUtils.degToRad(this.tilt);
      this.camera.position.copy(target).addScaledVector(up, range * Math.cos(a)).addScaledVector(forward, -range * Math.sin(a));
      this.camera.up.copy(up);
      this.camera.lookAt(target);
    }
    if (Math.abs(this.offset) > 1e-4 || Math.abs(this.offsetY) > 1e-4) {
      this.camera.setViewOffset(width, height, -this.offset * width, -this.offsetY * height, width, height);
    } else if (this.camera.view) {
      this.camera.clearViewOffset();
    }
  }

  /**
   * Degrees of rotation per pixel of drag. Around a body the surface tracks
   * the finger; around a point (radius 0) a full-height drag turns about 50°
   * whatever the distance, so a far view doesn't spin wildly.
   */
  private dragScale() {
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    if (this.radius <= 0) return THREE.MathUtils.radToDeg((2 * Math.tan(fov / 2)) / this.el.clientHeight) * 1.5;
    const visible = 2 * Math.tan(fov / 2) * (this.pose.dist - this.radius);
    return THREE.MathUtils.radToDeg(visible / (this.el.clientHeight * this.radius)) * 0.95;
  }

  private handleDown = (e: PointerEvent) => {
    if (!this.interactive) return;
    this.el.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.velocity.lat = this.velocity.lon = 0;
    this.flyUntil = 0;
    this.glideState = null;
    this.stiffness = 14;
    if (this.pointers.size === 1) {
      this.down = { x: e.clientX, y: e.clientY, t: performance.now() };
      this.orbitDrag = e.button === 2 || e.ctrlKey || e.shiftKey;
    }
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.pinchAngle = Math.atan2(b.y - a.y, b.x - a.x);
      this.down = null;
      this.orbitDrag = false;
    }
  };

  private handleMove = (e: PointerEvent) => {
    if (!this.interactive) return;
    const prev = this.pointers.get(e.pointerId);
    if (!prev) {
      const now = performance.now();
      if (e.pointerType === "mouse" && now - this.lastHover > 40) {
        this.lastHover = now;
        this.onHover?.(e.clientX, e.clientY);
      }
      return;
    }
    const cur = { x: e.clientX, y: e.clientY };
    this.pointers.set(e.pointerId, cur);
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      if (this.pinchDist > 0) {
        const altitude = this.goal.dist - this.radius;
        this.goal.dist = this.radius + altitude * (this.pinchDist / d);
        if (this.radius > 0) {
          let turn = angle - this.pinchAngle;
          if (turn > Math.PI) turn -= 2 * Math.PI;
          if (turn < -Math.PI) turn += 2 * Math.PI;
          this.headingGoal -= THREE.MathUtils.radToDeg(turn);
        }
      }
      this.pinchDist = d;
      this.pinchAngle = angle;
      this.onUserMove?.();
      return;
    }
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    if (this.orbitDrag && this.radius > 0) {
      this.headingGoal -= dx * 0.3;
      this.tiltUser = THREE.MathUtils.clamp(this.tiltUser - dy * 0.25, -this.autoTilt(), 70);
      this.onUserMove?.();
      return;
    }
    const s = this.dragScale();
    const latScale = 1 / Math.max(0.3, Math.cos(THREE.MathUtils.degToRad(this.pose.lat)));
    // Screen up points along the heading: rotate the drag into north/east.
    const h = THREE.MathUtils.degToRad(this.heading);
    const north = dx * Math.sin(h) + dy * Math.cos(h);
    const east = -dx * Math.cos(h) + dy * Math.sin(h);
    this.goal.lon += east * s * latScale;
    this.goal.lat += north * s;
    const dt = Math.max(1 / 120, (e.timeStamp - (this.lastMoveT || e.timeStamp)) / 1000 || 1 / 60);
    this.lastMoveT = e.timeStamp;
    this.velocity.lon = (east * s * latScale) / dt;
    this.velocity.lat = (north * s) / dt;
    this.onUserMove?.();
  };

  private lastMoveT = 0;

  private handleUp = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    this.pinchDist = 0;
    this.stiffness = 6;
    // A fling only counts if the pointer was still moving when released.
    if (e.timeStamp - this.lastMoveT > 80) this.velocity.lat = this.velocity.lon = 0;
    this.velocity.lat = THREE.MathUtils.clamp(this.velocity.lat, -120, 120);
    this.velocity.lon = THREE.MathUtils.clamp(this.velocity.lon, -240, 240);
    if (this.down && !this.pointers.size) {
      const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
      if (moved < 6 && performance.now() - this.down.t < 500) {
        this.velocity.lat = this.velocity.lon = 0;
        this.onTap?.(e.clientX, e.clientY);
      }
    }
    this.down = null;
  };

  /** Arrows turn the globe, + and − zoom; ignored while typing. */
  private handleKey = (e: KeyboardEvent) => {
    if (!this.interactive || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    const stepDeg = this.radius > 0 ? Math.max(0.05, Math.min(12, (this.goal.dist - this.radius) * 4)) : 4;
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown": {
        const h = THREE.MathUtils.degToRad(this.radius > 0 ? this.heading : 0);
        const [fx, fy] = e.key === "ArrowLeft" ? [-1, 0] : e.key === "ArrowRight" ? [1, 0] : e.key === "ArrowUp" ? [0, 1] : [0, -1];
        this.goal.lat += (fy * Math.cos(h) - fx * Math.sin(h)) * stepDeg;
        this.goal.lon += (fx * Math.cos(h) + fy * Math.sin(h)) * stepDeg;
        break;
      }
      case "+":
      case "=":
        this.goal.dist = this.radius + (this.goal.dist - this.radius) * 0.8;
        break;
      case "-":
      case "_":
        this.goal.dist = this.radius + (this.goal.dist - this.radius) * 1.25;
        break;
      case "q":
      case "Q":
        if (this.radius <= 0) return;
        this.headingGoal += 15;
        break;
      case "e":
      case "E":
        if (this.radius <= 0) return;
        this.headingGoal -= 15;
        break;
      case "r":
      case "R":
        if (this.radius <= 0) return;
        this.tiltUser = Math.min(70, this.tiltUser + 8);
        break;
      case "f":
      case "F":
        if (this.radius <= 0) return;
        this.tiltUser = Math.max(-this.autoTilt(), this.tiltUser - 8);
        break;
      case "n":
      case "N":
        if (this.radius <= 0) return;
        this.resetOrientation();
        break;
      default:
        return;
    }
    e.preventDefault();
    this.flyUntil = 0;
    this.glideState = null;
    this.stiffness = 6;
    this.onUserMove?.();
  };

  private handleContextMenu = (e: Event) => {
    if (this.interactive) e.preventDefault();
  };

  private handleWheel = (e: WheelEvent) => {
    if (!this.interactive) return;
    e.preventDefault();
    const altitude = this.goal.dist - this.radius;
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.goal.dist = this.radius + altitude * Math.exp(delta * 0.0012);
    this.flyUntil = 0;
    this.glideState = null;
    this.stiffness = 8;
    this.onUserMove?.();
  };
}
