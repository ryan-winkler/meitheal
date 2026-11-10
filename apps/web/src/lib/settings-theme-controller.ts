/**
 * Theme settings controller.
 *
 * Handles theme selection, custom theme import/export/delete,
 * locale, timezone, week start, and date format preferences.
 */
import { pageLifecycle } from "@lib/page-lifecycle"
import { DEFAULT_ACCENT } from "@lib/design-tokens"
import { showToast } from "@lib/toast"
import {
  setTheme as importedSetTheme,
  applyCustomTheme as importedApplyCustomTheme,
} from "@lib/theme-watcher"
import type { ThemeMode } from "@lib/theme-watcher"
import { saveSetting, sanitizeCSS, MAX_THEME_SIZE, log } from "@lib/settings-utils"

// ───── UI helpers ─────

/** Show/hide the custom theme section */
function showCustomThemeSection(show: boolean): void {
  const section = document.getElementById("custom-theme-section")
  if (section) section.style.display = show ? "block" : "none"
}

/** Update the custom theme loaded display */
function updateCustomThemeDisplay(filename: string | null): void {
  const emptyEl = document.getElementById("custom-theme-empty")
  const loadedEl = document.getElementById("custom-theme-loaded")
  const nameEl = document.getElementById("custom-theme-filename")
  if (!emptyEl || !loadedEl || !nameEl) return
  if (filename) {
    emptyEl.style.display = "none"
    loadedEl.style.display = "flex"
    nameEl.textContent = filename
  } else {
    emptyEl.style.display = "flex"
    loadedEl.style.display = "none"
    nameEl.textContent = ""
  }
}

// ───── Init ─────

const ACCENT_KEY = "meitheal-accent-color"

