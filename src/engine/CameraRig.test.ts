import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CameraRig } from "./CameraRig";

// The rig only needs somewhere to attach listeners and a height for drag scaling.
const listeners = { addEventListener() {}, removeEventListener() {} };
Object.assign(globalThis, { window: listeners });
const el = { ...listeners, clientHeight: 900 } as unknown as HTMLElement;

describe("CameraRig", () => {
  it("keeps a stable orientation looking straight down with the heading turned", () => {
    const camera = new THREE.PerspectiveCamera(32, 1.6, 0.01, 100);
    const rig = new CameraRig(camera, el);
    rig.radius = 1;
    // Turned away from north (as a right-drag does) with no lean: the camera looks straight down.
    rig.track({ lat: 30, lon: 10, dist: 3 }, 120, 0);
    for (let i = 0; i < 300; i++) rig.update(1 / 60, 1600, 1000);
    const view = new THREE.Vector3();
    let previous: THREE.Quaternion | null = null;
    for (let i = 0; i < 60; i++) {
      // Pan a little every frame; the picture must turn smoothly, never flip.
      rig.track({ lat: 30 + i * 0.05, lon: 10 + i * 0.05, dist: 3 }, 120, 0);
      rig.update(1 / 60, 1600, 1000);
      camera.updateMatrixWorld();
      camera.getWorldDirection(view);
      expect(Math.abs(camera.up.dot(view))).toBeLessThan(1e-6);
      if (previous) expect(THREE.MathUtils.radToDeg(camera.quaternion.angleTo(previous))).toBeLessThan(1);
      previous = camera.quaternion.clone();
    }
  });
});
