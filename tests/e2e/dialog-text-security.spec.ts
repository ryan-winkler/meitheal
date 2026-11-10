import { expect, test } from "@playwright/test"

test.skip(!process.env.E2E_BASE_URL, "Requires a disposable App server")
test.use({ serviceWorkers: "block" })

const attack = '<img src="missing-dialog-image" onerror="document.documentElement.dataset.dialogXss=\'executed\'">'
const svg = '<svg onload="document.documentElement.dataset.dialogXss=\'executed\'"></svg>'
const literal = 'Fáilte 🐕 &amp; <literal> "quotes"'

async function openPage(page: import("@playwright/test").Page) {
  await page.goto("/today")
  await page.waitForFunction(() => typeof window.confirmDialog === "function" && typeof window.promptDialog === "function")
  await page.evaluate(() => {
    const source = document.createElement("button")
    source.id = "dialog-source"
    source.textContent = "Open dialog"
    document.body.append(source)
    source.focus()
  })
}

test("confirmation renders malicious DOM-derived text literally in every option", async ({ page }) => {
  await openPage(page)
  const options = { title: attack + literal, message: svg + literal, confirmText: attack + "Confirm", cancelText: attack + "Cancel" }
  await page.evaluate(options => {
    const dom = document.createElement("div")
    for (const [key, value] of Object.entries(options)) {
      const label = document.createElement("span")
      label.dataset.dialogOption = key
      label.textContent = value
      dom.append(label)
    }
    dom.hidden = true
    document.body.append(dom)
    const text = (key: string) => dom.querySelector<HTMLElement>(`[data-dialog-option="${key}"]`)!.textContent!
    void window.confirmDialog!({ title: text("title"), message: text("message"), confirmText: text("confirmText"), cancelText: text("cancelText"), variant: "danger" })
      .then(result => { document.body.dataset.confirmResult = String(result) })
  }, options)
  const dialog = page.locator("#meitheal-confirm-overlay")
  await expect(dialog.locator("#confirm-title")).toHaveText(options.title)
  await expect(dialog.locator("#confirm-message")).toHaveText(options.message)
  await expect(dialog.locator("#confirm-ok")).toHaveText(options.confirmText)
  await expect(dialog.locator("#confirm-cancel")).toHaveText(options.cancelText)
  await expect(dialog.locator("img, svg, script")).toHaveCount(0)
  expect(await page.locator("html").getAttribute("data-dialog-xss")).toBeNull()
  await expect(dialog.locator("#confirm-cancel")).toBeFocused()
  await dialog.locator("#confirm-ok").click()
  await expect(page.locator("body")).toHaveAttribute("data-confirm-result", "true")
  await expect(dialog).toHaveCount(0)
  await expect(page.locator("#dialog-source")).toBeFocused()
})

test("confirmation preserves defaults, variants, focus trap, Escape, cancel, backdrop and abort", async ({ page }) => {
  await openPage(page)
  const open = (variant?: "danger" | "warning" | "default") => page.evaluate(variant => {
    delete document.body.dataset.confirmResult
    void window.confirmDialog!({ message: "Plain confirmation", ...(variant ? { variant } : {}) })
      .then(result => { document.body.dataset.confirmResult = String(result) })
  }, variant)
  const dialog = page.locator("#meitheal-confirm-overlay")
  await open()
  await expect(dialog.locator("#confirm-title")).toHaveText("Confirm")
  await expect(dialog.locator("#confirm-cancel")).toHaveText("Cancel")
  await expect(dialog.locator("#confirm-ok")).toHaveText("Confirm")
  await expect(dialog).toContainText("❓")
  await expect(dialog.locator("#confirm-cancel")).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(dialog.locator("#confirm-ok")).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(dialog.locator("#confirm-cancel")).toBeFocused()
  await page.keyboard.press("Shift+Tab")
  await expect(dialog.locator("#confirm-ok")).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(page.locator("body")).toHaveAttribute("data-confirm-result", "false")
  await expect(dialog).toHaveCount(0)
  await expect(page.locator("#dialog-source")).toBeFocused()
  await open()
  await dialog.locator("#confirm-ok").focus()
  await page.keyboard.press("Enter")
  await expect(page.locator("body")).toHaveAttribute("data-confirm-result", "true")
  await expect(dialog).toHaveCount(0)
  await open("warning")
  await expect(dialog).toContainText("⚠️")
  await dialog.locator("#confirm-cancel").click()
  await expect(page.locator("body")).toHaveAttribute("data-confirm-result", "false")
  await expect(dialog).toHaveCount(0)
  await open("danger")
  await expect(dialog).toContainText("🗑️")
  await dialog.click({ position: { x: 2, y: 2 } })
  await expect(dialog).toHaveCount(0)
  await page.evaluate(() => {
    const controller = new AbortController()
    window.addEventListener("abort-security-dialog", () => controller.abort(), { once: true })
    void window.confirmDialog!({ message: "Abortable", signal: controller.signal })
      .then(result => { document.body.dataset.confirmResult = String(result) })
  })
  await expect(dialog).toHaveCount(1)
  await page.evaluate(() => window.dispatchEvent(new Event("abort-security-dialog")))
  await expect(dialog).toHaveCount(0)
  await expect(page.locator("body")).toHaveAttribute("data-confirm-result", "false")
})

