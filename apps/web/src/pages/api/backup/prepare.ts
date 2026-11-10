import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { apiJson } from "../../../lib/api-response"
import { apiLogger } from "../../../lib/api-logger"

/** Flush committed WAL frames with wal_checkpoint(TRUNCATE), without pausing writes. */
export const POST: APIRoute = async () => {
  try {
    await ensureSchema()
    const result = await getPersistenceClient().execute("PRAGMA wal_checkpoint(TRUNCATE)")
    const row = result.rows[0]
    const busy = Number(row?.busy)
    const logFrames = Number(row?.log)
    const checkpointedFrames = Number(row?.checkpointed)

    if (![busy, logFrames, checkpointedFrames].every(Number.isInteger)) {
      return apiJson({ ok: false, errorCode: "BACKUP_CHECKPOINT_INVALID", error: "SQLite did not confirm a checkpoint." }, 503)
    }
    if (busy !== 0 || logFrames !== checkpointedFrames) {
      return apiJson({ ok: false, errorCode: "BACKUP_CHECKPOINT_BUSY", error: "SQLite is busy. Retry preparation or retain the WAL in the snapshot." }, 503)
    }

    return apiJson({ ok: true, checkpoint: "complete", log_frames: logFrames, checkpointed_frames: checkpointedFrames })
  } catch (error) {
    apiLogger.log("error", {
      event: "backup.checkpoint.failed", domain: "api", component: "backup",
      request_id: crypto.randomUUID(), message: "WAL checkpoint failed",
      metadata: { error: error instanceof Error ? error.message : String(error) },
    })
    return apiJson({ ok: false, errorCode: "BACKUP_CHECKPOINT_FAILED", error: "The database checkpoint failed. Keep the database and WAL together." }, 503)
  }
}
