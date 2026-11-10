import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

test.beforeEach(async ({ page }) => {
  await page.goto("/progress")
  const emoji = page.locator("#pillar-icon-picker [data-emoji-value]").first()
  const selected = await emoji.getAttribute("data-emoji-value")
  await expect(async () => {
    await emoji.evaluate(element => (element as HTMLButtonElement).click())
    await expect(page.locator("#pillar-icon-picker [data-icon-value]")).toHaveValue(selected!)
  }).toPass()
})

test("uploaded SVG removes root and nested active content and external references", async ({ page }) => {
  await page.locator("#pillar-icon-picker [data-icon-upload]").setInputFiles({
    name: "unsafe.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" style="fill:url(https://attacker.invalid/root)">
      <script>alert(2)</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">unsafe</div></foreignObject>
      <style>svg { fill: url(https://attacker.invalid/style) }</style>
      <defs><path id="shape" d="M0 0h10v10z"/></defs><use href="#shape"/>
      <use href="https://attacker.invalid/icon.svg#shape"/><use href="javascript:alert(3)"/>
      <path onmouseover="alert(4)" style="fill:red" d="M0 0h5v5z"/>
      <path fill="url(https://attacker.invalid/fill)" stroke="u\\72l(https://attacker.invalid/stroke)"/>
    </svg>`),
  })
  const image = page.locator("#pillar-icon-picker [data-icon-preview] img")
  await expect(image).toHaveAttribute("src", /^data:image\/svg\+xml;base64,/)
  const svg = Buffer.from((await image.getAttribute("src"))!.split(",")[1]!, "base64").toString("utf8")
  expect(svg).toContain('href="#shape"')
  expect(svg).toContain('d="M0 0h5v5z"')
  expect(svg).not.toMatch(/onload|onmouseover|<script|foreignObject|<style|style=|attacker\.invalid|javascript:/i)
})

test("uploaded SVG preserves Unicode text and presentation attributes", async ({ page }) => {
  await page.locator("#pillar-icon-picker [data-icon-upload]").setInputFiles({
    name: "gaeilge.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><text x="4" y="20" fill="blue">Fáilte 🐕</text></svg>'),
  })
  const image = page.locator("#pillar-icon-picker [data-icon-preview] img")
  await expect(image).toHaveAttribute("src", /^data:image\/svg\+xml;base64,/)
  const svg = Buffer.from((await image.getAttribute("src"))!.split(",")[1]!, "base64").toString("utf8")
  expect(svg).toContain("Fáilte 🐕")
  expect(svg).toContain('viewBox="0 0 128 128"')
  expect(svg).toContain('fill="blue"')
})

test("non-SVG uploads cannot replace the selected emoji", async ({ page }) => {
  const value = page.locator("#pillar-icon-picker [data-icon-value]")
  const before = await value.inputValue()
  await page.locator("#pillar-icon-picker [data-icon-upload]").setInputFiles({
    name: "invalid.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<div xmlns="http://www.w3.org/1999/xhtml" onclick="alert(1)">invalid</div>'),
  })
  await expect(page.locator("#pillar-icon-picker [data-icon-upload]")).toHaveValue("")
  await expect(value).toHaveValue(before)
  await expect(page.locator("#pillar-icon-picker [data-icon-preview] img")).toHaveCount(0)
})
