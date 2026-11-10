import { execFileSync, fork } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"
import { resolveAgentRouteScope } from "../../packages/domain-auth/src/agent-route-policy"
import {
  generateAgentToken,
  validateScopes,
  toPublicToken,
  hashToken,
  type AgentScope,
  type AgentTokenRecord,
} from "../../packages/domain-auth/src/agent-tokens"
import { GET, POST, PATCH, DELETE } from "../../apps/web/src/pages/api/agent-tokens/index"
import { getPersistenceClient, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"

/**
 * Agent Token E2E Tests — Phase 24 T10
 *
 * Tests cover domain logic, authorized handler behavior, and the standalone HTTP boundary.
 *
 * @domain auth
 * @bounded-context agent-authorization
 */

// ── Domain Logic Tests (no server needed) ────────────────────────────────────

test.describe("Agent Token — Domain Logic", () => {
  test("generateAgentToken produces mth_ prefixed token", () => {
    const { token, tokenHash, tokenPrefix } = generateAgentToken()
    expect(token).toMatch(/^mth_/)
    // tokenPrefix format: first 12 chars + "..." + last 4 chars
    expect(tokenPrefix).toBe(token.slice(0, 12) + "..." + token.slice(-4))
    expect(tokenHash).toBeTruthy()
    expect(tokenHash).not.toBe(token) // hash !== plaintext
  })

  test("generateAgentToken produces unique tokens", () => {
    const t1 = generateAgentToken()
    const t2 = generateAgentToken()
    expect(t1.token).not.toBe(t2.token)
    expect(t1.tokenHash).not.toBe(t2.tokenHash)
  })

  test("hashToken produces consistent SHA-256 hex", () => {
    const hash1 = hashToken("mth_test1234567890")
    const hash2 = hashToken("mth_test1234567890")
    expect(hash1).toBe(hash2)
    expect(hash1).toMatch(/^[a-f0-9]{64}$/) // SHA-256 = 64 hex chars
  })

  test("hashToken produces different hashes for different tokens", () => {
    const hash1 = hashToken("mth_aaaa")
    const hash2 = hashToken("mth_bbbb")
    expect(hash1).not.toBe(hash2)
  })

  test("validateScopes accepts valid scopes", () => {
    const { valid, invalid } = validateScopes(["tasks:read", "tasks:write", "search:read"])
    expect(valid).toEqual(["tasks:read", "tasks:write", "search:read"])
    expect(invalid).toHaveLength(0)
  })

  test("validateScopes rejects unknown scopes", () => {
    const { valid, invalid } = validateScopes(["tasks:read", "nope:write", "invalid"])
    expect(valid).toEqual(["tasks:read"])
    expect(invalid).toEqual(["nope:write", "invalid"])
  })

  test("validateScopes handles empty array", () => {
    const { valid, invalid } = validateScopes([])
    expect(valid).toHaveLength(0)
    expect(invalid).toHaveLength(0)
  })

  test("validateScopes passes through duplicates (no dedup)", () => {
    const { valid } = validateScopes(["tasks:read", "tasks:read", "tasks:read"])
    // Domain logic does not deduplicate — caller is responsible
    expect(valid).toHaveLength(3)
  })

  test("toPublicToken strips hash and sensitive fields", () => {
    const record: AgentTokenRecord = {
      id: "uuid-1",
      name: "test-token",
      tokenHash: hashToken("example-only"),
      tokenPrefix: "mth_a1b2",
      scopes: ["tasks:read"] as AgentScope[],
      createdAt: "2026-01-01T00:00:00Z",
      expiresAt: null,
      lastUsedAt: null,
      revoked: false,
    }

    const pub = toPublicToken(record)
    expect(pub).toHaveProperty("id", "uuid-1")
    expect(pub).toHaveProperty("name", "test-token")
    expect(pub).toHaveProperty("tokenPrefix", "mth_a1b2")
    expect(pub).not.toHaveProperty("tokenHash")
  })
})

const handlers = { GET, POST, PATCH, DELETE }
type InvokeAgentRoute = (method: keyof typeof handlers, data?: unknown) => Response | Promise<Response>

const handlerTest = test.extend<{ invoke: InvokeAgentRoute }>({
  invoke: async ({}, use) => {
    const previousDbUrl = process.env.MEITHEAL_DB_URL
    const directory = mkdtempSync(join(tmpdir(), "meitheal-agent-token-"))
    process.env.MEITHEAL_DB_URL = `file:${join(directory, "test.db")}`
    resetPersistenceForTests()

    try {
      await use((method, data) => {
        const request = new Request("http://localhost/api/agent-tokens", {
          method,
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        })

        // Ingress authentication is outside the route handler's boundary.
        return handlers[method]({
          request,
          locals: { hassIsAdmin: true },
        } as unknown as Parameters<typeof GET>[0])
      })
    } finally {
      getPersistenceClient().close()
      resetPersistenceForTests()
      if (previousDbUrl === undefined) {
        delete process.env.MEITHEAL_DB_URL
      } else {
        process.env.MEITHEAL_DB_URL = previousDbUrl
      }
      rmSync(directory, { recursive: true, force: true })
    }
  },
})

handlerTest.describe("Agent Token — Authorized Handler", () => {
  handlerTest("POST /api/agent-tokens creates token and returns plaintext once", async ({ invoke }) => {
    const res = await invoke("POST", {
      name: "e2e-test-token",
      scopes: ["tasks:read", "search:read"],
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.id).toBeTruthy()
    expect(body.token).toMatch(/^mth_/)
    expect(body.tokenPrefix).toBe(body.token.slice(0, 12) + "..." + body.token.slice(-4))
    expect(body.scopes).toEqual(["tasks:read", "search:read"])
    expect(body.name).toBe("e2e-test-token")
  })

  handlerTest("POST /api/agent-tokens rejects empty name", async ({ invoke }) => {
    const res = await invoke("POST", { name: "", scopes: ["tasks:read"] })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.type).toBeTruthy() // RFC 9457 problem type
    expect(body.invalidParams).toBeInstanceOf(Array)
    expect(body.invalidParams[0].name).toBe("name")
  })

  handlerTest("POST /api/agent-tokens rejects invalid scopes", async ({ invoke }) => {
    const res = await invoke("POST", { name: "bad-scopes", scopes: ["tasks:read", "bogus:scope"] })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.invalidParams?.some((p: { name: string; reason: string }) => p.reason.includes("bogus:scope"))).toBe(true)
  })

  handlerTest("POST /api/agent-tokens rejects empty scopes", async ({ invoke }) => {
    const res = await invoke("POST", { name: "no-scopes", scopes: [] })

    expect(res.status).toBe(400)
  })

  handlerTest("GET /api/agent-tokens lists tokens without hashes", async ({ invoke }) => {
    const created = await invoke("POST", { name: "listed-token", scopes: ["tasks:read"] })
    expect(created.status).toBe(201)

    const res = await invoke("GET")

    expect(res.status).toBe(200)
    const tokens = await res.json()
    expect(Array.isArray(tokens)).toBe(true)

    expect(tokens).toHaveLength(1)
    const token = tokens[0]
    expect(token).toHaveProperty("id")
    expect(token).toHaveProperty("name", "listed-token")
    expect(token).toHaveProperty("tokenPrefix")
    expect(token).not.toHaveProperty("tokenHash")
    expect(token).not.toHaveProperty("token")
  })

  handlerTest("PATCH /api/agent-tokens updates token name", async ({ invoke }) => {
    // Create a token first
    const createRes = await invoke("POST", { name: "rename-me", scopes: ["tasks:read"] })
    const { id } = await createRes.json()

    // Update it
    const res = await invoke("PATCH", { id, name: "renamed-token" })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  handlerTest("DELETE /api/agent-tokens revokes token (soft)", async ({ invoke }) => {
    // Create a token first
    const createRes = await invoke("POST", { name: "to-revoke", scopes: ["tasks:read"] })
    const { id } = await createRes.json()

    // Revoke it
    const res = await invoke("DELETE", { id })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.action).toBe("revoked")
  })

  handlerTest("DELETE /api/agent-tokens hard-deletes token", async ({ invoke }) => {
    // Create a token first
    const createRes = await invoke("POST", { name: "to-delete", scopes: ["tasks:read"] })
    const { id } = await createRes.json()

    // Hard delete
    const res = await invoke("DELETE", { id, hard: true })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.action).toBe("deleted")
  })

  handlerTest("PATCH /api/agent-tokens returns 404 for unknown id", async ({ invoke }) => {
    const res = await invoke("PATCH", { id: "00000000-0000-0000-0000-000000000000", name: "nah" })

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.type).toBeTruthy() // RFC 9457
  })

  handlerTest("DELETE /api/agent-tokens returns 404 for unknown id", async ({ invoke }) => {
    const res = await invoke("DELETE", { id: "00000000-0000-0000-0000-000000000000" })

    expect(res.status).toBe(404)
  })
})

