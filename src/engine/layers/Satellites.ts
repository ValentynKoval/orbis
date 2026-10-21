import * as THREE from "three";
import { advanceOrbit, type Vec3 } from "@/lib/geo";
import { satellitesFragment, satellitesVertex, logDepth } from "../shaders";
import type { SatLive, SatWorkerRequest, SatWorkerResponse } from "../types";
import type { Pass } from "@/lib/passes";

/** Colours per SatGroup, in enum order. Cool hues; gold is reserved for stations and selection. */
const GROUP_COLORS = ["#f2c14e", "#8ccbff", "#a9b7ff", "#c6a6ff", "#7ee7e1", "#f3f6ff", "#9fb3c8"];
const GROUP_SIZES = [7.5, 1.7, 2.2, 3.0, 3.0, 2.8, 2.4];

export interface SatCatalog {
  names: string[];
  norad: Uint32Array;
  groups: Uint8Array;
  inclination: Float32Array;
  periodMin: Float32Array;
  issIndex: number;
}

/**
 * Lives in the inertial frame. A worker re-propagates the whole catalogue
 * every few seconds of simulated time; in between, the vertex shader advances
 * each satellite along its orbit.
 */
export class Satellites {
  readonly points: THREE.Points;
  readonly orbit: THREE.Line;
  readonly material: THREE.ShaderMaterial;
  catalog: SatCatalog | null = null;
  private geometry = new THREE.BufferGeometry();
  private worker: Worker;
  private stateTime = 0;
  private pos: Float32Array | null = null;
  private vel: Float32Array | null = null;
  private pending = false;
  private lastRequest = 0;
  private selected = -1;
  private details = new Map<string, (live: SatLive | null) => void>();
  private passRequests = new Map<string, (passes: Pass[]) => void>();

  onLoaded: ((catalog: SatCatalog) => void) | null = null;

  constructor(pixelRatio: number) {
    this.material = new THREE.ShaderMaterial({
      ...logDepth(satellitesVertex, satellitesFragment),
      uniforms: {
        uDt: { value: 0 },
        uPixelRatio: { value: pixelRatio },
        uSelected: { value: -1 },
        uOpacity: { value: 1 },
        uColors: { value: GROUP_COLORS.map((c) => new THREE.Color(c)) },
        uSizes: { value: GROUP_SIZES },
      },
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;

    this.orbit = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: "#f2c14e", transparent: true, opacity: 0.55, depthWrite: false }),
    );
    this.orbit.frustumCulled = false;
    this.orbit.visible = false;
    this.orbit.renderOrder = 4;

    this.worker = new Worker(new URL("../workers/sgp4.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<SatWorkerResponse>) => this.handle(e.data);
  }

  load(tleText: string) {
    this.post({ type: "load", text: tleText });
  }

  private post(msg: SatWorkerRequest) {
    this.worker.postMessage(msg);
  }

  private handle(msg: SatWorkerResponse) {
    switch (msg.type) {
      case "loaded": {
        this.catalog = msg;
        const n = msg.names.length;
        this.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        this.geometry.setAttribute("aVel", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        this.geometry.setAttribute("aGroup", new THREE.BufferAttribute(Float32Array.from(msg.groups), 1));
        this.pending = false;
        this.onLoaded?.(msg);
        break;
      }
      case "state": {
        const posAttr = this.geometry.getAttribute("position") as THREE.BufferAttribute;
        const velAttr = this.geometry.getAttribute("aVel") as THREE.BufferAttribute;
        if (!posAttr || posAttr.count * 3 !== msg.pos.length) break;
        (posAttr.array as Float32Array).set(msg.pos);
        (velAttr.array as Float32Array).set(msg.vel);
        posAttr.needsUpdate = true;
        velAttr.needsUpdate = true;
        this.pos = msg.pos;
        this.vel = msg.vel;
        this.stateTime = msg.time;
        this.pending = false;
        break;
      }
      case "detail": {
        const cb = this.details.get(msg.tag);
        this.details.delete(msg.tag);
        cb?.(msg.ok ? { lat: msg.lat, lon: msg.lon, altKm: msg.altKm, speedKms: msg.speedKms } : null);
        break;
      }
      case "passes": {
        const cb = this.passRequests.get(msg.tag);
        this.passRequests.delete(msg.tag);
        cb?.(msg.passes);
        break;
      }
      case "orbit": {
        if (msg.index !== this.selected) break;
        this.orbit.geometry.setAttribute("position", new THREE.BufferAttribute(msg.points, 3));
        this.orbit.geometry.computeBoundingSphere();
        this.orbit.visible = true;
        break;
      }
    }
  }

  /** Called every frame with the simulated time. */
  update(simMs: number) {
    if (!this.catalog) return;
    const age = (simMs - this.stateTime) / 1000;
    const now = performance.now();
    if (!this.pending && (Math.abs(age) > 2.5 || !this.pos) && now - this.lastRequest > 200) {
      this.pending = true;
      this.lastRequest = now;
      this.post({ type: "propagate", time: simMs });
    }
    this.material.uniforms.uDt.value = this.pos ? age : 0;
  }

  /** Inertial-frame position of satellite `i` at `simMs`, matching the shader. */
  positionOf(i: number, simMs: number): Vec3 | null {
    if (!this.pos || !this.vel) return null;
    const p: Vec3 = [this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]];
    if (p[0] * p[0] + p[1] * p[1] + p[2] * p[2] < 0.5) return null;
    const v: Vec3 = [this.vel[i * 3], this.vel[i * 3 + 1], this.vel[i * 3 + 2]];
    return advanceOrbit(p, v, (simMs - this.stateTime) / 1000);
  }

  get count() {
    return this.catalog?.names.length ?? 0;
  }

  select(index: number, simMs: number) {
    this.selected = index;
    this.material.uniforms.uSelected.value = index;
    this.orbit.visible = false;
    if (index >= 0) this.post({ type: "orbit", index, time: simMs });
  }

  refreshOrbit(simMs: number) {
    if (this.selected >= 0) this.post({ type: "orbit", index: this.selected, time: simMs });
  }

  detail(index: number, simMs: number, tag: string): Promise<SatLive | null> {
    return new Promise((resolve) => {
      this.details.set(tag, resolve);
      this.post({ type: "detail", index, time: simMs, tag });
    });
  }

  /** ISS passes over a place for the next `hours`, computed in the worker. */
  issPasses(lat: number, lon: number, fromMs: number, hours = 48): Promise<Pass[]> {
    return new Promise((resolve) => {
      const tag = `passes-${Date.now()}-${Math.random()}`;
      this.passRequests.set(tag, resolve);
      this.post({ type: "passes", lat, lon, from: fromMs, hours, tag });
    });
  }

  setOpacity(v: number) {
    this.material.uniforms.uOpacity.value = v;
    this.points.visible = v > 0.01;
    if (v < 0.01) this.orbit.visible = false;
  }

  dispose() {
    this.worker.terminate();
    this.geometry.dispose();
    this.material.dispose();
    this.orbit.geometry.dispose();
    (this.orbit.material as THREE.Material).dispose();
  }
}

