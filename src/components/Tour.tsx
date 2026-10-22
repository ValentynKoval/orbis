"use client";

import { useEffect, useRef, useState } from "react";
import { useDict } from "@/i18n/client";
import { sunPosition } from "@/lib/astro";
import { COORD_SCALE } from "@/lib/feeds/live";
import { busiestRegion, nightSpot, strongestQuake } from "@/lib/tour";
import { useOrbis } from "@/store/orbis";
import type { Engine } from "@/engine/Engine";
import { Close } from "./icons";

type StepId = "intro" | "iss" | "planes" | "ships" | "quake" | "fires" | "night" | "aurora" | "moon" | "saturn" | "craft" | "overview" | "home";

interface Step {
  id: StepId;
  /** Seconds to linger once the step has started. */
  hold: number;
  /** Sets the scene up; false means there is nothing to show (no data yet) and the step is skipped. */
  run: (e: Engine) => boolean;
}

const clampLat = (lat: number) => Math.max(-60, Math.min(60, lat));

/** A guided flight through everything live, from low orbit out to Voyager 1 and back. */
const STEPS: Step[] = [
  {
    id: "intro",
    hold: 7,
    run: (e) => {
      const s = useOrbis.getState();
      s.select(null);
      e.setFocus(null);
      const sun = sunPosition(e.clock.now());
      e.rig.flyTo({ lat: clampLat(sun.lat + 12), lon: sun.lon - 55, dist: 4.2 }, 2.6);
      e.rig.setAutoRotate(1.2);
      return true;
    },
  },
  {
    id: "iss",
    hold: 9,
    run: (e) => {
      const i = e.issIndex;
      if (i < 0) return false;
      e.rig.setAutoRotate(0);
      e.setFocus("satellites");
      void e.focusResult("satellite", i);
      return true;
    },
  },
  {
    id: "planes",
    hold: 8,
    run: (e) => {
      const snap = e.traffic.planeSnap;
      const spot = snap && busiestRegion(snap, COORD_SCALE);
      if (!spot) return false;
      useOrbis.getState().select(null);
      e.setFocus("planes");
      e.rig.flyTo({ lat: spot.lat, lon: spot.lon, dist: 1.55 }, 2.8);
      return true;
    },
  },
  {
    id: "ships",
    hold: 8,
    run: (e) => {
      const snap = e.traffic.shipSnap;
      const spot = snap && busiestRegion(snap, COORD_SCALE);
      if (!spot) return false;
      e.setFocus("ships");
      e.rig.flyTo({ lat: spot.lat, lon: spot.lon, dist: 1.5 }, 2.8);
      return true;
    },
  },
  {
    id: "quake",
    hold: 8,
    run: (e) => {
      const s = useOrbis.getState();
      const q = strongestQuake(s.quakes, e.clock.now());
      if (!q) return false;
      e.setFocus("quakes");
      s.select({ kind: "quake", quake: q });
      e.rig.flyTo({ lat: q.lat, lon: q.lon, dist: 2.1 }, 2.8);
      return true;
    },
  },
  {
    id: "fires",
    hold: 7,
    run: (e) => {
      const s = useOrbis.getState();
      if (!s.fireSpot) return false;
      s.select(null);
      e.setFocus("fires");
      e.rig.flyTo({ lat: s.fireSpot.lat, lon: s.fireSpot.lon, dist: 2 }, 2.8);
      return true;
    },
  },
  {
    id: "night",
    hold: 7,
    run: (e) => {
      const n = nightSpot(sunPosition(e.clock.now()));
      e.setFocus("lights");
      e.rig.flyTo({ lat: n.lat, lon: n.lon, dist: 3 }, 2.8);
      return true;
    },
  },
  {
    id: "aurora",
    hold: 7,
    run: (e) => {
      const n = nightSpot(sunPosition(e.clock.now()));
      e.setFocus("aurora");
      e.rig.flyTo({ lat: 66, lon: n.lon, dist: 2.6 }, 2.8);
      return true;
    },
  },
  {
    id: "moon",
    hold: 12,
    run: (e) => {
      useOrbis.getState().select(null);
      e.setFocus(null);
      e.goToSystem({ kind: "major", id: "moon" });
      return true;
    },
  },
  {
    id: "saturn",
    hold: 11,
    run: () => {
      useOrbis.getState().focusOn({ kind: "major", id: "saturn" });
      return true;
    },
  },
  {
    id: "craft",
    hold: 10,
    run: (e) => {
      const i = e.system.craft.findIndex((c) => /voyager 1/i.test(c.name));
      if (i < 0) return false;
      useOrbis.getState().focusOn({ kind: "craft", index: i });
      return true;
    },
  },
  {
    id: "overview",
    hold: 13,
    run: (e) => {
      useOrbis.getState().selectBody(null);
      e.overview();
      e.setTime(e.clock.now(), 86_400 * 30);
      return true;
    },
  },
  {
    id: "home",
    hold: 12,
    run: (e) => {
      e.goLive();
      e.returnToEarth();
      return true;
    },
  },
];

