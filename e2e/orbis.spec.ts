import { expect, test, type Page } from "@playwright/test";

/** The globe fades in once base textures are on the GPU. */
async function globeReady(page: Page) {
  await expect(page.locator("canvas")).toHaveCSS("opacity", "1", { timeout: 60_000 });
}

test.describe("landing", () => {
  test("sends a Ukrainian browser to /uk", async ({ browser }) => {
    const context = await browser.newContext({ locale: "uk-UA", extraHTTPHeaders: { "Accept-Language": "uk-UA,uk;q=0.9" } });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page).toHaveURL(/\/uk$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Планета наживо.");
    await context.close();
  });

  test("shows live counts and leads to the globe", async ({ page }) => {
    await page.goto("/en");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("The planet, live.");
    await globeReady(page);
    // Satellites come from the CelesTrak mirror: the count turns into a real number.
    await expect(page.locator("dd").first()).toHaveText(/\d[\d,\s]{3,}/);
    await page.getByRole("link", { name: "Open the live globe" }).first().click();
    await expect(page).toHaveURL(/\/en\/live$/);
  });

  test("switches language and keeps the page", async ({ page }) => {
    await page.goto("/en/live");
    await page.getByRole("link", { name: "Мова: українська" }).click();
    await expect(page).toHaveURL(/\/uk\/live$/);
    await expect(page.getByRole("button", { name: "Спитати Orbis" })).toBeVisible();
  });
});

test.describe("live globe", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/en/live");
    await globeReady(page);
  });

  test("toggles layers", async ({ page, isMobile }) => {
    if (isMobile) await page.getByRole("button", { name: "Show layers" }).click();
    const fires = page.getByRole("switch", { name: /Fires/ });
    await expect(fires).toHaveAttribute("aria-checked", "true");
    await fires.click();
    await expect(fires).toHaveAttribute("aria-checked", "false");
    // Aircraft load from the relay and show their count.
    await expect(page.getByRole("switch", { name: /Aircraft/ })).toContainText(/\d{1,3}(,\d{3})+/);
  });

  test("finds the ISS and opens its card", async ({ page }) => {
    await page.getByRole("button", { name: "Search" }).click();
    const box = page.getByRole("dialog").getByPlaceholder("Satellite, flight, ship or place");
    await box.fill("ISS");
    await expect(page.getByRole("option").first()).toContainText("ISS (ZARYA)");
    await box.press("Enter");
    const card = page.getByRole("complementary", { name: "ISS (ZARYA)" });
    await expect(card).toBeVisible();
    await expect(card).toContainText(/Altitude\s*4\d\d km/);
  });

  test("rides along with the ISS and hands the camera back", async ({ page }) => {
    await page.getByRole("button", { name: "Search" }).click();
    const box = page.getByRole("dialog").getByPlaceholder("Satellite, flight, ship or place");
    await box.fill("ISS");
    await expect(page.getByRole("option").first()).toContainText("ISS (ZARYA)");
    await box.press("Enter");
    const card = page.getByRole("complementary", { name: "ISS (ZARYA)" });
    await card.getByRole("button", { name: "Ride along" }).click();
    const stop = card.getByRole("button", { name: "Stop riding" });
    await expect(stop).toHaveAttribute("aria-pressed", "true");
    await stop.click();
    await expect(card.getByRole("button", { name: "Ride along" })).toHaveAttribute("aria-pressed", "false");
  });

  test("replays the past and returns to live", async ({ page }) => {
    const timeline = page.getByRole("region", { name: "Timeline, last 24 hours" });
    await timeline.getByRole("button", { name: "600×" }).click();
    const back = timeline.getByRole("button", { name: "Back to live" });
    await expect(back).toBeEnabled();
    await back.click();
    await expect(timeline.getByRole("button", { name: "Live" })).toBeDisabled();
  });

  test("opens the analyst with its disclosure", async ({ page }) => {
    await page.getByRole("button", { name: "Ask Orbis" }).click();
    const panel = page.getByRole("region", { name: "Ask Orbis" });
    await expect(panel).toContainText("Google Gemini");
    await expect(panel.getByRole("button", { name: "Where is the ISS?" })).toBeVisible();
  });
});

