"use client";

import { useEffect, useState } from "react";
import { useDict, useLocale } from "@/i18n/client";
import { fill } from "@/i18n/config";
import { formatLatLon, formatNumber, formatTime, zoneLabel } from "@/lib/format";
import { useOrbis } from "@/store/orbis";
import type { PointInfo } from "@/app/api/point/route";
import { Close, Target } from "./icons";
import { useNow } from "./hooks";

type Weather = keyof ReturnType<typeof useDict>["sky"]["weather"];

function weatherKind(code: number | null): Weather {
  if (code === null) return "unknown";
  if (code >= 95) return "storm";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if ((code >= 51 && code <= 67) || code >= 80) return "rain";
  if (code === 45 || code === 48) return "fog";
  return code >= 1 ? "cloudy" : "clear";
}

/** The card for a tapped spot of the globe: what is there, how high, what time and weather it is. */
export function PointCard({ lat, lon }: { lat: number; lon: number }) {
  const t = useDict();
  const locale = useLocale();
  const engine = useOrbis((s) => s.engine);
  const select = useOrbis((s) => s.select);
  const now = useNow(1000);
  const [info, setInfo] = useState<PointInfo | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/point?lat=${lat}&lon=${lon}&lang=${locale}`)
      .then((r) => (r.ok ? (r.json() as Promise<PointInfo>) : null))
      .then((d) => alive && (d ? setInfo(d) : setFailed(true)))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [lat, lon, locale]);

  const title = info?.name ?? (info && !info.elevationM ? t.point.ocean : formatLatLon(lat, lon));
  const rows: [string, string][] = [];
  if (info) {
    if (info.elevationM) rows.push([t.point.elevation, `${formatNumber(info.elevationM, locale)} ${t.units.m}`]);
    else if (info.depthM !== null) rows.push([t.point.depth, `${formatNumber(-info.depthM, locale)} ${t.units.m}`]);
    if (info.timeZone) rows.push([t.point.localTime, `${formatTime(now, locale, info.timeZone, false).slice(0, 5)} ${zoneLabel(now, info.timeZone)}`]);
    if (info.sunrise && info.sunset) {
      rows.push([t.point.daylight, fill(t.point.sunriseSunset, { rise: info.sunrise.slice(11, 16), set: info.sunset.slice(11, 16) })]);
    }
    if (info.temperature !== null) {
      const kind = weatherKind(info.weatherCode);
      rows.push([t.point.weather, `${formatNumber(info.temperature, locale)} °C${kind !== "unknown" ? `, ${t.sky.weather[kind]}` : ""}`]);
    }
    if (info.wind !== null) {
      const speed = formatNumber(info.wind, locale, info.wind < 10 ? 1 : 0);
      rows.push([
        t.point.wind,
        info.wind < 0.5 || info.windFrom === null
          ? fill(t.point.calm, { speed })
          : fill(t.point.windFrom, {
              speed,
              dir: t.point.compass[Math.round(info.windFrom / 45) % 8],
            }),
      ]);
    }
  }
  rows.push([t.card.position, formatLatLon(lat, lon)]);

  return (
    <aside aria-label={title} className="dock-right bezel pointer-events-auto animate-[card-in_0.7s_var(--ease-orbit)]">
      <div className="bezel-core p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-haze">{info?.country ?? t.point.kicker}</p>
            <h2 className="mt-1.5 font-display text-lg leading-snug font-medium tracking-tight break-words">{title}</h2>
          </div>
          <button type="button" onClick={() => select(null)} aria-label={t.card.close} className="-mt-1 -mr-1 flex size-9 shrink-0 items-center justify-center rounded-full text-haze transition-colors duration-300 hover:bg-white/[0.06] hover:text-lunar">
            <Close className="size-4" />
          </button>
        </div>
        {!info && !failed && <p className="mt-4 text-sm text-dim">{t.point.loading}</p>}
        <dl className="mt-4">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 border-t border-hairline py-2.5 first:border-t-0">
              <dt className="text-xs text-haze">{label}</dt>
              <dd className="readout text-right text-sm text-lunar" suppressHydrationWarning>
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => engine?.rig.glide({ lat, lon, dist: Math.min(engine.rig.pose.dist, 1.05) }, 2.4)}
            className="inline-flex items-center gap-2 rounded-full border border-hairline px-3.5 py-2 text-xs text-lunar transition-colors duration-300 hover:border-foil/50"
          >
            <Target className="size-3.5" />
            {t.card.focus}
          </button>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-dim">{t.point.credit}</p>
      </div>
    </aside>
  );
}
