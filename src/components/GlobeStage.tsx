"use client";

import { useEffect, useRef } from "react";
import { useOrbis } from "@/store/orbis";
import { useDict } from "@/i18n/client";

/**
 * The persistent WebGL canvas. It lives in the (globe) layout, so moving
 * between the landing page and the live globe keeps the same Earth running.
 */
export function GlobeStage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ready = useOrbis((s) => s.ready);
  const progress = useOrbis((s) => s.progress);
  const webglError = useOrbis((s) => s.webglError);
  const t = useDict();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let engine: import("@/engine/Engine").Engine | null = null;
    // three.js stays out of the first-load bundle; the page paints before it arrives.
    import("@/engine/Engine").then(({ Engine }) => {
      if (disposed) return;
      const lite = window.matchMedia("(pointer: coarse)").matches || Math.min(window.innerWidth, window.innerHeight) < 600;
      try {
        engine = new Engine(canvas, { lite });
      } catch {
        useOrbis.setState({ webglError: true });
        return;
      }
      const mode = useOrbis.getState().mode;
      engine.setInteractive(mode === "live");
      useOrbis.getState().setEngine(engine);
      if (process.env.NODE_ENV !== "production") Object.assign(window, { __orbisEngine: engine });
      engine.start().catch(() => useOrbis.setState({ webglError: true }));
    });
    return () => {
      disposed = true;
      engine?.dispose();
      useOrbis.setState({ engine: null, ready: false, progress: 0 });
    };
  }, []);

  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden
        className="fixed inset-0 h-[100lvh] w-full transition-opacity duration-[1600ms] ease-[var(--ease-out-soft)]"
        style={{ opacity: ready ? 1 : 0 }}
      />
      {!ready && (
        <div className="pointer-events-none fixed inset-x-0 bottom-10 z-30 flex flex-col items-center gap-3" role="status">
          {webglError ? (
            <p className="max-w-sm px-6 text-center text-sm text-haze">{t.loading.webgl}</p>
          ) : (
            <>
              <span className="text-xs tracking-wide text-haze">{t.loading.label}</span>
              <span className="block h-px w-40 overflow-hidden bg-hairline">
                <span
                  className="block h-full origin-left bg-foil transition-transform duration-500 ease-[var(--ease-orbit)]"
                  style={{ transform: `scaleX(${Math.max(0.04, progress)})` }}
                />
              </span>
            </>
          )}
        </div>
      )}
    </>
  );
}
