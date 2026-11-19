import type { FileHandle } from "node:fs/promises"
import { mkdtemp, open, rm, stat, statfs } from "node:fs/promises"
import path from "node:path"
import type { APIRoute } from "astro"
import { verifyCurrentHAOwner } from "@domains/ha/current-admin"
import { boardGrantStillCurrent, currentBoardGrantRevision } from "@domains/tasks/persistence/board-grant-fence"
import { ContinuityLockedError } from "@domains/tasks/persistence/continuity-client"
import { getPersistenceClient } from "@domains/tasks/persistence/store"
import { logApiError } from "@lib/api-logger"
import { readWithinLimit } from "@lib/bounded-body"
import { verifyDatabaseDownloadToken } from "@lib/database-download-token"
import { exportFilename } from "@lib/export-filename"
import { apiProblem } from "@lib/api-response"
import { verifiedIngressUser } from "@lib/verified-ingress-user"
import { getIngressTransport } from "../../../../scripts/ingress-transport.mjs"
import { paceResponseBody } from "@lib/response-backpressure"

const noStore = { "cache-control": "no-store" }
const formLimit = 256
let exportInProgress = false

function backupProblem(status: number, detail: string): Response {
  return apiProblem({ status, detail, extraHeaders: noStore })
}

export const ALL: APIRoute = () => apiProblem({
  status: 405,
  title: "Method Not Allowed",
  detail: "Start a database download from Meitheal Settings.",
  extraHeaders: { ...noStore, allow: "POST" },
})

