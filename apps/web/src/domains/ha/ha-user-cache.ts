/**
 * Local Home Assistant User Cache (Memory + SQLite)
 *
 * Caches verified Home Assistant Core user identities, display names, and roles
 * so Meitheal stays fast (zero per-request WebSocket churn) and resilient when
 * Home Assistant Core or Supervisor is temporarily slow, restarting, or offline.
 *
 * Security invariants:
 * - Keyed by SHA-256 fingerprint of SUPERVISOR_TOKEN so switching HA instances
 *   never leaks cached roles or names.
 * - Explicit revocations from HA Core (is_active: false, system_generated: true,
 *   or user removed from Core list) are persisted immediately and NEVER bypassed
 *   by stale cache fallback.
 * - Fallback to SQLite cache or trusted Supervisor ingress headers ONLY activates
 *   when HA Core is unreachable ("unavailable"), never when Core denies access.
 *
 * @domain ha
 * @bounded-context users
 */
import { createHash } from "node:crypto"
import { ensureSchema, getPersistenceClient } from "@domains/tasks"

export type CachedHARole = "admin" | "member"

export interface CachedHAUser {
  userId: string
  displayName: string | null
  username: string | null
  role: CachedHARole
  isOwner: boolean
  isActive: boolean
  sourceFingerprint: string
  verifiedAt: number
  updatedAt: number
}

export interface RawCoreUserRecord {
  id: string
  name?: unknown
  username?: unknown
  is_active: boolean
  is_owner: boolean
  system_generated: boolean
  group_ids: string[]
}

const MEMORY_FRESH_TTL_MS = 60_000
const OUTAGE_FALLBACK_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days for homelab outages
const RAW_HA_HEX_ID_RE = /^[a-f0-9]{32}$/i

interface MemoryCacheState {
  fingerprint: string
  users: Map<string, CachedHAUser>
  freshUntil: number
  loadedFromDb: boolean
}

let memoryState: MemoryCacheState | undefined
let schemaReady = false
let schemaPromise: Promise<void> | undefined

/** Return true when a value looks like a raw 32-character hex Home Assistant user ID. */
export function isRawHAUserId(value: string | null | undefined): boolean {
  return typeof value === "string" && RAW_HA_HEX_ID_RE.test(value.trim())
}

/** Fingerprint the active Supervisor token without retaining raw secrets. */
export function currentSupervisorFingerprint(token = process.env.SUPERVISOR_TOKEN): string | null {
  if (!token) return null
  return createHash("sha256").update(token).digest("hex")
}

/** Sanitize display names from HA headers or Core responses. */
export function sanitizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null
  const stripped = value
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, 128)
  return stripped || null
}

/** Reset in-memory cache state (primarily for unit tests). */
export function resetHAUserCacheForTests(): void {
  memoryState = undefined
  schemaReady = false
  schemaPromise = undefined
}

