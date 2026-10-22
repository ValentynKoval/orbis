"use client";

import { useMemo } from "react";
import { useDict, useLocale } from "@/i18n/client";
import { fill } from "@/i18n/config";
import { formatNumber } from "@/lib/format";
import { findEclipses, type Eclipse } from "@/lib/eclipses";
import { compass } from "@/lib/passes";
import { moonNow, skyFor } from "@/lib/skyview";
import { useOrbis } from "@/store/orbis";
import { useClockFormat } from "./hooks";

/** The Moon's phase and where the Moon and planets are for the observer right now. */
export function SkyTonight({ lat, lon, now }: { lat: number; lon: number; now: number }) {
  const t = useDict();
  const locale = useLocale();
  const engine = useOrbis((s) => s.engine);
  const sim = engine?.clock.now() ?? now;
  // Recomputed once a minute of simulated time: the sky turns 0.25° in that time.
  const minute = Math.floor(sim / 60_000);
  const { sun, objects, moon } = useMemo(() => {
    const ms = minute * 60_000;
    return { ...skyFor(lat, lon, ms), moon: moonNow(ms) };
  }, [lat, lon, minute]);
  const up = objects.filter((o) => o.alt > 0);

  return (
    <>
      <h3 className="mt-5 text-xs text-haze">{t.sky.moonPlanets}</h3>
      <p className="mt-2 text-sm text-lunar">
        <MoonGlyph phase={moon.phase} />
        {t.sky.phases[moon.name]}, {fill(t.sky.lit, { pct: formatNumber(moon.illuminated * 100, locale) })}
      </p>
      {sun.alt > -6 && <p className="mt-1 text-[11px] text-dim">{t.sky.daytime}</p>}
      <ul className="mt-2 space-y-1">
        {up.map((o) => (
          <li key={o.id} className="flex items-baseline justify-between gap-3 text-xs">
            <span className="text-lunar">{t.bodies[o.id]}</span>
            <span className="readout text-dim">{fill(t.sky.altAz, { alt: formatNumber(o.alt, locale), dir: compass(o.az) })}</span>
          </li>
        ))}
        {!up.length && <li className="text-xs text-dim">{t.sky.noneUp}</li>}
      </ul>
    </>
  );
}

/** A small lit-fraction icon for the phase (0 new → 0.5 full → 1 new). */
function MoonGlyph({ phase }: { phase: number }) {
  // The terminator is an ellipse whose half-width follows cos of the phase angle.
  const k = Math.cos(phase * 2 * Math.PI);
  const waxing = phase < 0.5;
  const rx = Math.abs(k) * 6;
  const litRight = waxing;
  const outer = litRight ? "M7 1 A6 6 0 0 1 7 13" : "M7 1 A6 6 0 0 0 7 13";
  const inner = `A${rx} 6 0 0 ${(k > 0) === litRight ? 0 : 1} 7 1`;
  return (
    <svg viewBox="0 0 14 14" className="mr-2 inline-block size-3.5 -translate-y-px align-middle" aria-hidden>
      <circle cx="7" cy="7" r="6" fill="rgb(255 255 255 / 0.12)" />
      <path d={`${outer} ${inner}`} fill="#e8ecf4" />
    </svg>
  );
}

/** The next eclipses anywhere on Earth, with a button that takes the globe there. */
export function EclipsesAhead({ now }: { now: number }) {
  const t = useDict();
  const engine = useOrbis((s) => s.engine);
  const clock = useClockFormat();
  const day = Math.floor(now / 86_400_000);
  const list = useMemo(() => findEclipses(day * 86_400_000, day * 86_400_000 + 3 * 365.25 * 86_400_000).slice(0, 6), [day]);

  const watch = (e: Eclipse) => {
    if (!engine) return;
    useOrbis.getState().select(null);
    engine.watchEclipse(e);
  };

  return (
    <>
      <h3 className="mt-5 text-xs text-haze">{t.sky.eclipses}</h3>
      <ul className="mt-2 divide-y divide-hairline">
        {list.map((e) => (
          <li key={e.time} className="flex items-center justify-between gap-3 py-2 text-xs">
            <div className="min-w-0">
              <p className="text-lunar">{t.sky.eclipseTypes[e.kind][e.type]}</p>
              <p className="readout text-dim" suppressHydrationWarning>{`${clock.time(e.time).replace(",", ` ${new Date(e.time).getUTCFullYear()},`)} ${clock.label(e.time)}`}</p>
            </div>
            <button type="button" onClick={() => watch(e)} className="shrink-0 rounded-full border border-hairline px-3 py-1 text-[11px] text-lunar transition-colors duration-300 hover:border-foil/50">
              {t.sky.watch}
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[10px] leading-snug text-dim">{t.sky.eclipseNote}</p>
    </>
  );
}