export const POST: APIRoute = async ({ locals, request }) => {
  const user = verifiedIngressUser(locals)
  if (!user?.isAdmin) {
    return backupProblem(403, "Database download requires a verified Home Assistant owner.")
  }

  const site = request.headers.get("sec-fetch-site")
  const mode = request.headers.get("sec-fetch-mode")
  // HTTP LAN browsers may omit Fetch Metadata. Every request still needs the
  // signed form from the verified owner's Settings page.
  if ((site !== null && site !== "same-origin") || (mode !== null && mode !== "navigate")) {
    return backupProblem(403, "Start the database download in the same Home Assistant browser window.")
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") {
    return backupProblem(415, "Use the database download form in Meitheal Settings.")
  }
  if (Number(request.headers.get("content-length")) > formLimit) {
    return backupProblem(413, "The database download form exceeds 256 bytes.")
  }
  let form: URLSearchParams
  try {
    const body = await readWithinLimit(request.body, formLimit, request.signal)
    if (!body) return backupProblem(413, "The database download form exceeds 256 bytes.")
    form = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(body))
  } catch {
    if (request.signal.aborted) return backupProblem(499, "Database download was cancelled.")
    return backupProblem(400, "Could not read the database download form.")
  }
  const token = form.get("token")
  if (form.size !== 1 || !token || !verifyDatabaseDownloadToken(token, user.id)) {
    return backupProblem(403, "Refresh Meitheal Settings and start the database download again.")
  }

  const waitForDrain = getIngressTransport()?.waitForDatabaseDownloadDrain
  // Astro can resolve encoded aliases that did not get the wrapper's socket guard.
  if (!waitForDrain) return backupProblem(404, "Database download not found.")

  const dbUrl = process.env.MEITHEAL_DB_URL ?? "file:./.data/meitheal.db"
  if (!dbUrl.startsWith("file:")) {
    return backupProblem(400, "Use your database host to back up a remote database.")
  }
  if (exportInProgress) {
    return backupProblem(409, "A database download is in progress. Try again when it finishes.")
  }

  const dbPath = path.resolve(dbUrl.slice("file:".length))
  const directory = path.dirname(dbPath)
  const signal = request.signal
  exportInProgress = true
  let snapshotDirectory: string | undefined
  let file: FileHandle | undefined
  let streaming = false
  let cleanupPromise: Promise<void> | undefined
  let removeAbortListener = () => {}

  function cleanup(): Promise<void> {
    return cleanupPromise ??= (async () => {
      removeAbortListener()
      try {
        await file?.close()
        if (snapshotDirectory) await rm(snapshotDirectory, { recursive: true, force: true })
      } catch (error) {
        logApiError("export-database", "Failed to remove the database snapshot", error)
      } finally {
        exportInProgress = false
      }
    })()
  }

  try {
    signal.throwIfAborted()
    const client = getPersistenceClient()
    const revision = await currentBoardGrantRevision(client)
    if (!revision) throw new ContinuityLockedError()
    async function requireOriginalAuthority() {
      signal.throwIfAborted()
      if (!await boardGrantStillCurrent(client, revision!)) throw new ContinuityLockedError()
      signal.throwIfAborted()
    }
    const currentOwner = await verifyCurrentHAOwner(user.id, signal)
    signal.throwIfAborted()
    await requireOriginalAuthority()
    if (currentOwner === "unavailable") {
      return backupProblem(503, "Could not verify current owner access with Home Assistant. Try again when it is available.")
    }
    if (currentOwner === "denied") {
      return backupProblem(403, "Database download requires an active Home Assistant owner.")
    }
    if (!(await stat(dbPath)).isFile()) {
      return backupProblem(404, "Database file not found on the server.")
    }
    const headers = {
      ...noStore,
      "content-type": "application/x-sqlite3",
      "content-disposition": `attachment; filename="${exportFilename("Database", "db")}"`,
    }
    // Use the database volume so a Home Assistant tmpfs cannot hold the entire copy.
    snapshotDirectory = await mkdtemp(path.join(directory, ".meitheal-export-"))
    const snapshotPath = path.join(snapshotDirectory, "snapshot.tmp")
    const { backup, DatabaseSync } = await import("node:sqlite")
    const source = new DatabaseSync(dbPath, { readOnly: true })
    try {
      // Pin one WAL snapshot so writes on other connections cannot restart the copy.
      source.exec("BEGIN")
      if (source.prepare("SELECT 1 FROM task_boards WHERE id <> 'household' LIMIT 1").get()) {
        return backupProblem(403, "Download is unavailable for databases with named Boards. Use the Home Assistant backup controls.")
      }
      if (source.prepare("SELECT 1 FROM app_settings WHERE key = 'private_organization_data' LIMIT 1").get()) {
        return backupProblem(403, "Use Home Assistant backups for databases containing personal labels or restricted organization data.")
      }
      if (source.prepare(`SELECT 1 FROM organization_access_policies WHERE audience = 'selected' OR scope <> 'feature'
        UNION ALL SELECT 1 FROM home_assistant_task_areas
        UNION ALL SELECT 1 FROM pillars WHERE user_id <> 'default' LIMIT 1`).get()) {
        return backupProblem(403, "Use Home Assistant backups for databases with restricted organization data.")
      }
      const pages = Number(source.prepare("PRAGMA page_count").get()?.page_count)
      const pageSize = Number(source.prepare("PRAGMA page_size").get()?.page_size)
      const free = await statfs(directory)
      if (free.bavail * free.bsize < pages * pageSize) {
        return backupProblem(507, "There is not enough free space on the database volume for a download.")
      }
      signal.throwIfAborted()
      await backup(source, snapshotPath)
    } finally {
      source.close()
    }

    await requireOriginalAuthority()
    file = await open(snapshotPath, "r")
    await requireOriginalAuthority()
    let ended = false
    let streamController: ReadableStreamDefaultController<Uint8Array>
    async function finish(controller: ReadableStreamDefaultController<Uint8Array>, error?: unknown) {
      if (ended) return cleanup()
      ended = true
      await cleanup()
      if (error) controller.error(error)
      else controller.close()
    }
    // Read on demand, bounded to one chunk. Node's eager file stream can retain
    // snapshot bytes that were admitted before an asynchronous authority change.
    const body = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller },
      async pull(controller) {
        try {
          await requireOriginalAuthority()
          const chunk = Buffer.allocUnsafe(64 * 1024)
          const { bytesRead } = await file!.read(chunk, 0, chunk.byteLength, null)
          await requireOriginalAuthority()
          if (ended) return
          if (!bytesRead) return finish(controller)
          controller.enqueue(chunk.subarray(0, bytesRead))
        } catch (error) { await finish(controller, error) }
      },
      async cancel() {
        ended = true
        await cleanup()
      },
    }, { highWaterMark: 0 })
    const onAbort = () => { void finish(streamController, signal.reason ?? new Error("Database download was cancelled.")) }
    signal.addEventListener("abort", onAbort, { once: true })
    removeAbortListener = () => signal.removeEventListener("abort", onAbort)
    await requireOriginalAuthority()
    streaming = true
    return new Response(paceResponseBody(body, waitForDrain, signal), { headers })
  } catch (error) {
    if (signal.aborted) return backupProblem(499, "Database download was cancelled.")
    if (error instanceof ContinuityLockedError) return backupProblem(503, "Installation continuity or download authority changed. Start again only after current access is verified.")
    if (!snapshotDirectory && typeof error === "object" && error && "code" in error && error.code === "ENOENT") {
      return backupProblem(404, "Database file not found on the server.")
    }
    logApiError("export-database", "Failed to export database", error)
    return backupProblem(500, "Could not download the database.")
  } finally {
    if (!streaming) await cleanup()
  }
}
