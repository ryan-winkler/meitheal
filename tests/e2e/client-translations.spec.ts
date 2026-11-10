import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"
import { expect, test } from "@playwright/test"
import en from "../../apps/web/src/i18n/en.json" with { type: "json" }
import ga from "../../apps/web/src/i18n/ga.json" with { type: "json" }
import { t as clientTranslate, getClientLocale } from "../../apps/web/src/i18n/client"
import { alternateClientTranslationJson, clientTranslationJson, t } from "../../apps/web/src/i18n/translations"
import { escapeHtml } from "../../apps/web/src/lib/safe-html"
import type { Locale } from "../../apps/web/src/i18n/translations"

const ts = createRequire(new URL("../../apps/web/package.json", import.meta.url))("typescript")
const layout = readFileSync(new URL("../../apps/web/src/layouts/Layout.astro", import.meta.url), "utf8")
const bootstrap = layout.slice(layout.indexOf("const dict = JSON.parse"), layout.indexOf("</script>", layout.indexOf("const dict = JSON.parse")))

function client(locale: Locale) {
  const window: { mI18n?: { get: (key: string, locale?: Locale) => string } } = {}
  runInNewContext(bootstrap, {
    window, locale, timezone: "UTC", weekStart: 1, dateFormat: "iso",
    document: { getElementById: (id: string) => ({ textContent: id === "meitheal-client-translations"
      ? clientTranslationJson[locale] : alternateClientTranslationJson[locale] }) },
  })
  return window.mI18n!
}

function keys(catalog: unknown, prefix = ""): string[] {
  if (!catalog || typeof catalog !== "object") return []
  return Object.entries(catalog).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return typeof value === "string" ? [path] : keys(value, path)
  })
}

for (const locale of ["en", "ga"] as const) {
  test(`${locale} SSR catalog preserves nested, flat, legacy and missing-key translations`, () => {
    const messages = client(locale)
    const catalogKeys = [...keys(en), ...keys(ga), ...Object.keys(en.en), ...Object.keys(ga.ga)]
    for (const key of new Set(catalogKeys)) expect(messages.get(key), key).toBe(t(key, locale))
    expect(messages.get("missing.translation")).toBe("missing.translation")
    expect(messages.get("__proto__", locale === "en" ? "ga" : "en")).toBe("__proto__")
  })

  test(`${locale} SSR supports explicit opposite-locale pin, status and inactivity messages`, () => {
    const messages = client(locale)
    const alternate = locale === "en" ? "ga" : "en"
    const scoped = JSON.parse(alternateClientTranslationJson[locale])
    for (const key of Object.keys(scoped)) expect(messages.get(key, alternate), key).toBe(t(key, alternate))
    expect(messages.get("pins.account", alternate)).not.toBe(messages.get("pins.account", locale))
    expect(Buffer.byteLength(alternateClientTranslationJson[locale])).toBeLessThan(6000)
  })
}

test("missing Irish strings use English and script payloads cannot close their element", () => {
  const missing = keys(en).filter(key => !key.startsWith("en.") && !key.startsWith("ga."))
    .find(key => t(key, "en") === t(key, "ga") && !keys(ga).includes(key))!
  expect(missing).toBeTruthy()
  expect(client("ga").get(missing)).toBe(t(missing, "en"))
  for (const payload of [...Object.values(clientTranslationJson), ...Object.values(alternateClientTranslationJson)]) {
    expect(payload).not.toContain("<")
  }
})

test("browser translator preserves requested locale, default English and repeated interpolation", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  let stored = "ga"
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { mI18n: client("ga") } })
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => stored } })
    expect(getClientLocale()).toBe("ga")
    expect(clientTranslate("pins.account")).toBe(t("pins.account", "en"))
    expect(clientTranslate("pins.page", "ga", { page: "3", pages: "8" })).toBe(t("pins.page", "ga", { page: "3", pages: "8" }))
    expect(clientTranslate("missing.translation", "ga")).toBe("missing.translation")
    stored = "en"
    expect(getClientLocale()).toBe("en")
    stored = "invalid"
    expect(getClientLocale()).toBe("en")
    Object.defineProperty(globalThis, "window", { configurable: true, value: { mI18n: { get: () => "{title} / {title}" } } })
    expect(clientTranslate("pins.unpin_named", "en", { title: '<img src=x> & "name"' })).toBe('<img src=x> & "name" / <img src=x> & "name"')
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else Reflect.deleteProperty(globalThis, "window")
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage)
    else Reflect.deleteProperty(globalThis, "localStorage")
  }
})

