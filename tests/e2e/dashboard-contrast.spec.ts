import { expect, test, type Page } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

const targets = [
  { selector: ".dashboard-hero__title", minimum: 3 },
  { selector: ".dashboard-hero__description", minimum: 4.5 },
  { selector: ".dashboard-hero__eyebrow", minimum: 4.5 },
  { selector: ".dashboard-hero__status-label", minimum: 4.5 },
  { selector: ".dashboard-hero__chip", minimum: 4.5 },
  { selector: ".stats-grid .stat-value", minimum: 3 },
  { selector: ".stats-grid .stat-label", minimum: 4.5 },
]

async function paintedTextContrast(page: Page) {
  const rows = await page.evaluate(targets => {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    const context = canvas.getContext("2d")!
    return targets.flatMap(target => [...document.querySelectorAll<HTMLElement>(target.selector)].map((node, index) => {
      const style = getComputedStyle(node)
      const bounds = node.getBoundingClientRect()
      if (style.visibility !== "visible" || bounds.width === 0 || bounds.height === 0) {
        throw new Error(`Visible text required: ${target.selector}`)
      }
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = style.color
      context.fillRect(0, 0, 1, 1)
      const foreground = [...context.getImageData(0, 0, 1, 1).data]
      const range = document.createRange()
      range.selectNodeContents(node)
      const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }))
      let opacity = 1
      for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) opacity *= Number(getComputedStyle(parent).opacity)
      return { ...target, index, text: node.textContent?.trim(), foreground, rects, opacity, savedStyle: node.getAttribute("style") }
    }))
  }, targets)
  for (const target of targets) expect(rows.some(row => row.selector === target.selector), target.selector).toBe(true)
  let paint: Buffer
  try {
    // Measure the real composited gradient/translucent-card paint beneath text.
    // Only glyph color is hidden; geometry/backgrounds remain unchanged.
    await page.evaluate(rows => {
      for (const row of rows) (document.querySelectorAll(row.selector)[row.index] as HTMLElement).style.color = "transparent"
    }, rows)
    paint = await page.screenshot({ animations: "disabled" })
  } finally {
    await page.evaluate(rows => {
      for (const row of rows) {
        const node = document.querySelectorAll(row.selector)[row.index]!
        if (row.savedStyle === null) node.removeAttribute("style")
        else node.setAttribute("style", row.savedStyle)
      }
    }, rows)
  }
  return page.evaluate(async ({ rows, png }) => {
    const image = new Image()
    image.src = png
    await image.decode()
    const canvas = document.createElement("canvas")
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext("2d")!
    context.drawImage(image, 0, 0)
    const luminance = (channels: number[]) => channels.map(channel => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0)
    return rows.map(row => {
      let minimumContrast = Infinity
      let samples = 0
      for (const rect of row.rects) for (const dx of [0.1, 0.5, 0.9]) for (const dy of [0.25, 0.5, 0.75]) {
        const x = Math.floor(rect.x + rect.width * dx), y = Math.floor(rect.y + rect.height * dy)
        if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue
        const background = [...context.getImageData(x, y, 1, 1).data].slice(0, 3)
        const alpha = row.foreground[3]! / 255
        const foreground = background.map((value, index) => row.foreground[index]! * alpha + value * (1 - alpha))
        const a = luminance(foreground), b = luminance(background)
        minimumContrast = Math.min(minimumContrast, (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05))
        samples++
      }
      return { selector: row.selector, text: row.text, minimum: row.minimum, opacity: row.opacity, samples, minimumContrast }
    })
  }, { rows, png: `data:image/png;base64,${paint.toString("base64")}` })
}

test.describe("Dashboard contrast", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
  test.use({ viewport: { width: 1640, height: 1369 }, deviceScaleFactor: 1, serviceWorkers: "block", reducedMotion: "reduce" })

  test("hidden metric text cannot receive a passing contrast proof", async ({ page }) => {
    await page.goto("/")
    await expect(page.locator(".dashboard-hero__title")).toBeVisible()
    const heroStyle = await page.locator(".dashboard-hero__title").getAttribute("style")
    const metric = page.locator("#dashboard-stat-open-count")
    await expect(metric).toBeVisible()
    await page.addStyleTag({ content: "#dashboard-stat-open-count { visibility: hidden !important }" })
    await expect(metric).toBeHidden()
    await expect(paintedTextContrast(page)).rejects.toThrow("Visible text required")
    expect(await page.locator(".dashboard-hero__title").getAttribute("style")).toBe(heroStyle)
  })

  for (const [theme, system] of [["light", "dark"], ["dark", "light"], ["auto", "light"], ["auto", "dark"]] as const) {
    test(`${theme} with system ${system} keeps hero and metric text readable`, async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on("pageerror", error => errors.push(error.message))
      await page.emulateMedia({ colorScheme: system })
      await page.addInitScript(theme => {
        localStorage.setItem("meitheal-theme", theme)
        localStorage.setItem("meitheal_sidebar_collapsed", "true")
      }, theme)
      await page.goto("/")
      await expect(page.locator(".dashboard-hero__title")).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      const measurements = await paintedTextContrast(page)
      await testInfo.attach("contrast.json", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" })
      await page.screenshot({ path: testInfo.outputPath(`dashboard-${theme}-${system}.png`), animations: "disabled" })
      for (const measurement of measurements) {
        expect(measurement.opacity, measurement.selector).toBe(1)
        expect(measurement.samples, measurement.selector).toBeGreaterThan(0)
        expect(measurement.minimumContrast, `${measurement.selector}: ${measurement.text}`).toBeGreaterThanOrEqual(measurement.minimum)
      }
      expect(errors).toEqual([])
    })
  }
})
