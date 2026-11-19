export const WORKSPACE_PREFERENCES_PREFIX = "meitheal-workspace-v1:"
export const DASHBOARD_LAYOUT_PREFIX = "meitheal:dashboard-layout:v1:"
export const WORKSPACE_THEMES = ["auto", "light", "dark"] as const
export type WorkspaceTheme = (typeof WORKSPACE_THEMES)[number]

export interface WorkspacePreferences {
  firstPage?: "dashboard" | "tasks"
  capture?: "quick" | "form"
  theme?: WorkspaceTheme
  acknowledged?: true
}

export function isWorkspaceTheme(value: unknown): value is WorkspaceTheme {
  return WORKSPACE_THEMES.some(theme => theme === value)
}

// Also used by Layout's pre-render appearance and ingress bootstrap.
export function parseWorkspacePreferences(raw: string | null): WorkspacePreferences {
  try {
    const value: unknown = JSON.parse(raw ?? "null")
    if (!value || typeof value !== "object") return {}
    const { firstPage, capture, theme, acknowledged } = value as Record<string, unknown>
    return {
      ...(firstPage === "dashboard" || firstPage === "tasks" ? { firstPage } : {}),
      ...(capture === "quick" || capture === "form" ? { capture } : {}),
      ...(theme === "auto" || theme === "light" || theme === "dark" ? { theme } : {}),
      ...(acknowledged === true ? { acknowledged } : {}),
    }
  } catch {
    return {}
  }
}

export function workspaceStorageKey(prefix: string): string | null {
  const { workspaceScope, workspaceFrozen } = document.documentElement.dataset
  return workspaceScope && !workspaceFrozen ? prefix + workspaceScope : null
}

export function readWorkspacePreferences(): WorkspacePreferences {
  const key = workspaceStorageKey(WORKSPACE_PREFERENCES_PREFIX)
  if (!key) return {}
  try {
    return parseWorkspacePreferences(localStorage.getItem(key))
  } catch {
    return {}
  }
}

export async function saveWorkspacePreferences(changes: WorkspacePreferences, clearTheme = false): Promise<boolean> {
  const key = workspaceStorageKey(WORKSPACE_PREFERENCES_PREFIX)
  if (!key) return false
  const save = () => {
    if (workspaceStorageKey(WORKSPACE_PREFERENCES_PREFIX) !== key) return false
    const current = parseWorkspacePreferences(localStorage.getItem(key))
    const next = { ...current, ...changes, acknowledged: changes.acknowledged ?? current.acknowledged }
    if (clearTheme) delete next.theme
    localStorage.setItem(key, JSON.stringify(next))
    return true
  }
  try {
    return navigator.locks ? await navigator.locks.request(key, save) : save()
  } catch {
    return false
  }
}