function initAccentSettings(): void {
  const swatches = document.querySelectorAll<HTMLButtonElement>(".accent-swatch")
  const picker = document.querySelector<HTMLInputElement>("#accent-color-custom")
  const reset = document.getElementById("accent-reset")
  const root = document.documentElement.style

  function updateSelection(color: string): void {
    const normalized = color.toLowerCase()
    for (const swatch of swatches) {
      const selected = swatch.dataset.color?.toLowerCase() === normalized
      swatch.classList.toggle("active", selected)
      swatch.setAttribute("aria-pressed", String(selected))
    }
    if (picker) picker.value = normalized
  }

  function setAccent(color: string): void {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return
    root.setProperty("--personal-accent", color)
    localStorage.setItem(ACCENT_KEY, color)
    updateSelection(color)
  }

  const stored = localStorage.getItem(ACCENT_KEY)
  updateSelection(stored && /^#[0-9a-f]{6}$/i.test(stored) ? stored : DEFAULT_ACCENT)
  for (const swatch of swatches) {
    pageLifecycle.on(swatch, "click", () => setAccent(swatch.dataset.color ?? ""))
  }
  if (picker) pageLifecycle.on(picker, "input", () => setAccent(picker.value))
  if (reset) {
    pageLifecycle.on(reset, "click", () => {
      root.removeProperty("--personal-accent")
      localStorage.removeItem(ACCENT_KEY)
      updateSelection(DEFAULT_ACCENT)
    })
  }
}

export function initThemeSettings(): void {
  initAccentSettings()

  // Theme Config — init select from localStorage
  const themeSelect = document.getElementById("theme-select") as HTMLSelectElement
  if (themeSelect) {
    themeSelect.value = localStorage.getItem("meitheal-theme") || "dark"
    showCustomThemeSection(themeSelect.value === "custom")
  }

  // Theme selector — instant apply + persist via theme-watcher
  const themeSelectEl = document.getElementById("theme-select")
  if (themeSelectEl) {
    pageLifecycle.on(themeSelectEl, "change", async (e) => {
    const theme = (e.target as HTMLSelectElement).value as ThemeMode
    importedSetTheme(theme)
    await saveSetting("theme", theme)
    showCustomThemeSection(theme === "custom")
    showToast(
      theme === "dark"
        ? "Theme: Dark"
        : theme === "light"
          ? "Theme: Light"
          : theme === "auto"
            ? "Theme: Auto (System)"
            : "Theme: Custom",
    )
    })
  }

  // Custom theme file import handler
  const customThemeInput = document.getElementById("custom-theme-input")
  if (customThemeInput) {
    pageLifecycle.on(customThemeInput, "change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return

    if (!file.name.endsWith(".css")) {
      showToast("Only .css files are allowed", "error")
      ;(e.target as HTMLInputElement).value = ""
      return
    }

    if (file.type && file.type !== "text/css" && !file.type.startsWith("text/")) {
      showToast("Invalid file type — must be a CSS file", "error")
      ;(e.target as HTMLInputElement).value = ""
      return
    }

    if (file.size > MAX_THEME_SIZE) {
      showToast(`File too large (${Math.round(file.size / 1024)}KB) — max 50KB`, "error")
      ;(e.target as HTMLInputElement).value = ""
      return
    }

    try {
      const rawCSS = await file.text()
      const cleanCSS = sanitizeCSS(rawCSS)
      localStorage.setItem("meitheal-custom-theme-css", cleanCSS)
      importedSetTheme("custom")
      importedApplyCustomTheme(cleanCSS)
      await saveSetting("custom_theme_css", cleanCSS)
      await saveSetting("custom_theme_name", file.name)
      await saveSetting("theme", "custom")
      updateCustomThemeDisplay(file.name)
      const themeEl = document.getElementById("theme-select") as HTMLSelectElement
      if (themeEl) themeEl.value = "custom"
      showToast(`Theme imported: ${file.name}`)
    } catch (err) {
      log.error("Failed to import custom theme", err)
      showToast("Failed to import theme", "error")
    }

    ;(e.target as HTMLInputElement).value = ""
    })
  }

  // Custom theme delete handler
  const deleteThemeBtn = document.getElementById("custom-theme-delete")
  if (deleteThemeBtn) {
    pageLifecycle.on(deleteThemeBtn, "click", async () => {
    const { confirmDialog } = await import("@lib/confirm-dialog")
    const ok = await confirmDialog({
      message: "Remove custom theme? The app will revert to Dark mode.",
      variant: "warning",
    })
    if (!ok) return

    localStorage.removeItem("meitheal-custom-theme-css")
    importedApplyCustomTheme(null)
    importedSetTheme("dark")
    const themeEl = document.getElementById("theme-select") as HTMLSelectElement
    if (themeEl) themeEl.value = "dark"
    await saveSetting("theme", "dark")
    await saveSetting("custom_theme_css", "")
    await saveSetting("custom_theme_name", "")
    updateCustomThemeDisplay(null)
    showToast("Custom theme removed — reverted to Dark")
    })
  }

  // Custom theme filename click — download the stored CSS
  const filenameEl = document.getElementById("custom-theme-filename")
  if (filenameEl) {
    pageLifecycle.on(filenameEl, "click", (e) => {
    e.preventDefault()
    const css = localStorage.getItem("meitheal-custom-theme-css")
    if (!css) return
    const blob = new Blob([css], { type: "text/css" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = document.getElementById("custom-theme-filename")?.textContent || "custom-theme.css"
    a.click()
    URL.revokeObjectURL(url)
    })
  }

  // Language selector — persist to API, cookie, localStorage
  const localeSelect = document.getElementById("locale-select")
  if (localeSelect) {
    pageLifecycle.on(localeSelect, "change", async (e) => {
    const locale = (e.target as HTMLSelectElement).value
    localStorage.setItem("meitheal-locale", locale)
    document.cookie = `meitheal-locale=${locale};path=/;max-age=31536000;SameSite=Lax`
    try {
      await saveSetting("locale", locale)
    } catch {
      /* ignore API errors */
    }
    window.dispatchEvent(new CustomEvent("meitheal:locale-changed", { detail: { locale } }))
    showToast(locale === "ga" ? "Teanga athraithe go Gaeilge" : "Language changed to English")
    // Full reload required — SSR translations are server-rendered and need a fresh page
    setTimeout(() => window.location.reload(), 800)
    })
  }

  // Timezone selector
  const tzSelect = document.getElementById("timezone-select")
  if (tzSelect) {
    pageLifecycle.on(tzSelect, "change", async (e) => {
    const tz = (e.target as HTMLSelectElement).value
    localStorage.setItem("meitheal-timezone", tz)
    await saveSetting("timezone", tz)
    showToast("common.updated")
    })
  }

  // Week start selector
  const wsSelect = document.getElementById("week-start-select")
  if (wsSelect) {
    pageLifecycle.on(wsSelect, "change", async (e) => {
    const ws = (e.target as HTMLSelectElement).value
    localStorage.setItem("meitheal-week-start", ws)
    await saveSetting("week_start", ws)
    showToast("common.updated")
    })
  }

  // Date format selector
  const dfSelect = document.getElementById("date-format-select")
  if (dfSelect) {
    pageLifecycle.on(dfSelect, "change", async (e) => {
    const df = (e.target as HTMLSelectElement).value
    localStorage.setItem("meitheal-date-format", df)
    await saveSetting("date_format", df)
    showToast("common.updated")
    })
  }
}

// ───── Restore ─────

/** Restore theme/locale/timezone settings from loaded settings object */
export function restoreThemeSettings(settings: Record<string, unknown>): void {
  try {
    const savedTheme = (settings.theme as string) || localStorage.getItem("meitheal-theme") || "dark"
    const themeEl = document.getElementById("theme-select") as HTMLSelectElement
    if (themeEl) themeEl.value = String(savedTheme)
    importedSetTheme(String(savedTheme) as ThemeMode)
    if (savedTheme === "custom" && settings.custom_theme_css) {
      localStorage.setItem("meitheal-custom-theme-css", String(settings.custom_theme_css))
      importedApplyCustomTheme(String(settings.custom_theme_css))
    }
    showCustomThemeSection(String(savedTheme) === "custom")
    if (settings.custom_theme_name) {
      updateCustomThemeDisplay(String(settings.custom_theme_name))
    }
  } catch (e) {
    log.error("Theme restore error", e)
  }

  try {
    // Restore locale
    if (settings.locale) {
      (document.getElementById("locale-select") as HTMLSelectElement).value = String(settings.locale)
    } else {
      const stored = localStorage.getItem("meitheal-locale") || "en"
      ;(document.getElementById("locale-select") as HTMLSelectElement).value = stored
    }
  } catch (e) {
    log.error("Locale restore error", e)
  }

  try {
    const tz = (settings.timezone as string) || localStorage.getItem("meitheal-timezone") || "Europe/Dublin"
    const tzEl = document.getElementById("timezone-select") as HTMLSelectElement
    if (tzEl) tzEl.value = tz

    const ws = (settings.week_start as string) || localStorage.getItem("meitheal-week-start") || "monday"
    const wsEl = document.getElementById("week-start-select") as HTMLSelectElement
    if (wsEl) wsEl.value = ws

    const df = (settings.date_format as string) || localStorage.getItem("meitheal-date-format") || "relative"
    const dfEl = document.getElementById("date-format-select") as HTMLSelectElement
    if (dfEl) dfEl.value = df
  } catch (e) {
    log.error("UI settings error", e)
  }
}
