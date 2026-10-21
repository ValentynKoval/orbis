/**
 * Wire formats shared by the relay (relay/src) and the site. Columnar arrays
 * keep payloads small and compress well; coordinates are integers (degrees ×
 * 10⁴, ~11 m) so JSON stays compact.
 */

export interface PlaneSnapshot {
  /** Unix ms of the aircraft list. */
  t: number;
  /** ICAO 24-bit address, hex. */
  ids: string[];
  callsign: string[];
  /** Registration, e.g. "UR-PSR". */
  reg: string[];
  /** ICAO type designator, e.g. "B738". */
  type: string[];
  lat: number[];
  lon: number[];
  /** Metres (geometric if known, else barometric). */
  alt: number[];
  /** Ground speed, m/s × 10. */
  spd: number[];
  /** Track over ground, degrees × 10. */
  trk: number[];
  /** Vertical rate, m/s × 10. */
  vr: number[];
  /** 1 = on the ground. */
  gnd: number[];
  /** Seconds between the position fix and `t`. */
  age: number[];
  /** ADS-B emitter category, e.g. "A3" ("" = unknown). */
  cat: string[];
  squawk: string[];
  /** 1 = the aircraft is signalling an emergency. */
  emg: number[];
}

export interface ShipSnapshot {
  t: number;
  /** MMSI. */
  ids: number[];
  lat: number[];
  lon: number[];
  /** Speed over ground, knots × 10. */
  sog: number[];
  /** Course over ground, degrees × 10. */
  cog: number[];
  /** ShipKind. */
  kind: number[];
  /** Seconds between the last report and `t`. */
  age: number[];
}

export interface ShipDetail {
  mmsi: number;
  name: string;
  callsign: string;
  destination: string;
  kind: number;
  /** AIS ship type code. */
  type: number;
  lengthM: number;
  imo: number;
  lat: number;
  lon: number;
  sog: number;
  cog: number;
  heading: number | null;
  t: number;
  /** [unix s, lat, lon] … */
  track: number[];
}

export interface PlaneTrack {
  id: string;
  /** [unix s, lat, lon, alt m] … */
  track: number[];
}

/** Coarse vessel families for colour and filters. */
export const ShipKind = {
  Other: 0,
  Cargo: 1,
  Tanker: 2,
  Passenger: 3,
  Fishing: 4,
  Leisure: 5,
  Service: 6,
} as const;
export type ShipKind = (typeof ShipKind)[keyof typeof ShipKind];
export const SHIP_KINDS = 7;

/** AIS "type of ship and cargo" code → ShipKind. */
export function shipKind(type: number): ShipKind {
  if (type >= 70 && type <= 79) return ShipKind.Cargo;
  if (type >= 80 && type <= 89) return ShipKind.Tanker;
  if (type >= 60 && type <= 69) return ShipKind.Passenger;
  if (type === 30) return ShipKind.Fishing;
  if (type === 36 || type === 37) return ShipKind.Leisure;
  if (type === 31 || type === 32 || (type >= 50 && type <= 59) || (type >= 40 && type <= 49)) return ShipKind.Service;
  return ShipKind.Other;
}

export const COORD_SCALE = 10_000;
