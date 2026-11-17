import { createClientLogger } from "@lib/client-logger"
import { buildIngressPagePath } from "@lib/page-shell-links"
import { waitForFn } from "@lib/wait-for-fn"
import { taskDetailPath } from "@lib/task-page-url"

const log = createClientLogger("tasks", "detail-handoff")

export type SearchDetailDismissal = "dismiss" | "discard" | "history"

export interface SearchDetailHandoff {
  onDismiss(reason: SearchDetailDismissal): void
}

/** Find the equivalent control in a board that replaced the focused control's DOM. */
export function findKanbanDetailFocus(board: ParentNode, previous: Element): HTMLElement | null {
  const laneId = previous.closest<HTMLElement>(".kanban-column")?.dataset.laneId
  if (!laneId) return null
  const lane = board.querySelector<HTMLElement>(`.kanban-column[data-lane-id="${CSS.escape(laneId)}"]`)
  if (!lane) return null
  const fallback = lane.querySelector<HTMLElement>(".kanban-column-header")
  const taskId = previous.closest<HTMLElement>(".kanban-card")?.dataset.id
  if (taskId) {
    const card = lane.querySelector(`.kanban-card[data-id="${CSS.escape(taskId)}"]`)
    const collapsed = card?.closest(".swimlane-collapsed")
    const control = previous.matches(".card-more-btn") ? ".card-more-btn" : ".card-open-btn"
    return (collapsed ?? card)?.querySelector<HTMLElement>(collapsed ? "button.swimlane-header" : control) ?? fallback
  }
  const group = previous.closest("button.swimlane-header")?.closest<HTMLElement>(".swimlane-group")?.dataset.swimlaneType
  if (group !== undefined) {
    return lane.querySelector<HTMLElement>(`.swimlane-group[data-swimlane-type="${CSS.escape(group)}"] button.swimlane-header`) ?? fallback
  }
  const direction = previous.closest<HTMLAnchorElement>("[data-kanban-page-lane]")?.rel
  if (direction) return lane.querySelector<HTMLElement>(`a[data-kanban-page-lane][rel="${CSS.escape(direction)}"]`) ?? fallback
  if (previous.hasAttribute("data-kanban-range")) return lane.querySelector<HTMLElement>("[data-kanban-range]") ?? fallback
  return fallback
}

export function buildTaskPath(taskId: string, commentId?: number): string {
  return taskDetailPath(taskId, commentId)
}

export function buildTaskPermalink(taskId: string, commentId?: number): string {
  return new URL(buildIngressPagePath(buildTaskPath(taskId, commentId)), window.location.origin).href
}

export function getLegacyTaskId(hash: string): string | null {
  if (!hash.startsWith("#task-")) return null
  const value = hash.slice("#task-".length)
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function openTaskDetailHandoff(taskId: string, search?: SearchDetailHandoff): void {
  const normalizedTaskId = String(taskId).trim()
  if (!normalizedTaskId) return

  if (typeof window.openTaskDetail === "function") {
    window.openTaskDetail(normalizedTaskId, undefined, search)
    return
  }

  if (search) {
    window.location.assign(buildTaskPermalink(normalizedTaskId))
    return
  }

  waitForFn<(id: string) => void>(
    "openTaskDetail",
    (openTaskDetail) => {
      openTaskDetail(normalizedTaskId)
    },
    1000,
  )

  window.setTimeout(() => {
    if (typeof window.openTaskDetail === "function") return

    log.warn("Falling back to hash-based task detail handoff", {
      taskId: normalizedTaskId,
    })
    window.location.hash = `task-${encodeURIComponent(normalizedTaskId)}`
  }, 1100)
}
