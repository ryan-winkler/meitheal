import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

const script = fileURLToPath(new URL("../../apps/web/scripts/perf-budget-check.mjs", import.meta.url))

test.describe.configure({ mode: "serial" })

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

for (const failure of [false, true]) {
  test(`performance harness reaps a SIGTERM-resistant server after ${failure ? "a failed budget" : "passing budgets"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "meitheal-perf-lifecycle-"))
    const pidFile = join(directory, "server.pid")
    const countFile = join(directory, "requests.count")
    let pid: number | undefined
    try {
      await mkdir(join(directory, "scripts"))
      await mkdir(join(directory, "dist/server"), { recursive: true })
      await mkdir(join(directory, "dist/client"), { recursive: true })
      await copyFile(script, join(directory, "scripts/perf-budget-check.mjs"))
      await writeFile(join(directory, "dist/client/fixture.js"), "ok")
      await writeFile(join(directory, "dist/server/entry.mjs"), `
import { createServer } from "node:http"
import { writeFileSync } from "node:fs"
let requests = 0
process.on("SIGTERM", () => {})
const server = createServer((request, response) => {
  request.resume()
  if (request.method === "POST") writeFileSync(process.env.TEST_COUNT_FILE, String(++requests))
  response.writeHead(request.method === "POST" ? 201 : 200, { "content-type": "application/json" })
  response.end(JSON.stringify({ ok: true }))
})
server.listen(Number(process.env.PORT), "127.0.0.1", () => writeFileSync(process.env.TEST_PID_FILE, String(process.pid)))
`)
      const result = await new Promise<{ code: string | number | null | undefined; stdout: string; stderr: string }>(resolve => {
        execFile(process.execPath, ["scripts/perf-budget-check.mjs"], {
          cwd: directory,
          timeout: 8_000,
          env: {
            ...process.env,
            TEST_PID_FILE: pidFile,
            TEST_COUNT_FILE: countFile,
            MEITHEAL_PERF_BUDGET_CLIENT_BYTES_MAX: failure ? "1" : "100",
            MEITHEAL_PERF_BUDGET_RSS_KB_MAX: "1048576",
            MEITHEAL_PERF_BUDGET_P95_MS_MAX: "10000",
          },
        }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }))
      })
      pid = Number(await readFile(pidFile, "utf8"))
      expect(result.code, result.stderr).toBe(failure ? 1 : 0)
      expect(JSON.parse(result.stdout).observed.clientBytes).toBe(2)
      expect(await readFile(countFile, "utf8")).toBe("20")
      expect(isAlive(pid), "The harness must reap its owned server before exiting").toBe(false)
      if (failure) expect(result.stderr).toContain("Client bundle too large: 2 bytes > 1")
    } finally {
      // Only this fixture's recorded child is eligible for failure cleanup.
      if (pid === undefined) {
        try { pid = Number(await readFile(pidFile, "utf8")) } catch { /* Startup failed before the PID receipt. */ }
      }
      if (pid && isAlive(pid)) process.kill(pid, "SIGKILL")
      await rm(directory, { recursive: true, force: true })
    }
  })
}
