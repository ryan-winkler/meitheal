import { createClientLogger } from "@lib/client-logger"
import { buildIngressPagePath } from "@lib/page-shell-links"
import { waitForFn } from "@lib/wait-for-fn"

const log = createClientLogger("tasks", "detail-handoff")

export type SearchDetailDismissal = "dismiss" | "discard" | "history"

export interface SearchDetailHandoff {
  onDismiss(reason: SearchDetailDismissal): void
}

export function buildTaskPermalink(taskId: string, commentId?: number): string {
  const url = new URL(buildIngressPagePath("/tasks"), window.location.origin)
  url.searchParams.set("open", taskId)
  if (commentId !== undefined) url.searchParams.set("comment", String(commentId))
  return url.href
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
