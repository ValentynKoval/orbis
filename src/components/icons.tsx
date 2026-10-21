/** Hairline glyphs drawn for Orbis: 1.25px strokes on a 24px grid. */
type IconProps = { className?: string };

const base = {
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.25,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function ArrowUpRight({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  );
}

export function Close({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

export function Target({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="6.5" />
      <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" />
    </svg>
  );
}

export function Stack({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="m12 4 8.5 4.5L12 13 3.5 8.5 12 4Z" />
      <path d="m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5 12 21l8.5-4.5" />
    </svg>
  );
}

export function Recenter({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <ellipse cx="12" cy="12" rx="3.6" ry="8.5" />
      <path d="M3.5 12h17" />
    </svg>
  );
}

/** The Orbis mark: a planet cut by an inclined orbit, with the station on it. */
export function OrbisMark({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden className={className}>
      <circle cx="16" cy="16" r="8" fill="currentColor" opacity="0.92" />
      <ellipse cx="16" cy="16" rx="14.5" ry="5.2" transform="rotate(-24 16 16)" stroke="currentColor" strokeWidth="1.3" opacity="0.55" />
      <circle cx="28.3" cy="10.6" r="2.1" fill="#f2c14e" />
    </svg>
  );
}

export function Magnifier({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
    </svg>
  );
}

/** The analyst: a four-point star, like a glint on a lens. */
export function Spark({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M12 3.5c.6 4.6 3.9 7.9 8.5 8.5-4.6.6-7.9 3.9-8.5 8.5-.6-4.6-3.9-7.9-8.5-8.5 4.6-.6 7.9-3.9 8.5-8.5Z" />
    </svg>
  );
}

/** Sound: a carrier wave; muted, a flat line. */
export function Wave({ className, on }: IconProps & { on: boolean }) {
  return (
    <svg {...base} className={className}>
      <path d="M2.5 12c1.6 0 1.6-5 3.2-5s1.6 10 3.2 10 1.6-13 3.1-13 1.6 16 3.2 16 1.6-10 3.2-10 1.5 7 3.1 7" opacity={on ? 1 : 0.55} />
      {!on && <path d="m4 20 16-16" />}
    </svg>
  );
}
