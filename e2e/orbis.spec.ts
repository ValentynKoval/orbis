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
  for (const name of ["CelesTrak", "adsb.lol", "aisstream.io", "Digitraffic", "USGS", "NASA FIRMS", "NASA GIBS", "Natural Earth"]) {
    await expect(page.getByRole("heading", { name: new RegExp(name) })).toBeVisible();
  }
  await expect(page.getByText("ODbL")).toBeVisible();
});

test("feeds answer with CDN cache headers", async ({ request }) => {
  const res = await request.get("/api/quakes");
  expect(res.ok()).toBeTruthy();
  expect(res.headers()["cache-control"]).toContain("s-maxage");
  const body = await res.json();
  expect(Array.isArray(body.quakes)).toBeTruthy();
});

test("case study explains the build in both languages", async ({ page }) => {
  await page.goto("/en/case");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("A live planet on a zero budget");
  await expect(page.getByRole("img", { name: /Cloudflare relay/ })).toBeVisible();
  await page.goto("/uk/case");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Жива планета з нульовим бюджетом");
});
