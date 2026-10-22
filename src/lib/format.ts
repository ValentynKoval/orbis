import type { Locale } from "@/i18n/config";

const intlLocale = (locale: Locale) => (locale === "uk" ? "uk-UA" : "en-GB");

export function formatNumber(n: number, locale: Locale, digits = 0): string {
  return new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);
}

export function formatAgo(ms: number, now: number, locale: Locale): string {
  const rtf = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: "auto" });
  const s = Math.round((ms - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, "second");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}

export function formatUtc(ms: number, locale: Locale, withDate = true): string {
  return formatTime(ms, locale, "UTC", withDate);
}

/** Clock time in an IANA zone ("Europe/Kyiv"); falls back to UTC for an unknown zone. */
export function formatTime(ms: number, locale: Locale, timeZone: string, withDate = true): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: safeZone(timeZone),
    ...(withDate ? { day: "numeric", month: "short" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    second: withDate ? undefined : "2-digit",
    hourCycle: "h23",
  }).format(ms);
}

/** "UTC+3", "UTC−5:30", "UTC" for a moment in a zone (the offset changes with daylight saving). */
export function zoneLabel(ms: number, timeZone: string): string {
  if (safeZone(timeZone) === "UTC") return "UTC";
  const part = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(ms)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = part?.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return "UTC";
  const h = Number(m[2]);
  return `UTC${m[1] === "-" ? "−" : "+"}${h}${m[3] === "00" ? "" : `:${m[3]}`}`;
}

function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

export function formatDate(isoDate: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { timeZone: "UTC", day: "numeric", month: "long" }).format(Date.parse(isoDate));
}

/** 50.45, 30.52 → "50.45° N, 30.52° E" */
export function formatLatLon(lat: number, lon: number): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(2)}° ${ns}, ${Math.abs(lon).toFixed(2)}° ${ew}`;
}
