import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { dictionaries, isLocale } from "@/i18n/config";
import { ArrowUpRight, OrbisMark } from "@/components/icons";

export async function generateMetadata({ params }: PageProps<"/[locale]/case">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = dictionaries[locale].caseStudy;
  return { title: t.title, description: t.lead, alternates: { canonical: `/${locale}/case` } };
}

/** Data flow, drawn rather than described: sources on the left, our edge in the middle, the browser on the right. */
function Architecture() {
  const box = (x: number, y: number, w: number, h: number, title: string, sub: string, accent = false) => (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={14} fill={accent ? "rgb(242 193 78 / 0.08)" : "rgb(255 255 255 / 0.03)"} stroke={accent ? "rgb(242 193 78 / 0.55)" : "rgb(232 236 244 / 0.16)"} />
      <text x={x + 16} y={y + 27} fill="#e8ecf4" fontSize={14} fontWeight={500}>
        {title}
      </text>
      <text x={x + 16} y={y + 47} fill="#8d97ae" fontSize={11.5}>
        {sub}
      </text>
    </g>
  );
  const arrow = (d: string) => <path d={d} fill="none" stroke="rgb(232 236 244 / 0.35)" strokeWidth={1.2} markerEnd="url(#arrow)" />;
  return (
    <svg viewBox="0 0 880 400" className="h-auto w-full" role="img" aria-label="USGS, NASA, CelesTrak, adsb.lol, aisstream.io → Vercel routes and a Cloudflare relay → CDN → browser">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 10 5 0 10z" fill="rgb(232 236 244 / 0.5)" />
        </marker>
      </defs>
      {box(10, 20, 200, 62, "USGS, NASA FIRMS", "quakes, fires")}
      {box(10, 98, 200, 62, "NASA GIBS", "yesterday's clouds")}
      {box(10, 176, 200, 62, "CelesTrak", "via GitHub Action mirror")}
      {box(10, 254, 200, 62, "adsb.lol, aisstream.io", "aircraft, AIS stream")}
      {box(10, 332, 200, 62, "Google Gemini", "analyst, free tier")}

      {box(300, 60, 240, 120, "Vercel functions", "feed routes, cloud mask, analyst", true)}
      {box(300, 230, 240, 120, "Cloudflare Durable Object", "AIS socket, polling, SQLite history", true)}
      <text x={316} y={140} fill="#8d97ae" fontSize={11.5}>
        cached on the CDN, gzipped
      </text>
      <text x={316} y={310} fill="#8d97ae" fontSize={11.5}>
        5-minute frames, 25 h
      </text>

      {box(630, 150, 240, 100, "Browser", "WebGL globe, SGP4 worker")}
      <text x={646} y={222} fill="#8d97ae" fontSize={11.5}>
        GPU motion for 50k objects
      </text>

      {arrow("M210 51 C 255 51, 255 95, 298 95")}
      {arrow("M210 129 C 255 129, 255 115, 298 115")}
      {arrow("M210 207 C 255 207, 255 140, 298 140")}
      {arrow("M210 285 C 255 285, 255 290, 298 290")}
      {arrow("M210 363 C 260 363, 260 165, 298 165")}
      {arrow("M420 230 L 420 182")}
      {arrow("M540 120 C 585 120, 585 185, 628 185")}
      {arrow("M540 290 C 585 290, 585 215, 628 215")}
    </svg>
  );
}

export default async function CasePage({ params }: PageProps<"/[locale]/case">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = dictionaries[locale];
  const c = t.caseStudy;

  return (
    <main className="mx-auto min-h-[100dvh] max-w-4xl px-5 pt-[max(2rem,env(safe-area-inset-top))] pb-28 md:px-8">
      <nav className="flex items-center justify-between py-4">
        <Link href={`/${locale}`} aria-label={t.nav.home} className="flex items-center gap-2">
          <OrbisMark className="size-7 text-lunar" />
          <span className="font-display text-sm font-medium tracking-tight">Orbis</span>
        </Link>
        <Link href={`/${locale}/live`} className="rounded-full bg-foil px-4 py-2 text-xs font-medium text-black">
          {c.open}
        </Link>
      </nav>

      <header className="mt-20 max-w-3xl">
        <h1 className="font-display text-[clamp(2.4rem,7vw,4.8rem)] leading-[0.98] font-medium tracking-[-0.045em]">{c.title}</h1>
        <p className="mt-7 max-w-[40rem] text-lg leading-relaxed text-haze">{c.lead}</p>
      </header>

      <dl className="mt-16 grid grid-cols-2 gap-x-6 gap-y-8 border-t border-hairline pt-8 sm:grid-cols-5">
        {c.figures.map(([value, label]) => (
          <div key={label}>
            <dt className="sr-only">{label}</dt>
            <dd className="readout font-display text-2xl font-light tracking-tight text-lunar md:text-3xl">{value}</dd>
            <dd aria-hidden className="mt-1.5 text-xs leading-snug text-haze">
              {label}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-24 space-y-20">
        {c.sections.map((s, i) => (
          <section key={s.title} className="grid gap-4 md:grid-cols-[13rem_1fr] md:gap-10">
            <h2 className="font-display text-lg leading-snug font-medium tracking-tight">{s.title}</h2>
            <div>
              <p className="max-w-[40rem] leading-relaxed text-haze">{s.body}</p>
              {i === 1 && (
                <figure className="bezel mt-8">
                  <div className="bezel-core p-4 md:p-6">
                    <Architecture />
                  </div>
                </figure>
              )}
            </div>
          </section>
        ))}

        <section className="grid gap-4 md:grid-cols-[13rem_1fr] md:gap-10">
          <h2 className="font-display text-lg leading-snug font-medium tracking-tight">{c.problemsTitle}</h2>
          <ul className="border-t border-hairline">
            {c.problems.map(([problem, fix]) => (
              <li key={problem} className="border-b border-hairline py-5">
                <h3 className="text-sm font-medium text-lunar">{problem}</h3>
                <p className="mt-1.5 max-w-[38rem] text-sm leading-relaxed text-haze">{fix}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="grid gap-4 md:grid-cols-[13rem_1fr] md:gap-10">
          <h2 className="font-display text-lg leading-snug font-medium tracking-tight">{c.stackTitle}</h2>
          <ul className="flex flex-wrap gap-2">
            {c.stack.map((item) => (
              <li key={item} className="rounded-full border border-hairline px-3.5 py-1.5 text-sm text-haze">
                {item}
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="mt-24 flex flex-wrap items-center gap-4">
        <Link
          href={`/${locale}/live`}
          className="group inline-flex items-center gap-3 rounded-full bg-foil py-2 pr-2 pl-6 text-sm font-medium text-black transition-transform duration-500 ease-[var(--ease-orbit)] active:scale-[0.98]"
        >
          {c.open}
          <span className="flex size-9 items-center justify-center rounded-full bg-black/10 transition-transform duration-500 ease-[var(--ease-orbit)] group-hover:translate-x-0.5 group-hover:-translate-y-px">
            <ArrowUpRight className="size-4" />
          </span>
        </Link>
        <Link href={`/${locale}/sources`} className="text-sm text-haze underline decoration-hairline underline-offset-4 hover:text-lunar">
          {t.nav.sources}
        </Link>
      </div>
    </main>
  );
}
