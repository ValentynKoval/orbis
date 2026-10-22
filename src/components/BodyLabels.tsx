"use client";

import { useEffect, useState } from "react";
import { useDict } from "@/i18n/client";
import { layoutLabels } from "@/lib/labels";
import { useOrbis } from "@/store/orbis";
import { BODY_COLORS, type BodyRef } from "@/engine/SolarSystem";

const sameRef = (a: BodyRef | null, b: BodyRef | null) =>
  !!a && !!b && a.kind === b.kind && (a.kind === "major" ? a.id === (b as { id: string }).id : a.index === (b as { index: number }).index);

function useViewport() {
  const [size, setSize] = useState({ width: 1, height: 1 });
  useEffect(() => {
    const update = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    const id = window.setTimeout(update, 0);
    window.addEventListener("resize", update);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("resize", update);
    };
  }, []);
  return size;
}

/**
 * Names next to the Sun, Moon, planets, comets and probes, in both scenes:
 * the same elements carry across the hand-over, so a label never blinks.
 * Overlapping labels step aside (or yield) by priority.
 */
export function BodyLabels() {
  const t = useDict();
  const engine = useOrbis((s) => s.engine);
  const labels = useOrbis((s) => s.systemLabels);
  const space = useOrbis((s) => s.space);
  const selected = useOrbis((s) => s.selectedBody);
  const focus = useOrbis((s) => s.focusBody);
  const selectBody = useOrbis((s) => s.selectBody);
  const focusOn = useOrbis((s) => s.focusOn);
  const { width, height } = useViewport();

  const items = labels
    .filter((l) => space === "system" || l.ref.kind === "major")
    .map((l) => {
      const key = l.ref.kind === "major" ? l.ref.id : `${l.ref.kind}-${l.ref.index}`;
      const text = l.ref.kind === "major" ? t.bodies[l.ref.id] : (engine?.system.name(l.ref) ?? "");
      const isSel = sameRef(l.ref, selected);
      const isFocus = space === "system" && sameRef(l.ref, focus);
      const priority = isSel ? 5 : isFocus ? 4 : l.ref.kind === "major" ? (l.ref.id === "moon" ? 2 : 3) : 1;
      return { ...l, key, text, isSel, isFocus, priority };
    });
  // Keep clear of the top bar and the corner buttons.
  const chrome: [number, number, number, number][] = [[0, 0, width, 72]];
  const layout = layoutLabels(items, width, height, chrome);

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {items.map((l) => {
        const place = layout.get(l.key)!;
        const comet = l.ref.kind === "comet";
        const craft = l.ref.kind === "craft";
        const color = l.ref.kind === "major" ? BODY_COLORS[l.ref.id] : l.isSel ? "#f2c14e" : craft ? "#ff8ad8" : "#7ee7e1";
        // The body being orbited is obvious once it fills the view.
        const hidden = place.hidden || (l.isFocus && l.px > 60);
        const ref = l.ref;
        return (
          <button
            key={l.key}
            type="button"
            tabIndex={hidden ? -1 : 0}
            onClick={() => (space === "earth" ? engine?.goToSystem(ref) : selectBody(ref))}
            onDoubleClick={() => space === "system" && focusOn(ref)}
            className={`absolute whitespace-nowrap rounded-full px-1.5 py-0.5 text-[11px] leading-[14px] transition-opacity duration-500 ${hidden ? "pointer-events-none opacity-0" : "pointer-events-auto opacity-100"} ${l.isSel ? "text-foil" : comet ? "text-aurora/80" : craft ? "text-[#ff8ad8]/90" : "text-lunar/85"} hover:text-foil`}
            style={{ left: place.left, top: place.top, textShadow: "0 1px 6px rgb(0 0 0 / 0.9)" }}
          >
            <span className="mr-1.5 inline-block size-1 rounded-full align-middle" style={{ background: color }} />
            {l.text}
          </button>
        );
      })}
    </div>
  );
}
