"use client";

import { useEffect, useRef } from "react";
import { useDict } from "@/i18n/client";
import { PLACE_COLORS, PLACES } from "@/lib/places";
import { useOrbis } from "@/store/orbis";
import type { Engine } from "@/engine/Engine";

const LINE = 18;
const CHAR = 6.4;

/** Moves the pins every frame as the engine reports where they are; returns the unsubscribe. */
function followPins(engine: Engine, pins: Map<string, HTMLButtonElement>, labels: Map<string, HTMLSpanElement>, names: Record<string, string>) {
  const ranked = [...PLACES].sort((a, b) => b.rank - a.rank);
  const byId = new Map<string, { x: number; y: number; alpha: number }>();
  engine.watchPlaces((items) => {
    for (const it of items) byId.set(it.id, it);
    const named = engine.rig.pose.dist < 2.4;
    const boxes: [number, number, number, number][] = [];
    for (const p of ranked) {
      const it = byId.get(p.id);
      const el = pins.get(p.id);
      const label = labels.get(p.id);
      if (!it || !el || !label) continue;
      const shown = it.alpha > 0.02;
      el.style.opacity = String(it.alpha);
      el.style.visibility = shown ? "visible" : "hidden";
      el.style.transform = `translate3d(${it.x - 5}px, ${it.y - LINE / 2}px, 0)`;
      let showName = false;
      if (shown && named) {
        const box: [number, number, number, number] = [it.x, it.y - LINE / 2, it.x + 22 + (names[p.id]?.length ?? 10) * CHAR, it.y + LINE / 2];
        if (!boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) {
          boxes.push(box);
          showName = true;
        }
      }
      label.style.opacity = showName ? "1" : "0";
    }
  });
  return () => engine.watchPlaces(null);
}

/**
 * Landmark pins over the globe. The engine reports every pin's screen position
 * each frame and this layer moves the elements directly (no React render per
 * frame), so pins stay glued to the ground while the globe turns. Names show
 * once the region fills the view; when two would collide, the bigger landmark
 * keeps its name.
 */
export function PlaceLabels() {
  const t = useDict();
  const engine = useOrbis((s) => s.engine);
  const select = useOrbis((s) => s.select);
  const selected = useOrbis((s) => (s.selection?.kind === "place" ? s.selection.id : null));
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const labels = useRef(new Map<string, HTMLSpanElement>());

  useEffect(() => {
    if (!engine) return;
    const names = Object.fromEntries(PLACES.map((p) => [p.id, t.places.items[p.id].name]));
    return followPins(engine, refs.current, labels.current, names);
  }, [engine, t]);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {PLACES.map((p) => (
        <button
          key={p.id}
          ref={(el) => {
            if (el) refs.current.set(p.id, el);
            else refs.current.delete(p.id);
          }}
          type="button"
          onClick={() => {
            select({ kind: "place", id: p.id });
            engine?.ambience.ping();
          }}
          onDoubleClick={() => engine?.flyToPlace(p.id)}
          aria-label={t.places.items[p.id].name}
          className="group pointer-events-auto invisible absolute top-0 left-0 flex items-center gap-1.5 whitespace-nowrap will-change-transform"
          style={{ opacity: 0 }}
        >
          <span
            className={`block size-2.5 rotate-45 rounded-[2px] border transition-transform duration-300 ease-[var(--ease-orbit)] group-hover:scale-125 ${selected === p.id ? "scale-125" : ""}`}
            style={{ borderColor: PLACE_COLORS[p.category], background: selected === p.id ? PLACE_COLORS[p.category] : "rgb(0 0 0 / 0.55)", boxShadow: `0 0 8px ${PLACE_COLORS[p.category]}` }}
          />
          <span
            ref={(el) => {
              if (el) labels.current.set(p.id, el);
              else labels.current.delete(p.id);
            }}
            className="text-[11px] text-lunar/90 transition-opacity duration-300 group-hover:!opacity-100"
            style={{ opacity: 0, textShadow: "0 1px 6px rgb(0 0 0 / 0.95)" }}
          >
            {t.places.items[p.id].name}
          </span>
        </button>
      ))}
    </div>
  );
}
