import { expect, test, type Frame, type Page } from "@playwright/test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { shouldSkipBrowserSpecs } from "./_helpers"

const evidenceDir = process.env.MEITHEAL_CONTRAST_EVIDENCE_DIR
const states = [
  { name: "dark", theme: "dark", system: "light", effective: "dark" },
  { name: "light", theme: "light", system: "dark", effective: "light" },
  { name: "auto-ha-dark-system-light", theme: "auto", system: "light", ha: "dark", effective: "dark" },
  { name: "auto-ha-light-system-dark", theme: "auto", system: "dark", ha: "light", effective: "light" },
] as const

type ContrastTarget = { selector: string; name: string; placeholder?: boolean }

async function sample(frame: Page | Frame, targets?: ContrastTarget[]) {
  return frame.evaluate(targets => {
    type Color = [number, number, number, number]
    const parse = (value: string): Color => {
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = 1
      const context = canvas.getContext("2d")!
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const pixel = context.getImageData(0, 0, 1, 1).data
      return [pixel[0]!, pixel[1]!, pixel[2]!, pixel[3]! / 255]
    }
    const over = (fg: Color, bg: Color): Color => [
      fg[0] * fg[3] + bg[0] * (1 - fg[3]),
      fg[1] * fg[3] + bg[1] * (1 - fg[3]),
      fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1,
    ]
    const luminance = (color: Color) => color.slice(0, 3).map(channel => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0)
    const measurements: Record<string, unknown>[] = []
    const measure = (element: Element, name: string, placeholder = false) => {
      const style = getComputedStyle(element)
      const textStyle = placeholder ? getComputedStyle(element, "::placeholder") : style
      const ancestors: Element[] = []
      for (let current: Element | null = element; current; current = current.parentElement) ancestors.unshift(current)
      let background: Color = [255, 255, 255, 1]
      let opacity = 1
      for (const ancestor of ancestors) {
        const computed = getComputedStyle(ancestor)
        background = over(parse(computed.backgroundColor), background)
        opacity *= Number(computed.opacity)
      }
      const foreground = parse(textStyle.color)
      foreground[3] *= opacity * (placeholder ? Number(textStyle.opacity) : 1)
      const rendered = over(foreground, background)
      const a = luminance(rendered), b = luminance(background)
      measurements.push({
        name, text: placeholder ? element.getAttribute("placeholder") : element.textContent?.trim(),
        background: style.backgroundColor, foreground: textStyle.color, opacity: style.opacity,
        effectiveTextOpacity: foreground[3], backgroundComposite: background.slice(0, 3),
        renderedText: rendered.slice(0, 3), contrast: Number(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(3)),
        colorScheme: style.colorScheme, appearance: style.appearance,
        active: element.getAttribute("aria-checked"),
      })
    }
    if (targets) for (const target of targets) measure(document.querySelector(target.selector)!, target.name, target.placeholder)
    else {
      for (const id of ["new-task-title-input", "new-task-desc-input", "nt-shopping-qty", "nt-shopping-category", "nt-shopping-item-input", "new-task-assigned-to", "new-task-goal", "submit-new-task-btn", "cancel-new-task", "nt-add-shopping-item"]) {
        const element = document.getElementById(id)!
        measure(element, id)
        if (element.getAttribute("placeholder")) measure(element, `${id}:placeholder`, true)
        const label = document.querySelector(`label[for="${id}"]`)
        if (label) measure(label, `${id}:label`)
      }
      document.querySelectorAll("#nt-status-pills [data-status]").forEach(element => measure(element, `status:${element.getAttribute("data-status")}`))
    }
    const root = document.documentElement
    const style = getComputedStyle(root)
    return {
      state: { theme: root.dataset.theme, haTheme: root.dataset.haTheme ?? null, base: root.dataset.appearanceBase, rootClass: root.className, colorScheme: style.colorScheme,
        bgInput: style.getPropertyValue("--bg-input").trim(), textPrimary: style.getPropertyValue("--text-primary").trim(),
        bgInputAlias: style.getPropertyValue("--color-bg-input").trim(), textPrimaryAlias: style.getPropertyValue("--color-text-primary").trim(),
        systemDark: matchMedia("(prefers-color-scheme: dark)").matches,
      }, measurements,
    }
  }, targets)
}

