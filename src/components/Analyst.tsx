"use client";

import { useEffect, useRef, useState } from "react";
import { useDict, useLocale } from "@/i18n/client";
import { fill } from "@/i18n/config";
import type { AnalystAction, AnalystResponse } from "@/lib/analyst/protocol";
import { search } from "@/lib/search";
import { vecToLatLon, latLonToVec } from "@/lib/geo";
import { useOrbis } from "@/store/orbis";
import type { Engine } from "@/engine/Engine";
import type { LayerKey } from "@/engine/types";
import { ArrowUpRight, Close, Spark } from "./icons";

interface Exchange {
  q: string;
  a: string;
  error?: boolean;
}

const ZOOM = { close: 1.6, region: 2.6, globe: 4.4 } as const;

async function perform(engine: Engine, actions: AnalystAction[]) {
  const store = useOrbis.getState();
  for (const action of actions) {
    if (action.type === "layers") {
      for (const key of action.show) if (!store.layers[key as LayerKey]) store.toggleLayer(key as LayerKey);
      for (const key of action.hide) if (useOrbis.getState().layers[key as LayerKey]) store.toggleLayer(key as LayerKey);
    } else if (action.type === "fly_to") {
      engine.rig.flyTo({ lat: action.lat, lon: action.lon, dist: ZOOM[action.zoom] }, 1.8);
    } else if (action.type === "select") {
      await engine.focusResult(action.kind, action.kind === "ship" ? Number(action.id) : action.id);
    } else if (action.type === "body") {
      const major = ["sun", "mercury", "venus", "earth", "moon", "mars", "jupiter", "saturn", "uranus", "neptune"] as const;
      const id = major.find((m) => m === action.id);
      if (!id) continue;
      engine.enterSystem();
      useOrbis.getState().focusOn({ kind: "major", id });
    } else if (action.type === "select_satellite") {
      const hits = search(action.name, (await engine.searchCandidates()).filter((c) => c.kind === "satellite"), 1);
      if (hits[0]) await engine.focusResult("satellite", hits[0].key);
    }
  }
}

/** "Ask Orbis": a question box whose answers come with camera moves. */
export function Analyst() {
  const t = useDict();
  const locale = useLocale();
  const engine = useOrbis((s) => s.engine);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [log, setLog] = useState<Exchange[]>([]);
  const [left, setLeft] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [log, busy]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => field.current?.focus());
  }, [open]);

  const ask = async (question: string) => {
    const q = question.trim();
    if (q.length < 2 || busy || !engine) return;
    setInput("");
    setBusy(true);
    // Answers describe the present, so leave any replay first.
    if (!useOrbis.getState().time.live) engine.goLive();
    if (engine.space === "system") engine.exitSystem();
    const centre = vecToLatLon(latLonToVec(engine.rig.pose.lat, engine.rig.pose.lon));
    try {
      const res = await fetch("/api/analyst", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, locale, view: { lat: centre.lat, lon: centre.lon }, history: log.filter((x) => !x.error).slice(-2) }),
      });
      if (!res.ok) {
        const code = ((await res.json().catch(() => ({}))) as { error?: string }).error;
        if (code === "quota") setLeft(0);
        setLog((l) => [...l, { q, a: code === "quota" ? t.analyst.quota : t.analyst.failed, error: true }]);
        return;
      }
      const data: AnalystResponse = await res.json();
      setLeft(data.left);
      setLog((l) => [...l, { q, a: data.answer || t.analyst.empty, error: !data.answer }]);
      await perform(engine, data.actions);
    } catch {
      setLog((l) => [...l, { q, a: t.analyst.failed, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="analyst"
        aria-label={t.analyst.open}
        className="bezel pointer-events-auto rounded-full p-1"
      >
        <span className={`bezel-core flex items-center gap-2 rounded-full px-3.5 py-2.5 text-sm ${open ? "text-foil" : "text-lunar"}`}>
          <Spark className="size-4" />
          <span className="hidden 2xl:inline">{t.analyst.open}</span>
        </span>
      </button>

      {open && (
        <section
          id="analyst"
          aria-label={t.analyst.open}
          className="bezel pointer-events-auto fixed inset-x-4 bottom-[calc(max(1rem,env(safe-area-inset-bottom))+7.25rem)] z-20 animate-[card-in_0.6s_var(--ease-orbit)] md:inset-x-auto md:left-1/2 md:w-[min(40rem,calc(100vw-42rem))] md:min-w-[26rem] md:-translate-x-1/2"
        >
          <div className="bezel-core flex max-h-[min(30rem,calc(100dvh-14rem))] flex-col">
            <div className="flex items-start justify-between gap-3 px-4 pt-3.5">
              <div>
                <h2 className="font-display text-sm font-medium tracking-tight">{t.analyst.title}</h2>
                <p className="mt-1 max-w-[30rem] text-[11px] leading-snug text-dim">{t.analyst.disclosure}</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} aria-label={t.analyst.close} className="-mr-1 rounded-full p-2 text-haze hover:text-lunar">
                <Close className="size-4" />
              </button>
            </div>

            <div ref={scroller} className="mt-2 flex-1 space-y-3 overflow-y-auto px-4 pb-2" aria-live="polite">
              {!log.length && !busy && (
                <ul className="flex flex-wrap gap-1.5 py-1">
                  {t.analyst.suggestions.map((s) => (
                    <li key={s}>
                      <button
                        type="button"
                        onClick={() => ask(s)}
                        className="rounded-full border border-hairline px-3 py-1.5 text-left text-xs text-haze transition-colors duration-300 hover:border-foil/45 hover:text-lunar"
                      >
                        {s}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {log.map((x, i) => (
                <div key={i} className="space-y-1.5">
                  <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-white/[0.06] px-3 py-1.5 text-sm text-haze">{x.q}</p>
                  <p className={`max-w-[95%] text-sm leading-relaxed ${x.error ? "text-dim" : "text-lunar"}`}>{x.a}</p>
                </div>
              ))}
              {busy && <p className="animate-pulse text-sm text-dim">{t.analyst.thinking}</p>}
            </div>

            <form
              className="flex items-center gap-2 border-t border-hairline p-2 pl-4"
              onSubmit={(e) => {
                e.preventDefault();
                ask(input);
              }}
            >
              <input
                ref={field}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                maxLength={300}
                placeholder={t.analyst.placeholder}
                aria-label={t.analyst.placeholder}
                className="h-10 min-w-0 flex-1 bg-transparent text-sm text-lunar outline-none placeholder:text-dim"
                disabled={left === 0}
              />
              {left !== null && <span className="readout hidden shrink-0 text-[11px] text-dim sm:inline">{fill(t.analyst.left, { n: left })}</span>}
              <button
                type="submit"
                disabled={busy || input.trim().length < 2 || left === 0}
                className="group flex shrink-0 items-center gap-2 rounded-full bg-foil py-1.5 pr-1.5 pl-4 text-xs font-medium text-black transition-opacity duration-300 disabled:opacity-40"
              >
                {t.analyst.send}
                <span className="flex size-6 items-center justify-center rounded-full bg-black/10 transition-transform duration-500 ease-[var(--ease-orbit)] group-hover:translate-x-0.5 group-hover:-translate-y-px">
                  <ArrowUpRight className="size-3.5" />
                </span>
              </button>
            </form>
          </div>
        </section>
      )}
    </>
  );
}
