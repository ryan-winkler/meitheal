/**
 * Theme & appearance settings controller.
 *
 * Unifies Theme, Match Home Assistant Theme, Accent Color, Customize Appearance,
 * and Navigation Layout into a live-preview ("Show me immediately") + explicit-save
 * ("Make sure I save to commit") experience with Discard and automatic unload revert.
 */
import {
  APPEARANCE_PREFERENCES,
  APPEARANCE_STORAGE_KEY,
  appearanceAttribute,
  applyAppearancePreferences,
  type AppearancePreferences,
} from "@lib/appearance-preferences"
import {
  cloneAppearanceSnapshot,
  countAppearanceDraftChanges,
  isAppearanceDraftDirty,
  normalizeHexAccent,
  type AppearanceDraftSnapshot,
} from "@lib/appearance-draft"
import { pageLifecycle } from "@lib/page-lifecycle"
import { applyPersonalAccent } from "@lib/accent-colors"
import { refreshHAThemeMatch } from "@lib/ha-theme-bridge"
import { HA_THEME_MATCH_KEY } from "@lib/ha-theme-palette"
import { showToast } from "@lib/toast"
import { isThemeMode } from "@lib/theme-mode"
import { applyTheme, readAppearanceValue, readStoredThemeMode, setTheme } from "@lib/theme-watcher"
import { readWorkspacePreferences, saveWorkspacePreferences } from "@lib/workspace-preferences"
import { attachShortcutTooltips } from "@lib/shortcut-tooltip"
import { SINGLE_KEY_SHORTCUTS_STORAGE_KEY, setSingleKeyShortcuts, singleKeyShortcutsEnabled } from "@lib/single-key-shortcuts"
import { settingsStore } from "@lib/settings-store"
import { saveSetting, showSettingsSaveError, sanitizeCSS, MAX_THEME_SIZE, log } from "@lib/settings-utils"

const ACCENT_KEY = "meitheal-accent-color"

let syncCommittedTheme: ((mode: string) => void) | null = null

function showCustomThemeSection(show: boolean): void {
  const section = document.getElementById("custom-theme-section")
  if (section) section.style.display = show ? "block" : "none"
}

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

function matchesHaPalette(): boolean {
  const match = document.documentElement.dataset.haMatch
  return match === "light" || match === "dark"
}

function readStoredAppearanceMap(): Record<string, string> {
  const root = document.documentElement
  let stored: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}")
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>
  } catch { /* fallback to active root attributes */ }
  return Object.fromEntries(
    Object.entries(APPEARANCE_PREFERENCES).map(([name, pref]) => {
      const fromStore = typeof stored[name] === "string" && pref.options.includes(stored[name] as string)
        ? (stored[name] as string)
        : null
      const fromRoot = root.getAttribute(appearanceAttribute(name))
      const resolved = fromStore ?? (fromRoot && pref.options.includes(fromRoot) ? fromRoot : pref.defaultValue)
      return [name, resolved]
    }),
  )
}

function resolveFullAppearance(overrides: Record<string, string>): AppearancePreferences {
  const base = readStoredAppearanceMap()
  return Object.fromEntries(
    Object.entries(APPEARANCE_PREFERENCES).map(([name, pref]) => {
      const val = overrides[name] ?? base[name]
      return [name, typeof val === "string" && pref.options.includes(val) ? val : pref.defaultValue]
    }),
  ) as AppearancePreferences
}

function clearSetupTheme(): Promise<void> {
  if (!readWorkspacePreferences().theme) return Promise.resolve()
  return saveWorkspacePreferences({}, true).then((ok) => {
    if (!ok) throw new Error("The household theme was saved. This browser kept its setup theme.")
  })
}

