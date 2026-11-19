import { execFileSync, fork, type ChildProcess } from "node:child_process"
import { createHash, randomUUID, X509Certificate } from "node:crypto"
import { readFile } from "node:fs/promises"
import { existsSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Page } from "@playwright/test"

const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
const fixture = fileURLToPath(new URL("./feedback-ingress-fixture.mjs", import.meta.url))

export async function launchPinBrowser(work: string, backForwardCache = false, extraArgs: string[] = []) {
  const certificate = new X509Certificate(await readFile(join(work, "fixture-cert.pem")))
  const spki = createHash("sha256").update(certificate.publicKey.export({ type: "spki", format: "der" })).digest("base64")
  return chromium.launch({
    args: ["--no-proxy-server", `--ignore-certificate-errors-spki-list=${spki}`, ...extraArgs],
    ...(backForwardCache ? {
      channel: "chromium", ...(process.env.MEITHEAL_BFCACHE_CHROMIUM ? { executablePath: process.env.MEITHEAL_BFCACHE_CHROMIUM } : {}),
      ignoreDefaultArgs: ["--disable-back-forward-cache"],
    } : {}),
  })
}

export function startCoreFixture(work: string, plainHttp = false, restartPort?: number, timeZone?: string, boardDataDirectory?: string): ChildProcess {
  const cert = join(work, "fixture-cert.pem")
  const key = join(work, "fixture-key.pem")
  if (!restartPort) execFileSync("openssl", ["req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert], { stdio: "ignore" })
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    MEITHEAL_DB_URL: `file:${join(work, "pins.db")}`,
    MEITHEAL_PIN_FIXTURE: "1",
    MEITHEAL_PIN_FIXTURE_HTTP: plainHttp ? "1" : "0",
    ...(restartPort ? { MEITHEAL_INGRESS_FIXTURE_PORT: String(restartPort) } : {}),
    ...(timeZone ? { TZ: timeZone } : {}),
    ...(boardDataDirectory ? { MEITHEAL_FIXTURE_BOARD_DATA: boardDataDirectory } : {}),
    ...(process.env.MEITHEAL_PIN_LEGACY_WORKER ? { MEITHEAL_PIN_LEGACY_WORKER: process.env.MEITHEAL_PIN_LEGACY_WORKER } : {}),
    MEITHEAL_PIN_FIXTURE_TLS_CERT: cert,
    MEITHEAL_PIN_FIXTURE_TLS_KEY: key,
  }
  const freshDatabase = !existsSync(join(work, "pins.db"))
  execFileSync(process.execPath, ["scripts/migrate.mjs"], { cwd: web, env })
  if (boardDataDirectory && freshDatabase) {
    // Synthetic current custody for isolated browser fixtures, never production enrollment.
    const revision = randomUUID()
    const database = new DatabaseSync(join(work, "pins.db"))
    try {
      database.prepare("INSERT INTO board_access_epoch (singleton, revision) VALUES (1, ?)").run(revision)
      writeFileSync(join(boardDataDirectory, "meitheal-board-grants.json"), JSON.stringify({ epoch: revision }), { mode: 0o600 })
    } finally { database.close() }
  }
  return fork(fixture, { cwd: web, env, stdio: ["ignore", "pipe", "pipe", "ipc"] })
}

export async function pinRequest(page: Page, path: string, method: "POST" | "PUT" | "HEAD", body?: object, context?: string) {
  return page.evaluate(async ({ path, method, body, context }) => {
    const response = await fetch(path, {
      method, mode: "same-origin", referrerPolicy: "same-origin", cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(7_000),
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(context ? { "X-Meitheal-Pin-Context": context } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return {
      status: response.status, cache: response.headers.get("cache-control"),
      body: method === "HEAD" ? null : await response.json(),
    }
  }, { path, method, body, context })
}
