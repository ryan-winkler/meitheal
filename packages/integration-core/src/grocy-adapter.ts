/**
 * Grocy Adapter — Bidirectional Sync
 *
 * Full integration with Grocy REST API covering:
 *   - Stock management (checkStock, consumeItems, addToShoppingList)
 *   - Chores (getChores, trackChoreExecution, undoChoreExecution)
 *   - Tasks (getTasks, markTaskCompleted, undoTask)
 *   - Shopping List (getShoppingList)
 *   - System (getSystemInfo for connection testing)
 *
 * Follows the CalendarIntegrationAdapter pattern from integration-core.
 * Uses discriminated union GrocyResult<T> for typed error handling.
 *
 * @domain integrations
 * @bounded-context grocy
 */

import { fetchOutbound, OutboundUrlError } from "./outbound-fetch"

// --- Types: Core ---

export interface GrocyAdapterConfig {
  baseUrl: string
  apiKey: string
  timeoutMs?: number | undefined
  /** "manual" reports a redirect status without following it; defaults to "error". */
  redirect?: "error" | "manual" | undefined
}

export type GrocyErrorCode =
  | "timeout"
  | "unauthorized"
  | "invalid_request"
  | "service_unavailable"
  | "unknown"

export type GrocyResult<T> =
  | { ok: true; data: T }
  | { ok: false; errorCode: GrocyErrorCode; retryable: boolean; message: string }

// --- Types: Stock ---

export interface GrocyStockItem {
  productId: number
  name: string
  amount: number
  bestBeforeDate: string | null
}

export interface GrocyShoppingListItem {
  id?: number | undefined
  productId: number
  amount: number
  note?: string | undefined
  shoppingListId?: number | undefined
}

export interface GrocyConsumeRequest {
  productId: number
  amount: number
  transactionType?: "consume" | "spoiled" | undefined
}

// --- Types: Chores ---

export interface GrocyChore {
  choreId: number
  choreName: string
  lastTrackedTime: string | null
  nextEstimatedExecutionTime: string | null
  nextExecutionAssignedToUserId: number | null
  nextExecutionAssignedUser: { id: number; display_name: string } | null
  isOverdue: boolean
  isReassigned: boolean
  trackDateOnly: boolean
  periodType: string | null
  periodInterval: number | null
}

// --- Types: Tasks ---

export interface GrocyTask {
  taskId: number
  name: string
  description: string | null
  dueDate: string | null
  done: boolean
  doneTimestamp: string | null
  categoryId: number | null
  categoryName: string | null
  assignedToUserId: number | null
}

// --- Types: System ---

export interface GrocySystemInfo {
  grocyVersionInfo: {
    Version: string
    ReleaseDate: string
  }
  phpVersion: string
  sqliteVersion: string
  os: string
  client: string
}

// --- Error Classification (matches HA adapter pattern) ---

function classifyGrocyError(
  status: number
): Pick<Extract<GrocyResult<never>, { ok: false }>, "errorCode" | "retryable"> {
  if (status >= 300 && status < 400) {
    return { errorCode: "invalid_request", retryable: false }
  }
  if (status === 401 || status === 403) {
    return { errorCode: "unauthorized", retryable: false }
  }
  if (status === 400 || status === 422) {
    return { errorCode: "invalid_request", retryable: false }
  }
  if (status === 429) {
    return { errorCode: "service_unavailable", retryable: true }
  }
  if (status >= 500) {
    return { errorCode: "service_unavailable", retryable: true }
  }
  return { errorCode: "unknown", retryable: true }
}

// --- URL Safety ---

export type GrocyUrlValidationResult =
  | { ok: true; normalizedUrl: string }
  | { ok: false; error: string }

const BLOCKED_EXACT_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::",
  "::1",
  "0:0:0:0:0:0:0:0",
  "0:0:0:0:0:0:0:1",
  "169.254.169.254",
  "100.100.100.200",
  "172.30.32.2",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "metadata.internal",
  "instance-data",
  "instance-data.ec2.internal",
  "supervisor",
  "supervisor.internal",
  "hassio",
  "hassio.internal",
])

const BLOCKED_DOMAIN_SUFFIXES = [
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
  "metadata.internal",
  "instance-data",
  "ec2.internal",
  "hass.io",
]

