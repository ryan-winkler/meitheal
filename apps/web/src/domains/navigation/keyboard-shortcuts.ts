/**
 * Keyboard shortcuts domain model: canonical actions, normalization,
 * event matching, conflict detection, and safe persistence sanitization.
 *
 * @domain navigation
 */

export type ShortcutCategory = "global" | "navigation" | "tasks" | "settings"

export type ShortcutActionId =
  | "search"
  | "commandPalette"
  | "newTask"
  | "toggleSidebar"
  | "showHelp"
  | "closeOverlay"
  | "goDashboard"
  | "goToday"
  | "goUpcoming"
  | "goKanban"
  | "goTable"
  | "goCalendar"
  | "taskView1"
  | "taskView2"
  | "taskView3"
  | "taskView4"
  | "scrollTop"

export interface ShortcutDefinition {
  id: ShortcutActionId
  category: ShortcutCategory
  defaultCombo: string
  labelKey: string
  noteKey?: string
  editable: boolean
}

export const KEYBOARD_SHORTCUTS_STORAGE_KEY = "meitheal-keyboard-shortcuts"
export const KEYBOARD_SHORTCUTS_SETTING_KEY = "keyboard_shortcuts"
export const KEYBOARD_SHORTCUTS_CHANGED_EVENT = "meitheal:shortcuts-changed"

export const SHORTCUT_DEFINITIONS: readonly ShortcutDefinition[] = [
  // Global (application-wide)
  { id: "search", category: "global", defaultCombo: "/", labelKey: "settings.shortcut_search", editable: true },
  { id: "commandPalette", category: "global", defaultCombo: "Ctrl+K", labelKey: "settings.shortcut_cmd_palette", editable: true },
  { id: "newTask", category: "global", defaultCombo: "N", labelKey: "settings.shortcut_new_task", noteKey: "settings.shortcut_new_task_note", editable: true },
  { id: "toggleSidebar", category: "global", defaultCombo: "Ctrl+B", labelKey: "settings.shortcut_toggle_sidebar", noteKey: "settings.shortcut_toggle_sidebar_note", editable: true },
  { id: "showHelp", category: "global", defaultCombo: "?", labelKey: "settings.shortcut_help", editable: true },
  { id: "closeOverlay", category: "global", defaultCombo: "Esc", labelKey: "settings.shortcut_close", editable: false },

  // Navigation
  { id: "goDashboard", category: "navigation", defaultCombo: "D", labelKey: "settings.shortcut_dashboard", editable: true },
  { id: "goToday", category: "navigation", defaultCombo: "Y", labelKey: "settings.shortcut_today", editable: true },
  { id: "goUpcoming", category: "navigation", defaultCombo: "U", labelKey: "settings.shortcut_upcoming", editable: true },
  { id: "goKanban", category: "navigation", defaultCombo: "K", labelKey: "settings.shortcut_kanban", noteKey: "settings.shortcut_kanban_note", editable: true },
  { id: "goTable", category: "navigation", defaultCombo: "T", labelKey: "settings.shortcut_table", editable: true },
  { id: "goCalendar", category: "navigation", defaultCombo: "C", labelKey: "settings.shortcut_calendar", noteKey: "settings.shortcut_calendar_note", editable: true },

  // Tasks page views
  { id: "taskView1", category: "tasks", defaultCombo: "1", labelKey: "settings.shortcut_kanban", editable: true },
  { id: "taskView2", category: "tasks", defaultCombo: "2", labelKey: "settings.shortcut_table", editable: true },
  { id: "taskView3", category: "tasks", defaultCombo: "3", labelKey: "settings.shortcut_calendar", editable: true },
  { id: "taskView4", category: "tasks", defaultCombo: "4", labelKey: "settings.shortcut_timeline", editable: true },

  // Settings page
  { id: "scrollTop", category: "settings", defaultCombo: "Home", labelKey: "settings.scroll_to_top", editable: false },
]

const EDITABLE_IDS = new Set<string>(
  SHORTCUT_DEFINITIONS.filter(def => def.editable).map(def => def.id),
)

const BLOCKED_KEYS = new Set([
  "escape", "esc", "tab", "enter", " ", "space", "spacebar",
  "control", "ctrl", "shift", "alt", "meta", "cmd", "command",
  "capslock", "numlock", "scrolllock", "dead", "unidentified", "process",
  "backspace", "delete",
])

const SPECIAL_KEY_NAMES: Record<string, string> = {
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  insert: "Insert",
}

const SHIFTED_SYMBOLS = new Set(["?", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+", "{", "}", "|", ":", "\"", "<", ">", "~"])

function normalizeKeyToken(raw: string): string | null {
  const token = raw.trim()
  if (!token || token.length > 20) return null
  const lower = token.toLowerCase()
  if (BLOCKED_KEYS.has(lower)) return null
  if (/^f([1-9]|1[0-2])$/.test(lower)) return lower.toUpperCase()
  if (SPECIAL_KEY_NAMES[lower]) return SPECIAL_KEY_NAMES[lower]
  if (token.length === 1 && !/\s/.test(token)) {
    return /^[a-z]$/i.test(token) ? token.toUpperCase() : token
  }
  return null
}

/**
 * Canonicalizes a shortcut combo (e.g. "cmd+shift+k" -> "Ctrl+Shift+K", "n" -> "N").
 * Returns null if invalid or blocked.
 */
