import { expect, test } from "@playwright/test";
import { shouldSkipBrowserSpecs } from "./_helpers";

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs");

test("home page has title", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Meitheal/);
});
