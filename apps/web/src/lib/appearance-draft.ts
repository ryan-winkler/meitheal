/**
 * Pure draft/committed comparison helpers for Look & Feel and Navigation appearance forms.
 * Keeps live preview ("Show me immediately") cleanly separated from committed persistence
 * ("Make sure I save to commit").
 */

export interface AppearanceDraftSnapshot {
  theme?: string
  matchHaTheme?: boolean
  accent?: string | null
  appearance: Record<string, string>
}

export function cloneAppearanceSnapshot(snapshot: AppearanceDraftSnapshot): AppearanceDraftSnapshot {
  return {
    ...(snapshot.theme !== undefined ? { theme: snapshot.theme } : {}),
    ...(snapshot.matchHaTheme !== undefined ? { matchHaTheme: snapshot.matchHaTheme } : {}),
    ...(snapshot.accent !== undefined ? { accent: snapshot.accent } : {}),
    appearance: { ...snapshot.appearance },
  }
}

export function normalizeHexAccent(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim().toLowerCase()
  return /^#[0-9a-f]{6}$/.test(trimmed) ? trimmed : null
}

export function countAppearanceDraftChanges(
  committed: AppearanceDraftSnapshot,
  draft: AppearanceDraftSnapshot,
): number {
  let count = 0
  if (committed.theme !== undefined && draft.theme !== undefined && committed.theme !== draft.theme) {
    count += 1
  }
  if (
    committed.matchHaTheme !== undefined &&
    draft.matchHaTheme !== undefined &&
    committed.matchHaTheme !== draft.matchHaTheme
  ) {
    count += 1
  }
  if (
    committed.accent !== undefined &&
    draft.accent !== undefined &&
    normalizeHexAccent(committed.accent) !== normalizeHexAccent(draft.accent)
  ) {
    count += 1
  }
  const keys = new Set([...Object.keys(committed.appearance), ...Object.keys(draft.appearance)])
  for (const key of keys) {
    if ((committed.appearance[key] ?? "") !== (draft.appearance[key] ?? "")) {
      count += 1
    }
  }
  return count
}

export function isAppearanceDraftDirty(
  committed: AppearanceDraftSnapshot,
  draft: AppearanceDraftSnapshot,
): boolean {
  return countAppearanceDraftChanges(committed, draft) > 0
}
