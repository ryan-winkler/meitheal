import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable App server")
test.use({ serviceWorkers: "block" })

test("custom URL sharing requires explicit review and is cleared by edits or revocation", async ({ page, request }) => {
  const keys = ["ai-custom-url", "ai-custom-url-approved", "ai-provider"]
  const previous = await Promise.all(keys.map(async key => [key, (await (await request.get(`/api/settings?key=${key}`)).json()).value] as const))
  const put = async (key: string, value: unknown) => expect((await request.put("/api/settings", { data: { key, value } })).status()).toBe(200)
  const read = async (key: string) => (await (await request.get(`/api/settings?key=${key}`)).json()).value
  const legacy = "https://assistant.example/chat?access_token=synthetic"
  try {
    await put("ai-custom-url", legacy)
    await put("ai-custom-url-approved", null)
    await put("ai-provider", "custom")
    await page.goto("/settings#automation-ai-settings")
    const share = page.getByRole("checkbox", { name: "Share this reviewed URL with household members" })
    const save = page.locator("#save-ai")
    const saveSettings = async () => {
      const finalWrite = page.waitForResponse(response => new URL(response.url()).pathname === "/api/settings" && response.request().method() === "PUT" && response.request().postDataJSON()?.key === "ai-provider")
      await save.click()
      expect((await finalWrite).status()).toBe(200)
      await expect(save).toBeEnabled()
    }
    await expect(page.locator("#ai-custom-url")).toHaveValue(legacy)
    await expect(share).not.toBeChecked()
    await saveSettings()
    expect(await read("ai-custom-url-approved")).toBeNull()
    await share.check()
    await saveSettings()
    expect(await read("ai-custom-url-approved")).toBe(legacy)
    await page.reload()
    await expect(share).toBeChecked()
    const changed = "https://assistant.example/changed"
    await page.locator("#ai-custom-url").fill(changed)
    await expect(share).not.toBeChecked()
    await saveSettings()
    expect(await read("ai-custom-url-approved")).toBeNull()
    await share.check()
    await saveSettings()
    expect(await read("ai-custom-url-approved")).toBe(changed)
    await share.uncheck()
    await saveSettings()
    expect(await read("ai-custom-url-approved")).toBeNull()
  } finally {
    for (const [key, value] of previous) await put(key, value)
  }
})