test.describe("browser catalog and YAML import", () => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1" && process.env.MEITHEAL_CATALOG_DEV !== "1", "Requires a disposable App server")
  test.use({ serviceWorkers: "block" })

  test("Irish SSR text switches to explicit English and handles storage, fallback, escaping and cleanup", async ({ page }) => {
    await page.route("**/locale-component-fixture", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: "<!doctype html><body></body>" }))
    await page.goto("/locale-component-fixture")
    const component = readFileSync(new URL("../../apps/web/src/components/I18nText.astro", import.meta.url), "utf8")
    const script = component.slice(component.indexOf("<script>") + 8, component.indexOf("</script>"))
      .replace(/^\s*import .*;$/gm, "")
    const localeCode = readFileSync(new URL("../../apps/web/src/lib/locale.ts", import.meta.url), "utf8").replace(/^export /gm, "")
    const code = ts.transpileModule(localeCode + "\n" + script, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    const fallback = '<img src=x onerror="window.localeInjection=true"> & "fallback"'
    const text = (key: string, initial: Locale, missing = "") => {
      const value = t(key, initial)
      return `<i18n-text data-key="${escapeHtml(key)}" data-en="${escapeHtml(t(key, "en"))}" data-ga="${escapeHtml(t(key, "ga"))}">${escapeHtml(value === key ? missing : value)}</i18n-text>`
    }
    await page.evaluate(() => localStorage.setItem("meitheal-locale", "ga"))
    await page.locator("body").evaluate((body, html) => { body.innerHTML = html }, text("pins.account", "ga") + text("unknown.key", "ga", fallback))
    await page.addScriptTag({ content: code })
    const element = page.locator("i18n-text").first()
    await expect(element).toHaveText(t("pins.account", "ga"))
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("meitheal:locale-changed", { detail: { locale: "en" } })))
    await expect(element).toHaveText(t("pins.account", "en"))
    await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "meitheal-locale", newValue: "ga" })))
    await expect(element).toHaveText(t("pins.account", "ga"))
    await expect(page.locator("i18n-text").nth(1)).toHaveText(fallback)
    expect(await page.locator("i18n-text img").count()).toBe(0)
    expect(await element.evaluate(node => {
      node.remove()
      window.dispatchEvent(new CustomEvent("meitheal:locale-changed", { detail: { locale: "en" } }))
      return node.textContent
    })).toBe(t("pins.account", "ga"))
  })

  test("pinned messages honor localStorage when it differs from the SSR cookie", async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "meitheal-locale", value: "ga", url: baseURL! }])
    await page.addInitScript(() => localStorage.setItem("meitheal-locale", "en"))
    await page.goto("/pinned")
    await expect(page.locator("#pinned-heading")).toHaveText(t("pins.title", "ga"))
    await expect(page.locator("[data-pins-status]")).toHaveText(t("pins.unavailable", "en"))
    expect(await page.evaluate(() => window.mI18n?.get("pins.account", "en"))).toBe(t("pins.account", "en"))
    expect(await page.evaluate(() => window.mI18n?.get("pins.account", "ga"))).toBe(t("pins.account", "ga"))
  })

  test("modal pin messages follow another tab's stored locale", async ({ page, context, request, baseURL }) => {
    const origin = new URL(baseURL!).origin
    const task = await request.post("/api/tasks", { headers: { origin }, data: { title: "Locale pin fixture" } })
    expect(task.status()).toBe(201)
    const { id } = await task.json()
    try {
      await context.addCookies([{ name: "meitheal-locale", value: "en", url: baseURL! }])
      await page.goto("/tasks")
      await page.waitForFunction(() => typeof window.openTaskDetail === "function")
      await page.evaluate(id => window.openTaskDetail!(id), id)
      await expect(page.locator("#task-detail-overlay")).toHaveClass(/active/)
      await expect(page.locator("#td-title")).toHaveValue("Locale pin fixture")
      const other = await context.newPage()
      await other.goto("/pinned")
      await other.evaluate(() => localStorage.setItem("meitheal-locale", "ga"))
      await page.bringToFront()
      await page.evaluate(() => window.dispatchEvent(new Event("meitheal:task-pins-invalidated")))
      await expect(page.locator("#td-pin-status")).toHaveText(t("pins.account", "ga"))
      await other.evaluate(() => localStorage.setItem("meitheal-locale", "en"))
      await page.evaluate(() => window.dispatchEvent(new Event("meitheal:task-pins-invalidated")))
      await expect(page.locator("#td-pin-status")).toHaveText(t("pins.account", "en"))
      await other.close()
    } finally {
      expect((await request.delete(`/api/tasks/${id}`, { headers: { origin }, data: {} })).status()).toBe(204)
    }
  })

  test("YAML import validates on the server and retains invalid input", async ({ page, request }) => {
    expect((await request.post("/api/frameworks", { data: { yaml: "name: Too large\n" + "#".repeat(65536) } })).status()).toBe(400)
    await page.goto("/settings#rules-lenses-settings")
    await page.locator("#fw-import-btn").click()
    for (const yaml of ["name: [unterminated", "fields: []"]) {
      await page.locator("#fw-import-yaml").fill(yaml)
      await page.locator("#fw-import-submit").click()
      await expect(page.locator("#fw-import-errors")).toContainText("Invalid YAML framework definition")
      await expect(page.locator("#fw-import-yaml")).toHaveValue(yaml)
    }
    const name = `Locale YAML fixture ${crypto.randomUUID()}`
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    try {
      await page.locator("#fw-import-yaml").fill(`name: ${name}\nformula: impact\nfields:\n  - key: impact\n    label: Impact\n    type: number\n`)
      await page.locator("#fw-import-submit").click()
      await expect(page.locator("#fw-import-dialog")).not.toBeVisible()
      const result = await request.get(`/api/frameworks/${id}`)
      expect(result.status()).toBe(200)
      expect((await result.json()).data).toMatchObject({ id, name, source: "imported", formula: "impact", fields: [{ key: "impact", label: "Impact", type: "number" }] })
    } finally { await request.delete(`/api/frameworks/${id}`) }
  })
})
