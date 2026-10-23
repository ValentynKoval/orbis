"use client";

import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useOrbis } from "@/store/orbis";

/** The HUD layer that docked panels render into. */
export const DockHost = createContext<HTMLElement | null>(null);

/**
 * Renders a panel into the HUD's dock layer. A panel opened from a toolbar button would otherwise be placed
 * relative to the toolbar instead of the viewport, and miss the dock lines every other panel keeps. Docked
 * panels belong to the Earth view and step aside in the heliocentric one.
 */
export function Dock({ children }: { children: ReactNode }) {
  const host = useContext(DockHost);
  const space = useOrbis((s) => s.space);
  return host && space === "earth" ? createPortal(children, host) : null;
}
