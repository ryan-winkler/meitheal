import { readFileSync } from "node:fs"
import v8 from "node:v8"
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"
import { getEntityCacheDiagnostics } from "@domains/ha"
import { getDatabaseDiagnostics } from "../../scripts/database-client.mjs"
import { getRuntimeCounters } from "../../scripts/runtime-counters.mjs"

export interface RuntimeVitals {
  ts: string
  rss_bytes: number
  heap_used_bytes: number
  heap_total_bytes: number
  heap_limit_bytes: number
  old_space_used_bytes: number
  external_bytes: number
  cgroup_current_bytes: number | null
  cgroup_max_bytes: number | null
  cgroup_oom_kill_count: number | null
  ha_tracked_entities: number
  ha_cached_entities: number
  ha_cache_approx_bytes: number
  sse_clients_active: number
  sse_backpressure_drops_total: number
  ingress_stream_aborts_total: number
  sqlite_busy_retries_total: number
  sqlite_busy_exhausted_total: number
  sqlite_read_pool_hits_total: number
  sqlite_read_pool_overflow_total: number
  sqlite_read_lease_slow_warnings_total: number
}

const VITALS_TIMER_KEY = Symbol.for("meitheal.runtime.vitalsTimer")
const VITALS_INTERVAL_MS = 60_000
const PRESSURE_WARN_COOLDOWN_MS = 10_000
const UNBOUNDED_CGROUP_THRESHOLD_BYTES = 1099511627776 // 1 TiB

const vitalsLogger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["observability"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: false,
})

function readTextSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim()
  } catch {
    return null
  }
}

function readCgroupCurrentBytes(): number | null {
  const raw =
    readTextSafe("/sys/fs/cgroup/memory.current") ??
    readTextSafe("/sys/fs/cgroup/memory/memory.usage_in_bytes")
  if (!raw || !/^\d+$/.test(raw)) return null
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function readCgroupMaxBytes(): number | null {
  const v2 = readTextSafe("/sys/fs/cgroup/memory.max")
  const raw = v2 ?? readTextSafe("/sys/fs/cgroup/memory/memory.limit_in_bytes")
  if (!raw || raw === "max" || !/^\d+$/.test(raw)) return null
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed >= UNBOUNDED_CGROUP_THRESHOLD_BYTES) {
    return null
  }
  return parsed
}

function readCgroupOomKillCount(): number | null {
  const raw =
    readTextSafe("/sys/fs/cgroup/memory.events") ??
    readTextSafe("/sys/fs/cgroup/memory/memory.oom_control")
  if (!raw) return null
  const match = raw.match(/^oom_kill\s+(\d+)/m)
  if (!match?.[1]) return null
  const parsed = Number(match[1])
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

export function collectRuntimeVitals(): RuntimeVitals {
  const mem = process.memoryUsage()
  const heapStats = v8.getHeapStatistics()
  const spaces = v8.getHeapSpaceStatistics()
  const oldSpace = spaces.find((space) => space.space_name === "old_space")
  const haDiag = getEntityCacheDiagnostics()
  const counters = getRuntimeCounters()
  const dbDiag = getDatabaseDiagnostics()

  return {
    ts: new Date().toISOString(),
    rss_bytes: mem.rss,
    heap_used_bytes: mem.heapUsed,
    heap_total_bytes: mem.heapTotal,
    heap_limit_bytes: heapStats.heap_size_limit,
    old_space_used_bytes: oldSpace?.space_used_size ?? 0,
    external_bytes: mem.external,
    cgroup_current_bytes: readCgroupCurrentBytes(),
    cgroup_max_bytes: readCgroupMaxBytes(),
    cgroup_oom_kill_count: readCgroupOomKillCount(),
    ha_tracked_entities: haDiag.trackedCount,
    ha_cached_entities: haDiag.cachedCount,
    ha_cache_approx_bytes: haDiag.approxBytes,
    sse_clients_active: counters.sseClientsActive,
    sse_backpressure_drops_total: counters.sseBackpressureDropsTotal,
    ingress_stream_aborts_total: counters.ingressStreamAbortsTotal,
    sqlite_busy_retries_total: dbDiag.sqliteBusyRetriesTotal,
    sqlite_busy_exhausted_total: dbDiag.sqliteBusyExhaustedTotal,
    sqlite_read_pool_hits_total: dbDiag.readPoolHitsTotal,
    sqlite_read_pool_overflow_total: dbDiag.readPoolOverflowTotal,
    sqlite_read_lease_slow_warnings_total: dbDiag.readLeaseSlowWarningsTotal,
  }
}

let lastWarnAt = 0
let lastBusyExhaustedTotal = 0

export function emitRuntimeVitalsTick(): RuntimeVitals {
  const vitals = collectRuntimeVitals()
  vitalsLogger.log("info", {
    event: "runtime.vitals",
    domain: "observability",
    component: "runtime-vitals",
    request_id: "system",
    message: "Runtime vitals snapshot",
    metadata: vitals as unknown as Record<string, unknown>,
  })

  const heapRatio =
    vitals.heap_limit_bytes > 0 ? vitals.old_space_used_bytes / vitals.heap_limit_bytes : 0
  const busyExhaustedIncreased = vitals.sqlite_busy_exhausted_total > lastBusyExhaustedTotal
  lastBusyExhaustedTotal = vitals.sqlite_busy_exhausted_total

  const now = Date.now()
  if ((heapRatio > 0.85 || busyExhaustedIncreased) && now - lastWarnAt >= PRESSURE_WARN_COOLDOWN_MS) {
    lastWarnAt = now
    vitalsLogger.log("warn", {
      event: "runtime.vitals.pressure",
      domain: "observability",
      component: "runtime-vitals",
      request_id: "system",
      message: busyExhaustedIncreased
        ? "SQLite write contention retries exhausted"
        : `V8 old_space pressure at ${(heapRatio * 100).toFixed(1)}% of heap limit`,
      metadata: vitals as unknown as Record<string, unknown>,
    })
  }

  return vitals
}

export function startRuntimeVitalsMonitor(): void {
  const g = globalThis as Record<symbol, ReturnType<typeof setInterval> | undefined>
  if (g[VITALS_TIMER_KEY]) return
  const timer = setInterval(() => {
    emitRuntimeVitalsTick()
  }, VITALS_INTERVAL_MS)
  timer.unref()
  g[VITALS_TIMER_KEY] = timer
}
