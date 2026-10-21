"use client";

import { useState } from "react";
import { useDict } from "@/i18n/client";
import { useOrbis } from "@/store/orbis";
import { Link as LinkIcon } from "./icons";

/** Copies a link that reopens this exact view: camera, time and layers. */
export function Share() {
  const t = useDict();
  const [copied, setCopied] = useState(false);

  const share = async () => {
    const s = useOrbis.getState();
    const e = s.engine;
    if (!e) return;
    const url = new URL(window.location.href);
    url.search = "";
    const r = e.space === "earth" ? e.rig.pose : e.system.rig.pose;
    url.searchParams.set("at", `${r.lat.toFixed(3)},${r.lon.toFixed(3)},${r.dist.toPrecision(5)}`);
    if (e.space === "system") url.searchParams.set("space", e.system.focus.kind === "major" ? e.system.focus.id : "earth");
    if (!s.time.live) url.searchParams.set("t", String(Math.round(e.clock.now())));
    const on = (Object.keys(s.layers) as (keyof typeof s.layers)[]).filter((k) => s.layers[k]);
    url.searchParams.set("layers", on.join(","));
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt(t.share.prompt, url.toString());
    }
  };

  return (
    <button type="button" onClick={share} aria-label={t.share.button} title={t.share.button} className="bezel pointer-events-auto rounded-full p-1">
      <span className={`bezel-core flex items-center gap-2 rounded-full px-3.5 py-2.5 text-sm ${copied ? "text-foil" : "text-lunar"}`}>
        <LinkIcon className="size-4" />
        <span className="hidden 2xl:inline">{copied ? t.share.copied : t.share.button}</span>
      </span>
    </button>
  );
}
