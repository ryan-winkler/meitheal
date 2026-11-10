export type LogLevel = "debug" | "info" | "warn" | "error"

/**
 * Actor types for the Immutable Audit Ledger.
 * Each event in the timeline records WHO performed the action.
 * Bounded enum — safe for use as a Loki label (low cardinality).
 */
export type ActorType = "human" | "bot" | "system" | "webhook" | "calendar_sync" | "llm" | "n8n" | "nodered" | "agent"

/**
 * Structured actor identity attached to audit/timeline events.
 * - type: discriminator for the actor category
 * - id: optional machine-readable identifier (e.g. bot agent name, webhook source)
 * - name: optional human-readable display name
 */
export interface Actor {
  type: ActorType
  id?: string
  name?: string
}

export interface LogEvent {
  ts: string
  level: LogLevel
  event: string
  domain: string
  component: string
  request_id: string
  user_hash?: string
  task_id?: string
  integration?: string
  duration_ms?: number
  err_code?: string
  message: string
  metadata?: Record<string, unknown>
  /** Structured actor identity for audit trail */
  actor?: Actor
  /** Denormalized actor type — extracted as Loki label */
  actor_type?: ActorType
  /** Entity this event relates to (task ID, goal ID, etc.) */
  entity_id?: string
  /** Entity type discriminator (task, goal, project, etc.) */
  entity_type?: string
  /** Correlation ID linking related events across a workflow */
  correlation_id?: string
  /** W3C trace-id (32 hex) — for Grafana Alloy / OTel trace correlation */
  trace_id?: string
  /** W3C span-id (16 hex) — for Grafana Alloy / OTel trace correlation */
  span_id?: string
}

export interface LoggerConfig {
  service: string
  env: string
  minLevel: LogLevel
  enabledCategories: string[]
  redactPatterns: RegExp[]
  auditEnabled?: boolean
}

/**
 * Timeline event types for the Immutable Audit Ledger.
 * Used in both the structured log output and the task_activity_log DB table.
 */
export type TimelineEventType =
  | "field_change"
  | "status_change"
  | "created"
  | "deleted"
  | "comment"
  | "delegated"
  | "proposal_submitted"
  | "proposal_accepted"
  | "proposal_rejected"
  | "sync"
  | "webhook"
  | "locked"
  | "unlocked"

/**
 * Input for the timeline() convenience method.
 * Requires actor context — the audit ledger must always know WHO.
 */
export interface TimelineEntry {
  event: string
  event_type: TimelineEventType
  actor: Actor
  entity_id: string
  entity_type: string
  component: string
  request_id: string
  message: string
  summary: string
  correlation_id?: string
  task_id?: string
  metadata?: Record<string, unknown>
}

const severity: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
}

function shouldLog(level: LogLevel, minLevel: LogLevel): boolean {
  return severity[level] >= severity[minLevel]
}

function redact(value: string, patterns: RegExp[]): string {
  let redacted = value
  for (const pattern of patterns) {
    redacted = redacted.replace(pattern, (...args: unknown[]) => {
      const captures = args.slice(1, -2)
      const firstCapture = captures[0]
      if (typeof firstCapture === "string" && (firstCapture.endsWith("=") || firstCapture.endsWith(" "))) {
        return `${firstCapture}[REDACTED]`
      }
      return "[REDACTED]"
    })
  }
  return redacted
}

export function createLogger(config: LoggerConfig) {
  const auditEnabled = config.auditEnabled ?? (process.env.MEITHEAL_AUDIT_LOGS !== "false")

  function emit(level: LogLevel, partial: Omit<LogEvent, "ts" | "level">): void {
    if (!shouldLog(level, config.minLevel)) {
      return
    }
    if (config.enabledCategories.length > 0 && !config.enabledCategories.includes(partial.domain)) {
      return
    }

    const message = redact(partial.message, config.redactPatterns)
    const event: LogEvent = {
      ts: new Date().toISOString(),
      level,
      ...partial,
      message
    }

    // Keep output as a single JSON object per line for Loki parsing.
    process.stdout.write(`${JSON.stringify({ service: config.service, env: config.env, ...event })}\n`)
  }

  return {
    log(level: LogLevel, partial: Omit<LogEvent, "ts" | "level">): void {
      emit(level, partial)
    },

    audit(partial: Omit<LogEvent, "ts" | "level">): void {
      if (!auditEnabled) {
        return
      }
      emit("info", { ...partial, domain: "audit" })
    },

    /**
     * Record an immutable audit ledger event.
     * Always logs at info level to the "audit" domain.
     * Requires structured actor context — the timeline must always know WHO did WHAT.
     *
     * Example:
     * ```ts
     * logger.timeline({
     *   event: "task.status.changed",
     *   event_type: "status_change",
     *   actor: { type: "human", name: "Ryan" },
     *   entity_id: "task-abc",
     *   entity_type: "task",
     *   component: "tasks",
     *   request_id: "req-123",
     *   message: "Status changed from pending to active",
     *   summary: "Status → active",
     * })
     * ```
     */
    timeline(entry: TimelineEntry): void {
      if (!auditEnabled) {
        return
      }
      emit("info", {
        event: entry.event,
        domain: "audit",
        component: entry.component,
        request_id: entry.request_id,
        message: entry.message,
        actor: entry.actor,
        actor_type: entry.actor.type,
        entity_id: entry.entity_id,
        entity_type: entry.entity_type,
        task_id: entry.task_id ?? entry.entity_id,
        ...(entry.correlation_id ? { correlation_id: entry.correlation_id } : {}),
        metadata: {
          ...entry.metadata,
          event_type: entry.event_type,
          summary: entry.summary,
        },
      })
    },
  }
}

/** Valid actor types — use for API input validation */
export const VALID_ACTOR_TYPES: readonly ActorType[] = ["human", "bot", "system", "webhook", "calendar_sync", "llm", "agent"] as const
export const VALID_ACTOR_TYPE_SET: ReadonlySet<string> = new Set(VALID_ACTOR_TYPES)

/** Valid event types — use for API input validation */
export const VALID_EVENT_TYPES: readonly TimelineEventType[] = [
  "field_change", "status_change", "created", "deleted", "comment",
  "delegated", "proposal_submitted", "proposal_accepted", "proposal_rejected",
  "sync", "webhook", "locked", "unlocked",
] as const
export const VALID_EVENT_TYPE_SET: ReadonlySet<string> = new Set(VALID_EVENT_TYPES)

export const defaultRedactionPatterns: RegExp[] = [
  /(bearer\s+)[a-z0-9\-._~+/]+=*/gi,
  /(authorization:\s*)[^\s]+/gi,
  /(hassio_token=)[^&\s]+/gi,
  /(ha_token=)[^&\s]+/gi,
  /(supervisor_token=)[^&\s]+/gi,
  /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi
];
