/**
 * Landmarks pinned to the globe: the extremes of the planet, natural wonders,
 * the places spaceflight started from, and where space hit back. Names and
 * stories live in the dictionaries (`places.*`); this file holds the facts
 * that need no translation. Coordinates are the feature itself (a summit, a
 * launch pad, a crater centre), elevations in metres above sea level.
 */

export type PlaceCategory = "extreme" | "wonder" | "space" | "impact";

export interface Place {
  id: PlaceId;
  lat: number;
  lon: number;
  category: PlaceCategory;
  /** Height above (or below, negative) sea level, metres. */
  elevationM?: number;
  /** Camera distance for "Fly there", Earth radii from the centre. */
  view: number;
  /** Larger landmarks win label space. */
  rank: number;
}

export const PLACE_IDS = [
  "everest",
  "challenger",
  "deadSea",
  "chimborazo",
  "maunaKea",
  "deathValley",
  "vostok",
  "mawsynram",
  "atacama",
  "baikal",
  "angelFalls",
  "pointNemo",
  "kola",
  "hoverla",
  "uyuni",
  "burjKhalifa",
  "greatBarrierReef",
  "richat",
  "greatWall",
  "baikonur",
  "canaveral",
  "starbase",
  "kourou",
  "alma",
  "arecibo",
  "greenwich",
  "chicxulub",
  "barringer",
  "tunguska",
  "chelyabinsk",
] as const;
export type PlaceId = (typeof PLACE_IDS)[number];

export const PLACES: Place[] = [
  { id: "everest", lat: 27.9881, lon: 86.925, category: "extreme", elevationM: 8849, view: 1.006, rank: 10 },
  { id: "challenger", lat: 11.3733, lon: 142.5917, category: "extreme", elevationM: -10935, view: 1.08, rank: 10 },
  { id: "deadSea", lat: 31.559, lon: 35.4732, category: "extreme", elevationM: -430, view: 1.02, rank: 8 },
  { id: "chimborazo", lat: -1.4692, lon: -78.8175, category: "extreme", elevationM: 6263, view: 1.006, rank: 8 },
  { id: "maunaKea", lat: 19.8207, lon: -155.4681, category: "extreme", elevationM: 4207, view: 1.012, rank: 7 },
  { id: "deathValley", lat: 36.4622, lon: -116.8669, category: "extreme", elevationM: -58, view: 1.012, rank: 7 },
  { id: "vostok", lat: -78.4645, lon: 106.8339, category: "extreme", elevationM: 3488, view: 1.05, rank: 7 },
  { id: "mawsynram", lat: 25.2976, lon: 91.5826, category: "extreme", elevationM: 1400, view: 1.01, rank: 5 },
  { id: "atacama", lat: -24.5, lon: -69.25, category: "extreme", view: 1.04, rank: 6 },
  { id: "baikal", lat: 53.5, lon: 108, category: "wonder", elevationM: 456, view: 1.15, rank: 8 },
  { id: "angelFalls", lat: 5.967, lon: -62.5355, category: "wonder", view: 1.004, rank: 6 },
  { id: "pointNemo", lat: -48.8767, lon: -123.3933, category: "extreme", view: 1.7, rank: 7 },
  { id: "kola", lat: 69.3965, lon: 30.609, category: "extreme", view: 1.01, rank: 5 },
  { id: "hoverla", lat: 48.1603, lon: 24.5, category: "extreme", elevationM: 2061, view: 1.005, rank: 6 },
  { id: "uyuni", lat: -20.1338, lon: -67.4891, category: "wonder", elevationM: 3656, view: 1.03, rank: 6 },
  { id: "burjKhalifa", lat: 25.1972, lon: 55.2744, category: "wonder", view: 1.0008, rank: 6 },
  { id: "greatBarrierReef", lat: -18.2871, lon: 147.6992, category: "wonder", view: 1.25, rank: 9 },
  { id: "richat", lat: 21.127, lon: -11.401, category: "wonder", view: 1.02, rank: 6 },
  { id: "greatWall", lat: 40.4319, lon: 116.5704, category: "wonder", view: 1.003, rank: 7 },
  { id: "baikonur", lat: 45.92, lon: 63.3422, category: "space", view: 1.004, rank: 9 },
  { id: "canaveral", lat: 28.6082, lon: -80.6041, category: "space", view: 1.004, rank: 9 },
  { id: "starbase", lat: 25.9972, lon: -97.156, category: "space", view: 1.002, rank: 7 },
  { id: "kourou", lat: 5.239, lon: -52.7684, category: "space", view: 1.004, rank: 7 },
  { id: "alma", lat: -23.0193, lon: -67.7532, category: "space", elevationM: 5050, view: 1.004, rank: 6 },
  { id: "arecibo", lat: 18.3464, lon: -66.7528, category: "space", view: 1.002, rank: 5 },
  { id: "greenwich", lat: 51.4778, lon: -0.0015, category: "space", view: 1.002, rank: 6 },
  { id: "chicxulub", lat: 21.4, lon: -89.5167, category: "impact", view: 1.06, rank: 8 },
  { id: "barringer", lat: 35.0274, lon: -111.0225, category: "impact", view: 1.0015, rank: 6 },
  { id: "tunguska", lat: 60.886, lon: 101.894, category: "impact", view: 1.02, rank: 7 },
  { id: "chelyabinsk", lat: 55.15, lon: 61.41, category: "impact", view: 1.02, rank: 5 },
];

export const PLACE_COLORS: Record<PlaceCategory, string> = {
  extreme: "#f2c14e",
  wonder: "#4fd1b0",
  space: "#8ccbff",
  impact: "#ff8a3d",
};

export function placeById(id: string): Place | undefined {
  return PLACES.find((p) => p.id === id);
}