test("sources credit every data provider", async ({ page }) => {
  await page.goto("/en/sources");
  for (const name of ["CelesTrak", "adsb.lol", "aisstream.io", "Digitraffic", "USGS", "NASA FIRMS", "NASA GIBS", "NOAA GFS", "GDACS", "Natural Earth", "OpenStreetMap", "d3-celestial", "NASA/Goddard SVS"]) {
    await expect(page.getByRole("heading", { name: new RegExp(name) })).toBeVisible();
  }
  await expect(page.getByText("ODbL").first()).toBeVisible();
});

test("feeds answer with CDN cache headers", async ({ request }) => {
  const res = await request.get("/api/quakes");
  expect(res.ok()).toBeTruthy();
  expect(res.headers()["cache-control"]).toContain("s-maxage");
  const body = await res.json();
  expect(Array.isArray(body.quakes)).toBeTruthy();
});

test("tropical cyclones come with their tracks and open a card", async ({ page, request, isMobile }) => {
  const res = await request.get("/api/storms");
  expect(res.ok()).toBeTruthy();
  expect(res.headers()["cache-control"]).toContain("s-maxage");
  const { storms } = (await res.json()) as { storms: { id: number; name: string; track: { t: number }[] }[] };
  expect(Array.isArray(storms)).toBeTruthy();
  await page.goto("/en/live?debug=1");
  await globeReady(page);
  if (isMobile) await page.getByRole("button", { name: "Show layers" }).click();
  await expect(page.getByRole("switch", { name: /Cyclones/ })).toHaveAttribute("aria-checked", "true");
  // Whatever storms are active today (there may be none), each one opens its card.
  const storm = storms.find((s) => s.track.length > 1);
  if (!storm) return;
  if (isMobile) await page.getByRole("button", { name: "Close layers" }).click();
  await page.waitForFunction(() => (window as unknown as { __orbisStore: { getState(): { feeds: { storms: { status: string } } } } }).__orbisStore.getState().feeds.storms.status === "ready");
  await page.evaluate((id) => {
    const store = (window as unknown as { __orbisStore: { getState(): { select(s: object): void } } }).__orbisStore;
    store.getState().select({ kind: "storm", id });
  }, storm.id);
  const card = page.getByRole("complementary", { name: storm.name });
  await expect(card).toContainText("Strongest wind");
  await expect(card.getByRole("link", { name: /GDACS report/ })).toBeVisible();
});

test("case study explains the build in both languages", async ({ page }) => {
  await page.goto("/en/case");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("A live planet on a zero budget");
  await expect(page.getByRole("img", { name: /Cloudflare relay/ })).toBeVisible();
  await page.goto("/uk/case");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Жива планета з нульовим бюджетом");
});

test.describe("beyond the Earth", () => {
  test("zooms out into the solar system and back", async ({ page, isMobile }) => {
    test.skip(isMobile, "the bodies list is a desktop panel; phones use the labels");
    await page.goto("/en/live");
    await expect(page.locator("canvas")).toHaveCSS("opacity", "1", { timeout: 60_000 });
    await page.getByRole("button", { name: "Solar system" }).click();
    const list = page.getByRole("region", { name: "Solar system", exact: true });
    await expect(list).toBeVisible();
    await list.getByRole("button", { name: "Saturn" }).click();
    await expect(page.getByRole("complementary", { name: "Saturn" })).toContainText(/From the Sun/);
    await page.getByRole("button", { name: "Back to Earth" }).first().click();
    await expect(page.getByRole("region", { name: "Timeline, last 24 hours" })).toBeVisible({ timeout: 30_000 });
  });

  test("lists ISS passes for the view centre", async ({ page }) => {
    await page.goto("/en/live?at=50.45,30.52,3.6");
    await expect(page.locator("canvas")).toHaveCSS("opacity", "1", { timeout: 60_000 });
    await page.getByRole("button", { name: "Above me" }).click();
    await page.getByRole("button", { name: "Use the view centre" }).click();
    const panel = page.getByRole("region", { name: "The sky above you" });
    await expect(panel).toContainText(/up to \d+°/, { timeout: 60_000 });
  });

  test("the aurora layer reports Kp", async ({ page, isMobile }) => {
    await page.goto("/en/live");
    await expect(page.locator("canvas")).toHaveCSS("opacity", "1", { timeout: 60_000 });
    if (isMobile) await page.getByRole("button", { name: "Show layers" }).click();
    await expect(page.getByRole("switch", { name: /Aurora/ })).toContainText(/Kp \d/, { timeout: 60_000 });
  });
});

