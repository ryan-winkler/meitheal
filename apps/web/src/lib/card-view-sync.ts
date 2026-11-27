/**
 * Shared Card View Sync — Propagates Kanban CardCustomizer preferences
 * (field visibility + density) across Dashboard, Today, and Upcoming views.
 *
 * @domain tasks
 * @bounded-context tasks (presentation)
 */

export const CARD_FIELD_PREFS_KEY = "meitheal-kanban-fields-preferences"
export const CARD_DENSITY_KEY = "meitheal-kanban-card-density"
export const SHARED_CARD_FIELDS = [
  "key", "type", "description", "priority", "due-date", "assignee",
  "labels", "rice", "sync", "subtasks", "checklist", "comments", "progress",
] as const
export const VALID_CARD_DENSITIES = ["compact", "comfortable", "spacious"] as const
export type SharedCardDensity = typeof VALID_CARD_DENSITIES[number]

export function readCardFieldPrefs(storage: Pick<Storage, "getItem"> | null = typeof localStorage !== "undefined" ? localStorage : null): Record<string, boolean> {
  try {
    const raw = storage?.getItem(CARD_FIELD_PREFS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === "boolean") out[k] = v
    return out
  } catch { return {} }
}

export function readCardDensity(storage: Pick<Storage, "getItem"> | null = typeof localStorage !== "undefined" ? localStorage : null): SharedCardDensity {
  try {
    const raw = storage?.getItem(CARD_DENSITY_KEY)
    if (raw && (VALID_CARD_DENSITIES as readonly string[]).includes(raw)) return raw as SharedCardDensity
  } catch { /* ignore */ }
  return "comfortable"
}

export function applyCardPreferencesToRoot(root: HTMLElement | null): void {
  if (!root) return
  const prefs = readCardFieldPrefs()
  for (const f of SHARED_CARD_FIELDS) root.classList.toggle(`hide-field-${f}`, prefs[f] === false)
  const density = readCardDensity()
  for (const d of VALID_CARD_DENSITIES) root.classList.toggle(`density-${d}`, d === density)
}

export function bindCardPreferencesSync(root: HTMLElement | null, signal: AbortSignal): void {
  if (!root) return
  applyCardPreferencesToRoot(root)
  window.addEventListener("storage", e => {
    if (e.key === null || e.key === CARD_FIELD_PREFS_KEY || e.key === CARD_DENSITY_KEY) applyCardPreferencesToRoot(root)
  }, { signal })
  document.addEventListener("meitheal:card-fields-change", () => applyCardPreferencesToRoot(root), { signal })
}
