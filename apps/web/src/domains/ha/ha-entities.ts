/**
 * HA Entity Subscriber — Server-Side Scoped Cache
 *
 * Subscribes only to Home Assistant `calendar.*`, `todo.*`, and explicitly
 * watched `onEntityChange` entity IDs via compressed `subscribe_entities` frames,
 * keeping steady-state Old Space independent of total Home Assistant entity count.
 *
 * @domain ha
 * @bounded-context integration
 */
import type { Connection, HassEntities, HassEntity } from "home-assistant-js-websocket"
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"
import { getHAConnection, haRestFetch } from "./ha-connection"

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["ha"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: false,
})
const SYS_REQ = "ha-system"

const SCOPED_ATTR_KEYS = new Set([
  "friendly_name",
  "supported_features",
  "icon",
  "all_day",
  "start_time",
  "end_time",
  "message",
  "description",
  "location",
])

const EMPTY_CONTEXT = Object.freeze({
  id: "",
  parent_id: null,
  user_id: null,
})

export interface SlimHassEntity extends HassEntity {
  entity_id: string
  state: string
  last_changed: string
  last_updated: string
  attributes: Record<string, unknown>
}

interface CompressedEntityAdd {
  s?: string
  a?: Record<string, unknown>
  lc?: number
  lu?: number
  c?: unknown
}

interface CompressedEntityDiff {
  "+"?: CompressedEntityAdd
  "-"?: { a?: string[] }
}

interface CompressedEntitiesPayload {
  a?: Record<string, CompressedEntityAdd>
  c?: Record<string, CompressedEntityDiff>
  r?: string[]
}

interface RegistryEntry {
  entity_id?: string
  disabled_by?: string | null
}

let entityCache: Record<string, SlimHassEntity> = {}
const trackedEntityIds = new Set<string>()
const disabledRegistryIds = new Set<string>()
let subscribed = false
let subscribedConnection: Connection | null = null
let initInFlight: { conn: Connection; promise: Promise<void> } | null = null
let unsubscribeEntities: (() => void | Promise<void>) | null = null
let registryUnsubscribe: (() => void | Promise<void>) | null = null
let componentUnsubscribe: (() => void | Promise<void>) | null = null
let detachReadyListener: (() => void) | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let hydrated = false
const hydrationWaiters = new Set<() => void>()

const changeListeners: Map<string, Set<(entity: HassEntity) => void>> = new Map()

function isCalendarOrTodo(entityId: string): boolean {
  return entityId.startsWith("calendar.") || entityId.startsWith("todo.")
}

function isTargetEntity(entityId: string): boolean {
  if (changeListeners.has(entityId)) return true
  if (disabledRegistryIds.has(entityId)) return false
  return isCalendarOrTodo(entityId)
}

function filterAttributes(entityId: string, rawAttrs: unknown): Record<string, unknown> {
  if (!rawAttrs || typeof rawAttrs !== "object" || Array.isArray(rawAttrs)) return {}
  const src = rawAttrs as Record<string, unknown>
  if (!isCalendarOrTodo(entityId)) return { ...src }
  const filtered: Record<string, unknown> = {}
  for (const key of SCOPED_ATTR_KEYS) {
    if (Object.hasOwn(src, key)) filtered[key] = src[key]
  }
  return filtered
}

function markHydrated(): void {
  hydrated = true
  for (const resolve of hydrationWaiters) resolve()
  hydrationWaiters.clear()
}

function notifyEntityListeners(entityId: string, entity: SlimHassEntity): void {
  const listeners = changeListeners.get(entityId)
  if (!listeners || listeners.size === 0) return
  for (const listener of [...listeners]) {
    try {
      listener(entity)
    } catch (err) {
      logger.log("error", {
        event: "ha.entity.listener_error",
        domain: "ha",
        component: "ha-entities",
        request_id: SYS_REQ,
        message: `Entity change listener error for ${entityId}: ${err}`,
      })
    }
  }
}

