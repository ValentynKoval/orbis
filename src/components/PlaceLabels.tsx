"use client";

import { useEffect, useRef } from "react";
import { useDict } from "@/i18n/client";
import { PLACE_COLORS, PLACES } from "@/lib/places";
import { ALERT_COLORS } from "@/lib/feeds/storms";
import { useOrbis } from "@/store/orbis";
import type { Engine } from "@/engine/Engine";

const LINE = 18;
const CHAR = 6.4;
/** Storm names sit to the right of the swirl, at least this far from the eye. */
const STORM_OFFSET = 14;

interface PinSet {
  /** Ids in priority order: when two names would collide, the earlier keeps its name. */
  order: string[];
  names: Record<string, string>;
  /** Named at any distance, not only once the region fills the view. */
  always: Set<string>;
}

/** Every visible glass panel; pins and names stay out from under them, where they would show through. */
function panelRects(): DOMRect[] {
  return [...document.querySelectorAll<HTMLElement>(".bezel")]
    .filter((el) => el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? true)
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0);
}

/** Moves the pins every frame as the engine reports where they are; returns the unsubscribe. */
function followPins(engine: Engine, pins: Map<string, HTMLButtonElement>, labels: Map<string, HTMLSpanElement>, set: () => PinSet) {
  const byId = new Map<string, { x: number; y: number; alpha: number; r?: number }>();
  let panels: DOMRect[] = [];
  let panelsAt = 0;
  const under = (l: number, t: number, r: number, b: number) => panels.some((p) => l < p.right + 4 && r > p.left - 4 && t < p.bottom + 4 && b > p.top - 4);
  engine.watchPlaces((items) => {
    const now = performance.now();
    // Panels move rarely; reading their boxes a few times a second keeps layout reads out of most frames.
    if (now - panelsAt > 250) {
      panels = panelRects();
      panelsAt = now;
    }
    const { order, names, always } = set();
    for (const it of items) byId.set(it.id, it);
    const close = engine.rig.pose.dist < 2.4;
    const boxes: [number, number, number, number][] = [];
    for (const id of order) {
      const it = byId.get(id);
      const el = pins.get(id);
      const label = labels.get(id);
      if (!it || !el || !label) continue;
      const shift = always.has(id) ? Math.max(STORM_OFFSET, (it.r ?? 0) + 6) : 0;
      const shown = it.alpha > 0.02 && !under(it.x - 5, it.y - 5, it.x + 5, it.y + 5);
      el.style.opacity = String(it.alpha);
      el.style.visibility = shown ? "visible" : "hidden";
      el.style.transform = `translate3d(${it.x - 5 + shift}px, ${it.y - LINE / 2}px, 0)`;
      let showName = false;
      if (shown && (close || always.has(id))) {
        const box: [number, number, number, number] = [it.x + shift, it.y - LINE / 2, it.x + shift + 22 + (names[id]?.length ?? 10) * CHAR, it.y + LINE / 2];
        if (!boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]) && !under(...box)) {
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
 * Landmark pins and storm names over the globe. The engine reports every pin's screen position each frame
 * and this layer moves the elements directly (no React render per frame), so pins stay glued to the ground
 * while the globe turns. Landmark names show once the region fills the view, storm names from orbit; when two
 * would collide, the storm and then the bigger landmark keep theirs, and nothing shows through a panel.
 */
export function PlaceLabels() {
  const t = useDict();
  const engine = useOrbis((s) => s.engine);
  const select = useOrbis((s) => s.select);
  const selected = useOrbis((s) => (s.selection?.kind === "place" ? s.selection.id : s.selection?.kind === "storm" ? `storm:${s.selection.id}` : null));
  const storms = useOrbis((s) => s.stormPins);
  const space = useOrbis((s) => s.space);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const labels = useRef(new Map<string, HTMLSpanElement>());
  const pinSet = useRef<PinSet>({ order: [], names: {}, always: new Set() });

  useEffect(() => {
    const places = [...PLACES].sort((a, b) => b.rank - a.rank);
    pinSet.current = {
      order: [...storms.map((s) => `storm:${s.id}`), ...places.map((p) => p.id)],
      names: Object.fromEntries([...storms.map((s) => [`storm:${s.id}`, s.name]), ...PLACES.map((p) => [p.id, t.places.items[p.id].name])]),
      always: new Set(storms.map((s) => `storm:${s.id}`)),
    };
  }, [storms, t]);

  useEffect(() => {
    if (!engine) return;
    return followPins(engine, refs.current, labels.current, () => pinSet.current);
  }, [engine]);

  return (
    // Pins belong to the Earth; in the heliocentric scene they fade away with the rest of the Earth HUD.
    <div className={`pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-700 ${space === "earth" ? "opacity-100" : "invisible opacity-0"}`}>
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
      {storms.map((s) => {
        const id = `storm:${s.id}`;
        return (
          <button
            key={id}
            ref={(el) => {
            if (el) refs.current.set(id, el);
            else refs.current.delete(id);
          }}
            type="button"
            onClick={() => {
              select({ kind: "storm", id: s.id });
              engine?.ambience.ping();
            }}
            aria-label={s.name}
            className="pointer-events-auto invisible absolute top-0 left-0 flex items-center whitespace-nowrap will-change-transform"
            style={{ opacity: 0 }}
          >
            <span
              ref={(el) => {
            if (el) labels.current.set(id, el);
            else labels.current.delete(id);
          }}
              className={`font-display text-xs font-medium tracking-tight transition-opacity duration-300 ${selected === id ? "underline underline-offset-4" : ""}`}
              style={{ opacity: 0, color: ALERT_COLORS[s.alert], textShadow: "0 1px 6px rgb(0 0 0 / 0.95)" }}
            >
              {s.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}
