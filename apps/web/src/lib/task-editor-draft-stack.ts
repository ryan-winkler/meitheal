/**
 * Bounded session-scoped stack for suspending an in-progress create/detail context
 * when launching child-task creation, and restoring it when the child flow closes.
 */
import type { EditableTaskType } from "./task-editor-fields"
import type { TaskDraftSnapshot } from "./task-draft-state"

const STACK_KEY = "meitheal:task-draft-stack:v1"
const MAX_STACK_DEPTH = 5

export interface TaskParentContext {
  parentId: string
  parentTitle: string
  parentTicketKey?: string | null
  parentType: EditableTaskType
  areaId?: string | null
  projectId?: string | null
}

export interface OpenNewTaskOptions {
  parent?: TaskParentContext
  taskType?: EditableTaskType
  title?: string
  description?: string
  priority?: number
  status?: string
  dueDate?: string
  labels?: string[]
  customFields?: Record<string, string | number | boolean>
  resumeOriginTaskId?: string
  areaId?: string | null
  projectId?: string | null
}

export interface TaskEditorStackEntry {
  snapshot?: TaskDraftSnapshot
  parentContext?: TaskParentContext
  resumeOriginTaskId?: string
  createdAt: number
}

function readStack(): TaskEditorStackEntry[] {
  try {
    const raw = sessionStorage.getItem(STACK_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.slice(-MAX_STACK_DEPTH) : []
  } catch {
    return []
  }
}

function writeStack(entries: TaskEditorStackEntry[]): void {
  try {
    if (entries.length === 0) sessionStorage.removeItem(STACK_KEY)
    else sessionStorage.setItem(STACK_KEY, JSON.stringify(entries.slice(-MAX_STACK_DEPTH)))
  } catch {
    // Ignore storage errors (private browsing / quota)
  }
}

export function pushTaskEditorDraft(entry: Omit<TaskEditorStackEntry, "createdAt">): void {
  const stack = readStack()
  stack.push({ ...entry, createdAt: Date.now() })
  writeStack(stack)
}

export function popTaskEditorDraft(): TaskEditorStackEntry | undefined {
  const stack = readStack()
  if (stack.length === 0) return undefined
  const last = stack.pop()
  writeStack(stack)
  return last
}

export function clearTaskEditorDraftStack(): void {
  writeStack([])
}
