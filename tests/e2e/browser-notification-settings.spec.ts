import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable App server")
test.use({ serviceWorkers: "block" })

test("browser notification settings use the current account and report storage failure", async ({ page }) => {
  const url = "/settings#people-notifications-settings"
  await page.goto(url)
  const scope = page.locator('meta[name="meitheal-work-actor"]')
  const actor = (await scope.getAttribute("content"))!
  expect(actor).toMatch(/^[a-f0-9]{64}$/)
  const card = page.locator("#user-notif-prefs-card")
  const duration = card.getByLabel("Notification display duration")
  const status = card.getByRole("status")
  await expect(duration).toHaveValue("5000")
  await duration.selectOption("8000")
  await expect(status).toHaveText("Notification preferences saved.")
  await page.reload()
  await expect(duration).toHaveValue("8000")

  const secondActor = "f".repeat(64)
  await page.route(requestUrl => requestUrl.pathname === "/settings", async route => {
    const response = await route.fetch()
    const body = (await response.text()).replace(`name="meitheal-work-actor" content="${actor}"`,
      `name="meitheal-work-actor" content="${secondActor}"`)
    await route.fulfill({ response, body })
  })
  await page.reload()
  await expect(scope).toHaveAttribute("content", secondActor)
  await expect(duration).toHaveValue("5000")
  await duration.selectOption("3000")
  await expect(status).toHaveText("Notification preferences saved.")
  expect(await page.evaluate(actor =>
    JSON.parse(localStorage.getItem("meitheal:notification-prefs:v2:" + actor)!).toastDurationMs,
  actor)).toBe(8000)

  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith("meitheal:notification-prefs:v2:")) throw new DOMException("Storage denied", "QuotaExceededError")
      original.call(this, key, value)
    }
  })
  await duration.selectOption("0")
  await expect(duration).toHaveValue("3000")
  await expect(status).toHaveText("Could not save notification preferences in this browser.")
})
