import { createClientLogger } from "@lib/client-logger"
import { buildIngressPagePath } from "@lib/page-shell-links"
import { waitForFn } from "@lib/wait-for-fn"
import { taskDetailPath, type TaskLocator } from "@lib/task-page-url"

const log = createClientLogger("tasks", "detail-handoff")

export type SearchDetailDismissal = "dismiss" | "discard" | "history"

export interface SearchDetailHandoff {
  onDismiss(reason: SearchDetailDismissal): void
}

function matchingKanbanControl(scope: Element | null | undefined, previous: Element): HTMLElement | null {
  const matches = Array.from(scope?.querySelectorAll<HTMLElement>("a[href], button, [tabindex]") ?? [])
    .filter(element => element.localName === previous.localName && element.className === previous.className)
  return matches.length === 1 ? matches[0] ?? null : null
}

/** Find the equivalent shared card or lane control after a workspace refresh. */
export function findKanbanDetailFocus(board: ParentNode, previous: Element): HTMLElement | null {
  const laneId = previous.closest<HTMLElement>(".kanban-column")?.dataset.laneId
  const lane = laneId ? board.querySelector<HTMLElement>(`.kanban-column[data-lane-id="${CSS.escape(laneId)}"]`) : null
  const fallback = lane?.querySelector<HTMLElement>(".kanban-column-header") ?? null
  const taskId = previous.closest<HTMLElement>(".kanban-card")?.dataset.id
  if (taskId) {
    const selector = `.kanban-card[data-id="${CSS.escape(taskId)}"]`
    const card = lane?.querySelector(selector) ?? board.querySelector(selector)
    const collapsed = card?.closest(".swimlane-collapsed")
    if (collapsed) return collapsed.querySelector<HTMLElement>("button.swimlane-header") ?? fallback
    return matchingKanbanControl(card, previous) ?? card?.querySelector<HTMLElement>(".card-open-btn") ?? fallback
  }
  if (!lane) return null
  const group = previous.closest<HTMLElement>(".swimlane-group")?.dataset.swimlaneType
  if (group !== undefined) {
    const section = lane.querySelector(`.swimlane-group[data-swimlane-type="${CSS.escape(group)}"]`)
    return matchingKanbanControl(section, previous) ?? fallback
  }
  const direction = previous.closest<HTMLAnchorElement>("[data-kanban-page-lane]")?.rel
  if (direction) return lane.querySelector<HTMLElement>(`a[data-kanban-page-lane][rel="${CSS.escape(direction)}"]`) ?? fallback
  if (previous.hasAttribute("data-kanban-range")) return lane.querySelector<HTMLElement>("[data-kanban-range]") ?? fallback
  return matchingKanbanControl(lane, previous) ?? fallback
}

export function buildTaskPermalink(task: TaskLocator, commentId?: number): string {
  return new URL(buildIngressPagePath(taskDetailPath(task, commentId)), window.location.origin).href
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