function handleCompressedEntityUpdate(payload: CompressedEntitiesPayload): void {
  if (!payload || typeof payload !== "object") return
  const changedIds: string[] = []

  if (payload.a && typeof payload.a === "object") {
    for (const [entityId, added] of Object.entries(payload.a)) {
      if (!isTargetEntity(entityId) || !added) continue
      const prev = entityCache[entityId]
      const lcIso = typeof added.lc === "number"
        ? new Date(added.lc * 1000).toISOString()
        : new Date(0).toISOString()
      const luIso = typeof added.lu === "number"
        ? new Date(added.lu * 1000).toISOString()
        : lcIso
      const next: SlimHassEntity = {
        entity_id: entityId,
        state: String(added.s ?? ""),
        attributes: filterAttributes(entityId, added.a),
        last_changed: lcIso,
        last_updated: luIso,
        context: EMPTY_CONTEXT,
      }
      entityCache[entityId] = next
      if (!prev || prev.state !== next.state || prev.last_updated !== next.last_updated) {
        changedIds.push(entityId)
      }
    }
  }

  if (Array.isArray(payload.r)) {
    for (const entityId of payload.r) {
      delete entityCache[entityId]
    }
  }

  if (payload.c && typeof payload.c === "object") {
    for (const [entityId, diff] of Object.entries(payload.c)) {
      if (!isTargetEntity(entityId) || !diff) continue
      let entity = entityCache[entityId]
      const hadExisting = Boolean(entity)
      const prevState = entity?.state
      const prevLu = entity?.last_updated
      if (!entity) {
        const iso = new Date(0).toISOString()
        entity = {
          entity_id: entityId,
          state: "",
          attributes: {},
          last_changed: iso,
          last_updated: iso,
          context: EMPTY_CONTEXT,
        }
        entityCache[entityId] = entity
      }

      const toAdd = diff["+"]
      const toRemove = diff["-"]
      let attrsChanged = false

      if (toAdd) {
        if (toAdd.s !== undefined) entity.state = String(toAdd.s)
        if (typeof toAdd.lc === "number") {
          const lcIso = new Date(toAdd.lc * 1000).toISOString()
          entity.last_changed = lcIso
          entity.last_updated = typeof toAdd.lu === "number"
            ? new Date(toAdd.lu * 1000).toISOString()
            : lcIso
        } else if (typeof toAdd.lu === "number") {
          entity.last_updated = new Date(toAdd.lu * 1000).toISOString()
        }
        if (toAdd.a && typeof toAdd.a === "object") {
          if (isCalendarOrTodo(entityId)) {
            for (const key of SCOPED_ATTR_KEYS) {
              if (Object.hasOwn(toAdd.a, key)) {
                if (entity.attributes[key] !== toAdd.a[key]) attrsChanged = true
                entity.attributes[key] = toAdd.a[key]
              }
            }
          } else {
            for (const [key, val] of Object.entries(toAdd.a)) {
              if (entity.attributes[key] !== val) attrsChanged = true
              entity.attributes[key] = val
            }
          }
        }
      }

      if (Array.isArray(toRemove?.a)) {
        for (const key of toRemove.a) {
          if (Object.hasOwn(entity.attributes, key)) {
            delete entity.attributes[key]
            attrsChanged = true
          }
        }
      }

      if (!hadExisting || prevState !== entity.state || prevLu !== entity.last_updated || attrsChanged) {
        changedIds.push(entityId)
      }
    }
  }

  if (changedIds.length > 0 && changeListeners.size > 0) {
    for (const entityId of changedIds) {
      const current = entityCache[entityId]
      if (current) notifyEntityListeners(entityId, current)
    }
  }
}

