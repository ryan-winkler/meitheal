import { expect, test } from "@playwright/test"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import {
  discardUnappliedTaskActivity,
  readRecentActivity,
  recentActivityPersonKey,
  sanitizeOriginKind,
  sanitizeOriginName,
  sanitizeOriginTarget,
  decodeOriginHeader,
  taskAddedActivity,
  taskChangedActivity,
} from "../../apps/web/src/domains/tasks"
import {
  formatVerifiedAgentAuthor,
  resolveRecentActivityActor,
  resolveVerifiedProvenanceLink,
} from "../../apps/web/src/lib/recent-activity-actor"

function baseLocals(overrides: Partial<App.Locals> = {}): App.Locals {
  return {
    ingressPath: undefined,
    behindIngress: false,
    hassUserId: undefined,
    hassIsAdmin: false,
    requestId: "req-1",
    timezone: "UTC",
    weekStart: "monday",
    dateFormat: "absolute-iso",
    automationSource: "browser",
    agentId: "",
    traceId: "0".repeat(32),
    spanId: "0".repeat(16),
    traceFlags: "01",
    ...overrides,
  }
}

function expectStatementObject(stmt: ReturnType<typeof taskAddedActivity>): { sql: string; args: unknown[] } {
  if (typeof stmt === "string") {
    throw new Error(`Expected SQL statement object, received string: ${stmt}`)
  }
  return {
    sql: stmt.sql,
    args: Array.isArray(stmt.args) ? stmt.args : [],
  }
}

test("sanitizes origin kind, display name, and safe internal target paths", () => {
  expect(sanitizeOriginKind(" HA_AUTOMATION ")).toBe("ha_automation")
  expect(sanitizeOriginKind("unknown")).toBeNull()
  expect(sanitizeOriginKind(42)).toBeNull()

  expect(sanitizeOriginName("  Morning\r\nKitchen\tRoutine  ")).toBe("Morning Kitchen Routine")
  expect(sanitizeOriginName("   ")).toBeNull()
  expect(sanitizeOriginName("x".repeat(140))?.length).toBe(120)
  expect(sanitizeOriginName(null)).toBeNull()

  expect(sanitizeOriginTarget(" /config/automation/edit/kitchen ")).toBe("/config/automation/edit/kitchen")
  expect(sanitizeOriginTarget("/config/automation/edit/kitchen", "ha_automation")).toBe("/config/automation/edit/kitchen")
  expect(sanitizeOriginTarget("/config/script/edit/night", "ha_script")).toBe("/config/script/edit/night")
  expect(sanitizeOriginTarget("/config/voice-assistants/assistants", "conversation_agent")).toBe("/config/voice-assistants/assistants")
  expect(sanitizeOriginTarget("/settings#agent-tokens-card", "webhook")).toBe("/settings#agent-tokens-card")
  // Kind-mismatched, query-bearing, and non-allowlisted Home Assistant paths are dropped.
  expect(sanitizeOriginTarget("/config/script/edit/night", "ha_automation")).toBeNull()
  expect(sanitizeOriginTarget("/config/automation/edit/kitchen", "webhook")).toBeNull()
  expect(sanitizeOriginTarget("/config/automation/edit/kitchen?tab=1", "ha_automation")).toBeNull()
  expect(sanitizeOriginTarget("/config/automationx", "ha_automation")).toBeNull()
  expect(sanitizeOriginTarget(
    "/auth/authorize?response_type=code&client_id=https://evil.example/&redirect_uri=https://evil.example/cb",
    "ha_automation",
  )).toBeNull()
  expect(sanitizeOriginTarget("/config/integrations")).toBeNull()

  expect(decodeOriginHeader("O%C3%ADche%20mhaith")).toBe("Oíche mhaith")
  expect(decodeOriginHeader("100% done")).toBe("100% done")
  expect(decodeOriginHeader("Plain name")).toBe("Plain name")
  expect(decodeOriginHeader(null)).toBeNull()
  for (const invalid of [
    null,
    "",
    "relative/path",
    "//evil.example",
    "/\\evil.example",
    "/bad\npath",
    "/bad\\path",
    "javascript:alert(1)",
    `/${"a".repeat(520)}`,
  ]) {
    expect(sanitizeOriginTarget(invalid)).toBeNull()
  }
})

