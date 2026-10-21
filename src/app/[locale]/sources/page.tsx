import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { dictionaries, isLocale } from "@/i18n/config";
import { ArrowUpRight, OrbisMark } from "@/components/icons";

export async function generateMetadata({ params }: PageProps<"/[locale]/sources">): Promise<Metadata> {
  const { locale } = await params;
  return isLocale(locale) ? { title: dictionaries[locale].sources.title, alternates: { canonical: `/${locale}/sources` } } : {};
}

export default async function SourcesPage({ params }: PageProps<"/[locale]/sources">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = dictionaries[locale];

  return (
    <main className="mx-auto min-h-[100dvh] max-w-3xl px-5 pt-[max(2rem,env(safe-area-inset-top))] pb-24 md:px-8">
      <nav className="flex items-center justify-between py-4">
        <Link href={`/${locale}`} aria-label={t.nav.home} className="flex items-center gap-2">
          <OrbisMark className="size-7 text-lunar" />
          <span className="font-display text-sm font-medium tracking-tight">Orbis</span>
        </Link>
        <Link href={`/${locale}/live`} className="rounded-full bg-foil px-4 py-2 text-xs font-medium text-black">
          {t.sources.back}
        </Link>
      </nav>

      <h1 className="mt-20 font-display text-[clamp(2.2rem,6vw,4rem)] leading-[1] font-medium tracking-[-0.045em]">{t.sources.title}</h1>
      <p className="mt-6 max-w-[38rem] text-lg leading-relaxed text-haze">{t.sources.lead}</p>

      <ul className="mt-16 border-t border-hairline">
        {t.sources.items.map((item) => (
          <li key={item.url} className="grid gap-2 border-b border-hairline py-7 md:grid-cols-[14rem_1fr] md:gap-8">
            <h2 className="font-display text-sm leading-snug font-medium tracking-tight">{item.name}</h2>
            <div>
              <p className="leading-relaxed text-haze">{item.text}</p>
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 text-sm text-lunar underline decoration-hairline underline-offset-4 hover:decoration-foil"
              >
                {new URL(item.url).host}
                <ArrowUpRight className="size-3.5" />
              </a>
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-10 max-w-[38rem] text-sm leading-relaxed text-haze">{t.sources.ai}</p>
      <p className="mt-4 max-w-[38rem] text-sm leading-relaxed text-dim">{t.sources.note}</p>
    </main>
  );
}