async function discoverTargetEntityIds(conn: Connection): Promise<void> {
  const nextTracked = new Set<string>(changeListeners.keys())
  const nextDisabled = new Set<string>()

  try {
    const registry = await conn.sendMessagePromise<unknown>({ type: "config/entity_registry/list" })
    if (Array.isArray(registry)) {
      for (const raw of registry as RegistryEntry[]) {
        const id = typeof raw?.entity_id === "string" ? raw.entity_id : ""
        if (!id || !isCalendarOrTodo(id)) continue
        if (raw.disabled_by === null || raw.disabled_by === undefined) {
          nextTracked.add(id)
        } else {
          nextDisabled.add(id)
        }
      }
    }
  } catch {
    // Minimal test harnesses or older instances may not support config/entity_registry/list
  }

  let rawStates: unknown = []
  let gotStatesArray = false
  try {
    rawStates = await conn.sendMessagePromise<unknown>({ type: "get_states" })
    gotStatesArray = Array.isArray(rawStates)
  } catch {
    rawStates = []
  }

  const states = Array.isArray(rawStates) ? rawStates : []
  const nextCache: Record<string, SlimHassEntity> = {}

  for (const item of states) {
    if (!item || typeof item !== "object") continue
    const raw = item as {
      entity_id?: unknown
      state?: unknown
      attributes?: unknown
      last_changed?: unknown
      last_updated?: unknown
    }
    const id = typeof raw.entity_id === "string" ? raw.entity_id : ""
    if (!id) continue
    const explicitlyWatched = changeListeners.has(id)
    if (!explicitlyWatched && (nextDisabled.has(id) || !isCalendarOrTodo(id))) continue
    nextTracked.add(id)
    const lc = typeof raw.last_changed === "string" ? raw.last_changed : new Date(0).toISOString()
    const lu = typeof raw.last_updated === "string" ? raw.last_updated : lc
    nextCache[id] = {
      entity_id: id,
      state: String(raw.state ?? ""),
      attributes: filterAttributes(id, raw.attributes),
      last_changed: lc,
      last_updated: lu,
      context: EMPTY_CONTEXT,
    }
  }

  disabledRegistryIds.clear()
  for (const id of nextDisabled) disabledRegistryIds.add(id)

  trackedEntityIds.clear()
  for (const id of nextTracked) trackedEntityIds.add(id)

  if (gotStatesArray) {
    const prevCache = entityCache
    entityCache = nextCache
    if (changeListeners.size > 0) {
      for (const id of [...changeListeners.keys()]) {
        const next = nextCache[id]
        const prev = prevCache[id]
        if (!next) continue
        if (!prev || prev.state !== next.state || prev.last_updated !== next.last_updated) {
          notifyEntityListeners(id, next)
        }
      }
    }
  } else {
    // Evict any previously cached entities that are no longer tracked
    for (const id of Object.keys(entityCache)) {
      if (!isTargetEntity(id)) delete entityCache[id]
    }
  }
}

async function refreshEntitySubscription(): Promise<void> {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
  const conn = subscribedConnection
  if (!conn || !subscribed) return

  const msg = trackedEntityIds.size > 0
    ? { type: "subscribe_entities", entity_ids: [...trackedEntityIds] }
    : { type: "subscribe_entities" }

  try {
    const nextUnsub = await conn.subscribeMessage<CompressedEntitiesPayload>(
      (payload) => {
        if (subscribedConnection !== conn) return
        handleCompressedEntityUpdate(payload)
      },
      msg,
      { resubscribe: false },
    )
    if (subscribedConnection !== conn || !subscribed) {
      void Promise.resolve(nextUnsub()).catch(() => {})
      return
    }
    const prev = unsubscribeEntities
    unsubscribeEntities = nextUnsub
    if (prev) void Promise.resolve(prev()).catch(() => {})
  } catch (err) {
    if (subscribedConnection !== conn) return
    logger.log("warn", {
      event: "ha.entities.resubscribe_failed",
      domain: "ha",
      component: "ha-entities",
      request_id: SYS_REQ,
      message: `Failed to refresh scoped entity subscription: ${err}`,
    })
  }
}

