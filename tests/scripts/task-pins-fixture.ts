import { execFileSync, fork, type ChildProcess } from "node:child_process"
import { createHash, X509Certificate } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Page } from "@playwright/test"

const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
const fixture = fileURLToPath(new URL("./feedback-ingress-fixture.mjs", import.meta.url))

export async function launchPinBrowser(work: string, backForwardCache = false) {
  const certificate = new X509Certificate(await readFile(join(work, "fixture-cert.pem")))
  const spki = createHash("sha256").update(certificate.publicKey.export({ type: "spki", format: "der" })).digest("base64")
  return chromium.launch({
    args: ["--no-proxy-server", `--ignore-certificate-errors-spki-list=${spki}`],
    ...(backForwardCache ? {
      channel: "chromium", ...(process.env.MEITHEAL_BFCACHE_CHROMIUM ? { executablePath: process.env.MEITHEAL_BFCACHE_CHROMIUM } : {}),
      ignoreDefaultArgs: ["--disable-back-forward-cache"],
    } : {}),
  })
}

export function startCoreFixture(work: string, plainHttp = false, restartPort?: number): ChildProcess {
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
    ...(process.env.MEITHEAL_PIN_LEGACY_WORKER ? { MEITHEAL_PIN_LEGACY_WORKER: process.env.MEITHEAL_PIN_LEGACY_WORKER } : {}),
    MEITHEAL_PIN_FIXTURE_TLS_CERT: cert,
    MEITHEAL_PIN_FIXTURE_TLS_KEY: key,
  }
  execFileSync(process.execPath, ["scripts/migrate.mjs"], { cwd: web, env })
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
