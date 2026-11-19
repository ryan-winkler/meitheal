import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test as base, type APIRequestContext, type Page } from "@playwright/test"
import { currentBoardWriteHeaders } from "./current-board-http"

type AssigneeFixture = {
  app: string
  page: Page
  request: APIRequestContext
  headers: Record<string, string>
  setStoredAssignee: (id: string, assignee: string | null) => void
}

export const test = base.extend<{ assigneeFixture: AssigneeFixture }>({
  assigneeFixture: async ({ browser }, use) => {
    const work = await mkdtemp(join(tmpdir(), "meitheal-assignee-fixture-"))
    const reservation = createServer().listen(0, "127.0.0.1")
    await once(reservation, "listening")
    const address = reservation.address()
    if (!address || typeof address === "string") throw new Error("Fixture port did not bind")
    const { port } = address
    await new Promise<void>((done, reject) => reservation.close(error => error ? reject(error) : done()))
    const app = `http://127.0.0.1:${port}`
    const dbPath = join(work, "assignees.db")
    const child = spawn(process.execPath, ["scripts/serve.mjs"], {
      cwd: resolve(import.meta.dirname, "../../apps/web"),
      env: {
        PATH: process.env.PATH, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port),
        MEITHEAL_DB_URL: "file:" + dbPath, MEITHEAL_BOARD_GRANT_PATH: join(work, "grants.json"),
      },
      stdio: ["ignore", "ignore", "ignore"],
    })
    const context = await browser.newContext({ baseURL: app, extraHTTPHeaders: {}, serviceWorkers: "block" })
    try {
      await expect.poll(async () => {
        if (child.exitCode !== null) throw new Error("Assignee fixture server exited")
        return (await fetch(app + "/api/health").catch(() => null))?.status
      }, { timeout: 10_000 }).toBe(200)
      const request = context.request
      const headers = await currentBoardWriteHeaders(request, "household", { origin: app, "content-type": "application/json" }, app)
      // Load assignments already stored by earlier versions or a prior HA roster.
      // The live mutation API still enforces the current roster and Board scope.
      const setStoredAssignee = (id: string, assignee: string | null) => {
        const db = new DatabaseSync(dbPath, { timeout: 5_000 })
        try {
          expect(db.prepare("UPDATE tasks SET assigned_to = ? WHERE id = ?").run(assignee, id).changes).toBe(1)
        }
        finally { db.close() }
      }
      await use({ app, page: await context.newPage(), request, headers, setStoredAssignee })
    } finally {
      await context.close()
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit", { signal: AbortSignal.timeout(3_000) })
        child.kill("SIGTERM")
        await exited
      }
      await rm(work, { recursive: true, force: true })
    }
  },
})
