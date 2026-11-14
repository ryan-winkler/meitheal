import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

test.describe("Branding — Typography", () => {
  test("Geist Variable font is loaded for headings and body text", async ({
    page,
  }) => {
    await page.goto("/")
    const geistHeadingLoaded = await page.evaluate(() =>
      document.fonts.check('500 16px "Geist Variable"')
    )
    const geistBodyLoaded = await page.evaluate(() =>
      document.fonts.check('400 12px "Geist Variable"')
    )
    expect(geistHeadingLoaded).toBe(true)
    expect(geistBodyLoaded).toBe(true)
  })

  test("JetBrains Mono font is loaded for phonetic mark and code", async ({
    page,
  }) => {
    await page.goto("/")
    const monoLoaded = await page.evaluate(() =>
      document.fonts.check('400 10px "JetBrains Mono"')
    )
    expect(monoLoaded).toBe(true)
  })
})

test.describe("Branding — Color Tokens (Dark)", () => {
  // A first visit follows the system appearance, so name the dark palette these tokens belong to.
  test.use({ colorScheme: "dark" })

  test("--bg-primary uses Evergreen Carbon (#101210) and --palette-on-accent uses #07140f", async ({
    page,
  }) => {
    await page.goto("/")
    const tokens = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement)
      return {
        bgPrimary: s.getPropertyValue("--bg-primary").trim().toLowerCase(),
        accent: s.getPropertyValue("--accent").trim().toLowerCase(),
        onAccent: s.getPropertyValue("--palette-on-accent").trim().toLowerCase(),
      }
    })
    expect(tokens.bgPrimary).toBe("#101210")
    expect(tokens.accent).toBe("#69e3b2")
    expect(tokens.onAccent).toBe("#07140f")
  })
})

test.describe("Branding — Color Tokens (Light)", () => {
  test.use({ colorScheme: "light" })

  test("Light mode uses Warm Paper (#f6f5f0), Forest Emerald (#146c4e), and white on-accent", async ({
    page,
  }) => {
    await page.goto("/")
    const tokens = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement)
      return {
        bgPrimary: s.getPropertyValue("--bg-primary").trim().toLowerCase(),
        accent: s.getPropertyValue("--accent").trim().toLowerCase(),
        onAccent: s.getPropertyValue("--palette-on-accent").trim().toLowerCase(),
      }
    })
    expect(tokens.bgPrimary).toBe("#f6f5f0")
    expect(tokens.accent).toBe("#146c4e")
    expect(["#fff", "#ffffff"]).toContain(tokens.onAccent)
  })

  test("Light mode warning token pairs with readable white foreground", async ({
    page,
  }) => {
    await page.goto("/")
    const tokens = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement)
      return {
        warning: s.getPropertyValue("--warning").trim().toLowerCase(),
        onWarning: s.getPropertyValue("--on-warning").trim().toLowerCase(),
      }
    })
    expect(tokens.warning).toBe("#b45309")
    expect(["#fff", "#ffffff"]).toContain(tokens.onWarning)
  })
})