export function Tour() {
  const t = useDict();
  const engine = useOrbis((s) => s.engine);
  const on = useOrbis((s) => s.tour);
  const setTour = useOrbis((s) => s.setTour);
  const [index, setIndex] = useState(-1);
  const timer = useRef(0);
  const indexRef = useRef(-1);

  useEffect(() => {
    if (!on || !engine) return;
    const e = engine;
    const advance = (from: number) => {
      let i = from + 1;
      while (i < STEPS.length && !STEPS[i].run(e)) i++;
      indexRef.current = i;
      setIndex(i);
      if (i >= STEPS.length) {
        timer.current = window.setTimeout(() => setTour(false), 5000);
        return;
      }
      timer.current = window.setTimeout(() => advance(i), STEPS[i].hold * 1000);
    };
    const stop = () => setTour(false);
    e.watchUser(stop);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") stop();
    };
    window.addEventListener("keydown", onKey);
    advance(-1);
    return () => {
      window.clearTimeout(timer.current);
      window.removeEventListener("keydown", onKey);
      e.watchUser(null);
      e.setFocus(null);
      e.rig.setAutoRotate(0);
      if (!useOrbis.getState().time.live) e.goLive();
      indexRef.current = -1;
      setIndex(-1);
    };
  }, [on, engine, setTour]);

  const next = () => {
    if (!engine) return;
    window.clearTimeout(timer.current);
    const from = indexRef.current;
    let i = from + 1;
    while (i < STEPS.length && !STEPS[i].run(engine)) i++;
    indexRef.current = i;
    setIndex(i);
    if (i >= STEPS.length) timer.current = window.setTimeout(() => setTour(false), 5000);
    else timer.current = window.setTimeout(() => next(), STEPS[i].hold * 1000);
  };

  if (!on || index < 0) return null;
  const done = index >= STEPS.length;
  const step = done ? null : STEPS[index];
  return (
    <section
      aria-label={t.tour.open}
      aria-live="polite"
      className="bezel pointer-events-auto absolute top-[calc(max(1rem,env(safe-area-inset-top))+4.25rem)] left-1/2 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 animate-[card-in_0.7s_var(--ease-orbit)]"
    >
      <div className="bezel-core px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5" aria-hidden>
              {STEPS.map((s, i) => (
                <span key={s.id} className={`h-1 rounded-full transition-all duration-500 ease-[var(--ease-orbit)] ${i === index ? "w-5 bg-foil" : i < index ? "w-1.5 bg-lunar/60" : "w-1.5 bg-lunar/20"}`} />
              ))}
            </p>
            <h2 key={index} className="mt-2.5 font-display text-base leading-snug font-medium tracking-tight animate-[card-in_0.6s_var(--ease-orbit)]">
              {step ? t.tour.steps[step.id].title : t.tour.steps.home.title}
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-haze">{step ? t.tour.steps[step.id].text : t.tour.end}</p>
          </div>
          <button type="button" onClick={() => setTour(false)} aria-label={t.tour.stop} className="-mt-1 -mr-2 flex size-9 shrink-0 items-center justify-center rounded-full text-haze transition-colors duration-300 hover:bg-white/[0.06] hover:text-lunar">
            <Close className="size-4" />
          </button>
        </div>
        {!done && (
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={next} className="rounded-full border border-hairline px-3.5 py-1.5 text-xs text-lunar transition-colors duration-300 hover:border-foil/50">
              {t.tour.skip}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
