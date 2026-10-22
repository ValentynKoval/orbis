"use client";

import { useEffect, useState } from "react";
import { useDict, useLocale } from "@/i18n/client";
import { fill } from "@/i18n/config";
import { formatNumber, formatUtc } from "@/lib/format";
import { AU_KM } from "@/lib/orbits";
import type { CloseApproach } from "@/lib/feeds/bodies";
import type { SolarWind } from "@/lib/feeds/sun";
import { useOrbis } from "@/store/orbis";
import { BODY_COLORS, MAJOR, RADIUS_KM, type BodyRef, type MajorBody } from "@/engine/SolarSystem";
import { Close, Target } from "./icons";
import { useClockFormat, useNow } from "./hooks";

const sameRef = (a: BodyRef | null, b: BodyRef | null) =>
  !!a && !!b && a.kind === b.kind && (a.kind === "major" ? a.id === (b as { id: MajorBody }).id : a.index === (b as { index: number }).index);

/** Rates in simulated seconds per real second for the heliocentric view. */
const RATES: [number, string][] = [
  [3600, "1 h/s"],
  [86_400, "1 d/s"],
  [86_400 * 30, "1 mo/s"],
];

function distance(au: number, locale: "uk" | "en", t: ReturnType<typeof useDict>) {
  if (au < 0.02) return `${formatNumber(Math.round(au * AU_KM), locale)} ${t.units.km}`;
  return `${formatNumber(au, locale, 2)} ${t.units.au} (${formatNumber(au * AU_KM / 1e6, locale, 0)} ${t.units.mkm})`;
}

function lightTime(au: number, t: ReturnType<typeof useDict>, locale: "uk" | "en") {
  const s = (au * AU_KM) / 299_792.458;
  if (s < 90) return `${formatNumber(s, locale, 1)} ${t.units.s}`;
  if (s < 5400) return `${formatNumber(s / 60, locale, 1)} ${t.units.min}`;
  return `${formatNumber(s / 3600, locale, 2)} ${t.units.h}`;
}

