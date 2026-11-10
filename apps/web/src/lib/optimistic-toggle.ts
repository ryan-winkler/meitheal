/**
 * Optimistic UI Toggle — instant visual feedback for checkbox toggles
 *
 * @domain tasks
 * @bounded-context ui-optimism
 *
 * @kcs Immediately updates the DOM (checkbox state, row styling) on user
 * interaction, then calls the API in the background. If the API fails,
 * reverts the DOM and shows a retry toast.
 *
 * Usage:
 *   import { optimisticToggle } from "@lib/optimistic-toggle"
 *
 *   checkbox.addEventListener("change", (e) => {
 *     optimisticToggle({
 *       checkbox: e.target as HTMLInputElement,
 *       taskRow: row,
 *       taskId: "abc-123",
 *       newStatus: e.target.checked ? "complete" : "pending",
 *     })
 *   })
 */

import { showRetryToast } from "./toast"

export interface OptimisticToggleOptions {
  /** The checkbox input element */
  checkbox: HTMLInputElement
  /** The parent task row/card element for styling */
  taskRow: HTMLElement | null
  /** Task ID for the API call */
  taskId: string
  /** New status to set */
  newStatus: "complete" | "pending" | "active" | "backlog"
  /** Optional callback on success */
  onSuccess?: () => void
}

/**
 * Perform an optimistic status update:
 * 1. Immediately update DOM (check/uncheck, add/remove .task-done)
 * 2. Fire API PATCH in background
 * 3. On failure: revert DOM + show retry toast
 */
export async function optimisticToggle(opts: OptimisticToggleOptions): Promise<void> {
  const { checkbox, taskRow, taskId, newStatus, onSuccess } = opts
  const isDone = newStatus === "complete"

  // Step 1: Optimistic DOM update
  checkbox.checked = isDone
  if (taskRow) {
    taskRow.classList.toggle("task-done", isDone)
  }

  // Step 2: API call
  try {
    // P0 T3: Use bare path — Layout.astro monkey-patches fetch() with ingress prefix
    const res = await fetch(`/api/tasks/${taskId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    })

    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    onSuccess?.()
  } catch {
    // Step 3: Revert on failure
    checkbox.checked = !isDone
    if (taskRow) {
      taskRow.classList.toggle("task-done", !isDone)
    }

    showRetryToast(
      "Failed to update task — check your connection",
      () => optimisticToggle(opts),
    )
  }
}