function bindAppearanceForm(form: HTMLFormElement): void {
  const status = form.querySelector<HTMLElement>("[data-appearance-status]")
  const dirtyBar = form.querySelector<HTMLElement>("[data-appearance-dirty-bar]")
  const dirtyText = form.querySelector<HTMLElement>("[data-appearance-dirty-text]")
  const discardBtn = form.querySelector<HTMLButtonElement>("[data-appearance-discard]")
  const saveBtns = Array.from(form.querySelectorAll<HTMLButtonElement>("[data-appearance-save]"))
  if (!status) return

  const isLookAndFeel = form.dataset.appearanceForm === "look-and-feel"
  const root = document.documentElement

  const fields = Object.entries(APPEARANCE_PREFERENCES).flatMap(([name, preference]) => {
    const select = form.elements.namedItem(name) as HTMLSelectElement | null
    if (!select) return []
    return [{ name, attribute: appearanceAttribute(name), select, ...preference }]
  })
  if (fields.length === 0) return

  const themeSelect = isLookAndFeel ? form.querySelector<HTMLSelectElement>("#theme-select") : null
  const matchHaCheckbox = isLookAndFeel ? form.querySelector<HTMLInputElement>("#match-ha-theme") : null
  const matchHaStatus = isLookAndFeel ? form.querySelector<HTMLElement>("#match-ha-theme-status") : null
  const swatches = isLookAndFeel ? Array.from(form.querySelectorAll<HTMLButtonElement>(".accent-swatch")) : []
  const picker = isLookAndFeel ? form.querySelector<HTMLInputElement>("#accent-color-custom") : null
  const accentReset = isLookAndFeel ? form.querySelector<HTMLButtonElement>("#accent-reset") : null
  const sidebarFieldGroup = form.querySelector<HTMLElement>('[data-appearance-field-group="sidebar"]')
  const sidebarNavbarNote = form.querySelector<HTMLElement>("#appearance-sidebar-navbar-note")

  const readCommitted = (): AppearanceDraftSnapshot => {
    const storedMap = readStoredAppearanceMap()
    const appearance = Object.fromEntries(fields.map((f) => [f.name, storedMap[f.name] ?? f.defaultValue]))
    if (!isLookAndFeel) return { appearance }
    return {
      theme: readStoredThemeMode(),
      matchHaTheme: readAppearanceValue(HA_THEME_MATCH_KEY) === "1",
      accent: normalizeHexAccent(readAppearanceValue(ACCENT_KEY)),
      appearance,
    }
  }

  let committed = readCommitted()
  let draft = cloneAppearanceSnapshot(committed)
  let saving = false

  const syncMatchHaStatus = (): void => {
    if (!matchHaStatus) return
    const state = root.dataset.haMatch
    const msg = matchesHaPalette() ? matchHaStatus.dataset.active : state ? matchHaStatus.dataset[state] : ""
    if (matchHaStatus.textContent !== (msg ?? "")) matchHaStatus.textContent = msg ?? ""
  }

  const syncAccentSelection = (accent: string | null): void => {
    if (!isLookAndFeel) return
    const fallback = matchesHaPalette()
      ? root.style.getPropertyValue("--personal-accent").trim()
      : getComputedStyle(root).getPropertyValue("--palette-accent").trim()
    const activeColor = (accent ?? fallback).toLowerCase()
    for (const swatch of swatches) {
      const selected = swatch.dataset.color?.toLowerCase() === activeColor
      swatch.classList.toggle("active", selected)
      swatch.setAttribute("aria-pressed", String(selected))
    }
    if (picker && /^#[0-9a-f]{6}$/i.test(activeColor)) picker.value = activeColor
  }

  const visualOptions = Array.from(form.querySelectorAll<HTMLButtonElement>("[data-visual-field][data-visual-option]"))

  const syncVisualGroup = (fieldName: string, activeValue: string): void => {
    const groupButtons = visualOptions.filter((btn) => btn.dataset.visualField === fieldName)
    if (!groupButtons.length) return
    const hasMatch = groupButtons.some((btn) => btn.dataset.visualOption === activeValue)
    groupButtons.forEach((btn, index) => {
      const selected = hasMatch ? btn.dataset.visualOption === activeValue : index === 0
      btn.setAttribute("aria-checked", String(selected))
      btn.tabIndex = selected ? 0 : -1
    })
  }

  const syncNavigationState = (snap: AppearanceDraftSnapshot): void => {
    const navMode = snap.appearance.navigation ?? "sidebar"
    const isNavbar = navMode === "navbar"
    sidebarFieldGroup?.classList.toggle("is-inactive", isNavbar)
    if (sidebarNavbarNote) sidebarNavbarNote.hidden = !isNavbar
    const navSummary = document.getElementById("nav-layout-active-summary")
    if (navSummary) {
      const layoutLabel = isNavbar ? "Top navigation" : "Sidebar"
      const toneMap: Record<string, string> = { match: "Match theme", dark: "Dark nav", accent: "Colored nav" }
      const toneLabel = toneMap[snap.appearance.navTone ?? "match"] ?? "Match theme"
      const sidebarMap: Record<string, string> = { remember: "Remember state", expanded: "Expanded", folded: "Folded", hover: "Hover expand" }
      navSummary.textContent = isNavbar
        ? `${layoutLabel} · ${toneLabel} · Tabler overflow`
        : `${layoutLabel} · ${toneLabel} · ${sidebarMap[snap.appearance.sidebar ?? "remember"] ?? "Remember state"}`
    }
  }

  const syncInputsFromSnapshot = (snap: AppearanceDraftSnapshot): void => {
    for (const field of fields) {
      const resolved = snap.appearance[field.name] ?? field.defaultValue
      field.select.value = resolved
      syncVisualGroup(field.name, resolved)
    }
    if (themeSelect && snap.theme) {
      themeSelect.value = snap.theme
      syncVisualGroup("theme", snap.theme)
      showCustomThemeSection(snap.theme === "custom")
    }
    if (matchHaCheckbox && snap.matchHaTheme !== undefined) {
      matchHaCheckbox.checked = snap.matchHaTheme
    }
    syncAccentSelection(snap.accent ?? null)
    syncNavigationState(snap)
  }

  const applySnapshotPreview = (snap: AppearanceDraftSnapshot): void => {
    applyAppearancePreferences(resolveFullAppearance(snap.appearance))
    syncNavigationState(snap)
    if (isLookAndFeel) {
      if (snap.theme && isThemeMode(snap.theme)) {
        // Custom has nothing to preview until CSS is imported, so keep the saved theme.
        const preview = snap.theme === "custom" && !readAppearanceValue("meitheal-custom-theme-css")
          && committed.theme && isThemeMode(committed.theme) ? committed.theme : snap.theme
        applyTheme(preview, preview === "auto")
        showCustomThemeSection(snap.theme === "custom")
      }
      refreshHAThemeMatch({ matchHaTheme: Boolean(snap.matchHaTheme), accent: snap.accent ?? null })
      if (!matchesHaPalette()) applyPersonalAccent(root, snap.accent ?? null)
      syncAccentSelection(snap.accent ?? null)
      syncMatchHaStatus()
    }
  }

  const updateDirtyUi = (): void => {
    const changes = countAppearanceDraftChanges(committed, draft)
    const dirty = changes > 0
    form.dataset.dirty = dirty ? "true" : "false"
    if (dirtyBar) dirtyBar.hidden = !dirty
    if (dirtyText && dirty) {
      dirtyText.textContent = `${changes === 1 ? "1 unsaved change" : `${changes} unsaved changes`} — previewing live. Save to commit.`
    }
  }

  const previewDraft = (): void => {
    status.textContent = ""
    applySnapshotPreview(draft)
    updateDirtyUi()
  }

  // Initial sync
  syncInputsFromSnapshot(committed)
  syncMatchHaStatus()
  updateDirtyUi()

  if (isLookAndFeel) {
    pageLifecycle.on(document, "meitheal:ha-theme-match", syncMatchHaStatus)
    pageLifecycle.on(window, "meitheal:theme-changed", () => syncAccentSelection(draft.accent ?? null))

    syncCommittedTheme = (mode: string) => {
      // Importing or removing custom CSS commits the theme immediately, so an
      // unsaved Custom choice follows it; other unsaved choices stay drafts.
      const follow = !isAppearanceDraftDirty(committed, draft) || draft.theme === "custom"
      committed.theme = mode
      if (follow) {
        draft.theme = mode
        if (themeSelect) themeSelect.value = mode
        syncVisualGroup("theme", mode)
        showCustomThemeSection(mode === "custom")
      }
      updateDirtyUi()
    }
  }

  const selectVisualOption = (fieldName: string, value: string): void => {
    if (fieldName === "theme") {
      draft.theme = value
      if (themeSelect) themeSelect.value = value
      syncVisualGroup("theme", value)
      previewDraft()
      return
    }
    const field = fields.find((f) => f.name === fieldName)
    if (!field) return
    const nextValue = field.options.includes(value) ? value : field.defaultValue
    draft.appearance[field.name] = nextValue
    field.select.value = nextValue
    syncVisualGroup(field.name, nextValue)
    previewDraft()
  }

  // Visual radio card click & ARIA radiogroup arrow-key support
  pageLifecycle.on(form, "click", (event) => {
    const btn = (event.target instanceof Element ? event.target : null)?.closest<HTMLButtonElement>("[data-visual-field][data-visual-option]")
    if (!btn) return
    const fieldName = btn.dataset.visualField
    const value = btn.dataset.visualOption
    if (fieldName && value !== undefined) selectVisualOption(fieldName, value)
  })

  pageLifecycle.on(form, "keydown", (event) => {
    if (!(event instanceof KeyboardEvent)) return
    const btn = (event.target instanceof Element ? event.target : null)?.closest<HTMLButtonElement>("[data-visual-field][data-visual-option]")
    if (!btn) return
    const fieldName = btn.dataset.visualField
    if (!fieldName) return
    const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"]
    if (!keys.includes(event.key)) return
    const groupButtons = visualOptions.filter((candidate) => candidate.dataset.visualField === fieldName)
    const idx = groupButtons.indexOf(btn)
    if (idx === -1 || groupButtons.length < 2) return
    event.preventDefault()
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? groupButtons.length - 1
        : (idx + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + groupButtons.length) % groupButtons.length
    const nextBtn = groupButtons[nextIndex]
    if (nextBtn?.dataset.visualOption !== undefined) {
      selectVisualOption(fieldName, nextBtn.dataset.visualOption)
      nextBtn.focus()
    }
  })

  // Live preview on select/checkbox change
  pageLifecycle.on(form, "change", (event) => {
    const target = event.target
    if (target instanceof HTMLSelectElement) {
      if (target === themeSelect) {
        selectVisualOption("theme", target.value)
        return
      }
      const field = fields.find((f) => f.select === target)
      if (field) selectVisualOption(field.name, target.value)
      return
    }
    if (target === matchHaCheckbox && matchHaCheckbox) {
      draft.matchHaTheme = matchHaCheckbox.checked
      previewDraft()
    }
  })

  // Live preview on accent swatches / custom picker / accent reset
  for (const swatch of swatches) {
    pageLifecycle.on(swatch, "click", () => {
      const hex = normalizeHexAccent(swatch.dataset.color)
      if (!hex) return
      draft.accent = hex
      previewDraft()
    })
  }
  if (picker) {
    pageLifecycle.on(picker, "input", () => {
      const hex = normalizeHexAccent(picker.value)
      if (!hex) return
      draft.accent = hex
      previewDraft()
    })
  }
  if (accentReset) {
    pageLifecycle.on(accentReset, "click", () => {
      draft.accent = null
      previewDraft()
    })
  }

  // Reset previews defaults live so user sees them before committing
  pageLifecycle.on(form, "reset", (event) => {
    event.preventDefault()
    for (const field of fields) draft.appearance[field.name] = field.defaultValue
    if (isLookAndFeel) {
      draft.accent = null
      draft.matchHaTheme = false
    }
    syncInputsFromSnapshot(draft)
    applySnapshotPreview(draft)
    updateDirtyUi()
    status.textContent = isAppearanceDraftDirty(committed, draft)
      ? (status.dataset.reset ?? "Defaults previewed — save to commit.")
      : ""
  })

  // Discard reverts live preview back to committed snapshot
  if (discardBtn) {
    pageLifecycle.on(discardBtn, "click", () => {
      draft = cloneAppearanceSnapshot(committed)
      syncInputsFromSnapshot(committed)
      applySnapshotPreview(committed)
      updateDirtyUi()
      status.textContent = ""
    })
  }

  // Auto-revert uncommitted live previews if user navigates away
  pageLifecycle.signal.addEventListener("abort", () => {
    if (isLookAndFeel) syncCommittedTheme = null
    if (isAppearanceDraftDirty(committed, draft)) applySnapshotPreview(committed)
  }, { once: true })

  // Keep subsequent edits separate from the submitted values.
  pageLifecycle.on(form, "submit", async (event) => {
    event.preventDefault()
    if (saving) return
    const submitted = cloneAppearanceSnapshot(draft)
    saving = true
    for (const btn of saveBtns) {
      btn.disabled = true
      btn.classList.add("btn-loading")
    }
    try {
      const nextStored = resolveFullAppearance(submitted.appearance)
      // 1. Persist Theme (server-backed setting) if changed
      if (isLookAndFeel && submitted.theme && submitted.theme !== committed.theme) {
        if (submitted.theme === "custom" && !readAppearanceValue("meitheal-custom-theme-css")) {
          showToast("Import a CSS file first to use a custom theme.", "error")
          return
        }
        if (isThemeMode(submitted.theme)) {
          await saveSetting("theme", submitted.theme)
          await clearSetupTheme()
          setTheme(submitted.theme)
        }
      }

      // 2. Persist Match HA Theme & Accent to localStorage
      if (isLookAndFeel) {
        if (submitted.matchHaTheme) localStorage.setItem(HA_THEME_MATCH_KEY, "1")
        else localStorage.removeItem(HA_THEME_MATCH_KEY)

        if (submitted.accent) localStorage.setItem(ACCENT_KEY, submitted.accent)
        else localStorage.removeItem(ACCENT_KEY)
      }

      // 3. Persist appearance preferences to localStorage, keeping keys from newer versions
      let previous: Record<string, unknown> = {}
      try {
        const stored: unknown = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}")
        if (stored && typeof stored === "object" && !Array.isArray(stored)) previous = stored as Record<string, unknown>
      } catch { /* A valid save replaces malformed stored preferences. */ }
      localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ ...previous, ...nextStored }))
      committed = submitted
      if (isAppearanceDraftDirty(committed, draft)) {
        applySnapshotPreview(draft)
      } else {
        applyAppearancePreferences(nextStored)
        if (isLookAndFeel) {
          refreshHAThemeMatch()
          if (!matchesHaPalette()) applyPersonalAccent(root, submitted.accent ?? null)
        }
        status.textContent = status.dataset.saved ?? "Saved."
      }
      updateDirtyUi()
      showToast("common.updated")
    } catch (error) {
      if (isAppearanceDraftDirty(submitted, draft)) applySnapshotPreview(draft)
      status.textContent = status.dataset.error ?? ""
      showSettingsSaveError(error)
    } finally {
      saving = false
      for (const btn of saveBtns) {
        btn.disabled = false
        btn.classList.remove("btn-loading")
      }
    }
  })
}

