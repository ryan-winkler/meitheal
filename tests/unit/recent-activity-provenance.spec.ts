import { expect, test } from "@playwright/test"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import {
  discardUnappliedTaskActivity,
  readRecentActivity,
  recentActivityPersonKey,
  sanitizeOriginKind,
  sanitizeOriginName,
  sanitizeOriginTarget,
  taskAddedActivity,
  taskChangedActivity,
} from "../../apps/web/src/domains/tasks/persistence/recent-activity"
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
    dateFormat: "iso",
    automationSource: "browser",
    agentId: "",
    traceId: "0".repeat(32),
    spanId: "0".repeat(16),
    traceFlags: "01",
    ...overrides,
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

  expect(sanitizeOriginTarget(" /config/automation/edit/kitchen?tab=1 ")).toBe("/config/automation/edit/kitchen?tab=1")
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

  const humanActor = runWithIngressTransport({ fromSupervisor: true, identityHeadersSafe: true }, () =>
    resolveRecentActivityActor(baseLocals({ behindIngress: true, hassUserId: "user-42" })),
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
  ).label).toBe("Oscail foinse")

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
  const added = taskAddedActivity("task-1", {
    kind: "agent",
    personKey: null,
    provenance: { tokenName: "Bridge", originKind: "mcp", originName: "Claude", originTarget: "/config/voice" },
  }, 1_000)
  expect(added.args?.[2]).toContain('"originKind":"mcp"')

  const closed = taskChangedActivity({ status: "complete", title: "Updated" }, "WHERE id = ?", ["task-1"], {
    kind: "human",
    personKey: "pk-1",
  }, 2_000, "evt-1")
  expect(closed.sql).toContain("'closed'")

  const reopened = taskChangedActivity({ status: "pending" }, "WHERE id = ?", ["task-1"], {
    kind: "system",
    personKey: null,
  }, 3_000, "evt-2")
  expect(reopened.sql).toContain("'reopened'")

  expect(discardUnappliedTaskActivity("evt-2").args).toEqual(["evt-2"])

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
    ...Array.from({ length: 24 }, (_, idx) => ({
      id: 28 - idx,
      created_at: 2_800 - idx,
      feed_action: "edited",
      feed_person_key: "pk-1",
      actor_type: "human",
      summary: null,
      task_id: `t-${28 - idx}`,
      title: `Task ${28 - idx}`,
      ticket_number: 28 - idx,
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
  expect(page.items[2]?.provenance).toBeNull()
  expect(page.next).toEqual({ at: 2_800 - 22, id: 6 })
})
