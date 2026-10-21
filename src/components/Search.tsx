"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useDict } from "@/i18n/client";
import { fill } from "@/i18n/config";
import { search, type SearchCandidate, type SearchResult } from "@/lib/search";
import { useOrbis } from "@/store/orbis";
import { Close, Magnifier } from "./icons";

const SWATCH: Record<SearchCandidate["kind"], string> = {
  satellite: "bg-ion",
  plane: "bg-contrail",
  ship: "bg-aurora",
  quake: "bg-seismic",
};

/** Command palette: one box that finds satellites, flights, ships and quakes, then flies there. */
export function Search() {
  const t = useDict();
  const engine = useOrbis((s) => s.engine);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<SearchCandidate[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open || !engine) return;
    let alive = true;
    engine.searchCandidates().then((c) => alive && setCandidates(c));
    requestAnimationFrame(() => input.current?.focus());
    return () => {
      alive = false;
    };
  }, [open, engine]);

  const results = useMemo(() => search(query, candidates), [query, candidates]);

  const close = () => {
    setOpen(false);
    setQuery("");
    setActive(0);
  };

  const choose = (r: SearchResult) => {
    engine?.focusResult(r.kind, r.key);
    close();
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="bezel pointer-events-auto rounded-full p-1"
        aria-label={t.search.open}
      >
        <span className="bezel-core flex items-center gap-2 rounded-full px-3.5 py-2.5 text-sm text-haze">
          <Magnifier className="size-4 text-lunar" />
          <span className="hidden 2xl:inline">{t.search.open}</span>
          <kbd className="hidden rounded-md border border-hairline px-1.5 text-[11px] text-dim 2xl:inline">/</kbd>
        </span>
      </button>

      {open && (
        <div
          className="pointer-events-auto fixed inset-0 z-40 flex items-start justify-center bg-black/55 px-4 pt-[12dvh] backdrop-blur-sm"
          onMouseDown={(e) => e.target === e.currentTarget && close()}
        >
          <div role="dialog" aria-modal="true" aria-label={t.search.open} className="bezel w-full max-w-xl animate-[card-in_0.5s_var(--ease-orbit)]">
            <div className="bezel-core overflow-hidden">
              <div className="flex items-center gap-3 border-b border-hairline px-4">
                <Magnifier className="size-5 shrink-0 text-haze" />
                <input
                  ref={input}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") close();
                    if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, results.length - 1));
                    if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
                    if (e.key === "Enter" && results[active]) choose(results[active]);
                  }}
                  placeholder={t.search.placeholder}
                  aria-label={t.search.placeholder}
                  className="h-14 w-full bg-transparent text-base text-lunar outline-none placeholder:text-dim"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="button" onClick={close} aria-label={t.search.close} className="rounded-full p-2 text-haze hover:text-lunar">
                  <Close className="size-4" />
                </button>
              </div>
              <ul className="max-h-[55dvh] overflow-y-auto p-2" role="listbox">
                {query.trim().length < 2 && <li className="px-3 py-4 text-sm text-dim">{t.search.hint}</li>}
                {query.trim().length >= 2 && !results.length && (
                  <li className="px-3 py-4 text-sm text-dim">{fill(t.search.empty, { q: query.trim() })}</li>
                )}
                {results.map((r, i) => (
                  <li key={`${r.kind}-${r.key}`} role="option" aria-selected={i === active}>
                    <button
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(r)}
                      className={`flex w-full items-center gap-3 rounded-[0.9rem] px-3 py-2.5 text-left transition-colors duration-200 ${i === active ? "bg-white/[0.06]" : ""}`}
                    >
                      <span className={`size-1.5 shrink-0 rounded-full ${SWATCH[r.kind]}`} />
                      <span className="min-w-0 flex-1 truncate text-sm text-lunar">{r.label}</span>
                      <span className="readout hidden truncate text-xs text-dim sm:inline">{r.sub}</span>
                      <span className="shrink-0 text-xs text-haze">{t.search.groups[r.kind]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