test("resolves verified agent, human ingress, and system actors", () => {
  const req = new Request("http://localhost/api/tasks", {
    headers: {
      "X-Meitheal-Origin-Kind": "ha_automation",
      "X-Meitheal-Origin-Name": "Morning Kitchen",
      "X-Meitheal-Origin-Target": "/config/automation/edit/morning",
    },
  })
  const agentActor = resolveRecentActivityActor(
    baseLocals({
      agentToken: { tokenId: "tok-1", tokenName: "HA Bridge", scopes: ["tasks:write"] },
    }),
    req,
  )
  const spoofed = resolveRecentActivityActor(
    baseLocals({ agentToken: { tokenId: "tok-2", tokenName: "n8n", scopes: ["tasks:write"] } }),
    new Request("http://localhost/api/tasks", {
      headers: {
        "X-Meitheal-Origin-Kind": "ha_automation",
        "X-Meitheal-Origin-Name": "%F0%9F%8C%99 O%C3%ADche mhaith",
        "X-Meitheal-Origin-Target": "/auth/authorize?client_id=https://evil.example/",
      },
    }),
  )
  expect(spoofed.provenance).toEqual({
    tokenName: "n8n",
    originKind: "ha_automation",
    originName: "🌙 Oíche mhaith",
    originTarget: null,
  })
  expect(agentActor).toEqual({
    kind: "agent",
    personKey: null,
    provenance: {
      tokenName: "HA Bridge",
      originKind: "ha_automation",
      originName: "Morning Kitchen",
      originTarget: "/config/automation/edit/morning",
    },
  })

  const humanActor = runWithIngressTransport(
    { peer: "172.30.32.2", fromSupervisor: true, identityHeadersSafe: true, configuredPath: undefined },
    () => resolveRecentActivityActor(baseLocals({ behindIngress: true, hassUserId: "user-42" })),
  )
  expect(humanActor).toEqual({ kind: "human", personKey: recentActivityPersonKey("user-42") })
  expect(resolveRecentActivityActor(baseLocals({ behindIngress: true, hassUserId: "user-42" }))).toEqual({
    kind: "system",
    personKey: null,
  })
})

test("formats verified agent labels and resolves HA/internal provenance links across locales", () => {
  expect(formatVerifiedAgentAuthor({ tokenName: "Bridge", originKind: "ha_automation", originName: "Morning Kitchen" }))
    .toBe('Automation "Morning Kitchen" (via token "Bridge")')
  expect(formatVerifiedAgentAuthor({ tokenName: "Bridge", originKind: "ha_automation", originName: "Automation Reset" }))
    .toBe('Automation Reset (via token "Bridge")')
  expect(formatVerifiedAgentAuthor({ tokenName: "Bridge", originKind: "ha_script", originName: "Night Check" }))
    .toBe('Script "Night Check" (via token "Bridge")')
  expect(formatVerifiedAgentAuthor({ tokenName: "Bridge", originKind: "ha_script", originName: "Script Cleanup" }))
    .toBe('Script Cleanup (via token "Bridge")')
  expect(formatVerifiedAgentAuthor({ tokenName: "Bridge", originKind: "conversation_agent", originName: "Gemini Conversation" }))
    .toBe('Gemini Conversation (via token "Bridge")')
  expect(formatVerifiedAgentAuthor({ tokenName: "Bridge", originKind: "mcp" })).toBe('MCP client (via token "Bridge")')
  expect(formatVerifiedAgentAuthor({ tokenName: "Bridge", originKind: "webhook" })).toBe('Webhook (via token "Bridge")')
  expect(formatVerifiedAgentAuthor({ tokenName: "Bridge", originKind: "agent_token" })).toBe('Token "Bridge"')

  const voiceLink = resolveVerifiedProvenanceLink(
    { tokenName: "Bridge", originKind: "conversation_agent", originTarget: "/config/voice-assistants/assist" },
    "https://ha.local:8123",
    "en",
  )
  expect(voiceLink).toEqual({
    href: "https://ha.local:8123/config/voice-assistants/assist",
    label: "Open Voice Assistants",
    isInternal: false,
    isExternalHa: true,
  })

  expect(resolveVerifiedProvenanceLink(
    { tokenName: "Bridge", originKind: "ha_automation", originTarget: "/config/automation/edit/1" },
    null,
    "ga",
  )).toEqual({
    href: "/config/automation/edit/1",
    label: "Oscail uathoibriú",
    isInternal: false,
    haTarget: "/config/automation/edit/1",
    isExternalHa: true,
  })

  expect(resolveVerifiedProvenanceLink(
    { tokenName: "Bridge", originKind: "ha_script", originTarget: "/config/script/edit/1" },
    null,
    "en",
  ).label).toBe("Open script")

  expect(resolveVerifiedProvenanceLink(
    { tokenName: "Bridge", originKind: "webhook", originTarget: "/config/integrations" },
    null,
    "ga",
  )).toEqual({
    href: "/settings#agent-tokens-card",
    label: "Bainistigh comharthaí gníomhaire",
    isInternal: true,
    isExternalHa: false,
  })
  // A stored row whose target does not match its kind never renders a Home Assistant link.
  expect(resolveVerifiedProvenanceLink(
    { tokenName: "Bridge", originKind: "ha_script", originTarget: "/config/automation/edit/1" },
    "https://ha.local:8123",
    "en",
  ).isExternalHa).toBe(false)

  expect(resolveVerifiedProvenanceLink(
    { tokenName: "Bridge", originKind: "agent_token", originTarget: "javascript:bad" },
    null,
    "ga",
  )).toEqual({
    href: "/settings#agent-tokens-card",
    label: "Bainistigh comharthaí gníomhaire",
    isInternal: true,
    isExternalHa: false,
  })
})

