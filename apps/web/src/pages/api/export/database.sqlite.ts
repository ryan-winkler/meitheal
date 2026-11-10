import { open } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import type { APIRoute } from "astro"
import { logApiError } from "@lib/api-logger"
import { exportFilename } from "@lib/export-filename"
import { apiProblem } from "@lib/api-response"
import { verifiedIngressUser } from "@lib/verified-ingress-user"

const noStore = { "cache-control": "no-store" }

function backupProblem(status: number, detail: string): Response {
  return apiProblem({ status, detail, extraHeaders: noStore })
}

export const GET: APIRoute = async ({ locals }) => {
  if (!verifiedIngressUser(locals)?.isAdmin) {
    return backupProblem(403, "Database download requires a verified Home Assistant administrator.")
  }

  const dbUrl = process.env.MEITHEAL_DB_URL ?? "file:./.data/meitheal.db"
  if (!dbUrl.startsWith("file:")) {
    return backupProblem(400, "Use your database host to back up a remote database.")
  }

  try {
    // Stream the existing file without holding a full database copy in server memory.
    const file = await open(path.resolve(dbUrl.slice("file:".length)), "r")
    return new Response(Readable.toWeb(file.createReadStream()) as ReadableStream<Uint8Array>, {
      headers: {
        ...noStore,
        "content-type": "application/x-sqlite3",
        "content-disposition": `attachment; filename="${exportFilename("Database", "db")}"`,
      },
    })
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") {
      return backupProblem(404, "Database file not found on the server.")
    }
    logApiError("export-database", "Failed to export database", error)
    return backupProblem(500, "Could not download the database.")
  }
}
