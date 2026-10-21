import { Hub, type Env } from "./hub";

export { Hub };

/**
 * Public entry. Only the Orbis site (which holds RELAY_TOKEN) may read; it
 * caches responses on its CDN, so visitor traffic never reaches this worker
 * or the upstream providers directly.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    if (request.headers.get("x-orbis-key") !== env.RELAY_TOKEN) return new Response("Forbidden", { status: 403 });
    const hub = env.HUB.get(env.HUB.idFromName("global"));
    return hub.fetch(request);
  },

  /** Keeps the hub alive and its alarm armed even if nobody has visited for a while. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const hub = env.HUB.get(env.HUB.idFromName("global"));
    await hub.fetch("https://hub/health");
  },
} satisfies ExportedHandler<Env>;
