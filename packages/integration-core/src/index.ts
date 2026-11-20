import { createHmac } from "node:crypto"
import { isIP } from "node:net"

// ── A2A Protocol Constants & Discovery ──────────────────────────────────────

export const A2A_PROTOCOL_VERSION = "0.3"
export const A2A_TASK_SEARCH_SKILL = "task-search"

export const A2A_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
  VERSION_NOT_SUPPORTED: -32009,
} as const

export function buildAgentCard(options: { origin: string; basePath?: string; version?: string }) {
  const base = `${options.origin.replace(/\/+$/, "")}${(options.basePath ?? "").replace(/\/+$/, "")}`
  return {
    name: "Meitheal",
    description: "Household and homelab task execution hub",
    version: options.version ?? "0.0.1",
    protocolVersion: A2A_PROTOCOL_VERSION,
    url: `${base}/api/a2a/message`,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: A2A_TASK_SEARCH_SKILL,
        name: "Task Search",
        description: "Read-only search across Meitheal household tasks",
        tags: ["tasks", "search"],
      },
    ],
  }
}

// ── Outbound SSRF Policy & Network Host Classification ──────────────────────

export class OutboundUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OutboundUrlError"
  }
}

export type NetworkHostClass = "public" | "private" | "unconditional"

export function normalizeNetworkHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "")
}

const UNCONDITIONAL_BLOCKED_HOSTS = new Set([
  "supervisor",
  "hassio",
  "metadata",
  "metadata.google.internal",
  "169.254.169.254",
  "172.30.32.2",
  "fd00:ec2::254",
])

function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".").map(Number)
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  if (a === 10) return true
  if (a === 127) return true
  if (a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

export function classifyNetworkHost(rawHost: string): NetworkHostClass {
  const host = normalizeNetworkHost(rawHost)
  if (!host) return "unconditional"
  if (UNCONDITIONAL_BLOCKED_HOSTS.has(host)) return "unconditional"
  if (host.startsWith("169.254.") || host.startsWith("fe80:")) return "unconditional"
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "::") {
    return "private"
  }
  const ipVersion = isIP(host)
  if (ipVersion === 4) {
    return isPrivateIPv4(host) ? "private" : "public"
  }
  if (ipVersion === 6) {
    const mapped = host.startsWith("::ffff:") ? host.slice(7) : null
    if (mapped && isIP(mapped) === 4) {
      if (UNCONDITIONAL_BLOCKED_HOSTS.has(mapped) || mapped.startsWith("169.254.")) return "unconditional"
      return isPrivateIPv4(mapped) ? "private" : "public"
    }
    if (host.startsWith("fc") || host.startsWith("fd")) return "private"
    return "public"
  }
  if (host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) {
    return "private"
  }
  return "public"
}

export function assertOutboundUrl(
  input: string | URL,
  options: { allowPrivate?: boolean } = {},
): URL {
  let url: URL
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(String(input))
  } catch {
    throw new OutboundUrlError("Invalid outbound URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OutboundUrlError("Only HTTP and HTTPS outbound URLs are allowed")
  }
  const hostClass = classifyNetworkHost(url.hostname)
  if (hostClass === "unconditional") {
    throw new OutboundUrlError(`Outbound requests to "${url.hostname}" are blocked`)
  }
  if (hostClass === "private" && options.allowPrivate === false) {
    throw new OutboundUrlError(`Private or internal host "${url.hostname}" is not allowed`)
  }
  return url
}

export interface OutboundRequestInit extends RequestInit {
  allowPrivate?: boolean
  operationAllowed?: () => Promise<boolean>
}

export async function fetchOutbound(
  input: string | URL,
  init: OutboundRequestInit = {},
): Promise<Response> {
  const { allowPrivate = true, operationAllowed, ...fetchInit } = init
  const url = assertOutboundUrl(input, { allowPrivate })
  if (operationAllowed && !(await operationAllowed())) {
    throw new OutboundUrlError("Outbound request is no longer permitted")
  }
  return fetch(url, { ...fetchInit, redirect: fetchInit.redirect ?? "manual" })
}