function scheduleRefreshSubscription(): void {
  if (!subscribed || !subscribedConnection) return
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refreshEntitySubscription()
  }, 250)
  refreshTimer.unref?.()
}

async function hydrateSingleEntityViaRest(entityId: string, expectedConn: Connection): Promise<void> {
  const res = await haRestFetch(`/api/states/${encodeURIComponent(entityId)}`, {
    signal: AbortSignal.timeout(5_000),
  })
  if (!res || !res.ok || subscribedConnection !== expectedConn) return
  try {
    const raw = (await res.json()) as {
      entity_id?: unknown
      state?: unknown
      attributes?: unknown
      last_changed?: unknown
      last_updated?: unknown
    }
    if (subscribedConnection !== expectedConn || !isTargetEntity(entityId)) return
    if (entityCache[entityId]) return
    const lc = typeof raw.last_changed === "string" ? raw.last_changed : new Date(0).toISOString()
    const lu = typeof raw.last_updated === "string" ? raw.last_updated : lc
    const slim: SlimHassEntity = {
      entity_id: entityId,
      state: String(raw.state ?? ""),
      attributes: filterAttributes(entityId, raw.attributes),
      last_changed: lc,
      last_updated: lu,
      context: EMPTY_CONTEXT,
    }
    entityCache[entityId] = slim
    notifyEntityListeners(entityId, slim)
  } catch {
    // Ignore malformed single-entity payload
  }
}

