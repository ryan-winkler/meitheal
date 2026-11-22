/**
 * Editable keyboard shortcuts controller (Super Productivity–inspired UX).
 * Captures key chords, detects conflicts live, persists to /api/settings +
 * localStorage, and notifies the app immediately without reload.
 *
 * @domain navigation
 */
import {
  comboFromKeyboardEvent,
  findShortcutConflicts,
  KEYBOARD_SHORTCUTS_CHANGED_EVENT,
  KEYBOARD_SHORTCUTS_SETTING_KEY,
  readCustomShortcuts,
  resolveShortcuts,
  sanitizeShortcutOverrides,
  saveCustomShortcutsLocal,
  SHORTCUT_DEFINITIONS,
  type ShortcutActionId,
} from "@domains/navigation/keyboard-shortcuts"
import { pageLifecycle } from "@lib/page-lifecycle"
import { saveSetting, showSettingsSaveError } from "@lib/settings-utils"
import { showToast } from "@lib/toast"

const DEF_BY_ID = new Map(SHORTCUT_DEFINITIONS.map(def => [def.id, def]))

let currentOverrides: Record<string, string> = {}
let renderEditor: (() => void) | null = null

function notifyAppShortcutsChanged(): void {
  window.dispatchEvent(new Event(KEYBOARD_SHORTCUTS_CHANGED_EVENT))
}

function displayCombo(combo: string): string {
  return combo ? combo.replace(/\bCtrl\b/g, "Ctrl/Cmd") : ""
}

