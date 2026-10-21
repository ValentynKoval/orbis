import { describe, expect, it } from "vitest";
import { search, type SearchCandidate } from "./search";

const c = (kind: SearchCandidate["kind"], key: string | number, ...terms: string[]): SearchCandidate => ({
  kind,
  key,
  label: terms[0],
  sub: "",
  terms,
});

describe("search", () => {
  const items = [
    c("satellite", 1, "ISS (ZARYA)"),
    c("satellite", 2, "STARLINK-1007"),
    c("plane", "508035", "PS751", "UR-PSR", "B738"),
    c("plane", "4b1805", "SWR8", "HB-JHA", "A333"),
    c("ship", 273, "ISSA"),
  ];

  it("ignores one-letter queries", () => {
    expect(search("i", items)).toEqual([]);
  });

  it("ranks an exact callsign above prefixes", () => {
    const r = search("ps 751", items);
    expect(r[0].key).toBe("508035");
  });

  it("matches registrations without punctuation", () => {
    expect(search("urpsr", items).map((x) => x.key)).toEqual(["508035"]);
  });

  it("finds word starts and keeps the closest match first", () => {
    const r = search("iss", items);
    expect(r.map((x) => x.key)).toEqual([1, 273]);
  });

  it("caps results per kind", () => {
    const many = Array.from({ length: 20 }, (_, i) => c("satellite", i, `STARLINK-${1000 + i}`));
    expect(search("starlink", many, 5)).toHaveLength(5);
  });
});