export async function initEntitySubscription(establishedConnection?: Connection): Promise<void> {
  const conn = establishedConnection ?? await getHAConnection()
  if (!conn) {
    resetEntityConnection()
    return
  }
  if (subscribed && subscribedConnection === conn) return
  if (initInFlight?.conn === conn) return initInFlight.promise

  const promise = (async () => {
    resetEntityConnection()
    subscribedConnection = conn
    try {
      await discoverTargetEntityIds(conn)
      if (subscribedConnection !== conn) return

      const msg = trackedEntityIds.size > 0
        ? { type: "subscribe_entities", entity_ids: [...trackedEntityIds] }
        : { type: "subscribe_entities" }

      unsubscribeEntities = await conn.subscribeMessage<CompressedEntitiesPayload>(
        (payload) => {
          if (subscribedConnection !== conn) return
          handleCompressedEntityUpdate(payload)
        },
        msg,
        { resubscribe: false },
      )
      if (subscribedConnection !== conn) {
        if (unsubscribeEntities) void Promise.resolve(unsubscribeEntities()).catch(() => {})
        unsubscribeEntities = null
        return
      }

      subscribed = true

      // 1 & 2. Dynamic registry and component_loaded hooks
      const [regSub, compSub] = await Promise.allSettled([
        conn.subscribeEvents((rawEvent: unknown) => {
          if (subscribedConnection !== conn) return
          const ev = rawEvent as {
            data?: {
              action?: string
              entity_id?: string
              old_entity_id?: string
            }
          }
          const data = ev?.data
          if (!data) return
          let dirty = false

          if (typeof data.old_entity_id === "string" && data.old_entity_id !== data.entity_id) {
            disabledRegistryIds.delete(data.old_entity_id)
            if (!changeListeners.has(data.old_entity_id)) {
              if (trackedEntityIds.delete(data.old_entity_id)) dirty = true
              delete entityCache[data.old_entity_id]
            }
          }

          const entityId = typeof data.entity_id === "string" ? data.entity_id : ""
          if (!entityId) {
            if (dirty) scheduleRefreshSubscription()
            return
          }

          if (data.action === "remove") {
            disabledRegistryIds.delete(entityId)
            if (!changeListeners.has(entityId)) {
              if (trackedEntityIds.delete(entityId)) dirty = true
              delete entityCache[entityId]
            }
            if (dirty) scheduleRefreshSubscription()
            return
          }

          if (!isCalendarOrTodo(entityId)) {
            if (dirty) scheduleRefreshSubscription()
            return
          }

          void (async () => {
            let isDisabled = false
            try {
              const entry = await conn.sendMessagePromise<RegistryEntry | null>({
                type: "config/entity_registry/get",
                entity_id: entityId,
              })
              if (entry && entry.disabled_by !== null && entry.disabled_by !== undefined) {
                isDisabled = true
              }
            } catch {
              isDisabled = false
            }
            if (subscribedConnection !== conn) return
            if (isDisabled) {
              disabledRegistryIds.add(entityId)
              if (!changeListeners.has(entityId)) {
                trackedEntityIds.delete(entityId)
                delete entityCache[entityId]
              }
            } else {
              disabledRegistryIds.delete(entityId)
              trackedEntityIds.add(entityId)
            }
            scheduleRefreshSubscription()
          })()
        }, "entity_registry_updated"),
        conn.subscribeEvents((rawEvent: unknown) => {
          if (subscribedConnection !== conn) return
          const ev = rawEvent as { data?: { component?: string } }
          const component = ev?.data?.component
          if (component !== "calendar" && component !== "todo") return
          void discoverTargetEntityIds(conn).then(() => {
            if (subscribedConnection === conn) scheduleRefreshSubscription()
          }).catch(() => {})
        }, "component_loaded"),
      ])

      if (regSub.status === "fulfilled") {
        if (subscribedConnection === conn && subscribed) registryUnsubscribe = regSub.value
        else void Promise.resolve(regSub.value()).catch(() => {})
      }
      if (compSub.status === "fulfilled") {
        if (subscribedConnection === conn && subscribed) componentUnsubscribe = compSub.value
        else void Promise.resolve(compSub.value()).catch(() => {})
      }

      // 3. Reconnect listener (evicts offline-deleted entities & picks up YAML reloads)
      const onReady = () => {
        if (subscribedConnection !== conn) return
        void discoverTargetEntityIds(conn).then(() => {
          if (subscribedConnection === conn) return refreshEntitySubscription()
        }).catch(() => {})
      }
      conn.addEventListener("ready", onReady)
      detachReadyListener = () => conn.removeEventListener("ready", onReady)

      markHydrated()

      logger.log("info", {
        event: "ha.entities.subscribed",
        domain: "ha",
        component: "ha-entities",
        request_id: SYS_REQ,
        message: `Subscribed to ${trackedEntityIds.size} scoped HA entities`,
        metadata: { tracked_entities: trackedEntityIds.size, cached_entities: Object.keys(entityCache).length },
      })
    } catch (err) {
      markHydrated()
      logger.log("error", {
        event: "ha.entities.subscribe_failed",
        domain: "ha",
        component: "ha-entities",
        request_id: SYS_REQ,
        message: `Failed to subscribe to entities: ${err}`,
      })
    }
  })()

  initInFlight = { conn, promise }
  try {
    await promise
  } finally {
    if (initInFlight?.promise === promise) initInFlight = null
  }
}

/**
 * Wait until the initial scoped entity discovery and `subscribe_entities` handshake settle,
 * bounded by `timeoutMs`.
 */
export function waitForInitialEntityHydration(timeoutMs = 5_000): Promise<void> {
  if (hydrated) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      hydrationWaiters.delete(done)
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    timer.unref?.()
    hydrationWaiters.add(done)
  })
}

/**
 * Returns the scoped in-memory entity cache (`calendar.*`, `todo.*`, and active
 * `onEntityChange` entity IDs). Unrelated Home Assistant domains (`sensor.*`,
 * `light.*`, etc.) are intentionally excluded unless explicitly watched.
 */
export function getAllEntities(): HassEntities {
  return entityCache
}

export function getEntity(entityId: string): HassEntity | undefined {
  return entityCache[entityId]
}