export function validateGrocyBaseUrl(
  rawUrl: string,
): { ok: true; normalizedUrl: string } | { ok: false; error: string } {
  try {
    const parsed = assertOutboundUrl(rawUrl, { allowPrivate: true })
    const normalizedUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`
    return { ok: true, normalizedUrl }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Invalid Grocy URL" }
  }
}

// ── Webhooks ────────────────────────────────────────────────────────────────

export interface DomainEvent {
  eventId: string
  eventType: string
  occurredAt: string
  requestId: string
  payload: unknown
  traceId?: string
}

export interface WebhookSubscriberConfig {
  id: string
  url: string
  secret?: string
  events: string[]
  enabled: boolean
  headers?: Record<string, string>
}

export async function emitWebhook(
  event: DomainEvent,
  subscriber: WebhookSubscriberConfig,
  options?: { operationAllowed?: () => Promise<boolean>; timeoutMs?: number },
): Promise<{ ok: boolean; statusCode: number; error?: string }> {
  try {
    if (!subscriber.enabled) return { ok: false, statusCode: 0, error: "subscriber_disabled" }
    const body = JSON.stringify(event)
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-meitheal-event": event.eventType,
      "x-meitheal-event-id": event.eventId,
      ...(subscriber.headers ?? {}),
    }
    if (subscriber.secret) {
      headers["x-meitheal-signature"] = `sha256=${createHmac("sha256", subscriber.secret).update(body).digest("hex")}`
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? 5000)
    try {
      const response = await fetchOutbound(subscriber.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
        operationAllowed: options?.operationAllowed,
      })
      return { ok: response.ok, statusCode: response.status }
    } finally {
      clearTimeout(timeout)
    }
  } catch (err) {
    return {
      ok: false,
      statusCode: 0,
      error: err instanceof Error ? err.message : "webhook_failed",
    }
  }
}

// ── Grocy Adapter ───────────────────────────────────────────────────────────

export interface GrocyChore {
  choreId: number
  choreName: string
  isOverdue: boolean
  periodType?: string | null
  periodInterval?: number | null
  lastTrackedTime?: string | null
  nextEstimatedExecutionTime?: string | null
  nextExecutionAssignedUser?: { id?: number; display_name?: string } | null
}

export interface GrocyTask {
  taskId: number
  name: string
  description: string | null
  dueDate: string | null
  done: boolean
  categoryId?: number | null
}

export interface GrocyShoppingItem {
  id?: number
  productId: number
  amount: number
  note?: string
}

export type GrocyResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; statusCode?: number }

export interface GrocyAdapterConfig {
  baseUrl: string
  apiKey: string
  timeoutMs?: number
  operationAllowed?: () => Promise<boolean>
}

export class GrocyAdapter {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly operationAllowed?: () => Promise<boolean>

  constructor(config: GrocyAdapterConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "")
    this.apiKey = config.apiKey
    this.timeoutMs = config.timeoutMs ?? 5000
    this.operationAllowed = config.operationAllowed
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<GrocyResult<T>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetchOutbound(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          "GROCY-API-KEY": this.apiKey,
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
        operationAllowed: this.operationAllowed,
      })
      if (!res.ok) {
        return { ok: false, error: `Grocy HTTP ${res.status}`, statusCode: res.status }
      }
      if (res.status === 204) return { ok: true, data: undefined as T }
      const data = (await res.json()) as T
      return { ok: true, data }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Grocy request failed" }
    } finally {
      clearTimeout(timer)
    }
  }

  async getSystemInfo(): Promise<GrocyResult<{ grocy_version?: { Version?: string } }>> {
    return this.request("/api/system/info")
  }

  async getProducts(): Promise<GrocyResult<Map<number, string>>> {
    const res = await this.request<Array<{ id: number; name: string }>>("/api/objects/products")
    if (!res.ok) return res
    return { ok: true, data: new Map(res.data.map(p => [Number(p.id), String(p.name)])) }
  }

  async getCategories(): Promise<GrocyResult<Map<number, string>>> {
    const res = await this.request<Array<{ id: number; name: string }>>("/api/objects/task_categories")
    if (!res.ok) return res
    return { ok: true, data: new Map(res.data.map(c => [Number(c.id), String(c.name)])) }
  }

  async getChores(): Promise<GrocyResult<GrocyChore[]>> {
    const res = await this.request<Array<Record<string, unknown>>>("/api/chores")
    if (!res.ok) return res
    const now = Date.now()
    return {
      ok: true,
      data: res.data.map(raw => {
        const nextTime = typeof raw.next_estimated_execution_time === "string" ? raw.next_estimated_execution_time : null
        return {
          choreId: Number(raw.chore_id ?? raw.id),
          choreName: String(raw.chore_name ?? raw.name ?? ""),
          isOverdue: Boolean(nextTime && Date.parse(nextTime) < now),
          periodType: typeof raw.period_type === "string" ? raw.period_type : null,
          periodInterval: typeof raw.period_interval === "number" ? raw.period_interval : null,
          lastTrackedTime: typeof raw.last_tracked_time === "string" ? raw.last_tracked_time : null,
          nextEstimatedExecutionTime: nextTime,
          nextExecutionAssignedUser: (raw.next_execution_assigned_user as GrocyChore["nextExecutionAssignedUser"]) ?? null,
        }
      }),
    }
  }

  async getTasks(includeCompleted = false): Promise<GrocyResult<GrocyTask[]>> {
    const path = includeCompleted ? "/api/objects/tasks" : "/api/tasks"
    const res = await this.request<Array<Record<string, unknown>>>(path)
    if (!res.ok) return res
    return {
      ok: true,
      data: res.data.map(raw => ({
        taskId: Number(raw.id),
        name: String(raw.name ?? ""),
        description: typeof raw.description === "string" ? raw.description : null,
        dueDate: typeof raw.due_date === "string" ? raw.due_date : null,
        done: Boolean(Number(raw.done ?? 0)),
        categoryId: raw.category_id != null ? Number(raw.category_id) : null,
      })),
    }
  }

  async getShoppingList(): Promise<GrocyResult<GrocyShoppingItem[]>> {
    const res = await this.request<Array<Record<string, unknown>>>("/api/objects/shopping_list")
    if (!res.ok) return res
    return {
      ok: true,
      data: res.data.map(raw => ({
        id: raw.id != null ? Number(raw.id) : undefined,
        productId: Number(raw.product_id ?? 0),
        amount: Number(raw.amount ?? 1),
        note: typeof raw.note === "string" ? raw.note : undefined,
      })),
    }
  }

  async trackChoreExecution(choreId: number | string): Promise<GrocyResult<unknown>> {
    return this.request(`/api/chores/${encodeURIComponent(String(choreId))}/execute`, {
      method: "POST",
      body: JSON.stringify({}),
    })
  }

  async markTaskCompleted(taskId: number | string): Promise<GrocyResult<unknown>> {
    return this.request(`/api/tasks/${encodeURIComponent(String(taskId))}/complete`, {
      method: "POST",
      body: JSON.stringify({}),
    })
  }

  async clearShoppingList(listId = 1): Promise<GrocyResult<unknown>> {
    return this.request("/api/stock/shoppinglist/clear", {
      method: "POST",
      body: JSON.stringify({ list_id: listId }),
    })
  }

  async createTask(
    name: string,
    options?: { description?: string | null; dueDate?: string | null; categoryId?: number | null },
  ): Promise<GrocyResult<{ created_object_id?: number }>> {
    return this.request("/api/objects/tasks", {
      method: "POST",
      body: JSON.stringify({
        name,
        ...(options?.description ? { description: options.description } : {}),
        ...(options?.dueDate ? { due_date: options.dueDate } : {}),
        ...(options?.categoryId != null ? { category_id: options.categoryId } : {}),
      }),
    })
  }
}
