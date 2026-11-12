import { readFile } from "node:fs/promises"
import { expect } from "@playwright/test"
import { test } from "../scripts/settings-persistence-fixture"

const sliderSelector = '.rules-fw-weight[data-framework="rice"][data-field="reach"]'

for (const action of ["export", "navigate"] as const) {
  test(`a held then rejected framework save blocks immediate ${action} until an acknowledged retry`, async ({ page, request }) => {
    await page.goto("/settings#rules-lenses-settings")
    await page.locator("#framework-config-disclosure > summary").click()
    const slider = page.locator(sliderSelector)
    await expect(slider).toHaveValue("1")
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let writes = 0
    await page.route("**/api/frameworks/rice", async route => {
      if (route.request().method() !== "PUT") return route.continue()
      ++writes
      await held
      await route.fulfill({ status: 503, json: { ok: false } })
    })
    let downloads = 0
    page.on("download", () => { ++downloads })
    await page.evaluate(({ selector, action }) => {
      const input = document.querySelector<HTMLInputElement>(selector)!
      input.value = "2.7"
      input.dispatchEvent(new Event("input", { bubbles: true }))
      input.dispatchEvent(new Event("change", { bubbles: true }))
      if (action === "export") document.getElementById("rules-export-btn")!.click()
      else {
        const link = document.createElement("a")
        link.href = (window.__ingress_path || "") + "/today"
        document.body.append(link)
        link.click()
      }
    }, { selector: sliderSelector, action })
    await expect.poll(() => writes).toBe(1)
    expect(downloads).toBe(0)
    await expect(page).toHaveURL(/\/settings#rules-lenses-settings$/)
    release()
    await expect(slider).toHaveAttribute("aria-invalid", "true")
    await expect(slider).toHaveValue("2.7")
    const retry = slider.locator("../..").locator(".rules-fw-retry")
    await expect(retry).toBeVisible()
    expect(downloads).toBe(0)
    expect((await (await request.get("/api/frameworks/rice")).json()).data.fields.find((field: { key: string }) => field.key === "reach").weight).toBe(1)
    await page.unroute("**/api/frameworks/rice")
    await retry.click()
    await expect(slider).not.toHaveAttribute("aria-invalid", "true")
    await expect(retry).toHaveCount(0)
    if (action === "export") {
      const download = page.waitForEvent("download")
      await page.locator("#rules-export-btn").click()
      const exported = JSON.parse(await readFile((await (await download).path())!, "utf8"))
      expect(exported.frameworks.find((fw: { id: string }) => fw.id === "rice").fields.find((field: { key: string }) => field.key === "reach").weight).toBe(2.7)
    } else {
      await page.locator('a[href$="/today"]').last().evaluate(link => (link as HTMLAnchorElement).click())
      await expect(page).toHaveURL(/\/today$/)
    }
  })
}

test("lost framework acknowledgement stays dirty until retry and an older success cannot clear the latest field draft", async ({ page, request }) => {
  await page.goto("/settings#rules-lenses-settings")
  await page.locator("#framework-config-disclosure > summary").click()
  const slider = page.locator(sliderSelector)
  await expect(slider).toHaveValue("1")
  let first = true
  await page.route("**/api/frameworks/rice", async route => {
    if (route.request().method() !== "PUT" || !first) return route.continue()
    first = false
    expect((await route.fetch()).status()).toBe(200)
    await route.abort("failed")
  })
  await slider.evaluate((input: HTMLInputElement) => {
    input.value = "1.8"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    input.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await expect(slider).toHaveAttribute("aria-invalid", "true")
  expect((await (await request.get("/api/frameworks/rice")).json()).data.fields.find((field: { key: string }) => field.key === "reach").weight).toBe(1.8)
  await slider.locator("../..").locator(".rules-fw-retry").click()
  await expect(slider).not.toHaveAttribute("data-save-state", /.+/)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let writes = 0
  await page.unroute("**/api/frameworks/rice")
  await page.route("**/api/frameworks/rice", async route => {
    if (route.request().method() !== "PUT") return route.continue()
    if (++writes === 1) await held
    await route.continue()
  })
  await slider.evaluate((input: HTMLInputElement) => {
    input.value = "2"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    input.dispatchEvent(new Event("change", { bubbles: true }))
    input.value = "2.4"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    input.dispatchEvent(new Event("change", { bubbles: true }))
    document.getElementById("rules-export-btn")!.click()
  })
  const download = page.waitForEvent("download")
  await expect.poll(() => writes).toBe(1)
  release()
  const data = JSON.parse(await readFile((await (await download).path())!, "utf8"))
  expect(writes).toBe(2)
  expect(data.frameworks.find((fw: { id: string }) => fw.id === "rice").fields.find((field: { key: string }) => field.key === "reach").weight).toBe(2.4)
  await expect(slider).not.toHaveAttribute("data-save-state", /.+/)
})

test("failed reload after a framework reset reports recovery instead of a reset-success toast", async ({ page }) => {
  await page.goto("/settings#rules-lenses-settings")
  await page.locator("#framework-config-disclosure > summary").click()
  await expect(page.locator(sliderSelector)).toBeVisible()
  await page.route("**/api/frameworks", route => route.fulfill({ status: 503, json: { ok: false } }))
  await page.locator('.rules-fw-reset[data-framework="rice"]').click()
  await page.locator("#confirm-ok").click()
  await expect(page.locator('.rules-fw-config-fields[data-framework="rice"]')).toContainText("Reload this page to retry")
  await expect(page.locator("#toast-container .toast.error")).not.toHaveCount(0)
  await expect(page.getByText("Framework reset.", { exact: true })).toHaveCount(0)
})

test("a failed catalog refresh retains an unsaved slider and its retry control", async ({ page, request }) => {
  await page.goto("/settings#rules-lenses-settings")
  await page.locator("#framework-config-disclosure > summary").click()
  const slider = page.locator(sliderSelector)
  await expect(slider).toHaveValue("1")
  await page.route("**/api/frameworks/rice", route => route.request().method() === "PUT"
    ? route.fulfill({ status: 503, json: { ok: false } }) : route.continue())
  await slider.evaluate((input: HTMLInputElement) => {
    input.value = "2.6"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    input.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await expect(slider).toHaveAttribute("aria-invalid", "true")
  await page.route("**/api/frameworks", route => route.request().method() === "GET"
    ? route.fulfill({ status: 503, json: { ok: false } }) : route.continue())
  await page.locator("#fw-import-btn").click()
  await page.locator("#fw-import-yaml").fill("name: Draft read recovery\nformula: reach\nfields:\n  - key: reach\n    label: Reach\n")
  await page.locator("#fw-import-submit").click()
  await expect(page.locator('.rules-fw-config-fields[data-framework="rice"]')).toContainText("Reload this page to retry")
  await expect(slider).toHaveValue("2.6")
  await expect(slider).toHaveAttribute("aria-invalid", "true")
  await page.locator("#fw-import-cancel").click()
  await page.unroute("**/api/frameworks/rice")
  await slider.locator("../..").locator(".rules-fw-retry").click()
  await expect(slider).not.toHaveAttribute("data-save-state", /.+/)
  expect((await (await request.get("/api/frameworks/rice")).json()).data.fields.find((field: { key: string }) => field.key === "reach").weight).toBe(2.6)
})
