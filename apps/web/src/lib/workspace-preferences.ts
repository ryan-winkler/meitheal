export const WORKSPACE_PREFERENCES_PREFIX = "meitheal-workspace-v1:"
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

export function readWorkspacePreferences(): WorkspacePreferences {
  const { workspaceScope: scope, workspaceFrozen } = document.documentElement.dataset
  if (!scope || workspaceFrozen) return {}
  try {
    return parseWorkspacePreferences(localStorage.getItem(WORKSPACE_PREFERENCES_PREFIX + scope))
  } catch {
    return {}
  }
}

export async function saveWorkspacePreferences(changes: WorkspacePreferences, clearTheme = false): Promise<boolean> {
  const { workspaceScope: scope, workspaceFrozen } = document.documentElement.dataset
  if (!scope || workspaceFrozen) return false
  const key = WORKSPACE_PREFERENCES_PREFIX + scope
  const save = () => {
    if (document.documentElement.dataset.workspaceScope !== scope || document.documentElement.dataset.workspaceFrozen) return false
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
