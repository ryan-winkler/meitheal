import type { Client } from "@libsql/client"
import { localReaderCacheToken } from "../../scripts/database-client.mjs"
import { taskDetailServerSettingKey } from "./task-detail-layout"

const installationIdCache = new WeakMap<object, { token: string; value: string | undefined }>()
const sidebarProfileCache = new WeakMap<
  object,
  { token: string; value: { rawSidebarConfig: unknown; rawUserProfile: unknown; cacheKey: string } }
>()
const taskDetailLayoutCache = new WeakMap<object, { token: string; value: string | null }>()
const boardNameCache = new WeakMap<object, { token: string; byBoard: Map<string, string> }>()
const aiAssistDisabledCache = new WeakMap<object, { generation: string; value: boolean }>()

/** Read work_installation_id while the local database snapshot is unchanged. */
export async function readCachedWorkInstallationId(
  db: Pick<Client, "execute">,
): Promise<string | undefined> {
  const state = localReaderCacheToken(db)
  if (state) {
    const cached = installationIdCache.get(state.owner)
    if (cached && cached.token === state.token) return cached.value
  }
  const {
    rows: [installation],
  } = await db.execute({
    sql: "SELECT value FROM app_settings WHERE key = 'work_installation_id'",
    args: [],
  })
  const value = typeof installation?.value === "string" ? installation.value : undefined
  if (state && localReaderCacheToken(db)?.token === state.token) {
    installationIdCache.set(state.owner, { token: state.token, value })
  }
  return value
}

/** Read sidebar_config and user_profile while the local database snapshot is unchanged. */
export async function readCachedSidebarAndProfile(
  db: Pick<Client, "execute">,
): Promise<{ rawSidebarConfig: unknown; rawUserProfile: unknown; cacheKey: string }> {
  const state = localReaderCacheToken(db)
  if (state) {
    const cached = sidebarProfileCache.get(state.owner)
    if (cached && cached.token === state.token) {
      return {
        rawSidebarConfig: cached.value.rawSidebarConfig,
        rawUserProfile: cached.value.rawUserProfile,
        cacheKey: cached.value.cacheKey,
      }
    }
  }
  const res = await db.execute(
    "SELECT key, value FROM settings WHERE key IN ('sidebar_config', 'user_profile')",
  )
  let rawSidebarConfig: unknown = null
  let rawUserProfile: unknown = null
  for (const row of res.rows) {
    const key = String(row.key ?? "")
    if (key === "sidebar_config") rawSidebarConfig = row.value
    if (key === "user_profile") rawUserProfile = row.value
  }
  const value = {
    rawSidebarConfig,
    rawUserProfile,
    cacheKey: JSON.stringify([rawSidebarConfig, rawUserProfile]),
  }
  if (state && localReaderCacheToken(db)?.token === state.token) {
    sidebarProfileCache.set(state.owner, { token: state.token, value })
  }
  return value
}

/** Read task_detail_layout_default while the local database snapshot is unchanged. */
export async function readCachedTaskDetailLayout(
  db: Pick<Client, "execute">,
): Promise<string | null> {
  const state = localReaderCacheToken(db)
  if (state) {
    const cached = taskDetailLayoutCache.get(state.owner)
    if (cached && cached.token === state.token) return cached.value
  }
  const {
    rows: [row],
  } = await db.execute({
    sql: "SELECT value FROM settings WHERE key = ?",
    args: [taskDetailServerSettingKey],
  })
  let decoded: unknown = null
  if (row?.value !== undefined && row?.value !== null) {
    const raw = String(row.value)
    try {
      decoded = JSON.parse(raw)
    } catch {
      decoded = raw
    }
  }
  const value = typeof decoded === "string" && decoded.trim() ? decoded : null
  if (state && localReaderCacheToken(db)?.token === state.token) {
    taskDetailLayoutCache.set(state.owner, { token: state.token, value })
  }
  return value
}