function stripTrailingDots(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 46) {
    end--
  }
  return end === value.length ? value : value.slice(0, end)
}

/** Normalize a hostname by trimming, lowercasing, unbracketing IPv6 literals, and stripping trailing dots. */
export function normalizeNetworkHost(rawHostname: string): string {
  const trimmed = rawHostname.trim().toLowerCase()
  const unbracketed = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed
  return stripTrailingDots(unbracketed)
}

function isAsciiDigits(value: string): boolean {
  if (value.length === 0 || value.length > 3) return false
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 48 || code > 57) return false
  }
  return true
}

function isAsciiHexGroup(value: string): boolean {
  if (value.length === 0 || value.length > 4) return false
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    const isDigit = code >= 48 && code <= 57
    const isLowerHex = code >= 97 && code <= 102
    if (!isDigit && !isLowerHex) return false
  }
  return true
}

function parseDottedIpv4Octets(value: string): number[] | null {
  const parts = value.split(".")
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!isAsciiDigits(part)) return null
    const num = Number.parseInt(part, 10)
    if (num < 0 || num > 255) return null
    octets.push(num)
  }
  return octets
}

function parseHexGroups(segment: string): number[] | null {
  if (!segment) return []
  const parts = segment.split(":")
  const groups: number[] = []
  for (const part of parts) {
    if (!isAsciiHexGroup(part)) return null
    groups.push(Number.parseInt(part, 16))
  }
  return groups
}

function parseIpv6Hextets(host: string): number[] | null {
  if (!host || host.includes("%")) return null

  const lastColon = host.lastIndexOf(":")
  const tail = host.slice(lastColon + 1)
  let expandedAddr = host
  if (tail.includes(".")) {
    const octets = parseDottedIpv4Octets(tail)
    if (!octets) return null
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16)
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16)
    expandedAddr = `${host.slice(0, lastColon + 1)}${hi}:${lo}`
  }

  const compressed = expandedAddr.split("::")
  if (compressed.length > 2) return null

  const left = parseHexGroups(compressed[0]!)
  if (!left) return null

  if (compressed.length === 1) {
    return left.length === 8 ? left : null
  }

  const right = parseHexGroups(compressed[1]!)
  if (!right) return null

  const total = left.length + right.length
  if (total >= 8) return null

  const zeros = new Array<number>(8 - total).fill(0)
  return [...left, ...zeros, ...right]
}

function hextetsToIpv4(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
}

function isAllZeroHextets(h: number[], start: number, endExclusive: number): boolean {
  for (let i = start; i < endExclusive; i++) {
    if (h[i] !== 0) return false
  }
  return true
}

function isIsatapHextets(h: number[]): boolean {
  return (h[4]! & 0xfdff) === 0 && h[5] === 0x5efe
}

/** True when an IPv6 literal embeds or translates an IPv4 target (mapped, SIIT, NAT64, 6to4, ISATAP). */
export function isIpv4TranslationIpv6Host(host: string): boolean {
  if (!host.includes(":")) return false
  const h = parseIpv6Hextets(host)
  if (!h) return true
  if (isAllZeroHextets(h, 0, 5) && h[5] === 0xffff) return true
  if (isAllZeroHextets(h, 0, 4) && h[4] === 0xffff && h[5] === 0) return true
  if (h[0] === 0x0064 && h[1] === 0xff9b) return true
  return h[0] === 0x2002 || isIsatapHextets(h)
}

function classifyEmbeddedIpv6Prefix(h: number[]): "unconditional" | "private" | null | undefined {
  if (isAllZeroHextets(h, 0, 5)) {
    if (h[5] === 0xffff) return classifyNetworkHost(hextetsToIpv4(h[6]!, h[7]!))
    if (h[5] === 0) return "unconditional"
  }
  if (isAllZeroHextets(h, 0, 4) && h[4] === 0xffff && h[5] === 0) {
    return "unconditional"
  }
  if (h[0] === 0x0064 && h[1] === 0xff9b) {
    return isAllZeroHextets(h, 2, 6) ? classifyNetworkHost(hextetsToIpv4(h[6]!, h[7]!)) : "unconditional"
  }
  return undefined
}

