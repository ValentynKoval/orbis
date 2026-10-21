"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LOCALE_COOKIE, type Locale } from "@/i18n/config";
import { useDict, useLocale } from "@/i18n/client";
import { formatUtc } from "@/lib/format";
import { OrbisMark } from "./icons";
import { useNow } from "./hooks";

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

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-20 flex justify-center px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <nav className="bezel pointer-events-auto flex items-center rounded-full p-1">
        <div className="bezel-core flex items-center gap-1 rounded-full py-1 pr-1 pl-3 sm:gap-2">
          <Link href={`/${locale}`} aria-label={t.nav.home} className="flex items-center gap-2 rounded-full pr-2">
            <OrbisMark className="size-6 text-lunar" />
            <span className="font-display text-sm font-medium tracking-tight">Orbis</span>
          </Link>
          {live && (
            <span className="readout hidden items-center gap-2 border-l border-hairline px-3 text-xs text-haze sm:flex">
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-seismic/70" />
                <span className="relative inline-flex size-1.5 rounded-full bg-seismic" />
              </span>
              <span className="text-lunar">{t.hud.live}</span>
              <span suppressHydrationWarning>
                {formatUtc(now, locale, false)} {t.hud.utc}
              </span>
            </span>
          )}
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
