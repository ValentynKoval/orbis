// Orbis service worker: keeps map tiles between visits, so a place seen once
// opens instantly next time. Only imagery and terrain tiles are touched; pages,
// scripts and live data always go to the network. Each source's own freshness
// is respected (Esri asks for a day, EOX a week; terrain never changes).

const CACHE = "orbis-tiles-v1";
const MAX_ENTRIES = 5000;
const DAY = 86_400_000;
const RULES = [
  { test: (u) => u.hostname === "tiles.maps.eox.at", ttl: 7 * DAY },
  { test: (u) => u.hostname === "ibasemaps-api.arcgis.com", ttl: DAY },
  { test: (u) => u.origin === self.location.origin && u.pathname.startsWith("/api/terrain/"), ttl: 365 * DAY },
];

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith("orbis-tiles-") && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

let puts = 0;
async function trim(cache) {
  if (++puts % 200) return;
  const keys = await cache.keys();
  // Insertion order: the oldest entries go first.
  for (let i = 0; i < keys.length - MAX_ENTRIES; i++) await cache.delete(keys[i]);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const rule = RULES.find((r) => r.test(url));
  if (!rule) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreVary: true });
      if (hit && Date.now() - Number(hit.headers.get("x-orbis-cached") || 0) < rule.ttl) return hit;
      const res = await fetch(req);
      if (res.ok && (res.type === "cors" || res.type === "basic")) {
        const body = await res.clone().arrayBuffer();
        const headers = new Headers(res.headers);
        headers.set("x-orbis-cached", String(Date.now()));
        event.waitUntil(cache.put(req, new Response(body, { status: res.status, statusText: res.statusText, headers })).then(() => trim(cache)));
      }
      return res;
    })(),
  );
});