function classifyGlobalUnicastIpv6(h: number[]): "unconditional" | "private" | null {
  if (h[0] === 0x2002) {
    return "unconditional"
  }
  const isReserved2001 = h[0] === 0x2001 && (h[1]! < 0x0200 || h[1] === 0x0db8)
  const isReservedDocOrAs112 =
    (h[0]! & 0xfff0) === 0x3ff0 || (h[0] === 0x2620 && h[1] === 0x004f && h[2] === 0x8000)
  return isReserved2001 || isReservedDocOrAs112 ? "unconditional" : null
}

function classifyIpv6Host(host: string): "unconditional" | "private" | null {
  const h = parseIpv6Hextets(host)
  if (!h) {
    return "unconditional"
  }
  const embedded = classifyEmbeddedIpv6Prefix(h)
  if (embedded !== undefined) {
    return embedded
  }
  if (isIsatapHextets(h)) {
    return "unconditional"
  }
  if (h[0] === 0xfd00 && h[1] === 0x0ec2 && isAllZeroHextets(h, 2, 7) && h[7] === 0x0254) {
    return "unconditional"
  }
  if ((h[0]! & 0xfe00) === 0xfc00) {
    return "private"
  }
  if ((h[0]! & 0xe000) === 0x2000) {
    return classifyGlobalUnicastIpv6(h)
  }
  return "unconditional"
}

function isSpecialPurposeIpv4(o: number[]): boolean {
  if (o[0] === 0 || o[0] === 127 || o[0]! >= 224) return true
  if (o[0] === 169 && o[1] === 254) return true
  if (o[0] === 192 && o[1] === 0 && (o[2] === 0 || o[2] === 2)) return true
  if (o[0] === 198 && (o[1] === 18 || o[1] === 19 || (o[1] === 51 && o[2] === 100))) return true
  return o[0] === 203 && o[1] === 0 && o[2] === 113
}

function classifyIpv4Octets(o: number[]): "unconditional" | "private" | null {
  if (isSpecialPurposeIpv4(o)) {
    return "unconditional"
  }
  const isPrivateOrShared =
    o[0] === 10 ||
    (o[0] === 100 && o[1]! >= 64 && o[1]! <= 127) ||
    (o[0] === 172 && o[1]! >= 16 && o[1]! <= 31) ||
    (o[0] === 192 && o[1] === 168)
  return isPrivateOrShared ? "private" : null
}

function unwrapEmbeddedIpv4OrSelf(canonicalHost: string): string {
  if (!canonicalHost.includes(":")) return canonicalHost
  const h = parseIpv6Hextets(canonicalHost)
  if (!h) return canonicalHost
  if (isAllZeroHextets(h, 0, 5) && h[5] === 0xffff) {
    return hextetsToIpv4(h[6]!, h[7]!)
  }
  if (h[0] === 0x0064 && h[1] === 0xff9b && isAllZeroHextets(h, 2, 6)) {
    return hextetsToIpv4(h[6]!, h[7]!)
  }
  return canonicalHost
}

function configuredSupervisorCanonicalHost(): string {
  const raw = process.env.SUPERVISOR_URL
  if (!raw) return ""
  try {
    return canonicalizeNetworkHost(new URL(raw).hostname) ?? ""
  } catch {
    return ""
  }
}

/**
 * Canonicalize a standalone host string through WHATWG URL parsing while rejecting
 * zone IDs, ports, credentials, paths, queries, fragments, empty labels, and invalid host syntax.
 */
