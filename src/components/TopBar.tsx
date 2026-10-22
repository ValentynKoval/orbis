"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LOCALE_COOKIE, type Locale } from "@/i18n/config";
import { useDict, useLocale } from "@/i18n/client";
import { OrbisMark, Wave } from "./icons";
import { useOrbis } from "@/store/orbis";
import { useClockFormat, useNow, useTimeZoneSetup } from "./hooks";

function switchPath(pathname: string, to: Locale) {
  const parts = pathname.split("/");
  parts[1] = to;
  return parts.join("/") || `/${to}`;
}

/** Floating island navigation, shared by the landing page and the live globe. */
export function TopBar({ live = false }: { live?: boolean }) {
  const t = useDict();
  const locale = useLocale();
  const pathname = usePathname();
  const other: Locale = locale === "uk" ? "en" : "uk";
  const now = useNow(1000);
  const sound = useOrbis((s) => s.sound);
  const toggleSound = useOrbis((s) => s.toggleSound);
  const isLive = useOrbis((s) => s.time.live);
  const engine = useOrbis((s) => s.engine);
  const shown = isLive ? now : (engine?.clock.now() ?? now);
  const clock = useClockFormat();
  const toggleUtc = useOrbis((s) => s.toggleUtc);
  const utc = useOrbis((s) => s.utc);
  useTimeZoneSetup();

  return (
    <header className={`pointer-events-none fixed inset-x-0 top-0 z-20 flex justify-center px-4 pt-[max(1rem,env(safe-area-inset-top))] ${live ? "lg:justify-start" : ""}`}>
      <nav className="bezel pointer-events-auto flex items-center rounded-full p-1">
        <div className="bezel-core flex items-center gap-1 rounded-full py-1 pr-1 pl-3 sm:gap-2">
          <Link href={`/${locale}`} aria-label={t.nav.home} className="flex items-center gap-2 rounded-full pr-2">
            <OrbisMark className="size-6 text-lunar" />
            <span className="font-display text-sm font-medium tracking-tight">Orbis</span>
          </Link>
          {live && (
            <span className="readout pointer-events-auto hidden items-center gap-2 border-l border-hairline px-3 text-xs text-haze sm:flex">
              <span className="relative flex size-1.5">
                {isLive && <span className="absolute inline-flex size-full animate-ping rounded-full bg-seismic/70" />}
                <span className={`relative inline-flex size-1.5 rounded-full ${isLive ? "bg-seismic" : "bg-foil"}`} />
              </span>
              <span className="text-lunar">{isLive ? t.hud.live : t.timeline.replay}</span>
              <button
                type="button"
                onClick={toggleUtc}
                title={utc ? t.hud.showLocal : t.hud.showUtc}
                className="readout rounded-full transition-colors duration-300 hover:text-lunar"
                suppressHydrationWarning
              >
                {`${clock.time(shown, !isLive)} ${clock.label(shown)}`}
              </button>
            </span>
          )}
          <button
            type="button"
            onClick={toggleSound}
            aria-pressed={sound}
            aria-label={sound ? t.hud.soundOff : t.hud.soundOn}
            title={sound ? t.hud.soundOff : t.hud.soundOn}
            className={`rounded-full px-2.5 py-1.5 transition-colors duration-300 ease-[var(--ease-orbit)] ${sound ? "text-foil" : "text-haze hover:text-lunar"}`}
          >
            <Wave on={sound} className="size-4" />
          </button>
          <Link
            href={`/${locale}/sources`}
            className="rounded-full px-3 py-1.5 text-xs text-haze transition-colors duration-300 ease-[var(--ease-orbit)] hover:text-lunar"
          >
            {t.nav.sources}
          </Link>
          <Link
            href={switchPath(pathname, other)}
            aria-label={t.nav.language}
            onClick={() => {
              document.cookie = `${LOCALE_COOKIE}=${other}; path=/; max-age=31536000; samesite=lax`;
            }}
            className="rounded-full px-3 py-1.5 text-xs text-haze transition-colors duration-300 ease-[var(--ease-orbit)] hover:text-lunar"
          >
            {t.nav.languageShort}
          </Link>
          {!live && (
            <Link
              href={`/${locale}/live`}
              className="hidden rounded-full bg-foil px-4 py-1.5 text-xs font-medium text-black transition-transform duration-500 ease-[var(--ease-orbit)] active:scale-[0.97] sm:block"
            >
              {t.nav.live}
            </Link>
          )}
        </div>
      </nav>
    </header>
  );
}
