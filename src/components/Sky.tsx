"use client";

import { useEffect, useState } from "react";
import { useDict, useLocale } from "@/i18n/client";
import { fill } from "@/i18n/config";
import { formatAgo, formatLatLon, formatNumber } from "@/lib/format";
import { compass, type Pass } from "@/lib/passes";
import { useOrbis } from "@/store/orbis";
import type { Overhead } from "@/engine/Engine";
import { Close, Compass, Target } from "./icons";
import { useClockFormat, useNow } from "./hooks";
import { EclipsesAhead, SkyTonight } from "./SkyExtras";

interface Weather {
  temperature: number;
  wind: number;
  windDir: number;
  clouds: number;
  /** WMO weather code bucket: clear, cloudy, fog, rain, snow, storm. */
  code: "clear" | "cloudy" | "fog" | "rain" | "snow" | "storm";
}

/** Open-Meteo, free and keyless, straight from the browser. */
async function fetchWeather(lat: number, lon: number): Promise<Weather> {
  const q = new URLSearchParams({ latitude: lat.toFixed(3), longitude: lon.toFixed(3), current: "temperature_2m,wind_speed_10m,wind_direction_10m,weather_code,cloud_cover" });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`);
  if (!res.ok) throw new Error(`weather ${res.status}`);
  const c = ((await res.json()) as { current: Record<string, number> }).current;
  const w = c.weather_code;
  const code: Weather["code"] = w >= 95 ? "storm" : w >= 71 && w <= 77 ? "snow" : w === 85 || w === 86 ? "snow" : (w >= 51 && w <= 67) || w >= 80 ? "rain" : w === 45 || w === 48 ? "fog" : w >= 1 ? "cloudy" : "clear";
  return { temperature: Math.round(c.temperature_2m), wind: Math.round(c.wind_speed_10m), windDir: c.wind_direction_10m, clouds: Math.round(c.cloud_cover), code };
}

/** "The sky above me": ISS passes for a place and what is overhead right now. */
export function Sky() {
  const t = useDict();
  const locale = useLocale();
  const engine = useOrbis((s) => s.engine);
  const observer = useOrbis((s) => s.observer);
  const setObserver = useOrbis((s) => s.setObserver);
  const [open, setOpen] = useState(false);
  const [locating, setLocating] = useState(false);
  const [denied, setDenied] = useState(false);
  const [passes, setPasses] = useState<{ place: string; list: Pass[] } | null>(null);
  const [overhead, setOverhead] = useState<Overhead | null>(null);
  const [weather, setWeather] = useState<Weather | null>(null);
  const now = useNow(1000);
  const clock = useClockFormat();
  const place = observer ? `${observer.lat.toFixed(4)},${observer.lon.toFixed(4)}` : "";
  const currentPasses = passes?.place === place ? passes.list : null;

  useEffect(() => {
    if (!open || !observer) return;
    let alive = true;
    fetchWeather(observer.lat, observer.lon)
      .then((w) => alive && setWeather(w))
      .catch(() => alive && setWeather(null));
    return () => {
      alive = false;
    };
  }, [open, observer]);

  useEffect(() => {
    if (!open || !observer || !engine) return;
    let alive = true;
    engine.issPasses(observer.lat, observer.lon).then((list) => alive && setPasses({ place, list }));
    const tick = () => setOverhead(engine.overhead(observer.lat, observer.lon));
    const first = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, 4000);
    return () => {
      alive = false;
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [open, observer, engine, place]);

  const locate = () => {
    if (!navigator.geolocation) return setDenied(true);
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setDenied(false);
        setObserver({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      },
      () => {
        setLocating(false);
        setDenied(true);
      },
      { maximumAge: 600_000, timeout: 10_000 },
    );
  };
  const useView = () => {
    if (!engine) return;
    setObserver({ lat: engine.rig.pose.lat, lon: engine.rig.pose.lon });
  };

  const upcoming = currentPasses?.filter((p) => p.end > now) ?? [];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="sky"
        aria-label={t.sky.open}
        className="bezel pointer-events-auto rounded-full p-1"
      >
        <span className={`bezel-core flex items-center gap-2 rounded-full px-3.5 py-2.5 text-sm ${open ? "text-foil" : "text-lunar"}`}>
          <Compass className="size-4" />
          <span className="hidden 2xl:inline">{t.sky.open}</span>
        </span>
      </button>

      {open && (
        <section
          id="sky"
          aria-label={t.sky.title}
          className="bezel pointer-events-auto fixed inset-x-4 bottom-[calc(max(1rem,env(safe-area-inset-bottom))+7.25rem)] z-20 animate-[card-in_0.6s_var(--ease-orbit)] md:inset-x-auto md:top-24 md:right-4 md:bottom-auto md:w-[24rem]"
        >
          <div className="bezel-core flex max-h-[min(34rem,calc(100dvh-14rem))] flex-col overflow-y-auto p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-sm font-medium tracking-tight">{t.sky.title}</h2>
                <p className="mt-1 text-[11px] leading-snug text-dim">{t.sky.lead}</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} aria-label={t.sky.close} className="-mt-1 -mr-2 rounded-full p-2 text-haze hover:text-lunar">
                <Close className="size-4" />
              </button>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={locate}
                disabled={locating}
                className="inline-flex items-center gap-2 rounded-full bg-foil px-3.5 py-2 text-xs font-medium text-black disabled:opacity-50"
              >
                <Target className="size-3.5" />
                {locating ? t.sky.locating : t.sky.useMyLocation}
              </button>
              <button type="button" onClick={useView} className="rounded-full border border-hairline px-3.5 py-2 text-xs text-lunar hover:border-foil/50">
                {t.sky.useViewCentre}
              </button>
            </div>
            {denied && <p className="mt-2 text-[11px] text-seismic">{t.sky.denied}</p>}
            {observer && (
              <p className="readout mt-3 text-xs text-haze">
                {formatLatLon(observer.lat, observer.lon)}
                <button type="button" onClick={() => engine?.flyTo(observer.lat, observer.lon, 1.6)} className="ml-2 text-foil underline decoration-foil/40 underline-offset-4">
                  {t.sky.lookHere}
                </button>
              </p>
            )}

            {observer && (
              <>
                {weather && (
                  <p className="readout mt-3 text-sm text-lunar">
                    {formatNumber(weather.temperature, locale)}°C, {t.sky.weather[weather.code] ?? t.sky.weather.unknown},{" "}
                    {fill(t.sky.wind, { speed: formatNumber(weather.wind, locale), dir: compass(weather.windDir) })}, {fill(t.sky.cloudCover, { pct: String(weather.clouds) })}
                  </p>
                )}
                <h3 className="mt-5 text-xs text-haze">{t.sky.issPasses}</h3>
                {!currentPasses && <p className="mt-2 text-sm text-dim">{t.sky.computing}</p>}
                {currentPasses && !upcoming.length && <p className="mt-2 text-sm text-dim">{t.sky.noPasses}</p>}
                <ul className="mt-2 divide-y divide-hairline">
                  {upcoming.slice(0, 8).map((p) => (
                    <li key={p.start} className="flex items-center justify-between gap-3 py-2 text-xs">
                      <div className="min-w-0">
                        <p className="readout text-lunar">{`${clock.time(p.max)} ${clock.label(p.max)}`}</p>
                        <p className="text-dim">
                          {fill(t.sky.passLine, {
                            el: String(p.maxElevation),
                            from: compass(p.startAzimuth),
                            to: compass(p.endAzimuth),
                            min: String(Math.round((p.end - p.start) / 60_000)),
                          })}
                        </p>
                      </div>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${p.visible ? "border-foil/50 text-foil" : "border-hairline text-dim"}`}>
                        {p.visible ? t.sky.visible : t.sky.daylight}
                      </span>
                    </li>
                  ))}
                </ul>

                <h3 className="mt-5 text-xs text-haze">{t.sky.overhead}</h3>
                {overhead && !overhead.planes.length && !overhead.satellites.length && <p className="mt-2 text-sm text-dim">{t.sky.nothingOverhead}</p>}
                {overhead && overhead.planes.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {overhead.planes.slice(0, 6).map((p) => (
                      <li key={p.id} className="flex items-baseline justify-between gap-3 text-xs">
                        <button type="button" onClick={() => useOrbis.getState().select({ kind: "plane", id: p.id })} className="truncate text-lunar hover:text-foil">
                          {p.callsign || p.reg || p.id.toUpperCase()} {p.type && <span className="text-dim">{p.type}</span>}
                        </button>
                        <span className="readout shrink-0 text-dim">
                          {formatNumber(p.altM, locale)} {t.units.m}, {formatNumber(p.distanceKm, locale)} {t.units.km}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {overhead && overhead.satellites.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {overhead.satellites.slice(0, 6).map((s) => (
                      <li key={s.index} className="flex items-baseline justify-between gap-3 text-xs">
                        <button type="button" onClick={() => engine?.focusResult("satellite", s.index)} className="truncate text-lunar hover:text-foil">
                          {s.name}
                        </button>
                        <span className="readout shrink-0 text-dim">
                          {s.elevation}° · {formatNumber(s.altKm, locale)} {t.units.km}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {overhead && <p className="mt-2 text-[10px] text-dim">{formatAgo(overhead.at, now, locale)}</p>}
                <SkyTonight lat={observer.lat} lon={observer.lon} now={now} />
              </>
            )}
            <EclipsesAhead now={now} />
          </div>
        </section>
      )}
    </>
  );
}
