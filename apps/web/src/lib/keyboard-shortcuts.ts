import { TASK_VIEWS } from "./task-view-route"

/**
 * The one list of keyboard shortcuts shown to people. The Help dialog (`?`)
 * and Settings both render from it, so add a key here when a handler ships.
 */
export type KeyboardShortcutScope = "global" | "tasks" | "settings"

export interface KeyboardShortcut {
  /** Keys pressed together, shown as separate keycaps. */
  keys: readonly string[]
  /** i18n key for what the shortcut does. One label per destination. */
  labelKey: string
  /** Optional i18n key for a page where the key does something else. */
  noteKey?: string
  scope: KeyboardShortcutScope
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

export const KEYBOARD_SHORTCUTS: readonly KeyboardShortcut[] = [
  { keys: ["/"], labelKey: "settings.shortcut_search", scope: "global" },
  { keys: ["n"], labelKey: "settings.shortcut_new_task", scope: "global" },
  { keys: ["d"], labelKey: "settings.shortcut_dashboard", scope: "global" },
  { keys: ["k"], labelKey: "settings.shortcut_kanban", noteKey: "settings.shortcut_kanban_note", scope: "global" },
  { keys: ["t"], labelKey: "settings.shortcut_table", scope: "global" },
  { keys: ["y"], labelKey: "settings.shortcut_today", scope: "global" },
  { keys: ["u"], labelKey: "settings.shortcut_upcoming", scope: "global" },
  { keys: ["c"], labelKey: "settings.shortcut_calendar", scope: "global" },
  { keys: ["Ctrl", "K"], labelKey: "settings.shortcut_cmd_palette", scope: "global" },
  { keys: ["Ctrl", "B"], labelKey: "settings.shortcut_toggle_sidebar", scope: "global" },
  { keys: ["?"], labelKey: "settings.shortcut_help", scope: "global" },
  { keys: ["Esc"], labelKey: "settings.shortcut_close", scope: "global" },
  ...TASK_VIEWS.map((view, index): KeyboardShortcut => ({
    keys: [String(index + 1)],
    labelKey: `settings.shortcut_${view}`,
    scope: "tasks",
  })),
  { keys: ["Home"], labelKey: "settings.scroll_to_top", scope: "settings" },
]

export function keyboardShortcutGroups(
  scopes: readonly KeyboardShortcutScope[] = ["global", "tasks", "settings"],
): KeyboardShortcutGroup[] {
  return scopes.map(scope => ({
    scope,
    headingKey: SCOPE_HEADINGS[scope],
    shortcuts: KEYBOARD_SHORTCUTS.filter(shortcut => shortcut.scope === scope),
  }))
}
