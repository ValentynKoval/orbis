import { GlobeStage } from "@/components/GlobeStage";

export default function GlobeLayout({ children }: LayoutProps<"/[locale]">) {
  return (
    <>
      <GlobeStage />
      {children}
    </>
  );
}
