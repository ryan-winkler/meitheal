import test from "node:test"
import assert from "node:assert/strict"
import {
  generateAgentToken,
  hashToken,
  resolveAgentRouteAccess,
  validateScopes,
  verifyLicenseKey,
} from "./domain-auth/src/index"
import {
  computeProposalHash,
  deriveEisenhowerQuadrant,
  goalProgress,
  isValidTaskKind,
  TASK_STATUS,
  TASK_STATUS_ALIASES,
} from "./domain-tasks/src/index"
import {
  createTaskRule,
  evaluateFrameworkFormula,
  isFrameworkFormulaSupported,
  resolveRulesForTask,
} from "./domain-strategy/src/index"
import {
  assertOutboundUrl,
  classifyNetworkHost,
  OutboundUrlError,
  validateGrocyBaseUrl,
} from "./integration-core/src/index"

test("domain-auth token generation, scope validation, route access, and grace license", () => {
  const generated = generateAgentToken()
  assert.match(generated.token, /^mth_[a-f0-9]{64}$/)
  assert.equal(hashToken(generated.token), generated.tokenHash)
  assert.equal(generated.tokenPrefix, generated.token.slice(0, 12))

  const checked = validateScopes(["tasks:read", "tasks:write", "unknown:scope"])
  assert.deepEqual(checked.valid, ["tasks:read", "tasks:write"])
  assert.deepEqual(checked.invalid, ["unknown:scope"])

  const assignedAccess = resolveAgentRouteAccess("/api/tasks/task-123", "PATCH", ["tasks:write:assigned"])
  assert.equal(assignedAccess.allowed, true)
  assert.equal(assignedAccess.assignedTaskId, "task-123")

  const deniedDelete = resolveAgentRouteAccess("/api/tasks/task-123", "DELETE", ["tasks:write"])
  assert.equal(deniedDelete.allowed, false)

  const grace = verifyLicenseKey("")
  assert.equal(grace.valid, true)
  assert.equal("grace" in grace && grace.grace, true)
})

test("domain-tasks status constants, Eisenhower quadrant, goal progress, and proposal hash", async () => {
  assert.equal(TASK_STATUS.PENDING, "pending")
  assert.ok(TASK_STATUS_ALIASES.pending.includes("todo"))
  assert.equal(isValidTaskKind("standard_action"), true)
  assert.equal(isValidTaskKind("unknown_kind"), false)

  assert.equal(deriveEisenhowerQuadrant(0, 0), "unclassified")
  assert.equal(deriveEisenhowerQuadrant(4, 5), "do")
  assert.equal(deriveEisenhowerQuadrant(2, 4), "schedule")
  assert.equal(deriveEisenhowerQuadrant(4, 1), "delegate")
  assert.equal(deriveEisenhowerQuadrant(1, 2), "eliminate")

  assert.equal(goalProgress(3, 4), 75)
  assert.equal(goalProgress(50, null), 50)

  const h1 = await computeProposalHash({ b: 2, a: 1 })
  const h2 = await computeProposalHash({ a: 1, b: 2 })
  assert.equal(h1, h2)
  assert.equal(h1.length, 64)
})

test("domain-strategy formula evaluator and rule resolution", () => {
  assert.equal(isFrameworkFormulaSupported("(reach * impact * confidence) / effort"), true)
  assert.equal(isFrameworkFormulaSupported("process.exit(1)"), false)
  assert.equal(
    evaluateFrameworkFormula("(reach * impact * confidence) / effort", {
      reach: 100,
      impact: 2,
      confidence: 80,
      effort: 4,
    }),
    4000,
  )
  assert.equal(evaluateFrameworkFormula("a / b", { a: 10, b: 0 }), null)

  const rules = [
    createTaskRule({
      name: "Epic RICE",
      taskTypes: ["epic"],
      lensIds: ["rice", "ddd"],
      aiScope: { canAutoScore: true },
      priority: 10,
    }),
    createTaskRule({
      name: "Urgent tag",
      tags: ["urgent"],
      lensIds: ["kcs"],
      aiScope: { canSuggestLabels: true },
      priority: 20,
    }),
  ]
  const resolved = resolveRulesForTask("epic", ["urgent"], rules)
  assert.deepEqual(resolved.lensIds, ["rice", "ddd", "kcs"])
  assert.equal(resolved.aiScope.canAutoScore, true)
  assert.equal(resolved.aiScope.canSuggestLabels, true)
})

test("integration-core SSRF host classification and outbound URL validation", () => {
  assert.equal(classifyNetworkHost("169.254.169.254"), "unconditional")
  assert.equal(classifyNetworkHost("supervisor"), "unconditional")
  assert.equal(classifyNetworkHost("127.0.0.1"), "private")
  assert.equal(classifyNetworkHost("example.com"), "public")

  assert.throws(() => assertOutboundUrl("http://169.254.169.254/latest/meta-data"), OutboundUrlError)
  assert.throws(() => assertOutboundUrl("http://127.0.0.1:8080", { allowPrivate: false }), OutboundUrlError)
  assert.equal(assertOutboundUrl("https://example.com/hook", { allowPrivate: false }).hostname, "example.com")

  const grocyOk = validateGrocyBaseUrl("http://grocy.local:9283/")
  assert.equal(grocyOk.ok, true)
  if (grocyOk.ok) assert.equal(grocyOk.normalizedUrl, "http://grocy.local:9283")
})
