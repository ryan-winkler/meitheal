import { defineConfig } from "@playwright/test"

const useLocalFixture = process.env.MEITHEAL_TEST_BROWSER === "1"
const fixturePort = Number(process.env.MEITHEAL_TEST_PORT ?? 4611)
if (useLocalFixture && (!Number.isInteger(fixturePort) || fixturePort < 1024 || fixturePort > 65535)) {
  throw new Error("MEITHEAL_TEST_PORT must be a valid unprivileged port")
}
const fixtureOrigin = `http://127.0.0.1:${fixturePort}`

if (useLocalFixture) {
  process.env.E2E_BASE_URL = fixtureOrigin
  process.env.MEITHEAL_TEST_URL = fixtureOrigin
  delete process.env.GEMINI_API_KEY
}

export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  retries: 0,
  ...(useLocalFixture ? { workers: 1 } : {}),
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000",
    ...(useLocalFixture ? { extraHTTPHeaders: { origin: fixtureOrigin } } : {}),
  },
  webServer: useLocalFixture ? {
    command: `sh ci-web-server.sh ${fixturePort}`,
    url: `${fixtureOrigin}/api/health`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
  } : [],
})