function initAppearanceSettings(): void {
  const forms = new Set<HTMLFormElement>()
  const primary = document.querySelector<HTMLFormElement>("#appearance-preferences-form")
  if (primary) forms.add(primary)
  document.querySelectorAll<HTMLFormElement>("[data-appearance-form]").forEach((form) => forms.add(form))
  forms.forEach((form) => bindAppearanceForm(form))
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

  initAppearanceSettings()

  function bindPreference(id: string, key: string, apply: (value: string) => void | Promise<void>): void {
    const select = document.getElementById(id) as HTMLSelectElement | null
    if (!select) return

    pageLifecycle.on(select, "change", async () => {
      const value = select.value
      select.disabled = true
      select.setAttribute("aria-busy", "true")
      try {
        await saveSetting(key, value)
        await apply(value)
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

  bindPreference("locale-select", "locale", (locale) => {
    localStorage.setItem("meitheal-locale", locale)
    document.cookie = `meitheal-locale=${locale};path=/;max-age=31536000;SameSite=Lax`
    window.dispatchEvent(new CustomEvent("meitheal:locale-changed", { detail: { locale } }))
    window.location.reload()
  })
  bindPreference("timezone-select", "timezone", (value) => localStorage.setItem("meitheal-timezone", value))
  bindPreference("week-start-select", "week_start", (value) => localStorage.setItem("meitheal-week-start", value))
  bindPreference("date-format-select", "date_format", (value) => localStorage.setItem("meitheal-date-format", value))

  const themeSelect = document.getElementById("theme-select") as HTMLSelectElement | null
  const input = document.querySelector<HTMLInputElement>("#custom-theme-input")
  const remove = document.querySelector<HTMLButtonElement>("#custom-theme-delete")
  const filename = document.getElementById("custom-theme-filename")
  if (!input || !remove || !filename || !themeSelect) return

  const saveFile = async (css: string, name: string) => {
    if (themeSelect.disabled) return
    themeSelect.disabled = input.disabled = remove.disabled = true
    try {
      await settingsStore.saveSetting("custom_theme_css", css, name)
      await clearSetupTheme()
      if (!restoreTheme({ theme: css ? "custom" : "dark", custom_theme_css: css, custom_theme_name: name })) {
        showToast("settings.appearance_save_error", "error")
        return
      }
      showToast("common.updated")
      return true
    } catch (error) {
      showSettingsSaveError(error)
    } finally {
      themeSelect.disabled = input.disabled = remove.disabled = false
    }
  }

  pageLifecycle.on(input, "change", async () => {
    const file = input.files?.[0]
    input.value = ""
    if (!file) return
    if (!file.name.toLowerCase().endsWith(".css") || file.size > MAX_THEME_SIZE ||
        (file.type && !file.type.startsWith("text/"))) {
      showToast("Choose a CSS file no larger than 50 KB.", "error")
      return
    }
    try {
      const css = sanitizeCSS(await file.text())
      if (!css.trim()) {
        showToast("The CSS file is empty.", "error")
        return
      }
      await saveFile(css, file.name)
    } catch (error) {
      showSettingsSaveError(error)
    }
  })

  pageLifecycle.on(remove, "click", async () => {
    const { confirmDialog } = await import("@lib/confirm-dialog")
    if (await confirmDialog({ message: "Remove custom theme? The app will switch to Emerald Isle.", variant: "warning" })) {
      if (await saveFile("", "")) themeSelect.focus()
    }
  })

  pageLifecycle.on(filename, "click", (event) => {
    event.preventDefault()
    const css = localStorage.getItem("meitheal-custom-theme-css")
    if (!css) return
    const url = URL.createObjectURL(new Blob([css], { type: "text/css" }))
    const link = document.createElement("a")
    link.href = url
    link.download = filename.textContent || "custom-theme.css"
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  })
}

function restoreTheme(settings: Record<string, unknown>): boolean {
  try {
    const savedTheme = settings.theme ?? readStoredThemeMode()
    const css = document.getElementById("custom-theme-input") && typeof settings.custom_theme_css === "string"
      ? sanitizeCSS(settings.custom_theme_css) : ""
    const hasCSS = Boolean(css.trim())
    if (hasCSS) localStorage.setItem("meitheal-custom-theme-css", css)
    else localStorage.removeItem("meitheal-custom-theme-css")
    const mode = isThemeMode(savedTheme) && (savedTheme !== "custom" || hasCSS)
      ? savedTheme : "dark"
    const selectedMode = readWorkspacePreferences().theme ?? mode
    setTheme(mode)
    syncCommittedTheme?.(selectedMode)
    updateCustomThemeDisplay(hasCSS ? String(settings.custom_theme_name || "custom-theme.css") : null)
    return true
  } catch (e) {
    log.error("Theme restore error", e)
    return false
  }
}

/** Restore theme and regional preferences from loaded settings. */
export function restoreThemeSettings(settings: Record<string, unknown>): void {
  restoreTheme(settings)

  try {
    const localeSelect = document.getElementById("locale-select") as HTMLSelectElement | null
    if (localeSelect) {
      localeSelect.value = settings.locale
        ? String(settings.locale)
        : (localStorage.getItem("meitheal-locale") || "en")
    }
  } catch (e) {
    log.error("Locale restore error", e)
  }

  try {
    const tzEl = document.getElementById("timezone-select") as HTMLSelectElement | null
    if (tzEl) tzEl.value = (settings.timezone as string) || localStorage.getItem("meitheal-timezone") || "Europe/Dublin"

    const wsEl = document.getElementById("week-start-select") as HTMLSelectElement | null
    if (wsEl) wsEl.value = (settings.week_start as string) || localStorage.getItem("meitheal-week-start") || "monday"

    const dfEl = document.getElementById("date-format-select") as HTMLSelectElement | null
    if (dfEl) dfEl.value = (settings.date_format as string) || localStorage.getItem("meitheal-date-format") || "relative"
  } catch (e) {
    log.error("UI settings error", e)
  }
}
