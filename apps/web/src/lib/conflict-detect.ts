/**
 * Conflict Detection — Multi-tab optimistic locking via updatedAt guard
 *
 * Prevents write conflicts when multiple browser tabs or the HA Companion
 * app modify the same task simultaneously. Uses HTTP 409 Conflict responses
 * and BroadcastChannel to propagate stale warnings across tabs.
 *
 * Pattern:
 * 1. Client sends updatedAt with every PUT/PATCH request
 * 2. Server compares against DB value — rejects if stale (409)
 * 3. Client shows "Stale data" toast and auto-refreshes
 * 4. BroadcastChannel notifies other tabs of mutations
 *
 * @domain tasks
 * @bounded-context tasks (infrastructure)
 * @kcs Multi-tab safety: updatedAt acts as an optimistic lock version.
 *      If another tab updates the task between read and write, the
 *      server rejects with 409. Client auto-refreshes on conflict.
 */

import { createClientLogger } from "@lib/client-logger"

const log = createClientLogger("tasks", "conflict-detect")

const CHANNEL_NAME = "meitheal-task-mutations"

/** Shape of a mutation broadcast */
interface TaskMutation {
  type: "created" | "updated" | "deleted" | "completed"
  taskId: string
  updatedAt: string
  tabId: string
}

// Unique ID per tab for deduplication
const TAB_ID = typeof crypto !== "undefined" ? crypto.randomUUID() : "ssr"

let channel: BroadcastChannel | null = null

/**
 * Initialize the BroadcastChannel for cross-tab mutation notifications.
 * Safe to call multiple times — deduplicates.
 */
export function initConflictDetection(): void {
  if (typeof BroadcastChannel === "undefined") return
  if (channel) return

  try {
    channel = new BroadcastChannel(CHANNEL_NAME)
    channel.onmessage = (event: MessageEvent<TaskMutation>) => {
      const mutation = event.data
      if (mutation.tabId === TAB_ID) return // Ignore own mutations

      log.info("conflict-mutation-received", {
        message: `Tab ${mutation.tabId.slice(0, 8)} ${mutation.type} task ${mutation.taskId.slice(0, 8)}`,
      })

      // Dispatch a custom event so any listening controller can refresh
      document.dispatchEvent(
        new CustomEvent("meitheal:task-mutated", {
          detail: mutation,
        }),
      )
    }

    log.info("conflict-channel-open", {
      message: `BroadcastChannel "${CHANNEL_NAME}" open for tab ${TAB_ID.slice(0, 8)}`,
    })
  } catch (err) {
    log.error("conflict-channel-error", {
      message: `Failed to open BroadcastChannel: ${err}`,
    })
  }
}

/**
 * Broadcast a task mutation to all other tabs.
 */
export function broadcastMutation(
  type: TaskMutation["type"],
  taskId: string,
  updatedAt?: string,
): void {
  if (!channel) return

  const mutation: TaskMutation = {
    type,
    taskId,
    updatedAt: updatedAt ?? new Date().toISOString(),
    tabId: TAB_ID,
  }

  try {
    channel.postMessage(mutation)
  } catch {
    // Channel closed or dead — reinitialize
    channel = null
  }
}

/**
 * Check if a server response indicates a conflict (HTTP 409).
 * Returns true if the response was a conflict, false otherwise.
 * On conflict, dispatches a toast and triggers auto-refresh.
 */
export async function handleConflictResponse(
  response: Response,
  taskId: string,
): Promise<boolean> {
  if (response.status !== 409) return false

  log.warn("conflict-detected", {
    message: `Task ${taskId.slice(0, 8)} was modified by another tab/session. Refreshing...`,
  })

  // Dispatch a custom event for the UI to show a toast
  document.dispatchEvent(
    new CustomEvent("meitheal:conflict-detected", {
      detail: { taskId },
    }),
  )

  return true
}

/**
 * Clean up the BroadcastChannel on page unload.
 */
export function closeConflictDetection(): void {
  if (channel) {
    channel.close()
    channel = null
  }
}

/**
 * Get this tab's unique ID (for debugging).
 */
export function getTabId(): string {
  return TAB_ID
}