export function canonicalizeNetworkHost(rawHostname: string): string | null {
  const trimmed = rawHostname.trim().toLowerCase()
  if (!trimmed || trimmed.includes("%") || /[/?#@\\]/.test(trimmed)) return null
  if (trimmed.startsWith("[") && (!trimmed.endsWith("]") || !trimmed.slice(1, -1).includes(":"))) {
    return null
  }
  if (!trimmed.includes(":") && (trimmed.startsWith(".") || trimmed.includes(".."))) {
    return null
  }
  const candidate = trimmed.includes(":") && !trimmed.startsWith("[") ? `[${trimmed}]` : trimmed
  let parsed: URL
  try {
    parsed = new URL(`http://${candidate}`)
  } catch {
    return null
  }
  if (parsed.port !== "") return null
  const host = normalizeNetworkHost(parsed.hostname.toLowerCase())
  return host || null
}

/**
 * Classify whether a URL hostname targets an unconditionally forbidden host/range
 * (loopback, unspecified, link-local, metadata, Supervisor, special-purpose) or a private/CGNAT network.
 */
export function classifyNetworkHost(rawHostname: string): "unconditional" | "private" | null {
  const host = canonicalizeNetworkHost(rawHostname)
  if (!host) return "unconditional"

  const supHost = configuredSupervisorCanonicalHost()
  if (supHost && unwrapEmbeddedIpv4OrSelf(host) === unwrapEmbeddedIpv4OrSelf(supHost)) {
    return "unconditional"
  }

  if (host.includes(":")) {
    return classifyIpv6Host(host)
  }

  if (
    BLOCKED_EXACT_HOSTS.has(host) ||
    BLOCKED_DOMAIN_SUFFIXES.some((suffix) => host.endsWith(`.${suffix}`))
  ) {
    return "unconditional"
  }

  const octets = parseDottedIpv4Octets(host)
  return octets ? classifyIpv4Octets(octets) : null
}

/**
 * Validate a user-supplied Grocy base URL against unsafe schemes, embedded credentials,
 * loopback/metadata addresses, and private network ranges (unless explicitly `.internal`,
 * never exempting metadata hosts or loopback addresses).
 */
export function validateGrocyBaseUrl(rawUrl: string): GrocyUrlValidationResult {
  const trimmed = rawUrl.trim()
  if (!trimmed) {
    return { ok: false, error: "Invalid URL format" }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: "Invalid URL format" }
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Invalid URL scheme — only http: and https: are allowed" }
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: "Grocy URL must not include embedded credentials" }
  }

  if (parsed.search || parsed.hash) {
    return { ok: false, error: "Grocy URL must not include query parameters or fragments" }
  }

  const host = canonicalizeNetworkHost(parsed.hostname)
  if (!host) {
    return { ok: false, error: "Invalid URL format" }
  }
  const classification = classifyNetworkHost(host)

  if (classification === "unconditional" || (classification === "private" && !host.endsWith(".internal"))) {
    return { ok: false, error: "URL points to a private/internal network address" }
  }

  return { ok: true, normalizedUrl: parsed.toString().replace(/\/$/, "") }
}

// --- Adapter ---

export class GrocyAdapter {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly redirect: "error" | "manual"

