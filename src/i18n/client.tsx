"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { dictionaries, LOCALE_COOKIE, type Locale } from "./config";
import type { Dictionary } from "./en";

type LocaleState = {
  /** The language the interface speaks. */
  locale: Locale;
  /** The language of the route React rendered; differs from `locale` after a switch on the globe. */
  route: Locale;
  setLocale(locale: Locale): void;
};

const LocaleContext = createContext<LocaleState>({ locale: "en", route: "en", setLocale: () => undefined });

/**
 * Holds the interface language. On the globe pages the language switches here, on the client, and the address bar
 * follows through history.replaceState: navigating to /{other}/… would change the root [locale] segment, remount
 * the whole tree and rebuild the 3D engine, throwing the camera back to Earth.
 */
export function LocaleProvider({ locale: route, children }: { locale: Locale; children: React.ReactNode }) {
  const [locale, setLocale] = useState<Locale>(route);
  const [seen, setSeen] = useState<Locale>(route);
  // A real navigation to another language (a typed URL, a server-rendered page) wins over the switch.
  if (seen !== route) {
    setSeen(route);
    setLocale(route);
  }
  const pathname = usePathname();

  // Also runs after a link between the globe pages: those keep the route's language in the address (useGlobeHref).
  useEffect(() => {
    const parts = window.location.pathname.split("/");
    if (parts[1] !== locale) {
      parts[1] = locale;
      window.history.replaceState(null, "", parts.join("/") + window.location.search + window.location.hash);
    }
    document.documentElement.lang = locale;
    document.title = translateTitle(document.title, dictionaries[locale]);
  }, [locale, pathname]);

  return (
    <LocaleContext
      value={{
        locale,
        route,
        setLocale: (next) => {
          document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
          setLocale(next);
        },
      }}
    >
      {children}
    </LocaleContext>
  );
}

/** Page titles come from server metadata in the route's language; these are the ones the globe pages use. */
function translateTitle(title: string, to: Dictionary): string {
  for (const from of Object.values(dictionaries)) {
    if (title === from.meta.title) return to.meta.title;
    if (title.startsWith(`${from.nav.live} ·`)) return to.nav.live + title.slice(from.nav.live.length);
  }
  return title;
}

export function useLocale(): Locale {
  return useContext(LocaleContext).locale;
}

export function useSetLocale(): (locale: Locale) => void {
  return useContext(LocaleContext).setLocale;
}

/**
 * A link between the globe pages (/{locale} and /{locale}/live). It keeps the route's language so the router
 * reuses the mounted globe; the provider then rewrites the address to the interface language.
 * Links that leave the globe (sources, case study) use `useLocale()` and render in that language.
 */
export function useGlobeHref(): (path: "" | "/live") => string {
  const { route } = useContext(LocaleContext);
  return (path) => `/${route}${path}`;
}

export function useDict(): Dictionary {
  return dictionaries[useLocale()];
}
