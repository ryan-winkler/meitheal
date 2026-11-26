/**
 * Shared board-scoped custom field contracts (browser & server safe).
 *
 * Keeps SQLite persistence strictly on the server while sharing field parsing,
 * setting key derivation, and card value safety across browser views.
 */

export type CustomFieldType = "text" | "number" | "url" | "select" | "date" | "checkbox"

export interface CustomFieldDef {
  name: string
  type: CustomFieldType | string
  options?: string[]
}

export const BUILT_IN_CUSTOM_FIELDS: readonly CustomFieldDef[] = [
  { name: "sprint", type: "text" },
  { name: "story_points", type: "number" },
]

export function kanbanCardFieldNames(fields: readonly CustomFieldDef[]): string[] {
  const names = new Map<string, string>()
  for (const { name } of [...BUILT_IN_CUSTOM_FIELDS, ...fields]) {
    const key = name.toLowerCase()
    if (!names.has(key)) names.set(key, name)
  }
  return [...names.values()]
}

export function cardCustomFieldLabel(name: string): string {
  return name === "sprint" ? "Sprint" : name === "story_points" ? "Story points" : name
}

export const VALID_CUSTOM_FIELD_TYPES = new Set<string>([
  "text", "number", "url", "select", "date", "checkbox",
])

export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: "Text",
  number: "Number",
  url: "URL",
  select: "Select",
  date: "Date",
  checkbox: "Checkbox",
}

export const MAX_KANBAN_CARD_CUSTOM_FIELDS = 4
export const KANBAN_CARD_FIELDS_PREFIX = "meitheal:kanban-card-fields:v1:"

export function boardCustomFieldsSettingKey(boardId: string): string {
  return !boardId || boardId === "household"
    ? "custom_fields"
    : `custom_fields:board:${boardId}`
}

export function normalizeCustomFieldDefs(raw: unknown): CustomFieldDef[] {
  let list: unknown = raw
  if (typeof list === "string") {
    try {
      list = JSON.parse(list)
    } catch {
      return []
    }
  }
  if (!Array.isArray(list)) return []

  const seen = new Set<string>()
  const defs: CustomFieldDef[] = []
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const rec = item as Record<string, unknown>
    const name = typeof rec.name === "string" ? rec.name.trim().slice(0, 60) : ""
    if (!name) continue
    const normKey = name.toLowerCase()
    if (seen.has(normKey)) continue
    seen.add(normKey)

    const rawType = typeof rec.type === "string" ? rec.type.trim().toLowerCase() : "text"
    const type = VALID_CUSTOM_FIELD_TYPES.has(rawType) ? rawType : "text"
    const def: CustomFieldDef = { name, type }

    if (type === "select" && Array.isArray(rec.options)) {
      const options: string[] = []
      const optSeen = new Set<string>()
      for (const opt of rec.options) {
        if (typeof opt !== "string") continue
        const trimmed = opt.trim().slice(0, 60)
        if (!trimmed || optSeen.has(trimmed)) continue
        optSeen.add(trimmed)
        options.push(trimmed)
        if (options.length >= 30) break
      }
      if (options.length > 0) def.options = options
    }
    defs.push(def)
    if (defs.length >= 40) break
  }
  return defs
}

export function formatCardCustomFieldValue(value: unknown, maxLength = 20): string | null {
  if (value === null || value === undefined || typeof value === "object") return null
  if (typeof value === "boolean") return value ? "Yes" : "No"
  const text = String(value).trim()
  if (!text || text === "[object Object]") return null
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

export function parseVisibleCardCustomFields(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null
  let parsed: unknown = raw
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  if (!Array.isArray(parsed)) return null
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of parsed) {
    if (typeof entry !== "string") continue
    const name = entry.trim().slice(0, 60)
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
    if (out.length >= MAX_KANBAN_CARD_CUSTOM_FIELDS) break
  }
  return out
}

export interface CustomFieldApiOptions {
  headers?: HeadersInit
  signal?: AbortSignal
}

let pendingCustomFieldMutation: Promise<void> = Promise.resolve()

function customFieldRequestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(10_000)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export async function fetchBoardCustomFieldDefs(
  options: CustomFieldApiOptions = {},
): Promise<CustomFieldDef[]> {
  const response = await fetch("/api/custom-fields", {
    cache: "no-store",
    signal: customFieldRequestSignal(options.signal),
    ...(options.headers ? { headers: options.headers } : {}),
  })
  if (!response.ok) {
    const err = new Error(`Custom fields could not load: ${response.status}`) as Error & { status?: number }
    err.status = response.status
    throw err
  }
  const data = await response.json().catch(() => null) as { fields?: unknown } | null
  return normalizeCustomFieldDefs(data?.fields)
}

export function updateBoardCustomFieldDefs(
  updater: (current: CustomFieldDef[]) => CustomFieldDef[],
  options: CustomFieldApiOptions = {},
): Promise<CustomFieldDef[]> {
  const run = async (): Promise<CustomFieldDef[]> => {
    const current = await fetchBoardCustomFieldDefs(options)
    options.signal?.throwIfAborted()
    const fields = normalizeCustomFieldDefs(updater(current))
    const headers = new Headers(options.headers)
    headers.set("content-type", "application/json")
    const response = await fetch("/api/custom-fields", {
      method: "PUT",
      headers,
      body: JSON.stringify({ fields }),
      signal: customFieldRequestSignal(options.signal),
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null
      const err = new Error(payload?.error ?? `Custom fields could not save: ${response.status}`) as Error & { status?: number }
      err.status = response.status
      throw err
    }
    if (typeof document !== "undefined") {
      document.dispatchEvent(new CustomEvent("meitheal:custom-fields-updated", { detail: { fields } }))
    }
    return fields
  }
  const mutation = pendingCustomFieldMutation.then(run, run)
  pendingCustomFieldMutation = mutation.then(() => undefined, () => undefined)
  return mutation
}
