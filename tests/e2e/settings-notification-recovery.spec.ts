import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
test.use({ serviceWorkers: "block" })

test("notification preferences wait for valid settings and preserve targets during a Home Assistant outage", async ({ page }) => {
  const value = {
    channels: { sidebar: true, mobile_push: true },
    mobile_targets: ["notify.mobile_app_test_phone"],
    disabled_users: ["unavailable-user"],
  }
  let prefsAvailable = false
  let devicesAvailable = false
  const saves: unknown[] = []

  await page.route("**/api/settings?key=notification_preferences", route =>
    prefsAvailable ? route.fulfill({ json: { value } }) : route.fulfill({ status: 503, json: {} }),
  )
  await page.route("**/api/ha/services", route => route.fulfill({
    json: devicesAvailable
      ? { services: [{ domain: "notify", services: { mobile_app_test_phone: {} } }] }
      : { services: [], error: "No HA connection" },
  }))
  await page.route("**/api/settings", route => {
    if (route.request().method() !== "PUT") return route.continue()
    const { key, value: body } = route.request().postDataJSON()
    if (key !== "notification_preferences") return route.continue()
    saves.push(body)
    return route.fulfill({ json: { key, value: body } })
  })

  await page.goto("/settings#people-notifications-settings")
  const save = page.locator("#save-notif-prefs")
  const retryPrefs = page.getByRole("button", { name: "Retry notification preferences" })
  await expect(retryPrefs).toBeVisible()
  await expect(save).toBeDisabled()
  expect(saves).toEqual([])

  prefsAvailable = true
  await retryPrefs.click()
  const retryTargets = page.getByRole("button", { name: "Retry device discovery" })
  await expect(retryTargets).toBeVisible()
  await expect(save).toBeEnabled()
  await page.locator("#notif-channel-sidebar").locator("..").click()
  await save.click()
  await expect.poll(() => saves).toEqual([{
    ...value,
    enabled: true,
    channels: { sidebar: false, mobile_push: true },
    due_date_reminders: true,
    reminder_window_minutes: 60,
  }])

  devicesAvailable = true
  await retryTargets.click()
  const device = page.getByRole("checkbox", { name: "test phone" })
  await expect(device).toBeChecked()
  await device.uncheck()
  await save.click()
  await expect.poll(() => saves.at(-1)).toMatchObject({ mobile_targets: [] })
})

test("feature toggles roll back rejected or unconfirmed saves", async ({ page }) => {
  let confirm = false
  await page.route("**/api/features", route => {
    if (route.request().method() !== "PUT") return route.continue()
    return route.fulfill({
      status: confirm ? 200 : 503,
      json: confirm ? { feature: "gamification", enabled: false } : { error: "Try again" },
    })
  })

  await page.goto("/settings#tasks-boards-settings")
  const toggle = page.getByRole("checkbox", { name: "Gamification" })
  await expect(toggle).toBeChecked()
  await toggle.locator("..").click()
  await expect(page.getByText("Failed to update feature")).toBeVisible()
  await expect(toggle).toBeChecked()

  confirm = true
  await toggle.locator("..").click()
  await expect(toggle).toBeEnabled()
  await expect(toggle).not.toBeChecked()
  await expect(page.getByText("Failed to update feature")).toHaveCount(0)
})