export function getEntitiesByDomain(domain: string): HassEntity[] {
  return Object.values(entityCache).filter((e) => e.entity_id.startsWith(`${domain}.`))
}

export function getCalendarEntities(): HassEntity[] {
  return getEntitiesByDomain("calendar")
}

export function getTodoEntities(): HassEntity[] {
  return getEntitiesByDomain("todo")
}

export function getEntityCacheDiagnostics(): {
  trackedCount: number
  cachedCount: number
  listenerEntityCount: number
  approxBytes: number
  registrySubscribed: boolean
} {
  const values = Object.values(entityCache)
  let approxBytes = 0
  for (const entity of values) {
    approxBytes += (entity.entity_id.length + entity.state.length + JSON.stringify(entity.attributes).length) * 2 + 128
  }
  return {
    trackedCount: trackedEntityIds.size,
    cachedCount: values.length,
    listenerEntityCount: changeListeners.size,
    approxBytes,
    registrySubscribed: registryUnsubscribe !== null,
  }
}

const MAX_LISTENERS_PER_ENTITY = 50
const MAX_ENTITY_SUBSCRIPTIONS = 500

export function onEntityChange(entityId: string, callback: (entity: HassEntity) => void): () => void {
  if (changeListeners.size >= MAX_ENTITY_SUBSCRIPTIONS && !changeListeners.has(entityId)) {
    logger.log("warn", {
      event: "ha.entity.listener_cap_reached",
      domain: "ha",
      component: "ha-entities",
      request_id: SYS_REQ,
      message: `Entity subscription cap reached (${MAX_ENTITY_SUBSCRIPTIONS}) — rejecting listener for ${entityId}`,
    })
    return () => {}
  }

  if (!changeListeners.has(entityId)) changeListeners.set(entityId, new Set())
  const listeners = changeListeners.get(entityId)!

  if (listeners.size >= MAX_LISTENERS_PER_ENTITY) {
    logger.log("warn", {
      event: "ha.entity.listener_cap_per_entity",
      domain: "ha",
      component: "ha-entities",
      request_id: SYS_REQ,
      message: `Listener cap per entity reached (${MAX_LISTENERS_PER_ENTITY}) for ${entityId}`,
    })
    return () => {}
  }

  listeners.add(callback)

  if (subscribed && subscribedConnection) {
    const conn = subscribedConnection
    if (!trackedEntityIds.has(entityId)) {
      trackedEntityIds.add(entityId)
      scheduleRefreshSubscription()
    }
    if (!entityCache[entityId]) {
      void hydrateSingleEntityViaRest(entityId, conn)
    }
  }

  let active = true
  return () => {
    if (!active) return
    active = false
    const l = changeListeners.get(entityId)
    if (!l) return
    l.delete(callback)
    if (l.size === 0) {
      changeListeners.delete(entityId)
      if (!isCalendarOrTodo(entityId)) {
        trackedEntityIds.delete(entityId)
        delete entityCache[entityId]
        if (subscribed && subscribedConnection) scheduleRefreshSubscription()
      }
    }
  }
}

/** Retire one connection snapshot while preserving consumers registered by the App. */
export function resetEntityConnection(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
  if (detachReadyListener) {
    detachReadyListener()
    detachReadyListener = null
  }
  if (unsubscribeEntities) {
    void Promise.resolve(unsubscribeEntities()).catch(() => {})
    unsubscribeEntities = null
  }
  if (registryUnsubscribe) {
    void Promise.resolve(registryUnsubscribe()).catch(() => {})
    registryUnsubscribe = null
  }
  if (componentUnsubscribe) {
    void Promise.resolve(componentUnsubscribe()).catch(() => {})
    componentUnsubscribe = null
  }
  subscribed = false
  subscribedConnection = null
  hydrated = false
  trackedEntityIds.clear()
  disabledRegistryIds.clear()
  entityCache = {}
}

export function stopEntitySubscription(): void {
  resetEntityConnection()
  changeListeners.clear()
}
