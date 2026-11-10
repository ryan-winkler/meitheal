import type { ReadStream } from "node:fs"
import { mkdtemp, open, rm, stat, statfs } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import type { APIRoute } from "astro"
import { verifyCurrentHAAdministrator } from "@domains/ha/current-admin"
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
    return backupProblem(403, "Database download requires a verified Home Assistant administrator.")
  }

  const site = request.headers.get("sec-fetch-site")
  const mode = request.headers.get("sec-fetch-mode")
  // HTTP LAN browsers may omit Fetch Metadata. Every request still needs the
  // signed form from the verified administrator's Settings page.
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
  let stream: ReadStream | undefined

  async function cleanup() {
    try {
      if (snapshotDirectory) await rm(snapshotDirectory, { recursive: true, force: true })
    } catch (error) {
      logApiError("export-database", "Failed to remove the database snapshot", error)
    } finally {
      exportInProgress = false
    }
  }

  try {
    signal.throwIfAborted()
    const currentAdmin = await verifyCurrentHAAdministrator(user.id, signal)
    signal.throwIfAborted()
    if (currentAdmin === "unavailable") {
      return backupProblem(503, "Could not verify current administrator access with Home Assistant. Try again when it is available.")
    }
    if (currentAdmin === "denied") {
      return backupProblem(403, "Database download requires an active Home Assistant administrator.")
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

    signal.throwIfAborted()
    const file = await open(snapshotPath, "r")
    stream = file.createReadStream({ signal })
    stream.once("close", () => { void cleanup() })
    const body = Readable.toWeb(stream, {
      strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
    }) as ReadableStream<Uint8Array>
    return new Response(paceResponseBody(body, waitForDrain, signal), { headers })
  } catch (error) {
    stream?.destroy()
    if (signal.aborted) return backupProblem(499, "Database download was cancelled.")
    if (!snapshotDirectory && typeof error === "object" && error && "code" in error && error.code === "ENOENT") {
      return backupProblem(404, "Database file not found on the server.")
    }
    logApiError("export-database", "Failed to export database", error)
    return backupProblem(500, "Could not download the database.")
  } finally {
    if (!stream) await cleanup()
  }
}