test("builds activity statements and reads paginated provenance history", async () => {
  const added = expectStatementObject(taskAddedActivity("task-1", {
    kind: "agent",
    personKey: null,
    provenance: { tokenName: "Bridge", originKind: "mcp", originName: "Claude", originTarget: "/config/voice" },
  }, 1_000))
  expect(added.args[2]).toContain('"originKind":"mcp"')

  const closed = expectStatementObject(taskChangedActivity({ status: "complete", title: "Updated" }, "WHERE id = ?", ["task-1"], {
    kind: "human",
    personKey: "pk-1",
  }, 2_000, "evt-1"))
  expect(closed.sql).toContain("'closed'")

  const reopened = expectStatementObject(taskChangedActivity({ status: "pending" }, "WHERE id = ?", ["task-1"], {
    kind: "system",
    personKey: null,
  }, 3_000, "evt-2"))
  expect(reopened.sql).toContain("'reopened'")

  expect(expectStatementObject(discardUnappliedTaskActivity("evt-2")).args).toEqual(["evt-2"])

  let capturedSql = ""
  let capturedArgs: unknown[] = []
  const rows = [
    {
      id: 30,
      created_at: 3_000,
      feed_action: "added",
      feed_person_key: null,
      actor_type: "agent",
      summary: JSON.stringify({ v: 1, tokenName: "HA Bridge", originKind: "ha_automation", originName: "Washer", originTarget: "/config/automation/edit/washer" }),
      task_id: "t-30",
      title: "Empty washer",
      ticket_number: 30,
      created_by: null,
      source: "agent",
      area_name: "Home",
    },
    {
      id: 29,
      created_at: 2_900,
      feed_action: "added",
      feed_person_key: null,
      actor_type: "agent",
      summary: "{not-json",
      task_id: "t-29",
      title: "Fallback token row",
      ticket_number: null,
      created_by: "Legacy Token",
      source: "agent",
      area_name: null,
    },
    {
      id: 28,
      created_at: 2_850,
      feed_action: "closed",
      feed_person_key: null,
      actor_type: "agent",
      summary: null,
      task_id: "t-29",
      title: "Legacy close by another token",
      ticket_number: null,
      created_by: "Legacy Token",
      source: "agent",
      area_name: null,
    },
    ...Array.from({ length: 23 }, (_, idx) => ({
      id: 27 - idx,
      created_at: 2_800 - idx,
      feed_action: "edited",
      feed_person_key: "pk-1",
      actor_type: "human",
      summary: null,
      task_id: `t-${27 - idx}`,
      title: `Task ${27 - idx}`,
      ticket_number: 27 - idx,
      created_by: "user-1",
      source: "web",
      area_name: "Home",
    })),
  ]
  const client = {
    async execute(stmt: { sql: string; args?: unknown[] }) {
      capturedSql = stmt.sql
      capturedArgs = stmt.args ?? []
      return { rows }
    },
  } as unknown as Parameters<typeof readRecentActivity>[0]

  const page = await readRecentActivity(client, { areaId: "home", personKey: "pk-1", before: { at: 4_000, id: 99 } })
  expect(capturedSql).toContain("task.area_id = ?")
  expect(capturedArgs).toEqual(["home", "pk-1", 4_000, 99, 26])
  expect(page.items).toHaveLength(25)
  expect(page.items[0]?.provenance).toEqual({
    tokenName: "HA Bridge",
    originKind: "ha_automation",
    originName: "Washer",
    originTarget: "/config/automation/edit/washer",
  })
  expect(page.items[1]?.provenance).toEqual({
    tokenName: "Legacy Token",
    originKind: "agent_token",
    originName: null,
    originTarget: null,
  })
  // A pre-provenance close row is not credited to the token that created the task.
  expect(page.items[2]?.provenance).toBeNull()
  expect(page.items[3]?.provenance).toBeNull()
  expect(page.next).toEqual({ at: 2_800 - 21, id: 6 })
})
