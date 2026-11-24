import { expect, test } from "@playwright/test"

test.skip(!process.env.E2E_BASE_URL, "Requires a disposable App server")
test.use({ serviceWorkers: "block" })

for (const outcome of ["accepted", "dismissed"] as const) {
  test(`install controls stay hidden after ${outcome} until a fresh prompt arrives`, async ({ page }) => {
    await page.goto("/settings#app-pwa-settings")
    await page.waitForFunction(() => Boolean(window.__meithealPwaGlobalAc))
    await page.evaluate(() => {
      localStorage.removeItem("meitheal-pwa-dismissed")
      window.dispatchEvent(new Event("meitheal-pwa-hints-reset"))
      const event = new Event("beforeinstallprompt", { cancelable: true })
      Object.assign(event, {
        prompt: () => Promise.resolve(),
        userChoice: new Promise(resolve => {
          window.addEventListener("test:install-choice", (e) => resolve({ outcome: (e as CustomEvent).detail }), { once: true })
        }),
      })
      window.dispatchEvent(event)
    })
    const banner = page.locator("#pwa-install-banner")
    const settingsInstall = page.locator("#pwa-install-settings-btn")
    const badge = page.locator("#pwa-installed-badge")
    await expect(banner).toHaveClass(/pwa-banner--visible/)
    await expect(settingsInstall).toBeVisible()
    await (outcome === "accepted" ? page.locator("#pwa-install-btn") : settingsInstall).click()
    await expect(settingsInstall).toBeHidden()
    await expect(banner).not.toHaveClass(/pwa-banner--visible/)
    await expect(badge).toBeHidden()
    await page.evaluate(outcome => {
      window.dispatchEvent(new CustomEvent("test:install-choice", { detail: outcome }))
    }, outcome)
    await expect(settingsInstall).toBeHidden()
    await expect(banner).not.toHaveClass(/pwa-banner--visible/)
    await expect(badge).toBeHidden()
    await page.evaluate(() => {
      const event = new Event("beforeinstallprompt", { cancelable: true })
      Object.assign(event, { prompt: () => Promise.resolve(), userChoice: Promise.resolve({ outcome: "dismissed" }) })
      window.dispatchEvent(event)
    })
    await expect(settingsInstall).toBeVisible()
    await expect(banner).toHaveClass(/pwa-banner--visible/)
    await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")))
    await expect(settingsInstall).toBeHidden()
    await expect(badge).toBeVisible()
  })
}
