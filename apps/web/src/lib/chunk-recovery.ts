/**
 * Stale dynamic-import chunk recovery helper.
 *
 * Detects stale Vite/Astro module preload failures (for example after a dev
 * optimizeDeps refresh or production deploy) and triggers at most one reload
 * within a cooldown window so the page recovers without entering a loop.
 */

const RELOAD_STORAGE_KEY = "meitheal:chunk-reload-ts"
const DEFAULT_COOLDOWN_MS = 15_000

const STALE_CHUNK_PATTERNS = [
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /error loading dynamically imported module/i,
  /Unable to preload CSS/i,
  /Outdated Optimize Dep/i,
]

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function extractErrorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  if (typeof reason === "string") return reason
  if (reason && typeof reason === "object" && "message" in reason && typeof reason.message === "string") {
    return reason.message
  }
  return ""
}

export function isStaleChunkError(reason: unknown): boolean {
  const message = extractErrorMessage(reason)
  if (!message) return false
  return STALE_CHUNK_PATTERNS.some((pattern) => pattern.test(message))
}

export function attemptStaleChunkReload(
  storage: StorageLike | null | undefined,
  nowMs: number,
  reload: () => void,
  cooldownMs: number = DEFAULT_COOLDOWN_MS,
): boolean {
  try {
    const rawLast = storage?.getItem(RELOAD_STORAGE_KEY)
    const lastAttempt = rawLast ? Number(rawLast) : Number.NaN
    if (Number.isFinite(lastAttempt) && nowMs - lastAttempt >= 0 && nowMs - lastAttempt < cooldownMs) {
      return false
    }
    storage?.setItem(RELOAD_STORAGE_KEY, String(nowMs))
  } catch {
    // Private browsing or blocked storage — avoid risking an infinite reload loop
    return false
  }
  reload()
  return true
}
