import { createClientLogger } from "@lib/client-logger"
import { waitForFn } from "@lib/wait-for-fn"

const log = createClientLogger("tasks", "detail-handoff")

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
    window.location.hash = `task-${normalizedTaskId}`
  }, 1100)
}
