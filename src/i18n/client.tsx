"use client";

import { createContext, useContext } from "react";
import { dictionaries, type Locale } from "./config";
import type { Dictionary } from "./en";

const LocaleContext = createContext<Locale>("en");

export function LocaleProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return <LocaleContext value={locale}>{children}</LocaleContext>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

export function useDict(): Dictionary {
  return dictionaries[useContext(LocaleContext)];
}
