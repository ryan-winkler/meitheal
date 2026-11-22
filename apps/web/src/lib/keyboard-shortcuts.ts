import {
  formatShortcutKeys,
  SHORTCUT_DEFINITIONS,
  type ShortcutActionId,
  type ShortcutCategory,
} from "@domains/navigation/keyboard-shortcuts"

/**
 * The one list of keyboard shortcuts shown to people. The Help dialog (`?`)
 * and Settings both render from the navigation domain model.
 */
export type KeyboardShortcutScope = "global" | "tasks" | "settings"

export interface KeyboardShortcut {
  id: ShortcutActionId
  category: ShortcutCategory
  /** Keys pressed together, shown as separate keycaps. */
  keys: readonly string[]
  /** i18n key for what the shortcut does. One label per destination. */
  labelKey: string
  /** Optional i18n key for a page where the key does something else. */
  noteKey?: string
  scope: KeyboardShortcutScope
  editable: boolean
}

export interface KeyboardShortcutGroup {
  scope: KeyboardShortcutScope
  headingKey: string
  shortcuts: readonly KeyboardShortcut[]
}

const SCOPE_HEADINGS: Record<KeyboardShortcutScope, string> = {
  global: "settings.shortcut_everywhere",
  tasks: "settings.shortcut_task_views",
  settings: "settings.shortcut_settings_page",
}

export const KEYBOARD_SHORTCUTS: readonly KeyboardShortcut[] = SHORTCUT_DEFINITIONS.map(def => ({
  id: def.id,
  category: def.category,
  keys: formatShortcutKeys(def.defaultCombo),
  labelKey: def.labelKey,
  noteKey: def.noteKey,
  scope: def.category === "navigation" ? "global" : def.category,
  editable: def.editable,
}))

export function keyboardShortcutGroups(
  scopes: readonly KeyboardShortcutScope[] = ["global", "tasks", "settings"],
): KeyboardShortcutGroup[] {
  return scopes.map(scope => ({
    scope,
    headingKey: SCOPE_HEADINGS[scope],
    shortcuts: KEYBOARD_SHORTCUTS.filter(shortcut => shortcut.scope === scope),
  }))
}
