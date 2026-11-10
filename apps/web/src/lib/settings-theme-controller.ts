/**
 * Theme settings controller.
 *
 * Handles theme selection, custom theme import/export/delete,
 * locale, timezone, week start, and date format preferences.
 */
import { APPEARANCE_PREFERENCES, APPEARANCE_STORAGE_KEY } from "@lib/appearance-preferences"
import { pageLifecycle } from "@lib/page-lifecycle"
import { DEFAULT_ACCENT } from "@lib/design-tokens"
import { showToast } from "@lib/toast"
import {
  setTheme as importedSetTheme,
  applyCustomTheme as importedApplyCustomTheme,
} from "@lib/theme-watcher"
import { attachShortcutTooltips } from "@lib/shortcut-tooltip"
import { SINGLE_KEY_SHORTCUTS_STORAGE_KEY, setSingleKeyShortcuts, singleKeyShortcutsEnabled } from "@lib/single-key-shortcuts"
import { settingsStore } from "@lib/settings-store"
import type { ThemeMode } from "@lib/theme-watcher"
import { saveSetting, saveSettings, showSettingsSaveError, sanitizeCSS, MAX_THEME_SIZE, log } from "@lib/settings-utils"

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

function initAppearanceSettings(): void {
  const form = document.querySelector<HTMLFormElement>("#appearance-preferences-form")
  const status = document.getElementById("appearance-save-status")
  if (!form || !status) return

  const root = document.documentElement
  const fields = Object.entries(APPEARANCE_PREFERENCES).map(([name, preference]) => ({
    name,
    attribute: `data-appearance-${name}`,
    select: form.elements.namedItem(name) as HTMLSelectElement,
    ...preference,
  }))

  for (const field of fields) field.select.value = root.getAttribute(field.attribute) ?? field.defaultValue
  pageLifecycle.on(form, "change", () => { status.textContent = "" })
  pageLifecycle.on(form, "reset", event => {
    event.preventDefault()
    for (const field of fields) field.select.value = field.defaultValue
    status.textContent = status.dataset.reset ?? ""
  })
  pageLifecycle.on(form, "submit", event => {
    event.preventDefault()
    const selected = fields.map(field => ({
      ...field,
      value: field.options.includes(field.select.value) ? field.select.value : field.defaultValue,
    }))
    let previous: Record<string, unknown> = {}
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}")
      if (stored && typeof stored === "object" && !Array.isArray(stored)) previous = stored as Record<string, unknown>
    } catch { /* A valid save replaces malformed stored preferences. */ }
    try {
      localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({
        ...previous,
        ...Object.fromEntries(selected.map(({ name, value }) => [name, value])),
      }))
    } catch {
      status.textContent = status.dataset.error ?? ""
      return
    }
    for (const { attribute, value } of selected) root.setAttribute(attribute, value)
    status.textContent = status.dataset.saved ?? ""
  })
}

export function initThemeSettings(): void {
  const singleKeys = document.querySelector<HTMLInputElement>("#single-key-shortcuts")
  if (singleKeys) {
    singleKeys.checked = singleKeyShortcutsEnabled()
    pageLifecycle.on(singleKeys, "change", () => {
      try {
        setSingleKeyShortcuts(singleKeys.checked)
      } catch {
        singleKeys.checked = singleKeyShortcutsEnabled()
        showToast(window.mI18n?.get("settings.shortcut_preference_error") ?? "Could not save keyboard preferences on this device.", "error")
        return
      }
      attachShortcutTooltips(document.body)
    })
    window.addEventListener("storage", (event) => {
      if (event.key === SINGLE_KEY_SHORTCUTS_STORAGE_KEY || event.key === null) {
        singleKeys.checked = singleKeyShortcutsEnabled()
      }
    }, { signal: pageLifecycle.signal })
  }

  initAccentSettings()
  initAppearanceSettings()

  // Theme Config — init select from localStorage
  const themeSelect = document.getElementById("theme-select") as HTMLSelectElement
  if (themeSelect) {
    themeSelect.value = localStorage.getItem("meitheal-theme") || "dark"
    showCustomThemeSection(themeSelect.value === "custom")
  }

  function bindPreference(id: string, key: string, apply: (value: string) => void): void {
    const select = document.getElementById(id) as HTMLSelectElement | null
    if (!select) return

    pageLifecycle.on(select, "change", async () => {
      const value = select.value
      select.disabled = true
      select.setAttribute("aria-busy", "true")
      try {
        await saveSetting(key, value)
        apply(value)
        showToast("common.updated")
      } catch (error) {
        const settings = await settingsStore.load().catch(() => null)
        if (settings) restoreThemeSettings(settings)
        showSettingsSaveError(error)
      } finally {
        select.disabled = false
        select.removeAttribute("aria-busy")
      }
    })
  }

  bindPreference("theme-select", "theme", (theme) => {
    importedSetTheme(theme as ThemeMode)
    showCustomThemeSection(theme === "custom")
  })
  bindPreference("locale-select", "locale", (locale) => {
    localStorage.setItem("meitheal-locale", locale)
    document.cookie = `meitheal-locale=${locale};path=/;max-age=31536000;SameSite=Lax`
    window.dispatchEvent(new CustomEvent("meitheal:locale-changed", { detail: { locale } }))
    window.location.reload()
  })
  bindPreference("timezone-select", "timezone", (value) => localStorage.setItem("meitheal-timezone", value))
  bindPreference("week-start-select", "week_start", (value) => localStorage.setItem("meitheal-week-start", value))
  bindPreference("date-format-select", "date_format", (value) => localStorage.setItem("meitheal-date-format", value))

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
      await saveSettings({ custom_theme_css: cleanCSS, custom_theme_name: file.name, theme: "custom" })
      localStorage.setItem("meitheal-custom-theme-css", cleanCSS)
      importedSetTheme("custom")
      importedApplyCustomTheme(cleanCSS)
      updateCustomThemeDisplay(file.name)
      const themeEl = document.getElementById("theme-select") as HTMLSelectElement
      if (themeEl) themeEl.value = "custom"
      showToast(`Theme imported: ${file.name}`)
    } catch (err) {
      showSettingsSaveError(err)
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

    try {
      await saveSettings({ theme: "dark", custom_theme_css: "", custom_theme_name: "" })
      localStorage.removeItem("meitheal-custom-theme-css")
      importedApplyCustomTheme(null)
      restoreThemeSettings({ theme: "dark" })
      showToast("Custom theme removed. Dark mode is active.")
    } catch (error) {
      showSettingsSaveError(error)
    }
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
    updateCustomThemeDisplay(settings.custom_theme_name ? String(settings.custom_theme_name) : null)
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
