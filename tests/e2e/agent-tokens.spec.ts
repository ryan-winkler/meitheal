import { execFileSync, fork } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"
import { test as settingsBrowserTest } from "../scripts/settings-persistence-fixture"
import { resolveAgentRouteScope } from "../../packages/domain-auth/src/agent-route-policy"
import {
  AVAILABLE_SCOPES,
  generateAgentToken,
  validateScopes,
  toPublicToken,
  hashToken,
  type AgentScope,
  type AgentTokenRecord,
} from "../../packages/domain-auth/src/agent-tokens"
import { GET, POST, PATCH, DELETE } from "../../apps/web/src/pages/api/agent-tokens/index"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"
import { UserRepository } from "../../apps/web/src/domains/tasks/persistence/user-repository"

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

  test("OpenAPI jsondoc schema stays in sync with AgentScope and public token contract", () => {
    const spec = JSON.parse(
      readFileSync(new URL("../../apps/web/public/.well-known/jsondoc.json", import.meta.url), "utf8"),
    )
    expect(spec.components.schemas.AgentScope.enum).toEqual(AVAILABLE_SCOPES.map(s => s.scope))

    const sample = toPublicToken({
      id: "uuid-1",
      name: "test-token",
      tokenHash: hashToken("example-only"),
      tokenPrefix: "mth_a1b2",
      scopes: ["tasks:read"],
      assigneeId: "custom_agent_1",
      createdAt: "2026-01-01T00:00:00Z",
      expiresAt: null,
      lastUsedAt: null,
      revoked: false,
    })
    expect(Object.keys(spec.components.schemas.AgentToken.properties)).toEqual(
      expect.arrayContaining(Object.keys(sample)),
    )
    expect(spec.components.schemas.CreateAgentTokenResponse.properties).toHaveProperty("assigneeId")
  })
})

const handlers = { GET, POST, PATCH, DELETE }
type InvokeAgentRoute = (method: keyof typeof handlers, data?: unknown, search?: string) => Response | Promise<Response>

