import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { Geologica, Unbounded } from "next/font/google";
import { dictionaries, isLocale, locales } from "@/i18n/config";
import { LocaleProvider } from "@/i18n/client";
import "../globals.css";

const unbounded = Unbounded({ subsets: ["latin", "cyrillic"], variable: "--font-unbounded", display: "swap" });
const geologica = Geologica({ subsets: ["latin", "cyrillic"], variable: "--font-geologica", display: "swap" });

export const dynamicParams = false;

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://orbis-live.vercel.app";

export async function generateMetadata({ params }: LayoutProps<"/[locale]">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = dictionaries[locale];
  return {
    metadataBase: new URL(SITE),
    title: { default: t.meta.title, template: `%s · Orbis` },
    description: t.meta.description,
    alternates: { canonical: `/${locale}`, languages: { uk: "/uk", en: "/en" } },
    openGraph: {
      title: t.meta.title,
      description: t.meta.description,
      type: "website",
      locale: locale === "uk" ? "uk_UA" : "en_GB",
      images: [{ url: "/og.jpg", width: 1200, height: 630 }],
    },
    twitter: { card: "summary_large_image", title: t.meta.title, description: t.meta.description, images: ["/og.jpg"] },
  };
}

export default async function LocaleLayout({ children, params }: LayoutProps<"/[locale]">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return (
    <html lang={locale} className={`${unbounded.variable} ${geologica.variable} antialiased`}>
      <body>
        <LocaleProvider locale={locale}>{children}</LocaleProvider>
      </body>
    </html>
  );
}