test.describe("Shopping theme contrast", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
  for (const state of states) {
    test(`${state.name}: native fields, labels and placeholders stay readable`, async ({ browser, baseURL }, testInfo) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: state.system, reducedMotion: "reduce", serviceWorkers: "block" })
      try {
        await context.addInitScript(theme => {
          localStorage.setItem("meitheal-theme", theme)
          localStorage.setItem("meitheal-appearance", JSON.stringify({ base: "slate" }))
        }, state.theme)
        const page = await context.newPage()
        // Populate only absent options; application responses and theme CSS remain real.
        await page.route("**/api/users", async route => {
          const response = await route.fetch(), data = await response.json()
          await route.fulfill({ response, json: data.users?.length ? data : { ...data, users: [{ id: "contrast-fixture-user", name: "Fixture household member", source: "custom" }] } })
        })
        await page.route("**/api/goals", async route => {
          const response = await route.fetch(), data = await response.json()
          const goal = { id: "contrast-fixture-goal", title: "Fixture goal" }
          await route.fulfill({ response, json: Array.isArray(data) ? data.length ? data : [goal] : data.goals?.length ? data : { ...data, goals: [goal] } })
        })
        let frame: Page | Frame = page
        if ("ha" in state) {
          // Synthetic same-origin HA frontend only, with no transport/auth claim.
          await page.route("**/__task-theme-parent", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html style="color-scheme:${state.ha};--primary-background-color:${state.ha === "dark" ? "#111111" : "#ffffff"}"><body style="margin:0"><iframe title="Synthetic HA frontend" src="/today" style="border:0;width:100vw;height:100vh"></iframe></body></html>` }))
          // Supply the rendered ingress marker before the compiled page bridge starts.
          await context.addInitScript(() => {
            if (window.parent === window) return
            const mark = () => {
              if (!document.body) return
              document.body.classList.add("ha-ingress")
              observer.disconnect()
            }
            const observer = new MutationObserver(mark)
            observer.observe(document, { childList: true, subtree: true })
            mark()
          })
          await page.goto(`${baseURL}/__task-theme-parent`)
          const iframe = page.frames().find(candidate => candidate !== page.mainFrame())!
          await iframe.waitForSelector("#new-task-title-input", { state: "attached" })
          frame = iframe
          await expect(frame.locator("html")).toHaveAttribute("data-ha-theme", state.ha)
          await expect(frame.locator("html")).toHaveClass(new RegExp(state.effective))
        } else await page.goto(`${baseURL}/today`)
        await frame.getByRole("button", { name: "New Task", exact: true }).click()
        await frame.getByRole("button", { name: "Shopping", exact: true }).click()
        await frame.locator("#nt-options > summary").click()
        await expect(frame.locator('#new-task-assigned-to option[value]:not([value=""])').first()).toBeAttached()
        await expect(frame.locator('#new-task-goal option[value]:not([value=""])').first()).toBeAttached()
        await frame.locator("#close-new-task-modal").focus()
        await frame.evaluate(async () => {
          await document.fonts.ready
          // Pseudo-element opacity transitions are not consistently exposed by
          // getAnimations(). Allow the existing 150ms placeholder fade to settle.
          await new Promise(resolve => setTimeout(resolve, 300))
        })
        const unfocused = await sample(frame)
        const dir = evidenceDir ?? testInfo.outputPath("contrast")
        await mkdir(dir, { recursive: true })
        await frame.locator("#new-task-form").evaluate(element => { element.scrollTop = 0 })
        await page.screenshot({ path: join(dir, `${state.name}-top.png`) })
        await frame.locator("#new-task-form").evaluate(element => { element.scrollTop = element.scrollHeight })
        await page.screenshot({ path: join(dir, `${state.name}-details.png`) })
        await frame.locator("#new-task-title-input").focus()
        await frame.evaluate(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
        const focused = await sample(frame)
        await page.screenshot({ path: join(dir, `${state.name}-title-focused.png`) })
        await writeFile(join(dir, `${state.name}.json`), JSON.stringify({ fixture: "ha" in state ? "synthetic same-origin HA frontend with real initHAThemeBridge" : "normal standalone dev", unfocused, focused }, null, 2))
        expect(unfocused.state.base).toBe("slate")
        expect(unfocused.state.theme).toBe(state.theme)
        const violations = [...unfocused.measurements, ...focused.measurements.filter(item => item.name === "new-task-title-input:placeholder")].filter(item => Number(item.contrast) < 4.5)
        expect(violations, "Small text, including focused placeholder, must retain 4.5:1 contrast").toEqual([])
        expect(unfocused.state.colorScheme, "Native controls should use the authoritative app appearance").toBe(state.effective)
      } finally {
        await context.close()
      }
    })
  }

  test("bright personal accents keep action text readable through hover, bootstrap and reset", async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    page.on("console", message => {
      if (message.type() === "error" && /CSP:|content security policy/i.test(message.text())) errors.push(message.text())
    })
    await page.addInitScript(() => {
      localStorage.setItem("meitheal-theme", "dark")
      localStorage.setItem("meitheal-appearance", JSON.stringify({ base: "slate" }))
      document.addEventListener("securitypolicyviolation", event => console.error(`CSP:${event.violatedDirective}:${event.blockedURI}`))
    })
    const measurements: unknown[] = []
    const inspectAction = async (phase: string) => {
      // The contrast sample composites ancestor opacity. Wait for the dialog's entry fade to finish.
      await expect(page.locator("#new-task-overlay .modal-content")).toHaveCSS("opacity", "1")
      const result = (await sample(page)).measurements.find(item => item.name === "submit-new-task-btn")!
      measurements.push({ phase, ...result })
      expect(Number(result.contrast), phase).toBeGreaterThanOrEqual(4.5)
    }
    const openShopping = async () => {
      await page.getByRole("button", { name: "New Task", exact: true }).click()
      await page.getByRole("button", { name: "Shopping", exact: true }).click()
      await page.locator("#close-new-task-modal").focus()
    }
    const dir = evidenceDir ?? testInfo.outputPath("contrast")
    await mkdir(dir, { recursive: true })
    try {
      for (const color of ["#ffffff", "#ffff00"]) {
        await page.goto("/settings#look-and-feel-settings")
        await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
        await page.locator("#accent-color-custom").fill(color)
        await expect.poll(() => page.evaluate(() => localStorage.getItem("meitheal-accent-color"))).toBe(color)
        await page.goto("/today")
        await openShopping()
        await inspectAction(`${color}:normal-after-navigation`)
        await page.locator("#submit-new-task-btn").hover()
        await page.waitForTimeout(300)
        await inspectAction(`${color}:hover`)
        await page.screenshot({ path: join(dir, `bright-${color.slice(1)}-hover.png`) })
        await page.reload()
        await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--personal-accent").trim())).toBe(color)
        await openShopping()
        await page.mouse.move(0, 0)
        await page.waitForTimeout(300)
        await inspectAction(`${color}:reload-bootstrap`)
      }
      await page.goto("/settings#look-and-feel-settings")
      await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
      await page.locator("#accent-reset").click()
      await expect.poll(() => page.evaluate(() => localStorage.getItem("meitheal-accent-color"))).toBeNull()
      expect(await page.evaluate(() => ["--personal-accent", "--personal-accent-foreground", "--personal-accent-hover-foreground"].map(key => document.documentElement.style.getPropertyValue(key)))).toEqual(["", "", ""])
      await page.goto("/today")
      await openShopping()
      await inspectAction("reset-default")
      expect(errors, "No bootstrap runtime or CSP errors").toEqual([])
    } finally {
      await writeFile(join(dir, "bright-accents.json"), JSON.stringify({ measurements, errors }, null, 2))
    }
  })

  test("Tags input, dropdown, create hover and empty state stay readable in Dark and Light", async ({ browser, baseURL }, testInfo) => {
    const dir = evidenceDir ?? testInfo.outputPath("contrast")
    await mkdir(dir, { recursive: true })
    const violations: unknown[] = []
    const runtimeErrors: string[] = []
    for (const theme of ["dark", "light"] as const) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: theme === "dark" ? "light" : "dark", reducedMotion: "reduce", serviceWorkers: "block" })
      try {
        await context.addInitScript(theme => {
          localStorage.setItem("meitheal-theme", theme)
          localStorage.setItem("meitheal-appearance", JSON.stringify({ base: "slate" }))
        }, theme)
        const page = await context.newPage()
        page.on("pageerror", error => runtimeErrors.push(`${theme}: ${error.message}`))
        page.on("console", message => {
          if (message.type() === "error" && /content security policy/i.test(message.text())) runtimeErrors.push(`${theme}: ${message.text()}`)
        })
        // Deterministic labels only; selection is deferred inside the real form.
        await page.route("**/api/labels", route => route.fulfill({ json: [{ id: 981, title: "Contrast fixture", hex_color: "#6366f1" }] }))
        await page.goto(`${baseURL}/today`)
        await page.waitForFunction(() => typeof (window as Window & { openNewTaskModal?: unknown }).openNewTaskModal === "function")
        await page.getByRole("button", { name: "New Task", exact: true }).click()
        await page.getByRole("button", { name: "Shopping", exact: true }).click()
        await page.locator("#nt-options > summary").click()
        const input = page.locator("#new-task-label-picker-input")
        const option = "#new-task-label-picker-dropdown .label-picker__option"
        await input.scrollIntoViewIfNeeded()
        await page.locator("#close-new-task-modal").focus()
        const captures: unknown[] = []
        const capture = async (phase: string, targets: ContrastTarget[]) => {
          await page.waitForTimeout(300)
          const result = await sample(page, targets)
          captures.push({ phase, ...result })
          for (const item of result.measurements) if (Number(item.contrast) < 4.5) violations.push({ theme, phase, ...item })
          await page.screenshot({ path: join(dir, `tags-${theme}-${phase}.png`) })
        }
        await capture("placeholder", [{ selector: "#new-task-label-picker-input", name: "tags-placeholder", placeholder: true }])
        await input.focus()
        await expect(page.locator(`${option}[data-title]`)).toHaveText("Contrast fixture")
        await capture("dropdown", [{ selector: `${option}[data-title]`, name: "tags-dropdown-option" }])
        await input.fill("New contrast tag")
        await expect(page.locator(`${option}[data-create]`)).toHaveText('+ Create "new contrast tag"')
        await capture("typed-create", [
          { selector: "#new-task-label-picker-input", name: "tags-typed-text" },
          { selector: `${option}[data-create]`, name: "tags-create-option" },
        ])
        await page.locator(`${option}[data-create]`).hover()
        await capture("create-hover", [{ selector: `${option}[data-create]`, name: "tags-create-hover" }])
        await input.fill("")
        await page.locator(`${option}[data-title]`).click()
        await expect(page.locator("#new-task-label-picker-value")).toHaveValue('["Contrast fixture"]')
        await input.focus()
        await expect(page.locator(option)).toHaveText("No labels found")
        await capture("empty", [{ selector: option, name: "tags-empty-state" }])
        await writeFile(join(dir, `tags-${theme}.json`), JSON.stringify(captures, null, 2))
      } finally {
        await context.close()
      }
    }
    await writeFile(join(dir, "tags-errors.json"), JSON.stringify(runtimeErrors, null, 2))
    expect(violations, "Tags text and placeholders must retain at least 4.5:1 contrast").toEqual([])
    expect(runtimeErrors, "No Tags runtime or CSP errors").toEqual([])
  })
})
