import { createClientLogger } from "@lib/client-logger"
import { buildIngressPagePath } from "@lib/page-shell-links"
import { waitForFn } from "@lib/wait-for-fn"

const log = createClientLogger("tasks", "detail-handoff")

export function buildTaskPermalink(taskId: string): string {
  const url = new URL(buildIngressPagePath("/tasks"), window.location.origin)
  url.searchParams.set("open", taskId)
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

export function openTaskDetailHandoff(taskId: string): void {
  const normalizedTaskId = String(taskId).trim()
  if (!normalizedTaskId) return

  if (typeof window.openTaskDetail === "function") {
    window.openTaskDetail(normalizedTaskId)
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