const handlerTest = test.extend<{ invoke: InvokeAgentRoute }>({
  invoke: async ({}, use) => {
    const previousDbUrl = process.env.MEITHEAL_DB_URL
    const directory = mkdtempSync(join(tmpdir(), "meitheal-agent-token-"))
    process.env.MEITHEAL_DB_URL = `file:${join(directory, "test.db")}`
    resetPersistenceForTests()

    try {
      await ensureSchema()
      const users = new UserRepository(getPersistenceClient())
      await users.createCustomUser("custom_agent_1", "Claude", "#6366f1", "agent")
      await users.createCustomUser("custom_agent_2", "Codex", "#10b981", "agent")
      await users.createCustomUser("custom_human_1", "Aoife", "#f59e0b", "human")

      await use((method, data, search = "") => {
        const request = new Request(`http://localhost/api/agent-tokens${search}`, {
          method,
          ...(data === undefined ? {} : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(data),
          }),
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
    expect(res.headers.get("cache-control")).toBe("no-store")
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

  handlerTest("PATCH /api/agent-tokens updates token name and enforces assignee and empty-body rules", async ({ invoke }) => {
    const missingAssignee = await invoke("POST", { name: "assigned-no-id", scopes: ["tasks:write:assigned"] })
    expect(missingAssignee.status).toBe(400)
    const humanAssignee = await invoke("POST", { name: "human-assignee", scopes: ["tasks:read"], assigneeId: "custom_human_1" })
    expect(humanAssignee.status).toBe(400)

    // Create a token first
    const createRes = await invoke("POST", {
      name: "rename-me",
      scopes: ["tasks:write:assigned"],
      assigneeId: "custom_agent_1",
    })
    expect(createRes.status).toBe(201)
    const { id } = await createRes.json()

    expect((await invoke("PATCH", { id })).status).toBe(400)
    expect((await invoke("PATCH", { id, name: "x".repeat(101) })).status).toBe(400)
    expect((await invoke("PATCH", { id, assigneeId: "custom_agent_2", name: 123 })).status).toBe(400)
    expect((await invoke("PATCH", { id, assigneeId: "custom_agent_2", scopes: "tasks:read" })).status).toBe(400)
    expect((await invoke("PATCH", { id, assigneeId: null })).status).toBe(400)
    expect((await invoke("PATCH", { id, assigneeId: 123 })).status).toBe(400)
    expect((await invoke("PATCH", { id, assigneeId: "x".repeat(129) })).status).toBe(400)

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

    expect(await (await invoke("GET")).json()).toHaveLength(0)
    expect(await (await invoke("GET", undefined, "?include_revoked=1")).json()).toMatchObject([
      { id, name: "to-revoke", revoked: true },
    ])
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
  expect(response.headers()["cache-control"]).toBe("no-store")
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

    for (const encodedWellKnown of ["/.well-known/%6dcp.json", "/%2ewell-known/mcp.json"]) {
      const response = await list(encodedWellKnown, scoped)
      expect(response.status()).toBe(404)
      expect(response.headers()["cache-control"]).toBe("private, no-store")
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
  expect(resolveAgentRouteScope("/.well-known/mcp.json", "GET")).toBe("mcp:execute")
  expect(resolveAgentRouteScope("/.well-known/agent-card.json", "GET")).toBe("a2a:execute")
  expect(resolveAgentRouteScope("/.well-known/agent.json", "GET")).toBe("a2a:execute")
  expect(resolveAgentRouteScope("/api/tasks/a-task/future-action", "POST")).toBeUndefined()
  expect(resolveAgentRouteScope("/api/agent-tokens", "POST")).toBeUndefined()
  expect(resolveAgentRouteScope("/api/settings", "GET")).toBeUndefined()
  expect(resolveAgentRouteScope("/api/v1/tasks", "GET")).toBeUndefined()
})

handlerTest("token creation validates expiration, body limits, CSRF origin, and never caches the plaintext", async ({ invoke }) => {
  const payload = { name: "expires", scopes: ["tasks:read"] }
  expect((await invoke("POST", { ...payload, expiresAt: "invalid" })).status).toBe(400)
  expect((await invoke("POST", { ...payload, expiresAt: "2020-01-01" })).status).toBe(400)
  expect((await invoke("POST", { ...payload, assigneeId: 42 })).status).toBe(400)
  expect((await invoke("POST", { ...payload, assigneeId: "x".repeat(129) })).status).toBe(400)
  const oversized = await invoke("POST", { ...payload, name: "x".repeat(17_000) })
  expect(oversized.status).toBe(413)
  expect(oversized.headers.get("cache-control")).toBe("no-store")
  const wrongMediaType = await POST({
    request: new Request("http://localhost/api/agent-tokens", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(payload),
    }),
    locals: { hassIsAdmin: true, behindIngress: true },
  } as unknown as Parameters<typeof POST>[0])
  expect(wrongMediaType.status).toBe(415)
  expect(wrongMediaType.headers.get("cache-control")).toBe("no-store")
  const crossOrigin = await POST({
    request: new Request("http://localhost/api/agent-tokens", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    locals: { hassIsAdmin: true, behindIngress: true },
  } as unknown as Parameters<typeof POST>[0])
  expect(crossOrigin.status).toBe(403)
  expect(crossOrigin.headers.get("cache-control")).toBe("no-store")
  const siblingSubdomain = await POST({
    request: new Request("http://localhost/api/agent-tokens", {
      method: "POST",
      headers: { "sec-fetch-site": "same-site", "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    locals: { hassIsAdmin: true, behindIngress: true },
  } as unknown as Parameters<typeof POST>[0])
  expect(siblingSubdomain.status).toBe(403)
  expect(siblingSubdomain.headers.get("cache-control")).toBe("no-store")
  const response = await invoke("POST", payload)
  expect(response.status).toBe(201)
  expect(response.headers.get("cache-control")).toBe("no-store")
})

settingsBrowserTest("Settings Agent Tokens UI handles deferred load, retry, focus, secret wipe, assignee scope, revoke, and delete", async ({ page, request }) => {
  settingsBrowserTest.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built App and disposable authenticated fixture")

  const createdAgent = await request.post("/api/users/custom", { data: { name: "Claude", kind: "agent" } })
  expect(createdAgent.status(), await createdAgent.text()).toBe(201)
  const claude = await createdAgent.json() as { id: string; name: string }

  let failOnce = true
  await page.route("**/api/agent-tokens?include_revoked=1", async route => {
    if (failOnce) {
      failOnce = false
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) })
      return
    }
    await route.continue()
  })

  await page.goto("/settings#personal-settings")
  await expect(page.locator("#automation-ai-settings")).toBeHidden()
  await page.locator('[data-settings-nav="automation-ai-settings"]').click()
  await expect(page.locator("#automation-ai-settings")).toBeVisible()

  await expect(page.locator("#agent-tokens-status")).toBeVisible()
  await expect(page.locator("#tokens-retry")).toBeVisible()
  await page.locator("#tokens-retry").click()
  await expect(page.locator("#agent-tokens-status")).toBeHidden()
  await expect(page.locator("#agent-tokens-empty")).toBeVisible()
  await expect(page.locator("#agent-token-create-btn")).toBeFocused()
  await expect(page.locator("#agent-token-form")).toBeHidden()
  await expect(page.locator("#agent-token-reveal")).toBeHidden()

  await page.locator("#agent-token-create-btn").click()
  await expect(page.locator("#agent-token-form")).toBeVisible()
  await expect(page.locator("#agent-token-name")).toBeFocused()
  await page.locator("#agent-token-form-cancel").click()
  await expect(page.locator("#agent-token-form")).toBeHidden()
  await expect(page.locator("#agent-token-create-btn")).toBeFocused()

  let failCreateOnce = true
  await page.route("**/api/agent-tokens", async route => {
    if (route.request().method() === "POST" && failCreateOnce) {
      failCreateOnce = false
      await route.fulfill({
        status: 500,
        contentType: "application/problem+json",
        body: JSON.stringify({ status: 500, title: "Internal Error", detail: "Simulated token error" }),
      })
      return
    }
    await route.continue()
  })

  await page.locator("#agent-token-create-btn").click()
  await page.locator("#agent-token-name").fill("Assigned Scoped Token")
  await page.locator('input[name="agent-token-scopes"][value="tasks:write:assigned"]').check()
  await expect(page.locator(`#agent-token-assignee option[value="${claude.id}"]`)).toBeAttached()
  await page.locator("#agent-token-save").click()
  await expect(page.locator("#agent-token-form")).toBeVisible()
  await expect(page.locator("#agent-token-assignee")).toBeFocused()
  await page.locator("#agent-token-assignee").selectOption("__new__")
  await expect(page.locator("#agent-token-new-assignee")).toBeVisible()
  await page.locator("#agent-token-assignee").selectOption(claude.id)
  await expect(page.locator("#agent-token-new-assignee")).toBeHidden()
  await page.locator("#agent-token-save").click()
  await expect(page.locator("#agent-token-form")).toBeVisible()
  await expect(page.locator("#agent-token-save")).toBeFocused()
  await page.locator("#agent-token-save").click()
  await expect(page.locator("#agent-token-reveal")).toBeVisible()
  await page.locator("#agent-token-reveal-done").click()
  const assignedRow = page.locator(".agent-tokens__row", { hasText: "Assigned Scoped Token" })
  await expect(assignedRow).toContainText("Acts as Claude")
  await assignedRow.locator("[data-delete]").click()
  await page.locator("#confirm-ok").click()
  await expect(assignedRow).toHaveCount(0)

  await page.locator("#agent-token-create-btn").click()
  await page.locator("#agent-token-assignee").selectOption("__new__")
  await expect(page.locator("#agent-token-new-assignee")).toBeVisible()
  for (const scope of ["mcp:execute", "tasks:read", "tasks:write:assigned", "search:read"]) {
    await expect(page.locator(`input[name="agent-token-scopes"][value="${scope}"]`)).toBeChecked()
  }
  await page.locator("#agent-token-form-cancel").click()

  await page.locator("#agent-token-create-btn").click()
  await page.locator("#agent-token-name").fill("UI QA Token")
  await page.locator('input[name="agent-token-scopes"][value="tasks:read"]').check()
  await page.locator("#agent-token-save").click()

  await expect(page.locator("#agent-token-form")).toBeHidden()
  await expect(page.locator("#agent-token-reveal")).toBeVisible()
  await expect(page.locator("#agent-token-copy")).toBeFocused()
  await expect(page.locator("#agent-token-plaintext")).toContainText("mth_")
  await page.locator("#agent-token-reveal-done").click()
  await expect(page.locator("#agent-token-reveal")).toBeHidden()
  await expect(page.locator("#agent-token-plaintext")).toHaveText("")
  await expect(page.locator("#agent-token-create-btn")).toBeFocused()

  await page.locator("#agent-token-create-btn").click()
  await page.locator("#agent-token-name").fill("Navigation Wipe Token")
  await page.locator('input[name="agent-token-scopes"][value="tasks:read"]').check()
  await page.locator("#agent-token-save").click()
  await expect(page.locator("#agent-token-reveal")).toBeVisible()
  await expect(page.locator("#agent-token-plaintext")).toContainText("mth_")

  await page.locator("#bot-allow-proposals").click()
  await expect(page).toHaveURL(/\/review$/)
  await page.goBack()
  await page.locator('[data-settings-nav="automation-ai-settings"]').click()
  await expect(page.locator("#agent-token-reveal")).toBeHidden()
  await expect(page.locator("#agent-token-plaintext")).toHaveText("")

  const navRow = page.locator(".agent-tokens__row", { hasText: "Navigation Wipe Token" })
  await navRow.locator("[data-delete]").click()
  await page.locator("#confirm-ok").click()
  await expect(navRow).toHaveCount(0)

  const row = page.locator(".agent-tokens__row", { hasText: "UI QA Token" })
  await expect(row).toBeVisible()
  await expect(row.locator(".agent-tokens__row-prefix")).not.toContainText("...…")

  await row.locator("[data-revoke]").click()
  await expect(page.locator("#meitheal-confirm-overlay")).toBeVisible()
  await page.locator("#confirm-ok").click()
  await expect(row).toHaveClass(/agent-tokens__revoked/)
  await expect(row.locator("[data-delete]")).toBeFocused()

  await row.locator("[data-delete]").click()
  await expect(page.locator("#meitheal-confirm-overlay")).toBeVisible()
  await page.locator("#confirm-ok").click()
  await expect(page.locator("#agent-tokens-empty")).toBeVisible()
  await expect(page.locator("#agent-token-create-btn")).toBeFocused()
})

test("standalone ClientRouter navigation enforces non-admin notice and cleans up without errors", async ({ page }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Set MEITHEAL_TEST_BROWSER=1 to start the standalone fixture")
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))

  await page.goto("/settings#automation-ai-settings")
  await expect(page.locator("#agent-tokens-status")).toContainText("Home Assistant administrator access is required")
  await expect(page.locator("#agent-token-create-btn")).toBeDisabled()
  await expect(page.locator("#agent-token-form")).toBeHidden()
  await expect(page.locator("#agent-token-reveal")).toBeHidden()

  await page.locator("#bot-allow-proposals").click()
  await expect(page).toHaveURL(/\/review$/)
  await page.goBack()
  await expect(page.locator("#agent-tokens-status")).toContainText("Home Assistant administrator access is required")
  await expect(page.locator("#agent-token-create-btn")).toBeDisabled()
  expect(errors).toEqual([])
})
