export type LogLevel = "debug" | "info" | "warn" | "error"

export type ActorType =
  | "user"
  | "human"
  | "bot"
  | "system"
  | "webhook"
  | "calendar_sync"
  | "llm"
  | "n8n"
  | "nodered"
  | "agent"
  | "grocy"
  | "ha"

export const VALID_ACTOR_TYPE_SET: ReadonlySet<string> = new Set<string>([
  "user",
  "human",
  "bot",
  "system",
  "webhook",
  "calendar_sync",
  "llm",
  "n8n",
  "nodered",
  "agent",
  "grocy",
  "ha",
])

export const VALID_EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>([
  "field_change",
  "status_change",
  "comment",
  "created",
  "updated",
  "completed",
  "deleted",
  "assigned",
  "reaction",
  "handoff",
  "proposal",
  "sync",
  "deferral",
  "pin",
  "link",
  "audit",
])

export const defaultRedactionPatterns: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bmth_[a-f0-9]{16,}\b/gi,
  /(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s"',}]+["']?/gi,
]

export interface LoggerConfig {
  service: string
  env?: string
  minLevel?: LogLevel
  enabledCategories?: string[]
  redactPatterns?: RegExp[]
  auditEnabled?: boolean
}

export interface LogEntry {
  event: string
  domain: string
  component: string
  request_id?: string
  message: string
  duration_ms?: number
  trace_id?: string
  span_id?: string
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface StructuredLogger {
  log(level: LogLevel, entry: LogEntry): void
  debug(entry: LogEntry): void
  info(entry: LogEntry): void
  warn(entry: LogEntry): void
  error(entry: LogEntry): void
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

function redactString(input: string, patterns: RegExp[]): string {
  let result = input
  for (const pattern of patterns) {
    const cloned = new RegExp(pattern.source, pattern.flags)
    result = result.replace(cloned, "[REDACTED]")
  }
  return result
}

function redactValue(value: unknown, patterns: RegExp[]): unknown {
  if (typeof value === "string") return redactString(value, patterns)
  if (Array.isArray(value)) return value.map(item => redactValue(item, patterns))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(password|secret|token|apiKey|api_key|authorization)$/i.test(k)) {
        out[k] = "[REDACTED]"
      } else {
        out[k] = redactValue(v, patterns)
      }
    }
    return out
  }
  return value
}

export function createLogger(config: LoggerConfig): StructuredLogger {
  const minPriority = LEVEL_ORDER[config.minLevel ?? "info"] ?? LEVEL_ORDER.info
  const patterns = config.redactPatterns ?? defaultRedactionPatterns

  function emit(level: LogLevel, entry: LogEntry): void {
    if ((LEVEL_ORDER[level] ?? 20) < minPriority) return
    const record = {
      service: config.service,
      env: config.env ?? "development",
      ts: new Date().toISOString(),
      level,
      ...entry,
      message: redactString(String(entry.message ?? ""), patterns),
      ...(entry.metadata ? { metadata: redactValue(entry.metadata, patterns) } : {}),
    }
    const line = `${JSON.stringify(record)}\n`
    if (typeof process !== "undefined" && process.stdout?.write) {
      if (level === "error" && process.stderr?.write) process.stderr.write(line)
      else process.stdout.write(line)
    } else if (level === "error") {
      console.error(line)
    } else {
      console.log(line)
    }
  }

  return {
    log: emit,
    debug: entry => emit("debug", entry),
    info: entry => emit("info", entry),
    warn: entry => emit("warn", entry),
    error: entry => emit("error", entry),
  }
}
