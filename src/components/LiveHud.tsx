"use client";

import { useEffect, useState } from "react";
import { useDict, useLocale } from "@/i18n/client";
import { fill } from "@/i18n/config";
import { formatAgo, formatDate, formatLatLon, formatNumber } from "@/lib/format";
import { useOrbis } from "@/store/orbis";
import { placeById } from "@/lib/places";
import { stormCategory } from "@/lib/feeds/storms";
import type { FeedKey, LayerKey, Selection } from "@/engine/types";
import { ArrowUpRight, Close, Recenter, Stack, Target } from "./icons";
import { useClockFormat, useNow } from "./hooks";
import { Analyst } from "./Analyst";
import { Search } from "./Search";
import { Timeline } from "./Timeline";
import { SystemHud } from "./SystemHud";
import { BodyLabels } from "./BodyLabels";
import { Sky } from "./Sky";
import { Share } from "./Share";
import { Perf } from "./Perf";
import { Orbit, Play } from "./icons";
import { Tour } from "./Tour";
import { PlaceLabels } from "./PlaceLabels";
import { PointCard } from "./PointCard";
import { TopBar } from "./TopBar";
import { DockHost } from "./Dock";

const LAYERS: { key: LayerKey; feed?: FeedKey; swatch: string }[] = [
  { key: "satellites", feed: "satellites", swatch: "bg-ion" },
  { key: "planes", feed: "planes", swatch: "bg-contrail" },
  { key: "ships", feed: "ships", swatch: "bg-aurora" },
  { key: "quakes", feed: "quakes", swatch: "bg-seismic" },
  { key: "fires", feed: "fires", swatch: "bg-ember" },
  { key: "aurora", feed: "aurora", swatch: "bg-[#5cf27a]" },
  { key: "rain", feed: "rain", swatch: "bg-[#4aa3ff]" },
  { key: "wind", feed: "wind", swatch: "bg-[#cfe3ff]" },
  { key: "storms", feed: "storms", swatch: "bg-[#ff5d73]" },
  { key: "places", swatch: "bg-foil" },
  { key: "clouds", feed: "clouds", swatch: "bg-cloud" },
  { key: "lights", swatch: "bg-glow" },
  { key: "borders", swatch: "bg-foil" },
  { key: "constellations", swatch: "bg-ion" },
];

