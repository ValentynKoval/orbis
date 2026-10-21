"use client";

import { useRef } from "react";
import { useDict, useLocale } from "@/i18n/client";
import { fill } from "@/i18n/config";
import { formatUtc } from "@/lib/format";
import { useOrbis } from "@/store/orbis";
import { useNow } from "./hooks";

const SPAN_MS = 24 * 3600_000;
const RATES = [1, 60, 600] as const;
const REPLAY_FROM_MS = 3 * 3600_000;

function offsetLabel(ms: number, t: ReturnType<typeof useDict>) {
  const min = Math.round(ms / 60_000);
  if (min < 1) return t.timeline.now;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return fill(t.timeline.ago, { h: String(h), m: String(m).padStart(2, "0") });
}

/** The last 24 hours as a scrubber: drag to any moment, play it back, or return to live. */
export function Timeline() {
  const t = useDict();
  const locale = useLocale();
  const engine = useOrbis((s) => s.engine);
  const time = useOrbis((s) => s.time);
  /** Speed to resume with after a pause. */
  const lastRate = useRef(60);
  // Re-render often enough for a smooth playhead during playback.
  const wall = useNow(time.live ? 1000 : 250);
  const sim = engine?.clock.now() ?? wall;
  const start = wall - SPAN_MS;
  const historyStart = engine?.historyStart ?? null;
  const paused = !time.live && time.rate === 0;
  const playRate = time.live || time.rate === 0 ? lastRate.current : time.rate;

  const seek = (value: number) => engine?.setTime(value, paused ? 0 : time.live ? 1 : time.rate);
  const togglePlay = () => {
    if (!engine) return;
    if (time.live) engine.setTime(sim, 0);
    else if (paused) engine.setTime(sim, playRate);
    else {
      lastRate.current = time.rate;
      engine.setTime(sim, 0);
    }
  };
  const setRate = (rate: number) => {
    lastRate.current = rate;
    if (!engine) return;
    // From live, a faster speed means "replay the recent past": start three hours back.
    const from = time.live ? (rate === 1 ? sim - 60_000 : Math.max(start, sim - REPLAY_FROM_MS)) : sim;
    engine.setTime(from, rate);
  };

  const recorded = historyStart !== null ? Math.max(0, (historyStart - start) / SPAN_MS) : 1;
  const ticks = [0, 6, 12, 18, 24].map((h) => start + h * 3600_000);

  return (
    <section
      aria-label={t.timeline.label}
      className="bezel pointer-events-auto absolute inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] md:inset-x-auto md:left-1/2 md:w-[min(40rem,calc(100vw-42rem))] md:min-w-[26rem] md:-translate-x-1/2"
    >
      <div className="bezel-core flex flex-col gap-2 px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={togglePlay}
            aria-label={paused || time.live ? t.timeline.play : t.timeline.pause}
            className="flex size-8 shrink-0 items-center justify-center rounded-full border border-hairline text-lunar transition-colors duration-300 hover:border-foil/50"
          >
            {paused || time.live ? (
              <svg viewBox="0 0 24 24" className="size-3.5 translate-x-px" fill="currentColor" aria-hidden>
                <path d="M7 5.5v13l11-6.5z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor" aria-hidden>
                <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
              </svg>
            )}
          </button>
          <div className="flex items-center rounded-full border border-hairline p-0.5" role="group" aria-label={t.timeline.speed}>
            {RATES.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={!time.live && time.rate === r}
                onClick={() => setRate(r)}
                className={`readout rounded-full px-2 py-0.5 text-[11px] transition-colors duration-300 ${!time.live && time.rate === r ? "bg-white/10 text-lunar" : "text-dim hover:text-haze"}`}
              >
                {r}×
              </button>
            ))}
          </div>
          <p className="readout ml-auto truncate text-right text-xs text-haze" aria-live="polite">
            <span className="text-lunar" suppressHydrationWarning>
              {formatUtc(sim, locale)} {t.hud.utc}
            </span>
            <span className="hidden sm:inline">, {offsetLabel(wall - sim, t)}</span>
          </p>
          <button
            type="button"
            onClick={() => engine?.goLive()}
            disabled={time.live}
            className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors duration-300 ${time.live ? "text-lunar" : "bg-foil text-black"}`}
          >
            <span className={`size-1.5 rounded-full ${time.live ? "bg-seismic" : "bg-black/60"}`} />
            {time.live ? t.hud.live : t.timeline.goLive}
          </button>
        </div>
        <div className="relative h-6">
          {/* Where recorded aircraft and ships exist; other layers cover the whole day. */}
          <div aria-hidden className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/[0.07]">
            <div className="absolute inset-y-0 right-0 rounded-full bg-foil/25" style={{ left: `${recorded * 100}%` }} />
          </div>
          <input
            type="range"
            className="timeline-range absolute inset-0 w-full"
            min={start}
            max={wall}
            step={60_000}
            value={Math.max(start, Math.min(wall, sim))}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label={t.timeline.label}
            aria-valuetext={`${formatUtc(sim, locale)} ${t.hud.utc}`}
          />
        </div>
        <div aria-hidden className="readout flex justify-between text-[10px] text-dim" suppressHydrationWarning>
          {ticks.map((tick, i) => (
            <span key={i}>{i === ticks.length - 1 ? t.timeline.now : formatUtc(tick, locale, false).slice(0, 5)}</span>
          ))}
        </div>
        {!time.live && historyStart !== null && sim < historyStart && (
          <p className="text-[11px] text-dim">{fill(t.timeline.noTraffic, { time: formatUtc(historyStart, locale) })}</p>
        )}
      </div>
    </section>
  );
}