test("anonymous standalone HTTP requests cannot manage agent tokens", async ({ request }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Set MEITHEAL_TEST_BROWSER=1 to start the standalone fixture")
  const response = await request.get("/api/agent-tokens")
  expect(response.status()).toBe(403)
  expect(await response.json()).toMatchObject({ title: "Admin Required" })
})

test("encoded API namespace cannot bypass agent authorization in managed ingress", async ({ playwright, request, baseURL }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and its disposable ingress fixture")
  const directory = mkdtempSync(join(tmpdir(), "meitheal-agent-path-"))
  const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
  const fixture = fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url))
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    MEITHEAL_DB_URL: `file:${join(directory, "meitheal.db")}`,
    MEITHEAL_TEST_CORE_USER_LOOKUP: "1",
  }
  const api = await playwright.request.newContext()
  let server: ReturnType<typeof fork> | undefined
  try {
    execFileSync(process.execPath, ["scripts/migrate.mjs"], { cwd: web, env })
    server = fork(fixture, { cwd: web, env, stdio: ["ignore", "ignore", "ignore", "ipc"] })
    const [{ port, configuredPath }] = await once(server, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `http://127.0.0.1:${port}`
    const ingress = origin + configuredPath
    const admin = { origin, cookie: "feedback-fixture=admin" }
    const member = { origin, cookie: "feedback-fixture=member" }
    const credential = "/api/agent-tokens"
    const tasks = "/api/tasks"
    const created = await api.post(ingress + credential, {
      headers: admin, data: { name: "Scoped ingress fixture", scopes: ["tasks:read"] },
    })
    expect(created.status()).toBe(201)
    expect(created.headers()["cache-control"]).toBe("no-store")
    const { token, id } = await created.json()
    const scoped = { authorization: `Bearer ${token}` }
    const invalid = { authorization: "Bearer mth_invalid" }
    const deniedTitle = "Encoded namespace mutation sentinel"
    const write = (path: string, auth: Record<string, string>) => api.post(ingress + path, {
      headers: { ...member, ...auth }, data: { title: deniedTitle },
    })
    const list = (path: string, auth: Record<string, string>) => api.get(ingress + path, {
      headers: { ...admin, ...auth },
    })

    expect((await api.get(ingress + tasks, { headers: { ...member, ...scoped } })).status()).toBe(200)
    expect((await write(tasks, scoped)).status()).toBe(403)
    expect((await list(credential, scoped)).status()).toBe(403)
    const invalidCanonical = await list(credential, invalid)
    expect(invalidCanonical.status()).toBe(401)
    expect(invalidCanonical.headers()["cache-control"]).toBe("no-store")
    expect((await list(credential, {})).status()).toBe(200)
    expect((await api.get(ingress + credential, { headers: member })).status()).toBe(403)

    for (const encoded of ["/%61pi", "/%2561pi"]) {
      for (const response of [
        await write(encoded + "/tasks", scoped),
        await list(encoded + "/agent-tokens", scoped),
        await list(encoded + "/agent-tokens", invalid),
      ]) {
        expect(response.status()).toBe(404)
        if (encoded === "/%61pi") expect(response.headers()["cache-control"]).toBe("private, no-store")
      }
    }

    expect((await api.delete(ingress + credential, { headers: admin, data: { id } })).status()).toBe(200)
    const revoked = await write(tasks, scoped)
    expect(revoked.status()).toBe(401)
    expect(revoked.headers()["cache-control"]).toBe("no-store")
    for (const encoded of ["/%61pi/tasks", "/%2561pi/tasks"]) {
      expect((await write(encoded, scoped)).status()).toBe(404)
    }
    const search = await api.get(ingress + "/api/search", {
      headers: member, params: { q: deniedTitle, scope: "tasks" },
    })
    expect(search.status()).toBe(200)
    expect(await search.json()).toMatchObject({ sections: [] })

    const ordinary = await api.post(ingress + tasks, {
      headers: member, data: { title: "Ordinary ingress task" },
    })
    expect(ordinary.status()).toBe(201)
    const { id: taskId } = await ordinary.json()
    const encodedId = String(taskId).replace(/^[0-9a-f]/i, char => "%" + char.charCodeAt(0).toString(16))
    expect((await api.get(ingress + tasks + "/" + encodedId, { headers: member })).status()).toBe(200)
    expect((await api.get(ingress + "/api/v1/tasks", { headers: member })).status()).toBe(404)
    expect((await request.get(baseURL + "//api/tasks", { maxRedirects: 0 })).status()).toBe(200)
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit")
      server.kill()
      await exited
    }
    await api.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("agent routes require the permission for the concrete operation", () => {
  expect(resolveAgentRouteScope("/api/tasks", "GET")).toBe("tasks:read")
  expect(resolveAgentRouteScope("/api/tasks", "HEAD")).toBe("tasks:read")
  expect(resolveAgentRouteScope("/api/tasks", "POST")).toBe("tasks:write")
  expect(resolveAgentRouteScope("/api/tasks/a-task", "PATCH")).toBe("tasks:write")
  expect(resolveAgentRouteScope("/api/tasks/a-task", "DELETE")).toBe("tasks:delete")
  expect(resolveAgentRouteScope("/api/tasks/a-task/links", "DELETE")).toBe("tasks:write")
  expect(resolveAgentRouteScope("/api/tasks/clear-completed", "POST")).toBe("tasks:delete")
  expect(resolveAgentRouteScope("/api/projects/a-project", "DELETE")).toBe("projects:write")
  expect(resolveAgentRouteScope("/api/search", "GET")).toBe("search:read")
  expect(resolveAgentRouteScope("/api/tasks/a-task/future-action", "POST")).toBeUndefined()
  expect(resolveAgentRouteScope("/api/agent-tokens", "POST")).toBeUndefined()
  expect(resolveAgentRouteScope("/api/settings", "GET")).toBeUndefined()
  expect(resolveAgentRouteScope("/api/v1/tasks", "GET")).toBeUndefined()
})

handlerTest("token creation validates expiration and never caches the plaintext", async ({ invoke }) => {
  const payload = { name: "expires", scopes: ["tasks:read"] }
  expect((await invoke("POST", { ...payload, expiresAt: "invalid" })).status).toBe(400)
  expect((await invoke("POST", { ...payload, expiresAt: "2020-01-01" })).status).toBe(400)
  const response = await invoke("POST", payload)
  expect(response.status).toBe(201)
  expect(response.headers.get("cache-control")).toBe("no-store")
})