export function LiveHud() {
  const [docks, setDocks] = useState<HTMLDivElement | null>(null);
  const engine = useOrbis((s) => s.engine);
  const selection = useOrbis((s) => s.selection);
  const space = useOrbis((s) => s.space);
  const tour = useOrbis((s) => s.tour);
  const setTour = useOrbis((s) => s.setTour);
  const panel = useOrbis((s) => s.panel);
  const openPanel = useOrbis((s) => s.openPanel);
  const layersOpen = panel === "layers";
  const t = useDict();

  useEffect(() => {
    useOrbis.getState().setMode("live");
    if (!engine) return;
    engine.setInteractive(true);
    engine.setFocus(null);
    engine.rig.setAutoRotate(0);
    engine.rig.setOffset(0, 0);
    // Shareable views: /live?at=lat,lon,distance&t=unixms&layers=a,b&space=mars (see Share.tsx).
    const params = new URLSearchParams(window.location.search);
    const at = params.get("at")?.split(",").map(Number);
    const layers = params.get("layers");
    if (layers !== null) {
      const on = new Set(layers.split(",").filter(Boolean));
      const store = useOrbis.getState();
      for (const key of Object.keys(store.layers) as LayerKey[]) if (store.layers[key] !== on.has(key)) store.toggleLayer(key);
    }
    const t0 = Number(params.get("t"));
    const spaceParam = params.get("space");
    if (spaceParam) {
      engine.enterSystem();
      const major = ["sun", "mercury", "venus", "earth", "moon", "mars", "jupiter", "saturn", "uranus", "neptune"] as const;
      const id = major.find((m) => m === spaceParam);
      if (id && id !== "earth") useOrbis.getState().focusOn({ kind: "major", id });
      if (at && at.length >= 3 && at.every(Number.isFinite)) engine.system.rig.flyTo({ lat: at[0], lon: at[1], dist: at[2] }, 2.5);
    } else if (at && at.length >= 2 && at.every(Number.isFinite)) engine.rig.flyTo({ lat: at[0], lon: at[1], dist: at[2] || 2.4 }, 2);
    else engine.rig.flyTo({ dist: Math.min(Math.max(engine.rig.goal.dist, 3.4), 5.2) }, 1.4);
    if (Number.isFinite(t0) && t0 > 0) engine.setTime(t0, 0);
    if (params.get("tour") === "1") useOrbis.getState().setTour(true);
    return () => {
      engine.setInteractive(false);
      useOrbis.getState().setTour(false);
    };
  }, [engine]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useOrbis.getState().select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <DockHost value={docks}>
    <div className="pointer-events-none fixed inset-0 z-10">
      {/* Pins and body names first, so every panel and button sits above them. */}
      <PlaceLabels />
      <BodyLabels />
      {/* Toolbar panels (sky, analyst) render here, so they dock against the viewport like the cards. */}
      <div ref={setDocks} className="absolute inset-0" />
      <TopBar live />
      <div className="absolute top-[max(1rem,env(safe-area-inset-top))] right-4 flex items-center gap-2 max-lg:top-[calc(max(1rem,env(safe-area-inset-top))+4rem)]">
        <Fade shown={space === "earth"} layer={false} className="flex items-center gap-2">
          <Analyst />
          <Sky />
          <Search />
        </Fade>
        <button
          type="button"
          onClick={() => setTour(!tour)}
          aria-pressed={tour}
          className="bezel pointer-events-auto rounded-full p-1"
          aria-label={tour ? t.tour.stop : t.tour.open}
          title={tour ? t.tour.stop : t.tour.open}
        >
          <span className={`bezel-core flex items-center gap-2 rounded-full px-3.5 py-2.5 text-sm ${tour ? "text-foil" : "text-lunar"}`}>
            <Play className="size-4" />
            <span className="hidden 2xl:inline">{t.tour.open}</span>
          </span>
        </button>
        <Share />
        <button
          type="button"
          onClick={() => (space === "earth" ? engine?.goToSystem() : engine?.returnToEarth())}
          className="bezel pointer-events-auto rounded-full p-1"
          aria-label={space === "earth" ? t.system.open : t.system.backToEarth}
        >
          <span className={`bezel-core flex items-center gap-2 rounded-full px-3.5 py-2.5 text-sm ${space === "system" ? "text-foil" : "text-lunar"}`}>
            <Orbit className="size-4" />
            <span className="hidden xl:inline">{space === "earth" ? t.system.open : t.system.backToEarth}</span>
          </span>
        </button>
      </div>
      <Fade shown={space === "system"}>
        <SystemHud />
      </Fade>
      <Tour />
      <h1 className="sr-only">{t.nav.live}</h1>

      {/* Layers: the left dock on wide screens; on phones a sheet that shares the bottom slot with cards. */}
      <Fade shown={space === "earth"}>
      {/* The cinematic tour clears the left dock away. */}
      <Fade shown={!tour}>
        {!layersOpen && !selection && !panel && (
          <button
            type="button"
            onClick={() => openPanel("layers")}
            aria-expanded={false}
            aria-controls="layers-panel"
            className="bezel pointer-events-auto absolute bottom-[var(--dock-bottom)] left-4 rounded-full p-1 md:hidden"
          >
            <span className="bezel-core flex items-center gap-2 rounded-full px-4 py-2.5 text-sm">
              <Stack className="size-4 text-foil" />
              {t.hud.openPanel}
            </span>
          </button>
        )}
        {/* The panel is its own scroller, so a sheet that runs out of room keeps its rounded frame. */}
        <LayerPanel className={layersOpen ? "" : "max-md:hidden"} onClose={() => openPanel(null)} />
      </Fade>
      {selection?.kind === "point" ? (
        <PointCard key={cardKey(selection)} lat={selection.lat} lon={selection.lon} />
      ) : (
        selection && <ObjectCard key={cardKey(selection)} selection={selection} />
      )}
      <Timeline />
      <Footnote />
      </Fade>
      <Perf />
    </div>
    </DockHost>
  );
}

