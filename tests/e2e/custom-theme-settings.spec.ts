import { readFile } from "node:fs/promises"
import { test, expect } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

test("Custom CSS activates after import and can be downloaded, reused and removed", async ({ page, request }) => {
  await page.goto("/settings#personal-settings")
  await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
  const themeSelect = page.locator("#theme-select")
  const customSection = page.locator("#custom-theme-section")
  const root = page.locator("html")
  const css = ":root { --fixture-theme-probe: confirmed; }\n"
  const name = "fixture-theme.css"
  const readSettings = async () => {
    const response = await request.get("/api/settings")
    expect(response.ok()).toBe(true)
    return response.json()
  }
  const applied = () => root.evaluate(element => getComputedStyle(element).getPropertyValue("--fixture-theme-probe").trim())
  expect((await readSettings()).custom_theme_css ?? "").toBe("")
  await themeSelect.selectOption("light")
  await expect(root).toHaveAttribute("data-theme", "light")
  await expect(customSection).toBeHidden()

  const writes: unknown[] = []
  page.on("request", sent => {
    if (sent.method() === "PUT" && new URL(sent.url()).pathname === "/api/settings") writes.push(sent.postDataJSON())
  })
  await themeSelect.selectOption("custom")
  await expect(page.locator("#custom-theme-empty")).toBeVisible()
  await expect(root).toHaveAttribute("data-theme", "light")
  expect((await readSettings()).theme).toBe("light")
  expect(writes).toEqual([])

  await page.locator("#custom-theme-input").setInputFiles({ name, mimeType: "text/css", buffer: Buffer.from(css) })
  await expect.poll(applied).toBe("confirmed")
  expect(writes).toEqual([{ key: "custom_theme_css", value: css, name }])
  const imported = await readSettings()
  expect(imported).toMatchObject({ theme: "custom", custom_theme_css: css, custom_theme_name: name })
  const invalidImport = await request.put("/api/settings", {
    data: { key: "custom_theme_css", value: ":root { --fixture-theme-probe: rejected; }", name: "" },
  })
  expect(invalidImport.status()).toBe(400)
  expect(await readSettings()).toEqual(imported)

  await page.goto("/today")
  await page.reload()
  await expect.poll(applied).toBe("confirmed")
  await page.goto("/settings#personal-settings")
  await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
  await expect(themeSelect).toHaveValue("custom")
  const downloadReady = page.waitForEvent("download")
  await page.getByRole("link", { name, exact: true }).click()
  const download = await downloadReady
  expect(download.suggestedFilename()).toBe(name)
  expect(await readFile(await download.path(), "utf8")).toBe(css)

  await themeSelect.selectOption("light")
  await expect(root).toHaveAttribute("data-theme", "light")
  await expect(customSection).toBeHidden()
  expect(await applied()).toBe("")
  expect(await readSettings()).toMatchObject({ theme: "light", custom_theme_css: css, custom_theme_name: name })

  await themeSelect.selectOption("custom")
  await expect.poll(applied).toBe("confirmed")
  await page.getByRole("button", { name: "Remove custom theme" }).click()
  await page.getByRole("alertdialog").locator("#confirm-ok").click()
  await expect(themeSelect).toHaveValue("dark")
  await expect(customSection).toBeHidden()
  await page.reload()
  await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
  await expect(root).toHaveAttribute("data-theme", "dark")
  expect(await applied()).toBe("")
  expect(writes.at(-1)).toEqual({ key: "custom_theme_css", value: "", name: "" })
  expect(await readSettings()).toMatchObject({ theme: "dark", custom_theme_css: "", custom_theme_name: "" })

  const legacy = await request.put("/api/settings", { data: { key: "theme", value: "custom" } })
  expect(legacy.ok()).toBe(true)
  try {
    await page.reload()
    await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
    await expect(themeSelect).toHaveValue("dark")
    await expect(root).toHaveAttribute("data-theme", "dark")
    expect(await applied()).toBe("")
    expect(await readSettings()).toMatchObject({ theme: "custom", custom_theme_css: "", custom_theme_name: "" })
  } finally {
    const reset = await request.put("/api/settings", { data: { key: "theme", value: "dark" } })
    expect(reset.ok()).toBe(true)
  }
})