test("rain radar is a layer and the sky panel shows the weather", async ({ page, isMobile }) => {
  await page.goto("/en/live?at=50.45,30.52,3.6");
  await expect(page.locator("canvas")).toHaveCSS("opacity", "1", { timeout: 60_000 });
  if (isMobile) await page.getByRole("button", { name: "Show layers" }).click();
  const rain = page.getByRole("switch", { name: /Rain radar/ });
  await expect(rain).toHaveAttribute("aria-checked", "true");
  await rain.click();
  await expect(rain).toHaveAttribute("aria-checked", "false");
  if (isMobile) await page.getByRole("button", { name: "Close layers" }).click();
  await page.getByRole("button", { name: "Above me" }).click();
  await page.getByRole("button", { name: "Use the view centre" }).click();
  await expect(page.getByRole("region", { name: "The sky above you" })).toContainText(/°C/, { timeout: 30_000 });
});

test("streams the wind and reads it at a tapped spot", async ({ page, isMobile }) => {
  await page.goto("/en/live?debug=1");
  await globeReady(page);
  if (isMobile) await page.getByRole("button", { name: "Show layers" }).click();
  const wind = page.getByRole("switch", { name: /Wind/ });
  await expect(wind).toHaveAttribute("aria-checked", "false");
  await wind.click();
  // The GFS cycle the particles follow, e.g. "GFS 18z".
  await expect(wind).toContainText(/GFS \d\dz/);
  if (isMobile) await page.getByRole("button", { name: "Close layers" }).click();
  await page.evaluate(() => {
    const store = (window as unknown as { __orbisStore: { getState(): { select(s: object): void } } }).__orbisStore;
    store.getState().select({ kind: "point", lat: 50.45, lon: 30.52 });
  });
  await expect(page.getByRole("complementary").filter({ hasText: "Wind" })).toContainText(/\d m\/s|Calm/, { timeout: 30_000 });
});

test("the guided tour starts, captions its stops and stops on Escape", async ({ page }) => {
  await page.goto("/en/live");
  await expect(page.locator("canvas")).toHaveCSS("opacity", "1", { timeout: 60_000 });
  await page.getByRole("button", { name: "Tour", exact: true }).click();
  const tour = page.getByRole("region", { name: "Tour" });
  await expect(tour).toContainText("The Earth, right now");
  await tour.getByRole("button", { name: "Next" }).click();
  await expect(tour).not.toContainText("The Earth, right now");
  await page.keyboard.press("Escape");
  await expect(tour).toBeHidden();
});

test.describe("the planet up close", () => {
  test("finds a landmark and tells its story", async ({ page }) => {
    await page.goto("/en/live");
    await expect(page.locator("canvas")).toHaveCSS("opacity", "1", { timeout: 60_000 });
    await page.getByRole("button", { name: "Search" }).click();
    await page.getByRole("dialog").getByPlaceholder("Satellite, flight, ship or place").fill("Everest");
    await expect(page.getByRole("option").first()).toContainText("Mount Everest");
    await page.keyboard.press("Enter");
    const card = page.getByRole("complementary", { name: "Mount Everest" });
    await expect(card).toContainText("8,849 m above sea level");
    await expect(card.getByRole("button", { name: "Fly there" })).toBeVisible();
  });

  test("shows local time, the Moon and the eclipses ahead", async ({ page, isMobile }) => {
    await page.goto("/en/live?at=50.45,30.52,3.6");
    await expect(page.locator("canvas")).toHaveCSS("opacity", "1", { timeout: 60_000 });
    if (!isMobile) await expect(page.locator("header")).toContainText(/UTC([+−]\d+)?/);
    await page.getByRole("button", { name: "Above me" }).click();
    await page.getByRole("button", { name: "Use the view centre" }).click();
    const panel = page.getByRole("region", { name: "The sky above you" });
    await expect(panel).toContainText(/% lit/);
    await expect(panel).toContainText("Eclipses ahead");
    await expect(panel.getByRole("button", { name: "Watch" }).first()).toBeVisible();
  });
});
