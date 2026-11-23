import { normalizeEditableTaskType, type EditableTaskType } from "./task-editor-fields"

export interface TaskUrlPrefillDraft {
  title?: string
  description?: string
  priority?: number
  dueDate?: string
  taskType?: EditableTaskType
  parentId?: string
  areaId?: string
  projectId?: string
  labels?: string[]
  customFields?: Record<string, string | number | boolean>
}

export const TASK_URL_PREFILL_PARAMS = [
  "create",
  "v",
  "title",
  "description",
  "priority",
  "due_date",
  "task_type",
  "parent_id",
  "area_id",
  "project_id",
  "labels",
  "custom_fields",
] as const

const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,100}$/
const DUE_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))?)?$/
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"])

function isValidCalendarDueDate(raw: string): boolean {
  const trimmed = raw.trim()
  const match = DUE_DATE_RE.exec(trimmed)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return false
  }
  if (match[4] !== undefined) {
    const hour = Number(match[4])
    const minute = Number(match[5])
    const second = match[6] !== undefined ? Number(match[6]) : 0
    if (hour > 23 || minute > 59 || second > 59) return false
    if (match[8] !== undefined && (Number(match[8]) > 23 || Number(match[9]) > 59)) {
      return false
    }
  }
  return true
}

function sanitizeCustomFieldsRecord(parsed: unknown): Record<string, string | number | boolean> | undefined {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const out: Record<string, string | number | boolean> = {}
  let count = 0
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const key = k.trim().slice(0, 60)
    if (!key || BLOCKED_KEYS.has(key)) continue
    if (typeof v === "string") {
      out[key] = v.slice(0, 300)
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out[key] = v
    } else if (typeof v === "boolean") {
      out[key] = v
    } else {
      continue
    }
    count++
    if (count >= 8) break
  }
  return count > 0 ? out : undefined
}

function sanitizeIdParam(raw: string | null): string | undefined {
  const trimmed = raw?.trim()
  return trimmed && SAFE_ID_RE.test(trimmed) ? trimmed : undefined
}

function sanitizeLabelsParam(raw: string | null): string[] | undefined {
  if (!raw) return undefined
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(",")) {
    const label = part.trim().slice(0, 40)
    if (!label || seen.has(label)) continue
    seen.add(label)
    out.push(label)
    if (out.length >= 10) break
  }
  return out.length > 0 ? out : undefined
}

function sanitizeCustomFieldsParam(raw: string | null): Record<string, string | number | boolean> | undefined {
  if (!raw || raw.length > 4096) return undefined
  try {
    return sanitizeCustomFieldsRecord(JSON.parse(raw))
  } catch {
    return undefined
  }
}

export function parseTaskUrlPrefill(
  input: string | URLSearchParams,
  options?: { allowCustomFields?: boolean },
): TaskUrlPrefillDraft | null {
  const params = typeof input === "string" ? new URLSearchParams(input) : input
  if (params.get("create") !== "1") return null
  const version = params.get("v")
  if (version && version !== "1") return null

  const draft: TaskUrlPrefillDraft = {}
  const title = params.get("title")?.trim().slice(0, 500)
  if (title) draft.title = title

  const description = params.get("description")?.trim().slice(0, 10000)
  if (description) draft.description = description

  const rawPriority = params.get("priority")?.trim()
  if (rawPriority && /^[1-5]$/.test(rawPriority)) {
    draft.priority = Number(rawPriority)
  }

  const rawDue = params.get("due_date")?.trim()
  if (rawDue && isValidCalendarDueDate(rawDue)) {
    draft.dueDate = rawDue
  }

  const rawType = params.get("task_type")?.trim()
  if (rawType) {
    const normalized = normalizeEditableTaskType(rawType)
    if (normalized === rawType.toLowerCase()) draft.taskType = normalized
  }

  const parentId = sanitizeIdParam(params.get("parent_id"))
  if (parentId) draft.parentId = parentId

  const areaId = sanitizeIdParam(params.get("area_id"))
  if (areaId) draft.areaId = areaId

  const projectId = sanitizeIdParam(params.get("project_id"))
  if (projectId) draft.projectId = projectId

  const labels = sanitizeLabelsParam(params.get("labels"))
  if (labels) draft.labels = labels

  if (options?.allowCustomFields === true) {
    const customFields = sanitizeCustomFieldsParam(params.get("custom_fields"))
    if (customFields) draft.customFields = customFields
  }

  return draft
}

export function stripTaskUrlPrefillParams(url: URL): string {
  const cleaned = new URL(url.href)
  for (const key of TASK_URL_PREFILL_PARAMS) cleaned.searchParams.delete(key)
  return cleaned.pathname + cleaned.search + cleaned.hash
}

export function buildTaskPrefillUrl(currentHref: string, draft: TaskUrlPrefillDraft): string {
  const url = new URL(currentHref)
  for (const key of TASK_URL_PREFILL_PARAMS) url.searchParams.delete(key)
  url.searchParams.set("create", "1")
  url.searchParams.set("v", "1")
  if (draft.title?.trim()) url.searchParams.set("title", draft.title.trim().slice(0, 500))
  if (draft.description?.trim()) url.searchParams.set("description", draft.description.trim().slice(0, 10000))
  if (draft.priority && draft.priority >= 1 && draft.priority <= 5) {
    url.searchParams.set("priority", String(Math.round(draft.priority)))
  }
  if (draft.dueDate && isValidCalendarDueDate(draft.dueDate)) {
    url.searchParams.set("due_date", draft.dueDate.trim())
  }
  if (draft.taskType) url.searchParams.set("task_type", draft.taskType)
  if (draft.parentId && SAFE_ID_RE.test(draft.parentId)) url.searchParams.set("parent_id", draft.parentId)
  if (draft.areaId && SAFE_ID_RE.test(draft.areaId)) url.searchParams.set("area_id", draft.areaId)
  if (draft.projectId && SAFE_ID_RE.test(draft.projectId)) url.searchParams.set("project_id", draft.projectId)
  if (draft.labels && draft.labels.length > 0) {
    url.searchParams.set("labels", draft.labels.slice(0, 10).map(l => l.trim()).filter(Boolean).join(","))
  }
  const safeCustom = sanitizeCustomFieldsRecord(draft.customFields)
  if (safeCustom) {
    const serialized = JSON.stringify(safeCustom)
    if (serialized.length <= 4096) url.searchParams.set("custom_fields", serialized)
  }
  return url.toString()
}
