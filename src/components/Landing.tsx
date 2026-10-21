"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useDict, useLocale } from "@/i18n/client";
import { fill } from "@/i18n/config";
import { sunPosition } from "@/lib/astro";
import { formatAgo, formatLatLon, formatNumber } from "@/lib/format";
import { nightSpot, strongestQuake } from "@/lib/tour";
import { useOrbis } from "@/store/orbis";
import type { CameraPose, LayerKey } from "@/engine/types";
import { ArrowUpRight } from "./icons";
import { useMediaQuery, useNow } from "./hooks";
import { TopBar } from "./TopBar";

gsap.registerPlugin(ScrollTrigger);

type Chapter = "hero" | "orbit" | "ground" | "heat" | "night" | "final";

interface Shot {
  pose: CameraPose;
  focus: LayerKey | null;
  /** Globe shift as a fraction of the viewport. */
  offset: [number, number];
  rotate: number;
}

/** Where the camera goes for each chapter, decided at the moment the chapter starts. */
function shotFor(chapter: Chapter, wide: boolean): Shot {
  const s = useOrbis.getState();
  const now = Date.now();
  const sun = sunPosition(now);
  const side: [number, number] = wide ? [0.24, 0] : [0, -0.17];
  switch (chapter) {
    case "hero":
      return {
        pose: { lat: Math.max(-30, Math.min(40, sun.lat + 14)), lon: sun.lon - 72, dist: wide ? 3.5 : 4.6 },
        focus: null,
        offset: wide ? [0.27, 0] : [0, 0.17],
        rotate: 1.4,
      };
    case "orbit":
      return { pose: { lat: 26, lon: sun.lon - 30, dist: wide ? 9.5 : 13 }, focus: "satellites", offset: side, rotate: 2.2 };
    case "ground": {
      const q = strongestQuake(s.quakes, now);
      return { pose: { lat: q?.lat ?? 12, lon: q?.lon ?? 150, dist: wide ? 2.8 : 3.6 }, focus: "quakes", offset: side, rotate: 0 };
    }
    case "heat": {
      const f = s.fireSpot ?? { lat: -10, lon: 24 };
      return { pose: { lat: f.lat, lon: f.lon, dist: wide ? 2.6 : 3.4 }, focus: "fires", offset: side, rotate: 0 };
    }
    case "night": {
      const n = nightSpot(sun);
      return { pose: { lat: n.lat, lon: n.lon, dist: wide ? 3.1 : 3.9 }, focus: "lights", offset: side, rotate: 0.6 };
    }
    case "final":
      return { pose: { lat: 18, lon: sun.lon - 55, dist: wide ? 4.6 : 5.6 }, focus: null, offset: [0, wide ? 0 : -0.08], rotate: 2 };
  }
}