export function SystemHud() {
  const t = useDict();
  const engine = useOrbis((s) => s.engine);
  const selected = useOrbis((s) => s.selectedBody);
  const focus = useOrbis((s) => s.focusBody);
  const selectBody = useOrbis((s) => s.selectBody);
  const focusOn = useOrbis((s) => s.focusOn);
  const time = useOrbis((s) => s.time);
  const now = useNow(time.live ? 1000 : 200);
  const sim = engine?.clock.now() ?? now;
  const clock = useClockFormat();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") selectBody(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectBody]);


  return (
    <>
      {/* Bodies list */}
      <section aria-label={t.system.title} className="bezel pointer-events-auto absolute top-24 left-4 hidden w-[17rem] md:block">
        <div className="bezel-core p-2">
          <p className="px-3 pt-1.5 pb-2 text-xs text-haze">{t.system.title}</p>
          <ul className="flex flex-col">
            {MAJOR.map((id) => {
              const ref: BodyRef = { kind: "major", id };
              const active = sameRef(ref, focus);
              return (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => focusOn(ref)}
                    className={`flex w-full items-center gap-3 rounded-[0.9rem] px-3 py-2 text-left text-sm transition-colors duration-300 hover:bg-white/[0.04] ${active ? "text-foil" : "text-lunar"} ${id === "moon" ? "pl-7" : ""}`}
                  >
                    <span className="size-2 rounded-full" style={{ background: BODY_COLORS[id] }} />
                    {t.bodies[id]}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-1 border-t border-hairline px-1 pt-2">
            <button
              type="button"
              onClick={() => engine?.returnToEarth()}
              className="flex w-full items-center gap-3 rounded-[0.9rem] px-2 py-2 text-left text-sm text-haze transition-colors duration-300 hover:bg-white/[0.04] hover:text-lunar"
            >
              <Target className="size-4" />
              {t.system.backToEarth}
            </button>
          </div>
        </div>
      </section>

      {/* Phones: the bodies list is a select. */}
      <label className="bezel pointer-events-auto absolute bottom-[calc(max(1rem,env(safe-area-inset-bottom))+4.5rem)] left-4 rounded-full p-1 md:hidden">
        <span className="sr-only">{t.system.title}</span>
        <select
          value={focus.kind === "major" ? focus.id : ""}
          onChange={(ev) => ev.target.value && focusOn({ kind: "major", id: ev.target.value as MajorBody })}
          className="bezel-core appearance-none rounded-full bg-transparent px-4 py-2.5 text-sm text-lunar"
        >
          {MAJOR.map((id) => (
            <option key={id} value={id} className="bg-black">
              {t.bodies[id]}
            </option>
          ))}
        </select>
      </label>

      {selected && <BodyCard selection={selected} />}

      {/* Time: the heliocentric view may run far from now, in either direction. */}
      <section
        aria-label={t.system.timeLabel}
        className="bezel pointer-events-auto absolute inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] md:inset-x-auto md:left-1/2 md:w-[min(38rem,calc(100vw-40rem))] md:min-w-[24rem] md:-translate-x-1/2"
      >
        <div className="bezel-core flex flex-wrap items-center gap-2 px-3 py-2">
          <div className="flex items-center rounded-full border border-hairline p-0.5" role="group" aria-label={t.timeline.speed}>
            {RATES.map(([rate, label]) => (
              <button
                key={rate}
                type="button"
                aria-pressed={!time.live && time.rate === rate}
                onClick={() => engine?.setTime(sim, rate)}
                className={`readout rounded-full px-2 py-0.5 text-[11px] transition-colors duration-300 ${!time.live && time.rate === rate ? "bg-white/10 text-lunar" : "text-dim hover:text-haze"}`}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={!time.live && time.rate === 0}
              onClick={() => engine?.setTime(sim, 0)}
              className={`readout rounded-full px-2 py-0.5 text-[11px] ${!time.live && time.rate === 0 ? "bg-white/10 text-lunar" : "text-dim hover:text-haze"}`}
            >
              {t.timeline.pause}
            </button>
          </div>
          <div className="flex items-center gap-1">
            {[-365, -30, 30, 365].map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => engine?.setTime(sim + days * 86_400_000, time.live ? 0 : time.rate)}
                className="readout rounded-full border border-hairline px-2 py-0.5 text-[11px] text-dim hover:text-lunar"
              >
                {days > 0 ? "+" : "−"}
                {Math.abs(days) === 365 ? t.units.year : t.units.month}
              </button>
            ))}
          </div>
          <p className="readout ml-auto text-xs text-lunar" suppressHydrationWarning>
            {`${clock.time(sim)} ${clock.label(sim)}`}
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
      </section>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-hairline py-2.5 first:border-t-0">
      <dt className="text-xs text-haze">{label}</dt>
      <dd className="readout text-right text-sm text-lunar">{children}</dd>
    </div>
  );
}

function BodyCard({ selection }: { selection: BodyRef }) {
  const t = useDict();
  const locale = useLocale();
  const engine = useOrbis((s) => s.engine);
  const selectBody = useOrbis((s) => s.selectBody);
  const focusOn = useOrbis((s) => s.focusOn);
  const now = useNow(1000);
  const [approaches, setApproaches] = useState<CloseApproach[] | null>(null);
  const [sun, setSun] = useState<{ wind: SolarWind | null; image: { url: string; at: number | null } | null } | null>(null);
  const sim = engine?.clock.now() ?? now;
  const clock = useClockFormat();
  const sys = engine?.system;
  const isEarth = selection.kind === "major" && selection.id === "earth";
  const isSun = selection.kind === "major" && selection.id === "sun";

  useEffect(() => {
    if (!isSun || sun) return;
    fetch("/api/sun")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { wind: SolarWind | null; image: { url: string; at: number | null } | null } | null) => d && setSun(d))
      .catch(() => setSun({ wind: null, image: null }));
  }, [isSun, sun]);

  useEffect(() => {
    if (!isEarth || approaches) return;
    fetch("/api/approaches")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { approaches: CloseApproach[] } | null) => d && setApproaches(d.approaches))
      .catch(() => setApproaches([]));
  }, [isEarth, approaches]);

  if (!sys) return null;
  const pos = sys.heliocentric(selection, sim);
  const earth = sys.heliocentric({ kind: "major", id: "earth" }, sim)!;
  const fromSun = pos ? Math.hypot(...pos) : 0;
  const fromEarth = pos ? Math.hypot(pos[0] - earth[0], pos[1] - earth[1], pos[2] - earth[2]) : 0;
  const name = selection.kind === "major" ? t.bodies[selection.id] : sys.name(selection);
  const kicker = selection.kind === "major" ? t.system.kinds[selection.id === "sun" ? "star" : selection.id === "moon" ? "moon" : "planet"] : t.system.kinds[selection.kind];
  const rows: [string, React.ReactNode][] = [];
  if (!(selection.kind === "major" && selection.id === "sun")) rows.push([t.system.fromSun, distance(fromSun, locale, t)]);
  if (!isEarth) rows.push([t.system.fromEarth, distance(fromEarth, locale, t)], [t.system.lightTime, lightTime(fromEarth, t, locale)]);
  if (selection.kind === "major") rows.push([t.system.diameter, `${formatNumber(RADIUS_KM[selection.id] * 2, locale)} ${t.units.km}`]);
  else if (selection.kind === "craft") {
    const c = sys.craft[selection.index];
    const speed = sys.craftSpeed(selection.index, sim);
    if (c) rows.push([t.system.launched, c.launched]);
    if (speed !== null) rows.push([t.card.speed, `${formatNumber(speed, locale, 1)} ${t.units.kms}`]);
  } else {
    const rec = selection.kind === "comet" ? sys.comets[selection.index] : sys.asteroids[selection.index];
    if (rec?.diameterKm) rows.push([t.system.diameter, `${formatNumber(rec.diameterKm, locale)} ${t.units.km}`]);
    if (rec?.periodYears) rows.push([t.system.period, `${formatNumber(rec.periodYears, locale, 1)} ${t.units.years}`]);
    if (rec?.el.q) rows.push([t.system.perihelion, distance(rec.el.q, locale, t)]);
    if (rec?.el.tp) rows.push([t.system.perihelionDate, formatUtc((rec.el.tp - 2440587.5) * 86_400_000, locale).replace(/,.*$/, "")]);
    rows.push([t.system.eccentricity, formatNumber(rec.el.e, locale, 3)]);
  }

  return (
    <aside
      aria-label={name}
      className="bezel pointer-events-auto absolute right-4 bottom-[calc(max(1rem,env(safe-area-inset-bottom))+4.5rem)] max-h-[calc(100dvh-14rem)] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto animate-[card-in_0.7s_var(--ease-orbit)] md:top-24 md:bottom-auto"
    >
      <div className="bezel-core p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-aurora">{kicker}</p>
            <h2 className="mt-1.5 font-display text-lg leading-snug font-medium tracking-tight break-words">{name}</h2>
          </div>
          <button type="button" onClick={() => selectBody(null)} aria-label={t.card.close} className="-mt-1 -mr-1 flex size-9 shrink-0 items-center justify-center rounded-full text-haze hover:bg-white/[0.06] hover:text-lunar">
            <Close className="size-4" />
          </button>
        </div>
        <dl className="mt-4">
          {rows.map(([label, value]) => (
            <Row key={label} label={label}>
              {value}
            </Row>
          ))}
        </dl>
        {isSun && sun && (sun.image || sun.wind) && (
          <div className="mt-4 border-t border-hairline pt-3">
            <p className="text-xs text-haze">{t.sun.live}</p>
            {sun.image && (
              <figure className="mt-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- a live frame proxied from NASA, not a static asset */}
                <img src={`${sun.image.url}?v=${sun.image.at ?? 0}`} alt={t.sun.live} width={512} height={512} className="aspect-square w-full rounded-[0.9rem] bg-black object-cover" />
                <figcaption className="mt-1.5 text-[11px] text-dim">{fill(t.sun.image, { time: sun.image.at ? `${clock.time(sun.image.at)} ${clock.label(sun.image.at)}` : "—" })}</figcaption>
              </figure>
            )}
            {sun.wind && (
              <dl className="mt-2">
                <Row label={t.sun.wind}>{`${formatNumber(sun.wind.speed, locale)} ${t.units.kms}`}</Row>
                <Row label={t.sun.field}>{`${formatNumber(sun.wind.bt, locale, 1)} nT, ${t.sun.bz} ${sun.wind.bz > 0 ? "+" : ""}${formatNumber(sun.wind.bz, locale, 1)} nT`}</Row>
              </dl>
            )}
            {sun.wind && <p className="mt-2 text-[11px] leading-relaxed text-dim">{t.sun.windNote}</p>}
          </div>
        )}
        {isEarth && approaches && approaches.length > 0 && (
          <div className="mt-4 border-t border-hairline pt-3">
            <p className="text-xs text-haze">{t.system.approaches}</p>
            <ul className="mt-2 space-y-1.5">
              {approaches.slice(0, 6).map((a) => (
                <li key={`${a.name}-${a.time}`} className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="truncate text-lunar">{a.name}</span>
                  <span className="readout shrink-0 text-haze">
                    {formatUtc(a.time, locale).replace(/,.*$/, "")}, {formatNumber(a.distanceLd, locale, 1)} LD
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-dim">{fill(t.system.approachesNote, { n: approaches.length })}</p>
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => focusOn(selection)}
            className="inline-flex items-center gap-2 rounded-full border border-hairline px-3.5 py-2 text-xs text-lunar transition-colors duration-300 hover:border-foil/50"
          >
            <Target className="size-3.5" />
            {t.system.goThere}
          </button>
        </div>
      </div>
    </aside>
  );
}
