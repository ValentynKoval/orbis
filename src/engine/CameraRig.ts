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
  maxDist = 70;
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

  onTap: ((x: number, y: number) => void) | null = null;
  onHover: ((x: number, y: number) => void) | null = null;
  onUserMove: (() => void) | null = null;

  private velocity = { lat: 0, lon: 0 };
  private pointers = new Map<number, { x: number; y: number }>();
  private down: { x: number; y: number; t: number } | null = null;
  private pinchDist = 0;
  private flyUntil = 0;
  private lastHover = 0;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private el: HTMLElement,
  ) {
    el.addEventListener("pointerdown", this.handleDown);
    el.addEventListener("pointermove", this.handleMove);
    el.addEventListener("pointerup", this.handleUp);
    el.addEventListener("pointercancel", this.handleUp);
    el.addEventListener("wheel", this.handleWheel, { passive: false });
  }

  dispose() {
    this.el.removeEventListener("pointerdown", this.handleDown);
    this.el.removeEventListener("pointermove", this.handleMove);
    this.el.removeEventListener("pointerup", this.handleUp);
    this.el.removeEventListener("pointercancel", this.handleUp);
    this.el.removeEventListener("wheel", this.handleWheel);
  }

  /** Eases to a pose. `duration` is approximate: it sets how soft the approach is. */
  flyTo(target: Partial<CameraPose>, duration = 1.6) {
    if (target.lat !== undefined) this.goal.lat = target.lat;
    if (target.lon !== undefined) this.goal.lon = this.pose.lon + wrap(target.lon - this.pose.lon);
    if (target.dist !== undefined) this.goal.dist = target.dist;
    this.velocity.lat = this.velocity.lon = 0;
    this.stiffness = 4.2 / Math.max(0.3, duration);
    this.flyUntil = performance.now() + duration * 1000 * 1.6;
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

    const k = 1 - Math.exp(-dt * this.stiffness);
    this.pose.lat += (this.goal.lat - this.pose.lat) * k;
    this.pose.lon += (this.goal.lon - this.pose.lon) * k;
    // Zoom eases in log space so far and near moves feel the same.
    this.pose.dist = Math.exp(Math.log(this.pose.dist) + (Math.log(this.goal.dist) - Math.log(this.pose.dist)) * k);
    const ko = 1 - Math.exp(-dt * 3);
    this.offset += (this.offsetGoal - this.offset) * ko;
    this.offsetY += (this.offsetYGoal - this.offsetY) * ko;
    if (Math.abs(this.pose.lon) > 720) {
      const shift = Math.round(this.pose.lon / 360) * 360;
      this.pose.lon -= shift;
      this.goal.lon -= shift;
    }

    const [x, y, z] = latLonToVec(this.pose.lat, this.pose.lon, this.pose.dist);
    this.camera.position.set(x, y, z);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);
    if (Math.abs(this.offset) > 1e-4 || Math.abs(this.offsetY) > 1e-4) {
      this.camera.setViewOffset(width, height, -this.offset * width, -this.offsetY * height, width, height);
    } else if (this.camera.view) {
      this.camera.clearViewOffset();
    }
  }

  /** Degrees of rotation per pixel of drag, scaled so the surface tracks the finger. */
  private dragScale() {
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const visible = 2 * Math.tan(fov / 2) * (this.pose.dist - this.radius);
    return THREE.MathUtils.radToDeg(visible / this.el.clientHeight) * 0.95;
  }

  private handleDown = (e: PointerEvent) => {
    if (!this.interactive) return;
    this.el.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.velocity.lat = this.velocity.lon = 0;
    this.flyUntil = 0;
    this.stiffness = 14;
    if (this.pointers.size === 1) this.down = { x: e.clientX, y: e.clientY, t: performance.now() };
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.down = null;
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
      if (this.pinchDist > 0) {
        const altitude = this.goal.dist - this.radius;
        this.goal.dist = this.radius + altitude * (this.pinchDist / d);
      }
      this.pinchDist = d;
      this.onUserMove?.();
      return;
    }
    const s = this.dragScale();
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    const latScale = 1 / Math.max(0.3, Math.cos(THREE.MathUtils.degToRad(this.pose.lat)));
    this.goal.lon -= dx * s * latScale;
    this.goal.lat += dy * s;
    const dt = Math.max(1 / 120, (e.timeStamp - (this.lastMoveT || e.timeStamp)) / 1000 || 1 / 60);
    this.lastMoveT = e.timeStamp;
    this.velocity.lon = (-dx * s * latScale) / dt;
    this.velocity.lat = (dy * s) / dt;
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

  private handleWheel = (e: WheelEvent) => {
    if (!this.interactive) return;
    e.preventDefault();
    const altitude = this.goal.dist - this.radius;
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.goal.dist = this.radius + altitude * Math.exp(delta * 0.0012);
    this.flyUntil = 0;
    this.stiffness = 8;
    this.onUserMove?.();
  };
}
