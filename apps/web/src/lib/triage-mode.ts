import type { TaskRepository } from "@domains/tasks/persistence/task-repository"

export type TriageMode = "visible" | "hidden" | "disabled" | "unavailable"

export async function getTriageMode(repo: Pick<TaskRepository, "getSettings">): Promise<TriageMode> {
  try {
    const settings = await repo.getSettings(["backlog_mode"])
    if (settings.backlog_mode === undefined) return "visible"
    const mode: unknown = JSON.parse(settings.backlog_mode)
    if (mode === "visible" || mode === "hidden" || mode === "disabled") return mode
  } catch {
    // A failed or invalid setting cannot expose the queue.
  }
  return "unavailable"
}