/** Read a Board display name while the local database snapshot is unchanged. */
export async function readCachedBoardName(
  db: Pick<Client, "execute">,
  boardId: string,
  fallback: string,
): Promise<string> {
  const state = localReaderCacheToken(db)
  const cached = state ? boardNameCache.get(state.owner) : undefined
  if (cached && cached.token === state!.token) {
    const existing = cached.byBoard.get(boardId)
    if (existing !== undefined) return existing
  }
  const {
    rows: [boardRow],
  } = await db.execute({
    sql: "SELECT name FROM task_boards WHERE id = ?",
    args: [boardId],
  })
  const value = boardRow?.name ? String(boardRow.name) : fallback
  if (state && localReaderCacheToken(db)?.token === state.token) {
    let next = boardNameCache.get(state.owner)
    if (!next || next.token !== state.token) {
      next = { token: state.token, byBoard: new Map() }
      boardNameCache.set(state.owner, next)
    }
    next.byBoard.set(boardId, value)
  }
  return value
}

/** Read ai_assist_disabled while the local database snapshot is unchanged. */
export async function readCachedAiAssistDisabled(
  db: Pick<Client, "execute">,
): Promise<boolean> {
  const state = localReaderCacheToken(db)
  if (state) {
    const cached = aiAssistDisabledCache.get(state.owner)
    if (cached && cached.generation === state.token) return cached.value
  }
  const {
    rows: [row],
  } = await db.execute("SELECT value FROM settings WHERE key = 'ai_assist_disabled'")
  let decoded: unknown = row?.value
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded)
    } catch {
      /* keep raw string when unquoted */
    }
  }
  const value = decoded === true || decoded === "true"
  const currentGeneration = state ? localReaderCacheToken(db)?.token : undefined
  if (state && currentGeneration === state.token) {
    aiAssistDisabledCache.set(state.owner, { generation: currentGeneration, value })
  }
  return value
}

export interface CachedCalendarPushPolicy {
  calendar_manual_push_enabled: boolean | string | null | undefined
  calendar_sync_enabled: boolean | string | null | undefined
  calendar_sync_mode: string | null | undefined
  calendar_write_back: boolean | string | null | undefined
  calendar_sync_interval_ms: number | string | null | undefined
}

const calendarPushPolicyCache = new WeakMap<
  object,
  { generation: string; value: CachedCalendarPushPolicy }
>()
const hasActivePluginsCache = new WeakMap<object, { generation: string; value: boolean }>()

function decodeSettingScalar(raw: unknown): unknown {
  if (typeof raw !== "string") return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** Read calendar push policy settings while the local database snapshot is unchanged. */
export async function readCachedCalendarPushPolicy(
  db: Pick<Client, "execute">,
): Promise<CachedCalendarPushPolicy> {
  const state = localReaderCacheToken(db)
  if (state) {
    const cached = calendarPushPolicyCache.get(state.owner)
    if (cached && cached.generation === state.token) return { ...cached.value }
  }
  const { rows } = await db.execute(
    "SELECT key, value FROM settings WHERE key IN ('calendar_manual_push_enabled','calendar_sync_enabled','calendar_sync_mode','calendar_write_back','calendar_sync_interval_ms')",
  )
  const map: Record<string, unknown> = {}
  for (const row of rows) {
    const key = String(row.key ?? "")
    if (key) map[key] = decodeSettingScalar(row.value)
  }
  const value: CachedCalendarPushPolicy = {
    calendar_manual_push_enabled: map.calendar_manual_push_enabled as boolean | string | null | undefined,
    calendar_sync_enabled: map.calendar_sync_enabled as boolean | string | null | undefined,
    calendar_sync_mode: map.calendar_sync_mode as string | null | undefined,
    calendar_write_back: map.calendar_write_back as boolean | string | null | undefined,
    calendar_sync_interval_ms: map.calendar_sync_interval_ms as number | string | null | undefined,
  }
  const currentGeneration = state ? localReaderCacheToken(db)?.token : undefined
  if (state && currentGeneration === state.token) {
    calendarPushPolicyCache.set(state.owner, { generation: currentGeneration, value })
  }
  return { ...value }
}

/** Cache whether any plugin is enabled while the local database snapshot is unchanged. */
export async function readCachedHasActivePlugins(
  db: Pick<Client, "execute">,
  readLive: () => Promise<boolean>,
): Promise<boolean> {
  const state = localReaderCacheToken(db)
  if (state) {
    const cached = hasActivePluginsCache.get(state.owner)
    if (cached && cached.generation === state.token) return cached.value
  }
  const value = await readLive()
  const currentGeneration = state ? localReaderCacheToken(db)?.token : undefined
  if (state && currentGeneration === state.token) {
    hasActivePluginsCache.set(state.owner, { generation: currentGeneration, value })
  }
  return value
}
