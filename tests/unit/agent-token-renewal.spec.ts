import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test as base } from "@playwright/test"
import { generateAgentToken, type AgentTokenRecord } from "../../packages/domain-auth/src/index"
import {
  createAgentToken,
  ensureAgentTokenSchema,
  getAgentTokenByHash,
  getAgentTokenById,
  renewAgentToken,
  revokeAgentToken,
  rotateAgentToken,
} from "../../apps/web/src/domains/auth/agent-token-store"
import { ensureSchema, resetPersistenceForTests } from "../helpers/persistence-fixture"

const expiredAt = "2024-01-01T00:00:00.000Z"
const renewedAt = "2099-01-01T00:00:00.000Z"

const test = base.extend<{ record: AgentTokenRecord }>({
  record: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "meitheal-agent-token-renewal-"))
    const previousDbUrl = process.env.MEITHEAL_DB_URL
    try {
      process.env.MEITHEAL_DB_URL = `file:${join(directory, "tokens.db")}`
      resetPersistenceForTests()
      await ensureSchema()
      await ensureAgentTokenSchema()
      const { tokenHash, tokenPrefix } = generateAgentToken()
      await use(await createAgentToken({
        id: "fixture-token",
        name: "Fixture integration",
        scopes: ["tasks:read"],
        assigneeId: "fixture-assignee",
        expiresAt: expiredAt,
        tokenHash,
        tokenPrefix,
      }))
    } finally {
      resetPersistenceForTests()
      if (previousDbUrl === undefined) delete process.env.MEITHEAL_DB_URL
      else process.env.MEITHEAL_DB_URL = previousDbUrl
      await rm(directory, { recursive: true, force: true })
    }
  },
})

test("renews an expired credential and clears its expiry without replacing it", async ({ record }) => {
  expect(await renewAgentToken(record.id, renewedAt)).toEqual({ ...record, expiresAt: renewedAt })
  expect(await getAgentTokenByHash(record.tokenHash)).toEqual({ ...record, expiresAt: renewedAt })

  expect(await renewAgentToken(record.id, null)).toEqual({ ...record, expiresAt: null })
  expect(await getAgentTokenById(record.id)).toEqual({ ...record, expiresAt: null })
})

test("rotates the credential in place with a preserved, replaced, or cleared expiry", async ({ record }) => {
  const { tokenHash, tokenPrefix } = generateAgentToken()
  const rotated = { ...record, tokenHash, tokenPrefix }
  expect(await rotateAgentToken(record.id, { tokenHash, tokenPrefix })).toEqual(rotated)
  expect(await getAgentTokenByHash(record.tokenHash)).toBeNull()
  expect(await getAgentTokenByHash(tokenHash)).toEqual(rotated)

  const replacement = generateAgentToken()
  const withNewExpiry = {
    tokenHash: replacement.tokenHash,
    tokenPrefix: replacement.tokenPrefix,
    expiresAt: renewedAt,
  }
  expect(await rotateAgentToken(record.id, withNewExpiry)).toEqual({ ...record, ...withNewExpiry })

  const permanent = generateAgentToken()
  const withoutExpiry = {
    tokenHash: permanent.tokenHash,
    tokenPrefix: permanent.tokenPrefix,
    expiresAt: null,
  }
  expect(await rotateAgentToken(record.id, withoutExpiry)).toEqual({ ...record, ...withoutExpiry })
})

test("does not renew or rotate revoked and unknown credentials", async ({ record }) => {
  const { tokenHash, tokenPrefix } = generateAgentToken()
  expect(await revokeAgentToken(record.id)).toBe(true)
  expect(await renewAgentToken(record.id, renewedAt)).toBeNull()
  expect(await rotateAgentToken(record.id, { tokenHash, tokenPrefix })).toBeNull()
  expect(await getAgentTokenById(record.id)).toEqual({ ...record, revoked: true })
  expect(await getAgentTokenByHash(tokenHash)).toBeNull()

  expect(await renewAgentToken("unknown", renewedAt)).toBeNull()
  expect(await rotateAgentToken("unknown", { tokenHash, tokenPrefix })).toBeNull()
  expect(await getAgentTokenById("unknown")).toBeNull()
})
