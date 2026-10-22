import { describe, expect, it } from "vitest";
import { layoutLabels } from "./labels";

describe("layoutLabels", () => {
  it("keeps the higher-priority label in place and moves the other out of its way", () => {
    const out = layoutLabels(
      [
        { key: "earth", x: 500, y: 300, px: 2, text: "Earth", priority: 2 },
        { key: "moon", x: 503, y: 301, px: 2, text: "Moon", priority: 1 },
      ],
      1000,
      600,
    );
    const earth = out.get("earth")!;
    const moon = out.get("moon")!;
    expect(earth.hidden).toBe(false);
    expect(moon.hidden).toBe(false);
    expect(earth.left).toBeGreaterThan(500);
    // The Moon's label went somewhere else: left, below or above.
    expect(Math.abs(moon.top - earth.top) > 10 || moon.left < 500).toBe(true);
  });

  it("hides a label that fits nowhere", () => {
    const crowd = Array.from({ length: 12 }, (_, i) => ({ key: `c${i}`, x: 500, y: 300, px: 2, text: "Comet C/2025 A1", priority: 1 }));
    const out = layoutLabels(crowd, 1000, 600);
    const shown = [...out.values()].filter((p) => !p.hidden).length;
    expect(shown).toBeGreaterThanOrEqual(4);
    expect(shown).toBeLessThan(12);
  });

  it("keeps labels inside the viewport", () => {
    const out = layoutLabels([{ key: "n", x: 995, y: 5, px: 2, text: "Neptune", priority: 2 }], 1000, 600);
    const n = out.get("n")!;
    expect(n.hidden).toBe(false);
    expect(n.left).toBeLessThan(995);
    expect(n.top).toBeGreaterThanOrEqual(4);
  });
});