export function normalizeShortcutCombo(input: string): string | null {
  if (typeof input !== "string") return null
  const trimmed = input.trim()
  if (!trimmed || trimmed.length > 40) return null
  if (trimmed === "+") return "+"

  const parts = trimmed.split("+").map(p => p.trim()).filter(Boolean)
  if (parts.length === 0 || parts.length > 4) return null

  let ctrl = false
  let alt = false
  let shift = false
  let mainKey: string | null = null

  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === "ctrl" || lower === "control" || lower === "cmd" || lower === "command" || lower === "meta" || lower === "ctrl/cmd") {
      ctrl = true
    } else if (lower === "alt" || lower === "option") {
      alt = true
    } else if (lower === "shift") {
      shift = true
    } else {
      if (mainKey !== null) return null
      mainKey = normalizeKeyToken(part)
      if (!mainKey) return null
    }
  }

  if (!mainKey) return null
  // Shifted punctuation like "?" already encodes Shift; keep canonical "?" unless Ctrl/Alt also pressed.
  if (shift && !ctrl && !alt && SHIFTED_SYMBOLS.has(mainKey)) shift = false

  const mods: string[] = []
  if (ctrl) mods.push("Ctrl")
  if (alt) mods.push("Alt")
  if (shift) mods.push("Shift")
  return mods.length ? `${mods.join("+")}+${mainKey}` : mainKey
}

export interface KeyEventLike {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  isComposing?: boolean
  repeat?: boolean
}

export function comboFromKeyboardEvent(event: KeyEventLike): string | null {
  if (event.isComposing || !event.key) return null
  const mainKey = normalizeKeyToken(event.key)
  if (!mainKey) return null

  const ctrl = Boolean(event.ctrlKey || event.metaKey)
  const alt = Boolean(event.altKey)
  let shift = Boolean(event.shiftKey)

  if (shift && !ctrl && !alt && SHIFTED_SYMBOLS.has(mainKey)) {
    shift = false
  }

  const mods: string[] = []
  if (ctrl) mods.push("Ctrl")
  if (alt) mods.push("Alt")
  if (shift) mods.push("Shift")
  return mods.length ? `${mods.join("+")}+${mainKey}` : mainKey
}

export function isSingleKeyCombo(combo: string): boolean {
  return Boolean(combo) && !combo.includes("+")
}

export function matchesShortcutEvent(
  event: KeyEventLike,
  combo: string | null | undefined,
  singleKeyEnabled: boolean,
): boolean {
  if (!combo || event.isComposing) return false
  if (isSingleKeyCombo(combo) && !singleKeyEnabled) return false
  const pressed = comboFromKeyboardEvent(event)
  if (!pressed) return false
  if (pressed === combo) return true
  // Preserve historical Shift+N opening New Task only when default single-letter N is kept
  if (combo === "N" && pressed === "Shift+N") return true
  return false
}

export function formatShortcutKeys(combo: string | null | undefined): string[] {
  if (!combo) return []
  if (combo === "+") return ["+"]
  return combo.split("+").map(token => (token === "Ctrl" ? "Ctrl/Cmd" : token))
}

export function sanitizeShortcutOverrides(raw: unknown): Record<string, string> {
  const clean: Record<string, string> = {}
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return clean
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!EDITABLE_IDS.has(key) || typeof value !== "string") continue
    if (value === "") {
      clean[key] = ""
      continue
    }
    const normalized = normalizeShortcutCombo(value)
    if (normalized) clean[key] = normalized
  }
  return clean
}

export function resolveShortcuts(overrides: Record<string, string>): Record<ShortcutActionId, string> {
  const clean = sanitizeShortcutOverrides(overrides)
  const resolved = {} as Record<ShortcutActionId, string>
  for (const def of SHORTCUT_DEFINITIONS) {
    resolved[def.id] = def.editable && Object.hasOwn(clean, def.id)
      ? clean[def.id]!
      : def.defaultCombo
  }
  return resolved
}

export function findShortcutConflicts(
  resolved: Record<ShortcutActionId, string>,
): Map<ShortcutActionId, ShortcutActionId[]> {
  const byCombo = new Map<string, ShortcutActionId[]>()
  for (const def of SHORTCUT_DEFINITIONS) {
    if (!def.editable) continue
    const combo = resolved[def.id]
    if (!combo) continue
    const list = byCombo.get(combo) ?? []
    list.push(def.id)
    byCombo.set(combo, list)
  }
  const conflicts = new Map<ShortcutActionId, ShortcutActionId[]>()
  for (const ids of byCombo.values()) {
    if (ids.length < 2) continue
    for (const id of ids) {
      conflicts.set(id, ids.filter(other => other !== id))
    }
  }
  return conflicts
}

export function readCustomShortcuts(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEYBOARD_SHORTCUTS_STORAGE_KEY)
    if (!raw) return {}
    return sanitizeShortcutOverrides(JSON.parse(raw))
  } catch {
    return {}
  }
}

export function readResolvedShortcuts(): Record<ShortcutActionId, string> {
  return resolveShortcuts(readCustomShortcuts())
}

export function saveCustomShortcutsLocal(overrides: Record<string, string>): Record<string, string> {
  const clean = sanitizeShortcutOverrides(overrides)
  try {
    if (Object.keys(clean).length === 0) localStorage.removeItem(KEYBOARD_SHORTCUTS_STORAGE_KEY)
    else localStorage.setItem(KEYBOARD_SHORTCUTS_STORAGE_KEY, JSON.stringify(clean))
  } catch { /* storage unavailable */ }
  return clean
}
