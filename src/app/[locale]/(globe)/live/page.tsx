import type { Metadata } from "next";
import { LiveHud } from "@/components/LiveHud";
import { dictionaries, isLocale } from "@/i18n/config";

export async function generateMetadata({ params }: PageProps<"/[locale]/live">): Promise<Metadata> {
  const { locale } = await params;
  return isLocale(locale) ? { title: dictionaries[locale].nav.live, alternates: { canonical: `/${locale}/live` } } : {};
}

export default function LivePage() {
  return <LiveHud />;
}
