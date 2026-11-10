/**
 * Tab Sync — BroadcastChannel API for cross-tab state sync
 *
 * Enables multiple open tabs to stay in sync without page reload.
 * When a task is mutated in one tab, other tabs receive the event
 * and can refresh their data accordingly.
 *
 * Bounded context: offline (cross-tab coordination)
 */

const CHANNEL_NAME = "meitheal-tab-sync"

export interface TabSyncMessage {
  type: "task-created" | "task-updated" | "task-deleted" | "settings-changed" | "badge-update"
  payload: Record<string, unknown> | undefined
  timestamp: number
}

let channel: BroadcastChannel | null = null

/**
 * Initialize the BroadcastChannel for tab sync.
 * Call once per tab during app startup.
 */
export function initTabSync(): void {
  if (typeof BroadcastChannel === "undefined") return
  if (channel) return // Already initialized

  channel = new BroadcastChannel(CHANNEL_NAME)
}

/**
 * Broadcast a sync message to other tabs.
 */
export function broadcastTabSync(type: TabSyncMessage["type"], payload?: Record<string, unknown>): void {
  if (!channel) return

  const message: TabSyncMessage = {
    type,
    payload,
    timestamp: Date.now(),
  }

  try {
    channel.postMessage(message)
  } catch {
    // Channel closed or error — non-fatal
  }
}

/**
 * Listen for sync messages from other tabs.
 */
export function onTabSyncMessage(callback: (msg: TabSyncMessage) => void): void {
  if (!channel) return

  channel.onmessage = (event: MessageEvent<TabSyncMessage>) => {
    callback(event.data)
  }
}

/**
 * Close the channel (cleanup).
 */
export function closeTabSync(): void {
  channel?.close()
  channel = null
}
