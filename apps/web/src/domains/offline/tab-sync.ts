import { currentOfflinePartition, offlinePartitionKey } from "./offline-store"
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
  partition: string
}

let channel: BroadcastChannel | null = null
let channelPartition = ""
let listener: ((msg: TabSyncMessage) => void) | undefined

/**
 * Initialize the BroadcastChannel for tab sync.
 * Call once per tab during app startup.
 */
export function initTabSync(): void {
  if (typeof BroadcastChannel === "undefined") return
  const partition = currentOfflinePartition()
  const key = partition ? offlinePartitionKey(partition) : ""
  if (key === channelPartition && channel) return
  channel?.close()
  channel = null
  channelPartition = key
  if (!key) return
  channel = new BroadcastChannel(`${CHANNEL_NAME}:${key}`)
  channel.onmessage = (event: MessageEvent<TabSyncMessage>) => {
    const current = currentOfflinePartition()
    if (current && event.data?.partition === offlinePartitionKey(current) && event.data.partition === channelPartition) listener?.(event.data)
  }
}

/**
 * Broadcast a sync message to other tabs.
 */
export function broadcastTabSync(type: TabSyncMessage["type"], payload?: Record<string, unknown>): void {
  initTabSync()
  if (!channel) return

  const message: TabSyncMessage = {
    type,
    payload,
    timestamp: Date.now(),
    partition: channelPartition,
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
  listener = callback
  initTabSync()
}

/**
 * Close the channel (cleanup).
 */
export function closeTabSync(): void {
  channel?.close()
  channel = null
  channelPartition = ""
  listener = undefined
}
