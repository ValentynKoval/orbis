"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/i18n/client";
import { formatTime, zoneLabel } from "@/lib/format";
import { useOrbis } from "@/store/orbis";

/** Re-renders every `ms` milliseconds and returns the current time. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * Publishes an element's height as a CSS variable on the page while `active`, so the docks above it keep
 * clear however its content wraps (the time controls take two rows on phones).
 */
export function useReserve<T extends HTMLElement>(name: string, active: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => root.style.setProperty(name, `${el.offsetHeight}px`));
    observer.observe(el);
    return () => observer.disconnect();
  }, [name, active]);
  return ref;
}

/** Picks up the browser's time zone once mounted (the server renders UTC). */
export function useTimeZoneSetup() {
  useEffect(() => {
    let utc = false;
    try {
      utc = localStorage.getItem("orbis-utc") === "1";
    } catch {
      // Storage blocked: default to local time.
    }
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    useOrbis.setState({ timeZone, utc });
  }, []);
}

/** Formats times in the visitor's zone (or UTC, by choice) and names the zone: "UTC+3". */
export function useClockFormat() {
  const locale = useLocale();
  const zone = useOrbis((s) => (s.utc ? "UTC" : s.timeZone));
  return {
    zone,
    time: (ms: number, withDate = true) => formatTime(ms, locale, zone, withDate),
    label: (ms: number) => zoneLabel(ms, zone),
  };
}

export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatch(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return match;
}