test("prompt keeps malicious text and quoted attribute values inert and literal", async ({ page }) => {
  await openPage(page)
  const options = { title: attack + literal, message: svg + literal, placeholder: '\" autofocus onfocus="document.documentElement.dataset.dialogXss=\'executed\'" ' + literal,
    defaultValue: '\">' + attack + literal, confirmText: attack + "OK", cancelText: attack + "Cancel" }
  await page.evaluate(options => {
    const dom = document.createElement("div")
    for (const [key, value] of Object.entries(options)) {
      const label = document.createElement("span")
      label.dataset.dialogOption = key
      label.textContent = value
      dom.append(label)
    }
    dom.hidden = true
    document.body.append(dom)
    const text = (key: string) => dom.querySelector<HTMLElement>(`[data-dialog-option="${key}"]`)!.textContent!
    void window.promptDialog!({ title: text("title"), message: text("message"), placeholder: text("placeholder"), defaultValue: text("defaultValue"), confirmText: text("confirmText"), cancelText: text("cancelText") })
      .then(result => { document.body.dataset.promptResult = JSON.stringify(result) })
  }, options)
  const dialog = page.locator("#meitheal-prompt-overlay")
  await expect(dialog.locator("#prompt-title")).toHaveText(options.title)
  await expect(dialog.locator("p")).toHaveText(options.message)
  await expect(dialog.locator("#prompt-ok")).toHaveText(options.confirmText)
  await expect(dialog.locator("#prompt-cancel")).toHaveText(options.cancelText)
  const input = dialog.locator("#prompt-input")
  await expect(input).toHaveValue(options.defaultValue)
  await expect(input).toHaveAttribute("placeholder", options.placeholder)
  await expect(input).not.toHaveAttribute("onfocus")
  await expect(input).not.toHaveAttribute("autofocus")
  await expect(dialog.locator("img, svg, script")).toHaveCount(0)
  expect(await page.locator("html").getAttribute("data-dialog-xss")).toBeNull()
  await expect(input).toBeFocused()
  expect(await input.evaluate(element => [(element as HTMLInputElement).selectionStart, (element as HTMLInputElement).selectionEnd])).toEqual([0, options.defaultValue.length])
  await dialog.locator("#prompt-ok").click()
  await expect(page.locator("body")).toHaveAttribute("data-prompt-result", JSON.stringify(options.defaultValue))
  await expect(dialog).toHaveCount(0)
  await expect(page.locator("#dialog-source")).toBeFocused()
})

test("prompt preserves required validation, input selection, Tab, trimming, cancellation and abort", async ({ page }) => {
  await openPage(page)
  await page.evaluate(() => {
    void window.promptDialog!({ required: true, validate: value => value === "Fáilte" ? "" : 'Use literal <Fáilte> &amp;' })
      .then(result => { document.body.dataset.promptResult = JSON.stringify(result) })
  })
  const dialog = page.locator("#meitheal-prompt-overlay")
  const input = dialog.locator("#prompt-input")
  await expect(dialog.locator("#prompt-title")).toHaveText("Input")
  await expect(dialog.locator("p")).toHaveCount(0)
  await expect(input).toHaveAttribute("maxlength", "200")
  await expect(input).toBeFocused()
  await input.press("Enter")
  await expect(dialog.locator("#prompt-error")).toHaveText("This field is required")
  await input.fill("wrong")
  await expect(dialog.locator("#prompt-error")).toHaveText("")
  await input.press("Enter")
  await expect(dialog.locator("#prompt-error")).toHaveText('Use literal <Fáilte> &amp;')
  await input.fill(" Fáilte ")
  await input.press("Tab")
  await expect(dialog.locator("#prompt-cancel")).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(dialog.locator("#prompt-ok")).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(input).toBeFocused()
  await page.keyboard.press("Shift+Tab")
  await expect(dialog.locator("#prompt-ok")).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.locator("body")).toHaveAttribute("data-prompt-result", JSON.stringify("Fáilte"))
  await expect(dialog).toHaveCount(0)
  for (const action of ["cancel", "escape", "backdrop", "abort"] as const) {
    await page.evaluate(() => {
      const controller = new AbortController()
      window.addEventListener("abort-security-dialog", () => controller.abort(), { once: true })
      void window.promptDialog!({ message: "Plain prompt", signal: controller.signal })
        .then(result => { document.body.dataset.promptResult = JSON.stringify(result) })
    })
    await expect(input).toBeFocused()
    if (action === "cancel") await dialog.locator("#prompt-cancel").click()
    else if (action === "escape") await page.keyboard.press("Escape")
    else if (action === "backdrop") await dialog.click({ position: { x: 2, y: 2 } })
    else await page.evaluate(() => window.dispatchEvent(new Event("abort-security-dialog")))
    await expect(dialog).toHaveCount(0)
    await expect(page.locator("body")).toHaveAttribute("data-prompt-result", "null")
  }
})

test("Pillar removal uses the raw name without double-escaping literal entities", async ({ page, request, baseURL }) => {
  const name = 'Fáilte <garden> &amp; "Home"'
  const headers = { origin: new URL(baseURL!).origin, "content-type": "application/json" }
  const response = await request.post("/api/pillars", { headers, data: { name } })
  expect(response.status()).toBe(201)
  const { pillar } = await response.json()
  try {
    await page.goto("/progress#pillars")
    const card = page.locator(`[data-pillar-id="${pillar.id}"]`).filter({ has: page.locator('[data-action="open-detail"]') })
    await card.getByRole("button", { name: `View ${name} details` }).click()
    await page.locator("#pillar-detail-delete-btn").click()
    const dialog = page.locator("#meitheal-confirm-overlay")
    await expect(dialog.locator("#confirm-message")).toHaveText(`Remove "${name}" from active pillars?`)
    await expect(dialog.locator("garden, img, script")).toHaveCount(0)
    await dialog.locator("#confirm-cancel").click()
    await expect(dialog).toHaveCount(0)
    expect((await request.get(`/api/pillars/${pillar.id}`)).status()).toBe(200)
  } finally {
    expect((await request.delete(`/api/pillars/${pillar.id}?hard=true`, { headers, data: {} })).status()).toBe(200)
  }
})
