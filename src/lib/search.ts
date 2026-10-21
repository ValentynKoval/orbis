/** Ranking for the search palette: exact beats prefix beats word prefix beats substring. */

export type SearchKind = "satellite" | "plane" | "ship" | "quake";

export interface SearchCandidate {
  kind: SearchKind;
  /** Identifies the object within its kind (satellite index, ICAO hex, MMSI, quake id). */
  key: string | number;
  label: string;
  sub: string;
  /** Strings the query is matched against. */
  terms: string[];
}

export interface SearchResult extends SearchCandidate {
  score: number;
}

export function normalize(s: string): string {
  return s.toUpperCase().replace(/[\s\-_.()/]+/g, "");
}

function scoreTerm(term: string, q: string): number {
  if (!term) return 0;
  const n = normalize(term);
  if (n === q) return 100;
  // Whole words: "ISS (ZARYA)" is the ISS. Word starts: "SPACE STATION" matches "STAT".
  const words = term.toUpperCase().split(/[\s\-_/()]+/);
  if (words.includes(q)) return 90;
  if (n.startsWith(q)) return 70 - Math.min(20, n.length - q.length);
  if (words.some((w) => w.startsWith(q))) return 45;
  if (q.length >= 3 && n.includes(q)) return 25;
  return 0;
}

export function search(query: string, candidates: Iterable<SearchCandidate>, perKind = 6): SearchResult[] {
  const q = normalize(query);
  if (q.length < 2) return [];
  const byKind = new Map<SearchKind, SearchResult[]>();
  for (const c of candidates) {
    let best = 0;
    for (const t of c.terms) best = Math.max(best, scoreTerm(t, q));
    if (!best) continue;
    let list = byKind.get(c.kind);
    if (!list) byKind.set(c.kind, (list = []));
    list.push({ ...c, score: best });
  }
  const out: SearchResult[] = [];
  for (const list of byKind.values()) {
    list.sort((a, b) => b.score - a.score || a.label.length - b.label.length);
    out.push(...list.slice(0, perKind));
  }
  return out.sort((a, b) => b.score - a.score);
}
