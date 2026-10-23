/**
 * GitHub's own cron for public repositories fires hours late (three runs a day
 * instead of 144), so the worker's cron starts the ships collector instead:
 * a workflow_dispatch starts within seconds. Ten minutes keeps Actions busy
 * about two minutes in ten and costs one subrequest per dispatch.
 */
export const AIS_WORKFLOW_URL = "https://api.github.com/repos/ValentynKoval/orbis/actions/workflows/ais.yml/dispatches";
export const AIS_EVERY_MIN = 10;

/** The worker cron runs every 5 min; only every other tick (:00, :10, …) dispatches. */
export function aisDispatchDue(scheduledTime: number): boolean {
  return Math.round(scheduledTime / 60_000) % AIS_EVERY_MIN === 0;
}

export async function dispatchAis(token: string): Promise<void> {
  const res = await fetch(AIS_WORKFLOW_URL, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      // A secret piped in from Windows PowerShell 5.1 starts with a BOM (GitHub then answers 401); trim() drops it.
      Authorization: `Bearer ${token.trim()}`,
      "Content-Type": "application/json",
      "User-Agent": "Orbis/1.0 (+https://github.com/ValentynKoval/orbis)",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ ref: "main" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status !== 204) throw new Error(`workflow dispatch responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
