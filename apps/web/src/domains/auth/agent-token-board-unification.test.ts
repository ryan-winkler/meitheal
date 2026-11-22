import test from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { isAgentTokenActive, isAgentTokenExpired } from "./active-agent-token"
import {
  listBoardGrantsForAgentTokens,
  removeAgentBoardGrants,
} from "../tasks/agent-board-authority"

function createInMemoryBoardDb() {
  const sqlite = new DatabaseSync(":memory:")
  sqlite.exec(`
    CREATE TABLE task_boards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ticket_prefix TEXT NOT NULL,
      state TEXT NOT NULL
    );
    CREATE TABLE board_access_grants (
      board_id TEXT NOT NULL,
      principal_type TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      role TEXT NOT NULL,
      authority_limits TEXT,
      PRIMARY KEY (board_id, principal_type, principal_id)
    );
  `)
  return {
    sqlite,
    client: ({
      async execute(stmt: { sql: string; args?: unknown[] } | string) {
        const sql = typeof stmt === "string" ? stmt : stmt.sql
        const args = typeof stmt === "string" ? [] : (stmt.args ?? [])
        const prepared = sqlite.prepare(sql)
        if (/^\s*SELECT\b/i.test(sql)) {
          const rows = prepared.all(...(args as Array<string | number | null>))
          return { rows } as never
        }
        prepared.run(...(args as Array<string | number | null>))
        return { rows: [] } as never
      },
    }) as unknown as Parameters<typeof listBoardGrantsForAgentTokens>[0],
  }
}

test("isAgentTokenExpired fails closed on past, equal, and malformed timestamps", () => {
  const now = Date.parse("2026-06-01T12:00:00.000Z")
  assert.equal(isAgentTokenExpired(null, now), false)
  assert.equal(isAgentTokenExpired("2026-06-01T12:00:01.000Z", now), false)
  assert.equal(isAgentTokenExpired("2026-06-01T12:00:00.000Z", now), true)
  assert.equal(isAgentTokenExpired("2026-05-31T12:00:00.000Z", now), true)
  assert.equal(isAgentTokenExpired("not-a-date", now), true)
})

test("isAgentTokenActive requires non-revoked and non-expired state", () => {
  const now = Date.parse("2026-06-01T12:00:00.000Z")
  assert.equal(isAgentTokenActive({ revoked: false, expiresAt: null }, now), true)
  assert.equal(isAgentTokenActive({ revoked: false, expiresAt: "2026-07-01T00:00:00.000Z" }, now), true)
  assert.equal(isAgentTokenActive({ revoked: true, expiresAt: null }, now), false)
  assert.equal(isAgentTokenActive({ revoked: false, expiresAt: "2026-05-01T00:00:00.000Z" }, now), false)
  assert.equal(isAgentTokenActive({ revoked: false, expiresAt: "invalid" }, now), false)
})

test("listBoardGrantsForAgentTokens returns active visible boards ordered by name", async () => {
  const { sqlite, client } = createInMemoryBoardDb()
  try {
    sqlite.exec(`
      INSERT INTO task_boards (id, name, ticket_prefix, state) VALUES
        ('b-work', 'Work', 'WRK', 'active'),
        ('b-home', 'home', 'HOM', 'active'),
        ('b-secret', 'Secret', 'SEC', 'active'),
        ('b-retired', 'Old Board', 'OLD', 'retired');
      INSERT INTO board_access_grants (board_id, principal_type, principal_id, role) VALUES
        ('b-work', 'agent', 'tok-1', 'service'),
        ('b-home', 'agent', 'tok-1', 'service'),
        ('b-secret', 'agent', 'tok-1', 'service'),
        ('b-retired', 'agent', 'tok-1', 'service'),
        ('b-work', 'ha_user', 'tok-1', 'owner');
    `)

    const empty = await listBoardGrantsForAgentTokens(client, [])
    assert.equal(empty.size, 0)

    const allActive = await listBoardGrantsForAgentTokens(client, ["tok-1"])
    assert.deepEqual(
      allActive.get("tok-1")?.map(b => b.id),
      ["b-home", "b-secret", "b-work"],
    )

    const visibleOnly = await listBoardGrantsForAgentTokens(
      client,
      ["tok-1"],
      new Set(["b-work", "b-home"]),
    )
    assert.deepEqual(visibleOnly.get("tok-1"), [
      { id: "b-home", name: "home", ticketPrefix: "HOM" },
      { id: "b-work", name: "Work", ticketPrefix: "WRK" },
    ])
  } finally {
    sqlite.close()
  }
})

test("removeAgentBoardGrants removes only matching agent grants", async () => {
  const { sqlite, client } = createInMemoryBoardDb()
  try {
    sqlite.exec(`
      INSERT INTO task_boards (id, name, ticket_prefix, state) VALUES
        ('b-1', 'Home', 'HOM', 'active'),
        ('b-2', 'Work', 'WRK', 'active');
      INSERT INTO board_access_grants (board_id, principal_type, principal_id, role) VALUES
        ('b-1', 'agent', 'tok-del', 'service'),
        ('b-2', 'agent', 'tok-del', 'service'),
        ('b-1', 'agent', 'tok-keep', 'service'),
        ('b-1', 'ha_user', 'tok-del', 'owner');
    `)

    await removeAgentBoardGrants(client, "tok-del")

    const remaining = sqlite
      .prepare("SELECT board_id, principal_type, principal_id FROM board_access_grants ORDER BY board_id, principal_type, principal_id")
      .all()
      .map(row => ({ ...row }))
    assert.deepEqual(remaining, [
      { board_id: "b-1", principal_type: "agent", principal_id: "tok-keep" },
      { board_id: "b-1", principal_type: "ha_user", principal_id: "tok-del" },
    ])
  } finally {
    sqlite.close()
  }
})
