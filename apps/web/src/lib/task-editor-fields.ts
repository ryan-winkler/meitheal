/**
 * Shared metadata and field helpers for task creation and editing modals/sidebars.
 * Reuses domain hierarchy rules alongside client status and type-icon registries.
 */
import { ALLOWED_CHILD_TYPES } from "@meitheal/domain-tasks"
import { STATUS_CONFIG, normalizeStatus } from "./status-config"
import { TYPE_ICON_CONFIG, getTypeIconConfig, renderTypeIconSvg } from "./type-icon-config"

export type EditableTaskType = "epic" | "story" | "task"

export const TASK_TYPE_OPTIONS: readonly { value: EditableTaskType; label: string }[] = [
  { value: "task", label: "Task" },
  { value: "story", label: "Story" },
  { value: "epic", label: "Epic" },
] as const

export { ALLOWED_CHILD_TYPES, STATUS_CONFIG, TYPE_ICON_CONFIG, getTypeIconConfig, normalizeStatus, renderTypeIconSvg }

export function normalizeEditableTaskType(value: unknown): EditableTaskType {
  const key = String(value ?? "").trim().toLowerCase()
  return key === "epic" || key === "story" ? key : "task"
}

export function allowedChildTypesFor(parentType: unknown): readonly EditableTaskType[] {
  const parent = normalizeEditableTaskType(parentType)
  return (ALLOWED_CHILD_TYPES[parent] ?? ["task"]) as readonly EditableTaskType[]
}

export function defaultChildTaskType(parentType: unknown): EditableTaskType {
  return normalizeEditableTaskType(parentType) === "epic" ? "story" : "task"
}

/** Disable invalid child types when creating under an explicit parent, restoring all when standalone. */
export function syncTaskTypeSelect(select: HTMLSelectElement | null, parentType?: unknown): void {
  if (!select) return
  const allowed = parentType ? new Set<string>(allowedChildTypesFor(parentType)) : null
  for (const option of [...select.options]) {
    const ok = !allowed || allowed.has(option.value)
    option.disabled = !ok
    option.hidden = !ok
  }
  if (allowed && !allowed.has(select.value)) {
    select.value = defaultChildTaskType(parentType)
  }
}

export function formatTicketDisplay(ticketKey: unknown, title: unknown, id?: unknown): string {
  const key = typeof ticketKey === "string" && ticketKey.trim() ? ticketKey.trim() : ""
  const name = typeof title === "string" && title.trim() ? title.trim() : ""
  if (key && name) return `${key} · ${name}`
  if (name) return name
  if (key) return key
  return typeof id === "string" ? id.slice(0, 8) : "Task"
}