function cardKey(s: Selection) {
  if (s.kind === "quake") return s.quake.id;
  if (s.kind === "plane" || s.kind === "ship" || s.kind === "place" || s.kind === "storm") return `${s.kind}-${s.id}`;
  if (s.kind === "point") return `point-${s.lat},${s.lon}`;
  return `${s.kind}-${s.index}`;
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors duration-300 ease-[var(--ease-orbit)] ${on ? "border-foil/45 text-lunar" : "border-hairline text-dim hover:text-haze"}`}
    >
      {children}
    </button>
  );
}

function Filters({ layer }: { layer: "planes" | "ships" }) {
  const t = useDict();
  const planeFilter = useOrbis((s) => s.planeFilter);
  const setPlaneFilter = useOrbis((s) => s.setPlaneFilter);
  const shipKinds = useOrbis((s) => s.shipKinds);
  const toggleShipKind = useOrbis((s) => s.toggleShipKind);
  return (
    <div className="flex flex-wrap gap-1.5 px-2">
      {layer === "planes"
        ? (["all", "airborne", "high"] as const).map((f) => (
            <Chip key={f} on={planeFilter === f} onClick={() => setPlaneFilter(f)}>
              {t.filters[f]}
            </Chip>
          ))
        : t.shipKinds.map((name, kind) => (
            <Chip key={name} on={shipKinds[kind]} onClick={() => toggleShipKind(kind)}>
              {name}
            </Chip>
          ))}
    </div>
  );
}

function LayerPanel({ className, onClose }: { className: string; onClose: () => void }) {
  const t = useDict();
  const locale = useLocale();
  const layers = useOrbis((s) => s.layers);
  const feeds = useOrbis((s) => s.feeds);
  const toggle = useOrbis((s) => s.toggleLayer);
  const engine = useOrbis((s) => s.engine);
  const kp = useOrbis((s) => s.auroraKp);
  const [filters, setFilters] = useState(false);

  return (
    <section id="layers-panel" aria-label={t.hud.layers} className={`dock-left bezel pointer-events-auto ${className}`}>
      <div className="bezel-core p-2">
        <div className="flex items-center justify-between px-2 pt-0.5 pb-1.5 md:hidden">
          <h2 className="text-xs text-haze">{t.hud.layers}</h2>
          <button type="button" onClick={onClose} aria-label={t.hud.closePanel} className="-mr-1 rounded-full p-2 text-haze hover:text-lunar">
            <Close className="size-4" />
          </button>
        </div>
        <ul className="grid grid-cols-2 gap-0.5">
          {LAYERS.map(({ key, feed, swatch }) => {
            const state = feed ? feeds[feed] : null;
            const on = layers[key];
            const status =
              state?.status === "error"
                ? t.hud.status.error
                : state?.status === "loading" || (state?.status === "idle" && key !== "wind")
                  ? t.hud.status.loading
                  : key === "rain"
                    ? ""
                    : key === "wind"
                    ? state?.updated
                      ? `GFS ${String(new Date(state.updated).getUTCHours()).padStart(2, "0")}z`
                      : ""
                    : key === "aurora"
                    ? kp === null
                      ? ""
                      : `Kp ${formatNumber(kp, locale, 1)}`
                    : state && key !== "clouds"
                      ? formatNumber(state.count, locale)
                      : "";
            return (
              <li key={key}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  onClick={() => toggle(key)}
                  className="group flex w-full flex-col items-start gap-0.5 rounded-[0.9rem] px-2.5 py-1.5 text-left md:py-2 transition-colors duration-300 ease-[var(--ease-orbit)] hover:bg-white/[0.04]"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className={`size-2 shrink-0 rounded-full transition-all duration-500 ease-[var(--ease-orbit)] ${swatch} ${on ? "opacity-100 shadow-[0_0_10px_currentColor]" : "scale-75 opacity-25"}`}
                    />
                    <span className={`truncate text-[13px] transition-colors duration-300 ${on ? "text-lunar" : "text-dim"}`}>{t.layers[key]}</span>
                  </span>
                  <span className={`readout min-h-4 truncate pl-4 text-[11px] ${state?.status === "error" ? "text-seismic" : "text-dim"}`}>{status}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="mt-1 border-t border-hairline px-1 pt-1.5">
          <button
            type="button"
            onClick={() => setFilters((v) => !v)}
            aria-expanded={filters}
            className="flex w-full items-center justify-between rounded-[0.9rem] px-2 py-2 text-left text-xs text-haze transition-colors duration-300 hover:bg-white/[0.04] hover:text-lunar"
          >
            {t.hud.filters}
            <span className={`transition-transform duration-300 ease-[var(--ease-orbit)] ${filters ? "rotate-180" : ""}`} aria-hidden>
              ⌄
            </span>
          </button>
          {filters && (
            <div className="space-y-2 pb-2 animate-[card-in_0.4s_var(--ease-orbit)]">
              <p className="px-2 text-[11px] text-dim">{t.layers.planes}</p>
              <Filters layer="planes" />
              <p className="px-2 text-[11px] text-dim">{t.layers.ships}</p>
              <Filters layer="ships" />
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              engine?.rig.resetOrientation();
              engine?.rig.flyTo({ lat: 20, lon: engine.rig.pose.lon, dist: 4.4 }, 1.6);
            }}
            className="flex w-full items-center gap-3 rounded-[0.9rem] px-2 py-2 text-left text-xs text-haze transition-colors duration-300 hover:bg-white/[0.04] hover:text-lunar"
          >
            <Recenter className="size-4" />
            {t.hud.resetView}
          </button>
        </div>
      </div>
    </section>
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

function ObjectCard({ selection }: { selection: Selection }) {
  const t = useDict();
  const locale = useLocale();
  const live = useOrbis((s) => s.selectionLive);
  const detail = useOrbis((s) => s.selectionDetail);
  const engine = useOrbis((s) => s.engine);
  const select = useOrbis((s) => s.select);
  const following = useOrbis((s) => s.following);
  const now = useNow(1000);
  const simS = (engine?.clock.now() ?? now) / 1000;
  const clock = useClockFormat();

  let kicker = "";
  let title = "";
  let accent = "text-foil";
  let focus: { lat: number; lon: number; dist: number } | null = null;
  let link: { href: string; label: string } | null = null;
  let rows: [string, React.ReactNode][] = [];
  let note: string | null = null;

  if (selection.kind === "satellite") {
    kicker = t.groups[selection.group];
    title = selection.name;
    accent = selection.group === 0 ? "text-foil" : "text-ion";
    rows = [
      [t.card.altitude, live ? `${formatNumber(live.altKm, locale)} ${t.units.km}` : "…"],
      [t.card.speed, live ? `${formatNumber(live.speedKms, locale, 2)} ${t.units.kms}` : "…"],
      [t.card.position, live ? formatLatLon(live.lat, live.lon) : "…"],
      [t.card.inclination, `${formatNumber(selection.inclination, locale, 1)}°`],
      [t.card.period, `${formatNumber(selection.periodMin, locale, 1)} ${t.units.min}`],
      [t.card.norad, String(selection.norad)],
    ];
    if (live) focus = { lat: live.lat, lon: live.lon, dist: live.altKm > 15000 ? 14 : live.altKm > 3000 ? 7 : 2.8 };
    link = { href: `https://www.n2yo.com/satellite/?s=${selection.norad}`, label: t.card.n2yo };
  } else if (selection.kind === "plane") {
    const p = engine?.traffic.planeInfo(selection.id, simS);
    kicker = p?.type ? `${t.card.aircraft} ${p.type}` : t.card.aircraft;
    title = p?.callsign || p?.reg || selection.id.toUpperCase();
    accent = p?.emergency ? "text-seismic" : "text-contrail";
    if (p) {
      rows = [
        [t.card.altitude, p.ground ? t.card.onGround : `${formatNumber(p.altM, locale)} ${t.units.m} (${formatNumber(p.altM / 0.3048, locale)} ${t.units.ft})`],
        [t.card.groundSpeed, `${formatNumber(p.speedMs * 3.6, locale)} ${t.units.kmh}`],
        [t.card.heading, `${formatNumber(p.track, locale)}°`],
        [t.card.verticalRate, `${p.vrMs > 0 ? "+" : ""}${formatNumber(p.vrMs, locale, 1)} ${t.units.ms}`],
        [t.card.position, formatLatLon(p.lat, p.lon)],
        [t.card.registration, p.reg || "—"],
        [t.card.squawk, p.squawk || "—"],
      ];
      if (p.emergency) note = t.card.emergency;
      else note = t.card.trackNote;
      focus = { lat: p.lat, lon: p.lon, dist: 1.6 };
    }
    link = { href: `https://adsb.lol/?icao=${selection.id}`, label: t.card.adsb };
  } else if (selection.kind === "ship") {
    const s = engine?.traffic.shipInfo(selection.id, simS);
    const d = detail?.mmsi === selection.id ? detail : null;
    kicker = s ? t.shipKinds[s.kind] : t.card.ship;
    title = d?.name || `MMSI ${selection.id}`;
    accent = "text-aurora";
    if (s) {
      rows = [
        [t.card.speed, `${formatNumber(s.sogKn, locale, 1)} ${t.units.kn}`],
        [t.card.course, `${formatNumber(s.cog, locale)}°`],
        [t.card.destination, d?.destination || "—"],
        [t.card.length, d?.lengthM ? `${formatNumber(d.lengthM, locale)} ${t.units.m}` : "—"],
        [t.card.position, formatLatLon(s.lat, s.lon)],
        [t.card.mmsi, String(selection.id)],
        [t.card.lastReport, formatAgo(s.seen, now, locale)],
      ];
      if (d?.imo) rows.splice(5, 0, [t.card.imo, String(d.imo)]);
      note = t.card.trackNote;
      focus = { lat: s.lat, lon: s.lon, dist: 1.5 };
    }
    link = { href: `https://www.marinetraffic.com/en/ais/details/ships/mmsi:${selection.id}`, label: t.card.marineTraffic };
  } else if (selection.kind === "quake") {
    const q = selection.quake;
    kicker = t.card.quake;
    title = q.place || formatLatLon(q.lat, q.lon);
    accent = "text-seismic";
    rows = [
      [t.card.magnitude, formatNumber(q.mag, locale, 1)],
      [t.card.depth, `${formatNumber(q.depthKm, locale, 1)} ${t.units.km}`],
      [t.card.time, `${clock.time(q.time)} ${clock.label(q.time)}, ${formatAgo(q.time, now, locale)}`],
      [t.card.position, formatLatLon(q.lat, q.lon)],
    ];
    if (q.tsunami) note = t.card.tsunami;
    focus = { lat: q.lat, lon: q.lon, dist: 2.2 };
    link = { href: q.url, label: t.card.usgs };
  } else if (selection.kind === "place") {
    const p = placeById(selection.id);
    kicker = p ? t.places.kinds[p.category] : "";
    title = t.places.items[selection.id].name;
    accent = "text-foil";
    if (p) {
      rows = [[t.card.position, formatLatLon(p.lat, p.lon)]];
      if (p.elevationM !== undefined) rows.unshift([t.places.elevation, fill(p.elevationM < 0 ? t.places.belowSea : t.places.aboveSea, { m: formatNumber(Math.abs(p.elevationM), locale) })]);
      focus = { lat: p.lat, lon: p.lon, dist: p.view };
    }
    note = t.places.items[selection.id].text;
  } else if (selection.kind === "storm") {
    const s = engine?.stormNow(selection.id);
    if (s) {
      const { storm } = s;
      const category = stormCategory(storm.windKmh);
      kicker = category < 0 ? t.storms.kinds.depression : category === 0 ? t.storms.kinds.storm : fill(t.storms.kinds.cyclone, { n: String(category) });
      title = storm.name;
      accent = storm.alert === "red" ? "text-seismic" : storm.alert === "orange" ? "text-ember" : "text-aurora";
      const end = storm.track[storm.track.length - 1].t;
      rows = [
        [t.storms.maxWind, `${formatNumber(storm.windKmh, locale)} ${t.units.kmh}`],
        [t.storms.alert, t.storms.alerts[storm.alert]],
        [t.card.position, formatLatLon(s.lat, s.lon)],
        [
          t.storms.moving,
          s.heading === null || s.speedKmh === null
            ? t.storms.outside
            : s.speedKmh < 3
              ? t.storms.stationary
              : fill(t.storms.movingValue, { dir: t.storms.headings[Math.round(s.heading / 45) % 8], speed: formatNumber(s.speedKmh, locale) }),
        ],
        [t.storms.forecastTo, `${clock.time(end)} ${clock.label(end)}`],
      ];
      if (storm.countries.length) rows.push([t.storms.countries, storm.countries.join(", ")]);
      note = t.storms.note;
      focus = { lat: s.lat, lon: s.lon, dist: 2.2 };
      link = { href: storm.report, label: t.storms.report };
    }
  } else if (selection.kind === "fire") {
    kicker = t.card.fire;
    title = formatLatLon(selection.lat, selection.lon);
    accent = "text-ember";
    rows = [
      [t.card.power, `${formatNumber(selection.frp, locale)} ${t.units.mw}`],
      [t.card.detected, `${clock.time(selection.time)} ${clock.label(selection.time)}, ${formatAgo(selection.time, now, locale)}`],
    ];
    note = t.card.fireNote;
    focus = { lat: selection.lat, lon: selection.lon, dist: 1.6 };
  }

  return (
    <aside aria-label={title} className="dock-right bezel pointer-events-auto animate-[card-in_0.7s_var(--ease-orbit)]">
      <div className="bezel-core p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className={`text-xs ${accent}`}>{kicker}</p>
            <h2 className="mt-1.5 font-display text-lg leading-snug font-medium tracking-tight break-words">{title}</h2>
          </div>
          <button
            type="button"
            onClick={() => select(null)}
            aria-label={t.card.close}
            className="-mt-1 -mr-1 flex size-9 shrink-0 items-center justify-center rounded-full text-haze transition-colors duration-300 hover:bg-white/[0.06] hover:text-lunar"
          >
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
        {note && <p className="mt-3 text-xs leading-relaxed text-haze">{note}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          {focus && (
            <button
              type="button"
              onClick={() => (selection.kind === "place" ? engine?.flyToPlace(selection.id) : focus && engine?.rig.flyTo(focus, 1.5))}
              className="inline-flex items-center gap-2 rounded-full border border-hairline px-3.5 py-2 text-xs text-lunar transition-colors duration-300 hover:border-foil/50"
            >
              <Target className="size-3.5" />
              {selection.kind === "place" ? t.places.flyThere : t.card.focus}
            </button>
          )}
          {(selection.kind === "satellite" || selection.kind === "plane" || selection.kind === "ship") && (
            <button
              type="button"
              aria-pressed={following}
              onClick={() => engine?.follow(following ? null : selection)}
              className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-xs transition-colors duration-300 ${following ? "border-foil/60 bg-foil text-black" : "border-hairline text-lunar hover:border-foil/50"}`}
            >
              <Orbit className="size-3.5" />
              {following ? t.card.stopRiding : t.card.ride}
            </button>
          )}
          {link && (
            <a
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-hairline px-3.5 py-2 text-xs text-lunar transition-colors duration-300 hover:border-foil/50"
            >
              {link.label}
              <ArrowUpRight className="size-3.5" />
            </a>
          )}
        </div>
      </div>
    </aside>
  );
}

function Footnote() {
  const t = useDict();
  const locale = useLocale();
  const cloudsDate = useOrbis((s) => s.cloudsDate);
  return (
    <div className="absolute right-4 bottom-[var(--safe-b)] hidden max-w-[19rem] flex-col items-end gap-1 text-right text-[11px] leading-snug text-dim xl:flex">
      <p>{t.hud.hint}</p>
      <p>{cloudsDate ? fill(t.hud.clouds, { date: formatDate(cloudsDate, locale) }) : t.hud.cloudsArchive}</p>
    </div>
  );
}

/**
 * HUD groups fade and settle instead of popping when the scene hands over.
 * Hidden groups also leave the tab order and the accessibility tree. By
 * default the wrapper covers the viewport, so absolutely placed children
 * keep their positions whether or not it is transformed.
 */
function Fade({ shown, layer = true, className = "", children }: { shown: boolean; layer?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <div data-shown={shown} inert={!shown || undefined} className={`hud-fade ${layer ? "pointer-events-none absolute inset-0" : ""} ${className}`}>
      {children}
    </div>
  );
}