export function Landing() {
  const t = useDict();
  const locale = useLocale();
  const engine = useOrbis((s) => s.engine);
  const ready = useOrbis((s) => s.ready);
  const feeds = useOrbis((s) => s.feeds);
  const iss = useOrbis((s) => s.iss);
  const quakes = useOrbis((s) => s.quakes);
  const wide = useMediaQuery("(min-width: 900px)");
  const now = useNow(30_000);
  const root = useRef<HTMLDivElement>(null);
  const current = useRef<Chapter>("hero");
  const wideRef = useRef(wide);

  const apply = (chapter: Chapter, duration = 1.8) => {
    current.current = chapter;
    const e = useOrbis.getState().engine;
    if (!e) return;
    const shot = shotFor(chapter, wideRef.current);
    e.rig.flyTo(shot.pose, duration);
    e.rig.setOffset(...shot.offset);
    e.rig.setAutoRotate(shot.rotate);
    e.setFocus(shot.focus);
  };

  useEffect(() => {
    wideRef.current = wide;
    apply(current.current, 1.2);
  }, [wide]);

  useEffect(() => {
    useOrbis.getState().setMode("landing");
    useOrbis.getState().select(null);
    if (!engine) return;
    engine.setInteractive(false);
    apply(current.current, 0.01);
    return () => {
      engine.setFocus(null);
      engine.rig.setAutoRotate(0);
      engine.rig.setOffset(0, 0);
    };
  }, [engine]);

  // One orchestrated entrance: the Earth swings in from deep space as the title rises.
  useEffect(() => {
    if (!ready || !root.current) return;
    const ctx = gsap.context(() => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        const e = useOrbis.getState().engine;
        if (e && window.scrollY < 50) {
          e.rig.pose.dist = 14;
          e.rig.pose.lon -= 60;
          apply("hero", 2.6);
        }
        gsap
          .timeline({ defaults: { ease: "expo.out" } })
          .from("[data-rise]", { yPercent: 115, duration: 1.6, stagger: 0.08 }, 0.35)
          .from("[data-fade]", { opacity: 0, y: 18, filter: "blur(8px)", duration: 1.4, stagger: 0.12 }, 0.8);
        gsap.utils.toArray<HTMLElement>("[data-copy]").forEach((el) => {
          gsap.from(el, {
            opacity: 0,
            y: 48,
            filter: "blur(10px)",
            duration: 1.1,
            ease: "power3.out",
            scrollTrigger: { trigger: el, start: "top 82%", toggleActions: "play none none reverse" },
          });
        });
      });
      gsap.utils.toArray<HTMLElement>("[data-chapter]").forEach((el) => {
        ScrollTrigger.create({
          trigger: el,
          start: "top 55%",
          end: "bottom 55%",
          onToggle: (self) => {
            if (self.isActive) apply(el.dataset.chapter as Chapter);
          },
        });
      });
    }, root);
    return () => ctx.revert();
  }, [ready]);

  const count = (n: number, status: string) => (status === "ready" ? formatNumber(n, locale) : "…");
  const strongest = strongestQuake(quakes, now);

  return (
    <div ref={root} className="relative z-10">
      <TopBar />
      {/* Scrim that keeps copy legible over the globe; it sits on the copy side only. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 bg-[linear-gradient(to_top,rgb(0_0_0/0.85)_0%,rgb(0_0_0/0.35)_38%,transparent_60%)] min-[900px]:bg-[linear-gradient(to_right,rgb(0_0_0/0.82)_0%,rgb(0_0_0/0.45)_34%,transparent_58%)]"
      />

      <section
        data-chapter="hero"
        className="relative flex min-h-[100dvh] flex-col justify-end px-5 pb-[max(2.5rem,env(safe-area-inset-bottom))] min-[900px]:justify-center min-[900px]:px-[7vw] min-[900px]:pb-0"
      >
        <div className="max-w-[40rem] pt-28 max-[899px]:mb-[2vh]">
          <h1 className="font-display text-[clamp(2.6rem,8.2vw,6.6rem)] leading-[0.95] font-medium tracking-[-0.045em]">
            <span className="block overflow-hidden pb-[0.08em]">
              <span data-rise className="block">
                {t.hero.title}
              </span>
            </span>
          </h1>
          <p data-fade className="mt-6 max-w-[34rem] text-base leading-relaxed text-haze md:text-lg">
            {t.hero.lead}
          </p>
          <div data-fade className="mt-8 flex flex-wrap items-center gap-4">
            <Link
              href={`/${locale}/live`}
              className="group inline-flex items-center gap-3 rounded-full bg-foil py-2 pr-2 pl-6 text-sm font-medium text-black transition-transform duration-500 ease-[var(--ease-orbit)] active:scale-[0.98]"
            >
              {t.hero.cta}
              <span className="flex size-9 items-center justify-center rounded-full bg-black/10 transition-transform duration-500 ease-[var(--ease-orbit)] group-hover:translate-x-0.5 group-hover:-translate-y-px group-hover:scale-105">
                <ArrowUpRight className="size-4" />
              </span>
            </Link>
          </div>
          <dl data-fade className="mt-12 grid max-w-[34rem] grid-cols-3 border-t border-hairline pt-5">
            {(
              [
                ["satellites", "text-ion"],
                ["quakes", "text-seismic"],
                ["fires", "text-ember"],
              ] as const
            ).map(([key, color], i) => (
              <div key={key} className={i ? "border-l border-hairline pl-4" : "pr-4"}>
                <dt className="sr-only">{t.readout[key]}</dt>
                <dd className={`readout font-display text-xl font-light tracking-tight md:text-3xl ${color}`}>
                  {count(feeds[key].count, feeds[key].status)}
                </dd>
                <dd aria-hidden className="mt-1 text-xs leading-snug text-haze">
                  {t.readout[key]}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <p data-fade className="mt-10 hidden text-xs text-dim min-[900px]:absolute min-[900px]:bottom-8 min-[900px]:block">
          {t.hero.scroll}
        </p>
      </section>

      <Chapter id="orbit" legend={t.layers.satellites} color="bg-ion text-ion" title={t.chapters.orbit.title}>
        <p>{fill(t.chapters.orbit.body, { count: count(feeds.satellites.count, feeds.satellites.status) })}</p>
        {iss && (
          <p className="readout text-sm text-foil">
            {fill(t.chapters.orbit.iss, {
              alt: formatNumber(iss.altKm, locale),
              speed: formatNumber(iss.speedKms, locale, 2),
              pos: formatLatLon(iss.lat, iss.lon),
            })}
          </p>
        )}
      </Chapter>

      <Chapter id="ground" legend={t.layers.quakes} color="bg-seismic text-seismic" title={t.chapters.ground.title}>
        <p>{fill(t.chapters.ground.body, { count: count(feeds.quakes.count, feeds.quakes.status) })}</p>
        {strongest && (
          <p className="readout text-sm text-lunar">
            {fill(t.chapters.ground.strongest, {
              mag: formatNumber(strongest.mag, locale, 1),
              place: strongest.place,
              ago: formatAgo(strongest.time, now, locale),
            })}
          </p>
        )}
      </Chapter>

      <Chapter id="heat" legend={t.layers.fires} color="bg-ember text-ember" title={t.chapters.heat.title}>
        <p>{fill(t.chapters.heat.body, { count: count(feeds.fires.count, feeds.fires.status) })}</p>
      </Chapter>

      <Chapter id="night" legend={t.layers.lights} color="bg-glow text-glow" title={t.chapters.night.title}>
        <p>{t.chapters.night.body}</p>
      </Chapter>

      <section data-chapter="final" className="relative flex min-h-[110dvh] flex-col items-center justify-center px-5 text-center">
        <div data-copy className="max-w-[36rem]">
          <h2 className="font-display text-[clamp(2rem,5vw,3.6rem)] leading-[1.02] font-medium tracking-[-0.04em]">
            {t.chapters.final.title}
          </h2>
          <p className="mx-auto mt-5 max-w-[30rem] text-haze">{t.chapters.final.body}</p>
          <Link
            href={`/${locale}/live`}
            className="group mt-9 inline-flex items-center gap-3 rounded-full bg-foil py-2 pr-2 pl-6 text-sm font-medium text-black transition-transform duration-500 ease-[var(--ease-orbit)] active:scale-[0.98]"
          >
            {t.hero.cta}
            <span className="flex size-9 items-center justify-center rounded-full bg-black/10 transition-transform duration-500 ease-[var(--ease-orbit)] group-hover:translate-x-0.5 group-hover:-translate-y-px group-hover:scale-105">
              <ArrowUpRight className="size-4" />
            </span>
          </Link>
        </div>
        <footer className="absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-xs text-dim">
          <span>CelesTrak, USGS, NASA FIRMS, NASA GIBS, NASA Visible Earth, Natural Earth</span>
          <Link href={`/${locale}/sources`} className="text-haze underline decoration-hairline underline-offset-4 hover:text-lunar">
            {t.nav.sources}
          </Link>
        </footer>
      </section>
    </div>
  );
}

function Chapter({
  id,
  legend,
  color,
  title,
  children,
}: {
  id: Chapter;
  legend: string;
  color: string;
  title: string;
  children: React.ReactNode;
}) {
  const [dot, text] = color.split(" ");
  return (
    <section
      data-chapter={id}
      className="relative flex min-h-[125dvh] items-end px-5 pb-[18dvh] min-[900px]:items-center min-[900px]:px-[7vw] min-[900px]:pb-0"
    >
      <div data-copy className="max-w-[30rem]">
        <p className={`flex items-center gap-2 text-sm ${text}`}>
          <span className={`size-1.5 rounded-full ${dot}`} />
          {legend}
        </p>
        <h2 className="mt-4 font-display text-[clamp(1.9rem,4.2vw,3.3rem)] leading-[1.04] font-medium tracking-[-0.04em]">{title}</h2>
        <div className="mt-5 space-y-4 leading-relaxed text-haze">{children}</div>
      </div>
    </section>
  );
}