export function initShortcutsSettings(): void {
  const root = document.getElementById("shortcuts-editor-root")
  if (!root) return

  const statusEl = document.getElementById("shortcuts-save-status")
  const summaryMeta = document.getElementById("shortcuts-summary-meta")
  const resetAllBtn = document.getElementById("shortcuts-reset-all") as HTMLButtonElement | null
  const fields = Array.from(root.querySelectorAll<HTMLElement>("[data-shortcut-field]"))
  if (!fields.length) return

  currentOverrides = readCustomShortcuts()
  let activeInput: HTMLInputElement | null = null

  const stopRecording = () => {
    if (activeInput) {
      activeInput.classList.remove("is-recording")
      activeInput.placeholder = "None — click to set"
      activeInput = null
    }
    document.documentElement.removeAttribute("data-shortcut-recording")
  }

  const labelFor = (id: ShortcutActionId): string => {
    const field = root.querySelector<HTMLElement>(`[data-shortcut-field="${id}"]`)
    return field?.dataset.shortcutLabel || id
  }

  const render = () => {
    const resolved = resolveShortcuts(currentOverrides)
    const conflicts = findShortcutConflicts(resolved)
    let customizedCount = 0

    for (const field of fields) {
      const id = field.dataset.shortcutField as ShortcutActionId | undefined
      if (!id) continue
      const def = DEF_BY_ID.get(id)
      if (!def) continue

      const combo = resolved[id] ?? ""
      const isCustom = def.editable && combo !== def.defaultCombo
      if (isCustom) customizedCount += 1

      const input = field.querySelector<HTMLInputElement>("[data-shortcut-input]")
      const clearBtn = field.querySelector<HTMLButtonElement>("[data-shortcut-clear]")
      const resetBtn = field.querySelector<HTMLButtonElement>("[data-shortcut-reset]")
      const conflictEl = field.querySelector<HTMLElement>("[data-shortcut-conflict]")

      if (input && input !== activeInput) {
        input.value = displayCombo(combo)
      }
      if (clearBtn) clearBtn.hidden = !combo
      if (resetBtn) resetBtn.hidden = !isCustom

      const dupes = conflicts.get(id)
      field.classList.toggle("has-conflict", Boolean(dupes?.length))
      field.classList.toggle("is-custom", isCustom)
      if (conflictEl) {
        if (dupes?.length) {
          conflictEl.textContent = `Conflicts with ${dupes.map(labelFor).join(", ")}`
          conflictEl.hidden = false
        } else {
          conflictEl.textContent = ""
          conflictEl.hidden = true
        }
      }
    }

    if (resetAllBtn) resetAllBtn.disabled = customizedCount === 0
    if (summaryMeta) {
      const total = fields.length
      summaryMeta.textContent = customizedCount > 0
        ? `${total} editable · ${customizedCount} custom`
        : `${total} editable · defaults`
    }
  }

  const persistOverrides = async (next: Record<string, string>, message: string) => {
    const clean = sanitizeShortcutOverrides(next)
    // Strip entries that match the default so only real overrides are persisted
    for (const [id, combo] of Object.entries(clean)) {
      const def = DEF_BY_ID.get(id as ShortcutActionId)
      if (def && def.defaultCombo === combo) delete clean[id]
    }
    const previous = { ...currentOverrides }
    currentOverrides = clean
    saveCustomShortcutsLocal(clean)
    notifyAppShortcutsChanged()
    render()

    if (statusEl) statusEl.textContent = "Saving…"
    try {
      await saveSetting(KEYBOARD_SHORTCUTS_SETTING_KEY, clean)
      if (statusEl) statusEl.textContent = message
    } catch (error) {
      currentOverrides = previous
      saveCustomShortcutsLocal(previous)
      notifyAppShortcutsChanged()
      render()
      if (statusEl) statusEl.textContent = "Could not save shortcuts."
      showSettingsSaveError(error)
    }
  }

  for (const field of fields) {
    const id = field.dataset.shortcutField as ShortcutActionId | undefined
    const def = id ? DEF_BY_ID.get(id) : undefined
    if (!id || !def || !def.editable) continue

    const input = field.querySelector<HTMLInputElement>("[data-shortcut-input]")
    const clearBtn = field.querySelector<HTMLButtonElement>("[data-shortcut-clear]")
    const resetBtn = field.querySelector<HTMLButtonElement>("[data-shortcut-reset]")

    if (input) {
      pageLifecycle.on(input, "focus", () => {
        stopRecording()
        activeInput = input
        input.classList.add("is-recording")
        input.value = ""
        input.placeholder = "Press keys…"
        document.documentElement.setAttribute("data-shortcut-recording", "")
      })

      pageLifecycle.on(input, "blur", () => {
        if (activeInput === input) {
          stopRecording()
          render()
        }
      })

      pageLifecycle.on(input, "keydown", (event) => {
        const keyEvent = event as KeyboardEvent
        if (keyEvent.key === "Tab") return
        keyEvent.preventDefault()
        keyEvent.stopPropagation()

        if (keyEvent.key === "Escape") {
          stopRecording()
          render()
          input.blur()
          return
        }
        if (keyEvent.key === "Backspace" || keyEvent.key === "Delete") {
          stopRecording()
          input.blur()
          void persistOverrides({ ...currentOverrides, [id]: "" }, `Cleared shortcut for ${labelFor(id)}.`)
          return
        }
        const combo = comboFromKeyboardEvent(keyEvent)
        if (!combo) return // Wait for non-modifier key

        stopRecording()
        input.blur()
        void persistOverrides({ ...currentOverrides, [id]: combo }, `Updated ${labelFor(id)} to ${displayCombo(combo)}.`)
      })
    }

    if (clearBtn) {
      pageLifecycle.on(clearBtn, "click", () => {
        stopRecording()
        void persistOverrides({ ...currentOverrides, [id]: "" }, `Cleared shortcut for ${labelFor(id)}.`)
      })
    }

    if (resetBtn) {
      pageLifecycle.on(resetBtn, "click", () => {
        stopRecording()
        const next = { ...currentOverrides }
        delete next[id]
        void persistOverrides(next, `Reset ${labelFor(id)} to default (${displayCombo(def.defaultCombo)}).`)
      })
    }
  }

  if (resetAllBtn) {
    pageLifecycle.on(resetAllBtn, "click", () => {
      stopRecording()
      void persistOverrides({}, "All keyboard shortcuts reset to defaults.")
      showToast("common.updated")
    })
  }

  pageLifecycle.signal.addEventListener("abort", () => {
    stopRecording()
    renderEditor = null
  }, { once: true })

  renderEditor = render
  render()
}

export function restoreShortcutsSettings(settings: Record<string, unknown>): void {
  if (Object.hasOwn(settings, KEYBOARD_SHORTCUTS_SETTING_KEY)) {
    const serverClean = sanitizeShortcutOverrides(settings[KEYBOARD_SHORTCUTS_SETTING_KEY])
    currentOverrides = serverClean
    saveCustomShortcutsLocal(serverClean)
    notifyAppShortcutsChanged()
  }
  renderEditor?.()
}
