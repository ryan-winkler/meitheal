import { expect, test, type APIRequestContext } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable App server")
test.use({ serviceWorkers: "block" })

async function read(request: APIRequestContext, key: string) {
  const response = await request.get(`/api/settings?key=${key}`)
  expect(response.status()).toBe(200)
  return (await response.json()).value
}

async function put(request: APIRequestContext, key: string, value: unknown) {
  const response = await request.put("/api/settings", { data: { key, value } })
  expect(response.status()).toBe(200)
}

async function saveTuple(request: APIRequestContext, url: string, shared: boolean) {
  const provider = await read(request, "ai-provider")
  const current = await read(request, "ai-custom-url")
  const approval = await read(request, "ai-custom-url-approved")
  const response = await request.put("/api/settings", { data: {
    key: "ai-provider",
    value: "custom",
    custom_url: url,
    share_custom_url: shared,
    previous_provider: typeof provider === "string" ? provider : null,
    previous_custom_url: typeof current === "string" ? current : null,
    previously_shared: Boolean(current) && approval === current,
  } })
  expect(response.status()).toBe(200)
}

test("Settings saves reviewed URL sharing with the provider in one request and clears review on edit", async ({ page, request }) => {
  const previousProvider = await read(request, "ai-provider")
  const previousUrl = await read(request, "ai-custom-url")
  const previousApproval = await read(request, "ai-custom-url-approved")
  const legacy = "https://assistant.example/chat?access_token=synthetic"
  try {
    await put(request, "ai-custom-url", legacy)
    await put(request, "ai-provider", "custom")
    await page.goto("/settings#automation-ai-settings")
    const share = page.getByRole("checkbox", { name: "Share this reviewed URL with household members" })
    const save = page.locator("#save-ai")
    const writes: Array<Record<string, unknown>> = []
    page.on("request", request => {
      if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/settings") writes.push(request.postDataJSON())
    })
    const saveSettings = async (url: string, shared: boolean, previousUrl: string, previousShared: boolean) => {
      const before = writes.length
      const write = page.waitForResponse(response => new URL(response.url()).pathname === "/api/settings" &&
        response.request().method() === "PUT" && response.request().postDataJSON()?.key === "ai-provider")
      await save.click()
      expect((await write).status()).toBe(200)
      await expect(save).toBeEnabled()
      expect(writes.slice(before)).toEqual([{
        key: "ai-provider", value: "custom", custom_url: url, share_custom_url: shared,
        previous_provider: "custom", previous_custom_url: previousUrl, previously_shared: previousShared,
      }])
    }
    const input = page.getByRole("textbox", { name: "Custom provider URL" })
    await expect(input).toHaveValue(legacy)
    await expect(share).not.toBeChecked()
    await share.check()
    await saveSettings(legacy, true, legacy, false)
    expect(await read(request, "ai-custom-url-approved")).toBe(legacy)
    await page.reload()
    await expect(share).toBeChecked()

    const changed = "https://assistant.example/changed"
    await input.fill(changed)
    await expect(share).not.toBeChecked()
    await saveSettings(changed, false, legacy, true)
    expect(await read(request, "ai-custom-url-approved")).toBeNull()

    await share.check()
    await saveSettings(changed, true, changed, false)
    expect(await read(request, "ai-custom-url-approved")).toBe(changed)
    await share.uncheck()
    await saveSettings(changed, false, changed, true)
    expect(await read(request, "ai-custom-url-approved")).toBeNull()

    // Another tab selected HA-only without changing the URL or sharing choice.
    await put(request, "ai-provider", "ha_llm")
    await share.check()
    await save.click()
    await expect(page.getByText("The saved AI settings changed. Reload Settings and review the URL and sharing choice before saving again.")).toBeVisible()
    expect(await read(request, "ai-provider")).toBe("ha_llm")
    expect(await read(request, "ai-custom-url-approved")).toBeNull()

    await page.reload()
    const provider = page.getByRole("combobox", { name: "Provider", exact: true })
    await expect(provider).toHaveValue("ha_llm")
    await provider.selectOption("gemini")
    const builtInWrite = page.waitForResponse(response => new URL(response.url()).pathname === "/api/settings" &&
      response.request().method() === "PUT" && response.request().postDataJSON()?.key === "ai-provider")
    await save.click()
    const builtInReceipt = await builtInWrite
    expect(builtInReceipt.status()).toBe(200)
    expect(builtInReceipt.request().postDataJSON()).toEqual({
      key: "ai-provider", value: "gemini", previous_provider: "ha_llm",
      previous_custom_url: changed, previously_shared: false,
    })
    expect(await read(request, "ai-provider")).toBe("gemini")
  } finally {
    if (typeof previousUrl === "string" && previousApproval === previousUrl) {
      await saveTuple(request, previousUrl, true)
    } else {
      await put(request, "ai-custom-url", previousUrl)
    }
    await put(request, "ai-provider", previousProvider)
  }
})

test("Settings requires an explicit editable snapshot before enabling the provider form", async ({ page }) => {
  await page.route(url => url.pathname === "/api/settings" && !url.search, route => route.fulfill({
    json: { "ai-handoff-editable": false },
  }))
  await page.goto("/settings#automation-ai-settings")
  await expect(page.getByText("Could not verify access to edit the AI provider. Reload Settings to try again.")).toBeVisible()
  await expect(page.locator("#ai-provider-editor")).toBeHidden()
  await expect(page.locator("#ai-provider")).toBeDisabled()
  await expect(page.locator("#ext-ai-badge")).toBeHidden()
  await expect(page.locator("#save-ai")).toBeDisabled()
})
