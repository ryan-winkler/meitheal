import { expect, test } from "@playwright/test"
import {
  generateAgentToken,
  validateScopes,
  toPublicToken,
  hashToken,
  type AgentScope,
  type AgentTokenRecord,
} from "../../packages/domain-auth/src/agent-tokens"

/**
 * Agent Token E2E Tests — Phase 24 T10
 *
 * Tests cover domain logic (pure functions) and API contract (when E2E_BASE_URL set).
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
      tokenHash: "a1b2c3d4e5f6...",
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

// ── API Contract Tests (require running server) ──────────────────────────────

const hasServer = !!process.env.E2E_BASE_URL

test.describe("Agent Token — API Contract", () => {
  test.skip(!hasServer, "Set E2E_BASE_URL to run API contract tests")

  const baseURL = process.env.E2E_BASE_URL || ""

  test("POST /api/agent-tokens creates token and returns plaintext once", async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tokens`, {
      data: {
        name: "e2e-test-token",
        scopes: ["tasks:read", "search:read"],
      },
    })

    expect(res.status()).toBe(201)
    const body = await res.json()
    expect(body.id).toBeTruthy()
    expect(body.token).toMatch(/^mth_/)
    expect(body.tokenPrefix).toBe(body.token.slice(0, 8))
    expect(body.scopes).toEqual(["tasks:read", "search:read"])
    expect(body.name).toBe("e2e-test-token")
  })

  test("POST /api/agent-tokens rejects empty name", async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tokens`, {
      data: { name: "", scopes: ["tasks:read"] },
    })

    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.type).toBeTruthy() // RFC 9457 problem type
    expect(body.invalidParams).toBeInstanceOf(Array)
    expect(body.invalidParams[0].name).toBe("name")
  })

  test("POST /api/agent-tokens rejects invalid scopes", async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tokens`, {
      data: { name: "bad-scopes", scopes: ["tasks:read", "bogus:scope"] },
    })

    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.invalidParams?.some((p: { name: string; reason: string }) => p.reason.includes("bogus:scope"))).toBe(true)
  })

  test("POST /api/agent-tokens rejects empty scopes", async ({ request }) => {
    const res = await request.post(`${baseURL}/api/agent-tokens`, {
      data: { name: "no-scopes", scopes: [] },
    })

    expect(res.status()).toBe(400)
  })

  test("GET /api/agent-tokens lists tokens without hashes", async ({ request }) => {
    const res = await request.get(`${baseURL}/api/agent-tokens`)

    expect(res.status()).toBe(200)
    const tokens = await res.json()
    expect(Array.isArray(tokens)).toBe(true)

    if (tokens.length > 0) {
      const token = tokens[0]
      expect(token).toHaveProperty("id")
      expect(token).toHaveProperty("name")
      expect(token).toHaveProperty("tokenPrefix")
      expect(token).not.toHaveProperty("tokenHash")
      expect(token).not.toHaveProperty("token") // plaintext not returned on list
    }
  })

  test("PATCH /api/agent-tokens updates token name", async ({ request }) => {
    // Create a token first
    const createRes = await request.post(`${baseURL}/api/agent-tokens`, {
      data: { name: "rename-me", scopes: ["tasks:read"] },
    })
    const { id } = await createRes.json()

    // Update it
    const res = await request.patch(`${baseURL}/api/agent-tokens`, {
      data: { id, name: "renamed-token" },
    })

    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  test("DELETE /api/agent-tokens revokes token (soft)", async ({ request }) => {
    // Create a token first
    const createRes = await request.post(`${baseURL}/api/agent-tokens`, {
      data: { name: "to-revoke", scopes: ["tasks:read"] },
    })
    const { id } = await createRes.json()

    // Revoke it
    const res = await request.delete(`${baseURL}/api/agent-tokens`, {
      data: { id },
    })

    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.action).toBe("revoked")
  })

  test("DELETE /api/agent-tokens hard-deletes token", async ({ request }) => {
    // Create a token first
    const createRes = await request.post(`${baseURL}/api/agent-tokens`, {
      data: { name: "to-delete", scopes: ["tasks:read"] },
    })
    const { id } = await createRes.json()

    // Hard delete
    const res = await request.delete(`${baseURL}/api/agent-tokens`, {
      data: { id, hard: true },
    })

    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.action).toBe("deleted")
  })

  test("PATCH /api/agent-tokens returns 404 for unknown id", async ({ request }) => {
    const res = await request.patch(`${baseURL}/api/agent-tokens`, {
      data: { id: "00000000-0000-0000-0000-000000000000", name: "nah" },
    })

    expect(res.status()).toBe(404)
    const body = await res.json()
    expect(body.type).toBeTruthy() // RFC 9457
  })

  test("DELETE /api/agent-tokens returns 404 for unknown id", async ({ request }) => {
    const res = await request.delete(`${baseURL}/api/agent-tokens`, {
      data: { id: "00000000-0000-0000-0000-000000000000" },
    })

    expect(res.status()).toBe(404)
  })
})