  constructor(config: GrocyAdapterConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "")
    this.apiKey = config.apiKey
    this.timeoutMs = config.timeoutMs ?? 8_000
    this.redirect = config.redirect ?? "error"
  }

  // ═══════ System ═══════

  /**
   * GET /api/system/info — connection test + version info.
   */
  async getSystemInfo(): Promise<GrocyResult<GrocySystemInfo>> {
    return this.request<GrocySystemInfo>("GET", "/api/system/info", undefined, (raw) => {
      const r = raw as Record<string, unknown>
      const versionInfo = r.grocy_version_info as Record<string, string> | undefined
      return {
        grocyVersionInfo: {
          Version: versionInfo?.Version ?? "unknown",
          ReleaseDate: versionInfo?.ReleaseDate ?? "unknown",
        },
        phpVersion: String(r.php_version ?? "unknown"),
        sqliteVersion: String(r.sqlite_version ?? "unknown"),
        os: String(r.os ?? "unknown"),
        client: String(r.client ?? "unknown"),
      }
    })
  }

  // ═══════ Chores ═══════

  /**
   * GET /api/chores — returns all chores with current execution status.
   * Filtered to show actionable items (due/overdue or upcoming).
   */
  async getChores(): Promise<GrocyResult<GrocyChore[]>> {
    return this.request<GrocyChore[]>("GET", "/api/chores", undefined, (raw) => {
      const items = Array.isArray(raw) ? raw : []
      return items.map((item: Record<string, unknown>) => ({
        choreId: Number(item.chore_id ?? item.id ?? 0),
        choreName: String(item.chore_name ?? item.name ?? ""),
        lastTrackedTime: item.last_tracked_time ? String(item.last_tracked_time) : null,
        nextEstimatedExecutionTime: item.next_estimated_execution_time
          ? String(item.next_estimated_execution_time)
          : null,
        nextExecutionAssignedToUserId: item.next_execution_assigned_to_user_id
          ? Number(item.next_execution_assigned_to_user_id)
          : null,
        nextExecutionAssignedUser: item.next_execution_assigned_user
          ? {
              id: Number((item.next_execution_assigned_user as Record<string, unknown>).id),
              display_name: String(
                (item.next_execution_assigned_user as Record<string, unknown>).display_name ?? ""
              ),
            }
          : null,
        isOverdue: item.is_overdue === true || item.is_overdue === 1,
        isReassigned: item.is_reassigned === true || item.is_reassigned === 1,
        trackDateOnly: item.track_date_only === true || item.track_date_only === 1,
        periodType: item.period_type ? String(item.period_type) : null,
        periodInterval: item.period_interval ? Number(item.period_interval) : null,
      }))
    })
  }

  /**
   * POST /api/chores/{choreId}/execute — mark a chore as done.
   * Optionally pass tracked_time (ISO datetime) and done_by (user ID).
   */
  async trackChoreExecution(
    choreId: number,
    options?: { trackedTime?: string; doneBy?: number; skipped?: boolean }
  ): Promise<GrocyResult<{ choreId: number; executionId: number | null }>> {
    return this.request(
      "POST",
      `/api/chores/${choreId}/execute`,
      {
        tracked_time: options?.trackedTime ?? new Date().toISOString().replace("T", " ").slice(0, 19),
        ...(options?.doneBy ? { done_by: options.doneBy } : {}),
        ...(options?.skipped ? { skipped: true } : {}),
      },
      (raw) => {
        const r = raw as Record<string, unknown> | undefined
        return {
          choreId,
          executionId: r?.id ? Number(r.id) : null,
        }
      }
    )
  }

  /**
   * POST /api/chores/executions/{executionId}/undo — undo a chore execution.
   */
  async undoChoreExecution(executionId: number): Promise<GrocyResult<void>> {
    return this.request("POST", `/api/chores/executions/${executionId}/undo`) as Promise<
      GrocyResult<void>
    >
  }

  // ═══════ Tasks ═══════

  /**
   * GET /api/tasks — returns all Grocy tasks (not chores).
   * Use query param ?filter=done=0 for incomplete tasks only.
   */
  async getTasks(includeCompleted = false): Promise<GrocyResult<GrocyTask[]>> {
    // Grocy generic entity filter: ?query%5B%5D=done%3D0 filters to incomplete tasks
    const queryPath = includeCompleted
      ? "/api/tasks"
      : "/api/tasks?query%5B%5D=done%3D0"
    return this.request<GrocyTask[]>("GET", queryPath, undefined, (raw) => {
      const items = Array.isArray(raw) ? raw : []
      return items
        .filter((item: Record<string, unknown>) =>
          // Client-side filter as fallback — some Grocy versions ignore query params
          includeCompleted ? true : item.done !== 1 && item.done !== true
        )
        .map((item: Record<string, unknown>) => ({
          taskId: Number(item.id ?? 0),
          name: String(item.name ?? ""),
          description: item.description ? String(item.description) : null,
          dueDate: item.due_date ? String(item.due_date) : null,
          done: item.done === 1 || item.done === true,
          doneTimestamp: item.done_timestamp ? String(item.done_timestamp) : null,
          categoryId: item.category_id ? Number(item.category_id) : null,
          categoryName: null, // Resolved separately if needed
          assignedToUserId: item.assigned_to_user_id ? Number(item.assigned_to_user_id) : null,
        }))
    })
  }

  /**
   * POST /api/tasks/{taskId}/complete — mark a Grocy task as completed.
   */
  async markTaskCompleted(
    taskId: number,
    doneTime?: string
  ): Promise<GrocyResult<{ taskId: number }>> {
    return this.request(
      "POST",
      `/api/tasks/${taskId}/complete`,
      {
        done_time: doneTime ?? new Date().toISOString().replace("T", " ").slice(0, 19),
      },
      () => ({ taskId })
    )
  }

  /**
   * POST /api/tasks/{taskId}/undo — undo task completion.
   */
  async undoTask(taskId: number): Promise<GrocyResult<void>> {
    return this.request("POST", `/api/tasks/${taskId}/undo`) as Promise<GrocyResult<void>>
  }

  // ═══════ Stock (existing methods) ═══════

  /**
   * Check stock levels for given product names.
   * GET /api/stock — returns all stock items, filtered by names.
   */
  async checkStock(productNames: string[]): Promise<GrocyResult<GrocyStockItem[]>> {
    return this.request<GrocyStockItem[]>("GET", "/api/stock", undefined, (raw) => {
      const items = Array.isArray(raw) ? raw : []
      const lowerNames = productNames.map((n) => n.toLowerCase())
      return items
        .filter((item: Record<string, unknown>) => {
          const product = item.product as Record<string, unknown> | undefined
          const name = typeof product?.name === "string" ? product.name.toLowerCase() : ""
          return lowerNames.some((ln) => name.includes(ln))
        })
        .map((item: Record<string, unknown>) => ({
          productId: item.product_id as number,
          name: (item.product as Record<string, unknown>)?.name as string,
          amount: item.amount as number,
          bestBeforeDate: (item.best_before_date as string) ?? null,
        }))
    })
  }

  /**
   * POST /api/stock/shoppinglist/clear — remove all items from a shopping list.
   * Called when the "Go Shopping" task is marked done in Meitheal.
   */
  async clearShoppingList(listId = 1): Promise<GrocyResult<void>> {
    return this.request("POST", "/api/stock/shoppinglist/clear", {
      list_id: listId,
    }) as Promise<GrocyResult<void>>
  }

  /**
   * POST /api/objects/tasks — create a new task in Grocy.
   * Used for outbound sync when a new task is created in Meitheal (bidirectional mode).
   */
  async createTask(
    name: string,
    options?: { description?: string; dueDate?: string; categoryId?: number }
  ): Promise<GrocyResult<{ taskId: number }>> {
    return this.request(
      "POST",
      "/api/objects/tasks",
      {
        name,
        description: options?.description ?? "",
        due_date: options?.dueDate ?? null,
        category_id: options?.categoryId ?? null,
        done: 0,
      },
      (raw) => {
        const r = raw as Record<string, unknown>
        return { taskId: Number(r.created_object_id ?? r.id ?? 0) }
      }
    )
  }

  /**
   * Add items to Grocy shopping list.
   * POST /api/stock/shoppinglist/add-product — one per item.
   */
  async addToShoppingList(
    items: GrocyShoppingListItem[]
  ): Promise<GrocyResult<{ added: number }>> {
    let added = 0
    for (const item of items) {
      const result = await this.request("POST", "/api/stock/shoppinglist/add-product", {
        product_id: item.productId,
        amount: item.amount,
        note: item.note ?? "",
        list_id: item.shoppingListId ?? 1,
      })
      if (!result.ok) return result as GrocyResult<{ added: number }>
      added++
    }
    return { ok: true, data: { added } }
  }

  /**
   * Consume stock items.
   * POST /api/stock/products/{id}/consume — one per item.
   */
  async consumeItems(items: GrocyConsumeRequest[]): Promise<GrocyResult<{ consumed: number }>> {
    let consumed = 0
    for (const item of items) {
      const result = await this.request(
        "POST",
        `/api/stock/products/${item.productId}/consume`,
        {
          amount: item.amount,
          transaction_type: item.transactionType ?? "consume",
        }
      )
      if (!result.ok) return result as GrocyResult<{ consumed: number }>
      consumed++
    }
    return { ok: true, data: { consumed } }
  }

  /**
   * GET /api/objects/products — returns a Map of productId → product name.
   * Used to resolve productId references in shopping list to human-readable names.
   */
  async getProducts(): Promise<GrocyResult<Map<number, string>>> {
    return this.request<Map<number, string>>(
      "GET",
      "/api/objects/products",
      undefined,
      (raw) => {
        const items = Array.isArray(raw) ? raw : []
        const map = new Map<number, string>()
        for (const item of items) {
          const r = item as Record<string, unknown>
          map.set(Number(r.id ?? 0), String(r.name ?? `Product #${r.id}`))
        }
        return map
      }
    )
  }

  /**
   * Get current shopping list contents.
   * GET /api/objects/shopping_list
   */
  async getShoppingList(
    listId?: number
  ): Promise<GrocyResult<GrocyShoppingListItem[]>> {
    return this.request<GrocyShoppingListItem[]>(
      "GET",
      "/api/objects/shopping_list",
      undefined,
      (raw) => {
        const items = Array.isArray(raw) ? raw : []
        return items
          .filter((item: Record<string, unknown>) =>
            listId ? item.shopping_list_id === listId : true
          )
          .map((item: Record<string, unknown>) => ({
            id: item.id as number,
            productId: item.product_id as number,
            amount: item.amount as number,
            note: (item.note as string) ?? undefined,
            shoppingListId: item.shopping_list_id as number,
          }))
      }
    )
  }

  // --- Internal HTTP helper ---

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    transform?: (raw: unknown) => T
  ): Promise<GrocyResult<T>> {
    const base = new URL(this.baseUrl)
    const baseOrigin = base.origin
    const basePrefix = base.pathname.replace(/\/+$/, "")
    const normalizedPath = path.startsWith("/") ? path : `/${path}`
    const url = new URL(`${basePrefix}${normalizedPath}`, baseOrigin)
    if (url.origin !== baseOrigin) {
      throw new Error(`Invalid Grocy API path: ${path}`)
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await fetchOutbound(url.href, {
        method,
        allowPrivate: true,
        redirect: this.redirect,
        signal: controller.signal,
        headers: {
          "GROCY-API-KEY": this.apiKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        const classification = classifyGrocyError(response.status)
        return {
          ok: false,
          ...classification,
          message: `Grocy ${method} ${path}: HTTP ${response.status}`,
        }
      }

      const rawText = await response.text()
      let raw: unknown = undefined
      if (rawText) {
        try {
          raw = JSON.parse(rawText)
        } catch {
          raw = rawText
        }
      }

      const data = transform ? transform(raw) : (raw as T)
      return { ok: true, data }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return {
          ok: false,
          errorCode: "timeout",
          retryable: true,
          message: `Grocy ${method} ${path}: timeout after ${this.timeoutMs}ms`,
        }
      }

      const cause = error instanceof Error ? error.cause : undefined
      if (error instanceof OutboundUrlError || cause instanceof OutboundUrlError) {
        const outboundErr = error instanceof OutboundUrlError ? error : (cause as OutboundUrlError)
        return {
          ok: false,
          errorCode: "invalid_request",
          retryable: false,
          message: outboundErr.message,
        }
      }

      return {
        ok: false,
        errorCode: "unknown",
        retryable: true,
        message: error instanceof Error ? error.message : "Unknown Grocy adapter error",
      }
    } finally {
      clearTimeout(timeout)
    }
  }
  /**
   * GET /api/objects/task_categories — returns a Map of categoryId → name.
   * Used to map Grocy task categories to Meitheal boards (#12).
   */
  async getCategories(): Promise<GrocyResult<Map<number, string>>> {
    return this.request<Map<number, string>>(
      "GET",
      "/api/objects/task_categories",
      undefined,
      (raw) => {
        const items = Array.isArray(raw) ? raw : []
        const map = new Map<number, string>()
        for (const item of items) {
          const r = item as Record<string, unknown>
          map.set(Number(r.id ?? 0), String(r.name ?? `Category #${r.id}`))
        }
        return map
      }
    )
  }

  /**
   * POST /api/objects/api_keys — create a new API key.
   * Used for auto-generating a key when Grocy addon is detected via HA (#15).
   * Note: requires an existing API key or session with admin access.
   */
  async createApiKey(): Promise<GrocyResult<{ apiKey: string }>> {
    return this.request(
      "POST",
      "/api/objects/api_keys",
      { key_type: "default" },
      (raw) => {
        const r = raw as Record<string, unknown>
        return { apiKey: String(r.created_object_id ?? r.api_key ?? "") }
      }
    )
  }
}

// Note: GrocyStockAdapter was a deprecated alias — removed in v0.3.x. Use GrocyAdapter directly.