export async function ensureHAUserCacheSchema(): Promise<void> {
  if (schemaReady) return
  schemaPromise ??= (async () => {
    await ensureSchema()
    const db = getPersistenceClient()
    await db.execute({
      sql: `CREATE TABLE IF NOT EXISTS ha_user_cache (
        user_id TEXT PRIMARY KEY,
        display_name TEXT,
        username TEXT,
        role TEXT NOT NULL DEFAULT 'member',
        is_owner INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        source_fingerprint TEXT NOT NULL,
        verified_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      args: [],
    })
    await db.execute({
      sql: `CREATE INDEX IF NOT EXISTS idx_ha_user_cache_fp ON ha_user_cache(source_fingerprint)`,
      args: [],
    })
    schemaReady = true
  })().finally(() => {
    schemaPromise = undefined
  })
  return schemaPromise
}

function getOrCreateMemoryState(fingerprint: string): MemoryCacheState {
  if (!memoryState || memoryState.fingerprint !== fingerprint) {
    memoryState = {
      fingerprint,
      users: new Map(),
      freshUntil: 0,
      loadedFromDb: false,
    }
  }
  return memoryState
}

async function hydrateMemoryFromSqlite(fingerprint: string): Promise<MemoryCacheState> {
  const state = getOrCreateMemoryState(fingerprint)
  if (state.loadedFromDb) return state
  try {
    await ensureHAUserCacheSchema()
    const db = getPersistenceClient()
    const result = await db.execute({
      sql: `SELECT user_id, display_name, username, role, is_owner, is_active, source_fingerprint, verified_at, updated_at
            FROM ha_user_cache
            WHERE source_fingerprint = ?`,
      args: [fingerprint],
    })
    for (const row of result.rows) {
      const userId = String(row.user_id ?? "")
      if (!userId) continue
      const existing = state.users.get(userId)
      const updatedAt = Number(row.updated_at ?? 0)
      if (existing && existing.updatedAt >= updatedAt) continue
      state.users.set(userId, {
        userId,
        displayName: typeof row.display_name === "string" && row.display_name ? row.display_name : null,
        username: typeof row.username === "string" && row.username ? row.username : null,
        role: row.role === "admin" ? "admin" : "member",
        isOwner: Boolean(row.is_owner),
        isActive: Boolean(row.is_active),
        sourceFingerprint: fingerprint,
        verifiedAt: Number(row.verified_at ?? 0),
        updatedAt,
      })
    }
    state.loadedFromDb = true
  } catch {
    /* Non-fatal if DB is temporarily unavailable during bootstrap */
  }
  return state
}

/**
 * Persist a full authoritative user list from Home Assistant Core (`config/auth/list`).
 * Users missing from the authoritative list or marked inactive/system are deactivated immediately.
 */
export async function syncHAUserCacheFromCore(
  rawUsers: unknown,
  fingerprint: string,
  now = Date.now(),
): Promise<boolean> {
  if (!Array.isArray(rawUsers) || !fingerprint) return false
  const parsed: CachedHAUser[] = []
  const seenIds = new Set<string>()

  for (const item of rawUsers) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false
    const u = item as Record<string, unknown>
    if (
      typeof u.id !== "string" || !u.id.trim()
      || typeof u.is_active !== "boolean"
      || typeof u.system_generated !== "boolean"
      || typeof u.is_owner !== "boolean"
      || !Array.isArray(u.group_ids)
      || !u.group_ids.every(g => typeof g === "string")
    ) {
      return false
    }
    if (seenIds.has(u.id)) return false
    seenIds.add(u.id)

    const isActive = u.is_active && !u.system_generated
    const role: CachedHARole = u.is_owner || (u.group_ids as string[]).includes("system-admin") ? "admin" : "member"
    parsed.push({
      userId: u.id,
      displayName: sanitizeDisplayName(u.name),
      username: sanitizeDisplayName(u.username),
      role,
      isOwner: u.is_owner,
      isActive,
      sourceFingerprint: fingerprint,
      verifiedAt: now,
      updatedAt: now,
    })
  }

  const state = getOrCreateMemoryState(fingerprint)
  // Mark previously known users not present in Core's authoritative list as inactive
  for (const [existingId, existing] of state.users) {
    if (!seenIds.has(existingId)) {
      state.users.set(existingId, { ...existing, isActive: false, updatedAt: now })
    }
  }
  for (const entry of parsed) {
    const prev = state.users.get(entry.userId)
    state.users.set(entry.userId, {
      ...entry,
      displayName: entry.displayName ?? prev?.displayName ?? null,
      username: entry.username ?? prev?.username ?? null,
    })
  }
  state.freshUntil = now + MEMORY_FRESH_TTL_MS
  state.loadedFromDb = true

  // Persist asynchronously-safe to SQLite
  try {
    await ensureHAUserCacheSchema()
    const db = getPersistenceClient()
    // Deactivate any cached rows for this fingerprint that disappeared from Core
    const existingRows = await db.execute({
      sql: `SELECT user_id FROM ha_user_cache WHERE source_fingerprint = ? AND is_active = 1`,
      args: [fingerprint],
    })
    for (const row of existingRows.rows) {
      const uid = String(row.user_id ?? "")
      if (uid && !seenIds.has(uid)) {
        await db.execute({
          sql: `UPDATE ha_user_cache SET is_active = 0, updated_at = ? WHERE user_id = ? AND source_fingerprint = ?`,
          args: [now, uid, fingerprint],
        })
      }
    }
    for (const entry of parsed) {
      await db.execute({
        sql: `INSERT INTO ha_user_cache (user_id, display_name, username, role, is_owner, is_active, source_fingerprint, verified_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET
                display_name = COALESCE(excluded.display_name, ha_user_cache.display_name),
                username = COALESCE(excluded.username, ha_user_cache.username),
                role = excluded.role,
                is_owner = excluded.is_owner,
                is_active = excluded.is_active,
                source_fingerprint = excluded.source_fingerprint,
                verified_at = excluded.verified_at,
                updated_at = excluded.updated_at`,
        args: [
          entry.userId,
          entry.displayName,
          entry.username,
          entry.role,
          entry.isOwner ? 1 : 0,
          entry.isActive ? 1 : 0,
          entry.sourceFingerprint,
          entry.verifiedAt,
          entry.updatedAt,
        ],
      })
    }
  } catch {
    /* Keep in-memory cache even if SQLite write fails temporarily */
  }
  return true
}

/**
 * Bootstrap or enrich a user from verified Supervisor ingress headers.
 * Never revives a user explicitly marked inactive by Core.
 */
export async function cacheTrustedIngressUser(input: {
  userId: string
  displayName?: string | null
  username?: string | null
  isAdmin: boolean
  fingerprint: string
  now?: number
}): Promise<CachedHAUser | null> {
  const now = input.now ?? Date.now()
  const state = await hydrateMemoryFromSqlite(input.fingerprint)
  const existing = state.users.get(input.userId)

  // Never override an explicit Core revocation
  if (existing && !existing.isActive) return null

  const cleanDisplay = sanitizeDisplayName(input.displayName)
  const cleanUser = sanitizeDisplayName(input.username)
  const next: CachedHAUser = existing
    ? {
        ...existing,
        displayName: cleanDisplay ?? existing.displayName,
        username: cleanUser ?? existing.username,
        updatedAt: now,
      }
    : {
        userId: input.userId,
        displayName: cleanDisplay,
        username: cleanUser,
        role: input.isAdmin ? "admin" : "member",
        isOwner: false,
        isActive: true,
        sourceFingerprint: input.fingerprint,
        verifiedAt: now,
        updatedAt: now,
      }

  state.users.set(input.userId, next)

  try {
    await ensureHAUserCacheSchema()
    const db = getPersistenceClient()
    await db.execute({
      sql: `INSERT INTO ha_user_cache (user_id, display_name, username, role, is_owner, is_active, source_fingerprint, verified_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
              display_name = COALESCE(excluded.display_name, ha_user_cache.display_name),
              username = COALESCE(excluded.username, ha_user_cache.username),
              updated_at = excluded.updated_at
            WHERE ha_user_cache.is_active = 1`,
      args: [
        next.userId,
        next.displayName,
        next.username,
        next.role,
        next.isOwner ? 1 : 0,
        next.sourceFingerprint,
        next.verifiedAt,
        next.updatedAt,
      ],
    })
  } catch {
    /* Non-fatal */
  }
  return next
}

/** Fast synchronous memory lookup when cache is fresh (< 60s). */
export function readFreshCachedHARole(
  userId: string,
  fingerprint: string,
  now = Date.now(),
): "admin" | "member" | "denied" | null {
  if (!memoryState || memoryState.fingerprint !== fingerprint) return null
  if (now >= memoryState.freshUntil) return null
  const entry = memoryState.users.get(userId)
  if (!entry) return "denied"
  if (!entry.isActive) return "denied"
  return entry.role
}

/**
 * Outage fallback lookup from SQLite when HA Core is unreachable ("unavailable").
 * Returns "denied" if the user was explicitly revoked by Core; null if unknown/expired.
 */
export async function readOutageCachedHARole(
  userId: string,
  fingerprint: string,
  now = Date.now(),
): Promise<"admin" | "member" | "denied" | null> {
  const state = await hydrateMemoryFromSqlite(fingerprint)
  const entry = state.users.get(userId)
  if (!entry) return null
  if (!entry.isActive) return "denied"
  if (now - entry.verifiedAt > OUTAGE_FALLBACK_TTL_MS) return null
  return entry.role
}

/** Synchronous display name lookup from in-memory cache. */
export function getCachedHAUserDisplayNameSync(
  userId: string,
  fingerprint = currentSupervisorFingerprint(),
): string | undefined {
  if (!userId || !memoryState) return undefined
  if (fingerprint && memoryState.fingerprint !== fingerprint) return undefined
  const entry = memoryState.users.get(userId)
  const candidate = entry?.displayName || entry?.username
  return candidate && !isRawHAUserId(candidate) ? candidate : undefined
}

/** Async display name lookup checking memory then SQLite cache. */
export async function resolveCachedHAUserDisplayName(
  userId: string,
  fingerprint = currentSupervisorFingerprint(),
): Promise<{ displayName?: string; username?: string } | null> {
  if (!userId) return null
  if (fingerprint) {
    const state = await hydrateMemoryFromSqlite(fingerprint)
    const entry = state.users.get(userId)
    if (entry) {
      return {
        ...(entry.displayName && !isRawHAUserId(entry.displayName) ? { displayName: entry.displayName } : {}),
        ...(entry.username && !isRawHAUserId(entry.username) ? { username: entry.username } : {}),
      }
    }
  }
  // Also allow lookup by user_id when running without SUPERVISOR_TOKEN (local dev / restored DB)
  try {
    await ensureHAUserCacheSchema()
    const db = getPersistenceClient()
    const result = await db.execute({
      sql: `SELECT display_name, username FROM ha_user_cache WHERE user_id = ? LIMIT 1`,
      args: [userId],
    })
    const row = result.rows[0]
    if (!row) return null
    const displayName = typeof row.display_name === "string" && !isRawHAUserId(row.display_name) ? row.display_name : undefined
    const username = typeof row.username === "string" && !isRawHAUserId(row.username) ? row.username : undefined
    if (!displayName && !username) return null
    return { ...(displayName ? { displayName } : {}), ...(username ? { username } : {}) }
  } catch {
    return null
  }
}
