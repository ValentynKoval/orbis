"use client";

import { useEffect, useState } from "react";
import { useOrbis } from "@/store/orbis";

/** Frame-time readout for the curious: /live?debug=1 or press D. */
export function Perf() {
  const engine = useOrbis((s) => s.engine);
  const [on, setOn] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debug") === "1");
  const [stats, setStats] = useState<ReturnType<NonNullable<typeof engine>["perf"]> | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "d" || e.key === "D") setOn((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!on || !engine) return;
    const id = window.setInterval(() => setStats(engine.perf()), 500);
    return () => window.clearInterval(id);
  }, [on, engine]);

  if (!on || !stats) return null;
  return (
    <div className="readout pointer-events-none absolute top-[max(1rem,env(safe-area-inset-top))] left-1/2 mt-14 -translate-x-1/2 rounded-full border border-hairline bg-black/60 px-3 py-1 text-[11px] text-haze">
      {stats.fps} fps · {stats.calls} draws · {Math.round(stats.triangles / 1000)}k tris · {stats.tiles} tiles · ×{stats.pixelRatio.toFixed(2)}
    </div>
  );
}
