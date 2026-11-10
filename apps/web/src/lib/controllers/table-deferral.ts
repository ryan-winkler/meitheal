import { isDeferralTerminalStatus } from "@domains/tasks/persistence/task-deferral-status"
import { notifyTaskCountsChanged, readFreshDeferral } from "@lib/deferral-client"

/** Reconcile the rendered marker after a confirmed inline or bulk status write. */
export async function reconcileTableDeferral(row: HTMLElement, status: string, signal: AbortSignal): Promise<void> {
  notifyTaskCountsChanged(row.dataset.projectId)
  const id = row.dataset.id
  const badge = row.querySelector<HTMLElement>("[data-table-deferred]")
  if (!id || !badge || (badge.hidden && row.dataset.wasDeferred !== "true")) return
  row.dataset.wasDeferred = "true"
  if (isDeferralTerminalStatus(status)) badge.hidden = true
  try {
    const task = await readFreshDeferral(id, signal)
    if (row.isConnected && !signal.aborted && row.dataset.status === status) badge.hidden = task.deferred_at === null
  } catch {
    // A confirmed terminal response is sufficient to clear the badge with an older worker.
  }
}
