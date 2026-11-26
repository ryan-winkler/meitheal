import { getSyncQueueDepth } from "@domains/offline/offline-store"

export const OFFLINE_QUEUE_EVENT = "meitheal:offline-queue-changed"
export const countOfflineMutations = getSyncQueueDepth

export function buildOfflineSyncSummary(queued: number, synced: number): string {
  if (synced > 0) return `Synced ${synced} offline ${synced === 1 ? "change" : "changes"}`
  return queued > 0 ? `Offline · ${queued} pending` : "Offline"
}

let replay: Promise<{ synced: number; remaining: number; failed: number }> | undefined

export function replayOfflineMutations() {
  replay ??= runReplay().finally(() => { replay = undefined })
  return replay
}

async function runReplay() {
  const count = await getSyncQueueDepth()
  if (count === 0 || !navigator.onLine) return { synced: 0, remaining: count, failed: 0 }
  const { processSyncQueue } = await import("@domains/offline/sync-engine")
  const result = await processSyncQueue()
  return { synced: result.succeeded, remaining: await getSyncQueueDepth(), failed: result.failed }
}