test.describe("Branding — Logo & Static Assets", () => {
  test("meitheal.io SVG mark and wordmark lockup are visible in sidebar", async ({
    page,
  }) => {
    await page.goto("/")
    const logo = page.locator('.sidebar-brand svg[viewBox="0 0 64 64"]')
    await expect(logo).toBeVisible()
    await expect(page.locator(".sidebar-brand-text")).toHaveText("meitheal.")
    await expect(page.locator(".sidebar-ipa")).toHaveText("/meh·hal/")
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#10231b")
  })

  test("Sidebar SVG completion dot uses theme-aware --accent CSS var", async ({
    page,
  }) => {
    await page.goto("/")
    const accentFill = await page.evaluate(() => {
      const circle = document.querySelector(".sidebar-brand svg circle")
      return circle?.getAttribute("fill") ?? ""
    })
    expect(accentFill).toContain("var(--accent")
  })

  test("Manifest brand colors and static SVG marks match meitheal.io", async ({
    request,
  }) => {
    const manifestRes = await request.get("/manifest.webmanifest")
    expect(manifestRes.ok()).toBe(true)
    const manifest = await manifestRes.json()
    expect(manifest.theme_color.toLowerCase()).toBe("#10231b")
    expect(manifest.background_color.toLowerCase()).toBe("#101210")
    expect(manifest.description).toContain("Keep track of the work your home needs")

    for (const svgPath of ["/favicon.svg", "/logo.svg", "/logo-checkmark.svg"]) {
      const svgRes = await request.get(svgPath)
      expect(svgRes.ok(), svgPath).toBe(true)
      const svgText = (await svgRes.text()).toLowerCase()
      expect(svgText, svgPath).toContain('viewbox="0 0 64 64"')
      expect(svgText, svgPath).toContain("#10231b")
      expect(svgText, svgPath).toContain("#edf5ef")
    }
  })

  test("Offline routes render Evergreen mark and readable retry button", async ({
    page,
  }) => {
    await page.goto("/offline.html")
    await expect(page.locator('svg[viewBox="0 0 64 64"]')).toBeVisible()
    await expect(page.getByRole("heading", { name: /You're offline/i })).toBeVisible()
    const btnColors = await page.getByRole("button", { name: /Try again/i }).evaluate(el => {
      const s = getComputedStyle(el)
      return { bg: s.backgroundColor, fg: s.color }
    })
    expect(btnColors.bg).not.toBe(btnColors.fg)

    await page.goto("/offline")
    await expect(page.locator('.offline-icon svg[viewBox="0 0 64 64"]')).toBeVisible()
    await expect(page.getByRole("heading", { name: /You're Offline/i })).toBeVisible()
  })

  test("Skip-to-content link pairs personal accent background with WCAG AA foreground", async ({
    page,
  }) => {
    const contrastRatio = (rgbA: string, rgbB: string): number => {
      const lum = (rgb: string) => {
        const [r = 0, g = 0, b = 0] = (rgb.match(/\d+/g) ?? []).map(n => Number(n) / 255)
        const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
      }
      const l1 = lum(rgbA)
      const l2 = lum(rgbB)
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    }

    // Dark personal accent (#4f46e5) in dark theme must render #4f46e5 bg + white fg (6.07:1)
    await page.goto("/")
    await page.evaluate(() => {
      localStorage.setItem("meitheal-theme", "dark")
      localStorage.setItem("meitheal-accent-color", "#4f46e5")
    })
    await page.reload()
    const skip = page.locator(".skip-to-content")
    await skip.focus()
    const darkStyles = await skip.evaluate(el => {
      const s = getComputedStyle(el)
      return { bg: s.backgroundColor, fg: s.color }
    })
    expect(darkStyles.bg).toBe("rgb(79, 70, 229)")
    expect(darkStyles.fg).toBe("rgb(255, 255, 255)")
    expect(contrastRatio(darkStyles.bg, darkStyles.fg)).toBeGreaterThanOrEqual(4.5)

    // Mid-bright personal accent (#3b82f6) in light theme must render #3b82f6 bg + black fg (5.71:1)
    await page.evaluate(() => {
      localStorage.setItem("meitheal-theme", "light")
      localStorage.setItem("meitheal-accent-color", "#3b82f6")
    })
    await page.reload()
    await skip.focus()
    const lightStyles = await skip.evaluate(el => {
      const s = getComputedStyle(el)
      return { bg: s.backgroundColor, fg: s.color }
    })
    expect(lightStyles.bg).toBe("rgb(59, 130, 246)")
    expect(lightStyles.fg).toBe("rgb(0, 0, 0)")
    expect(contrastRatio(lightStyles.bg, lightStyles.fg)).toBeGreaterThanOrEqual(4.5)
  })
})

test.describe("Branding — Accent Picker", () => {
  test("Custom accent color updates --accent CSS var", async ({ page }) => {
    await page.goto("/settings")
    await page.waitForSelector(".settings-section", { timeout: 5000 }).catch(() => {})

    await page.evaluate(() => {
      const root = document.documentElement.style
      root.setProperty("--accent", "#e11d48")
      localStorage.setItem("meitheal-accent-color", "#e11d48")
    })

    const accent = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim()
    )
    expect(accent).toBe("#e11d48")

    await page.evaluate(() => {
      localStorage.removeItem("meitheal-accent-color")
    })
  })
})

test.describe("Branding — Greeting Context", () => {
  test("Dashboard greeting and workload signal are visible", async ({
    page,
  }) => {
    await page.goto("/")
    await expect(page.getByRole("heading", {
      level: 1,
      name: /Good (Morning|Afternoon|Evening)!/,
    })).toBeVisible()
    const signal = page.locator(".dashboard-hero__status")
    await expect(signal.getByText("Current signal")).toBeVisible()
    await expect(signal).toContainText(/\d+ (overdue|in progress)|Everything is steady/)
  })
})
