import { expect, test } from "@playwright/test"
import {
  isValidHandoffTransition,
  type HandoffState,
  VALID_HANDOFF_STATES,
} from "../../packages/domain-tasks/src/domain-model"
import {
  validateClaim,
  validatePropose,
  validateAccept,
  validateReject,
  computeProposalHash,
  getExpiredLockClause,
  type ProposalPayload,
} from "../../packages/domain-tasks/src/handoff"

// --- State Machine Transition Validation ---

const VALID_TRANSITIONS: [HandoffState, HandoffState][] = [
  ["idle", "claimed"],
  ["claimed", "proposed"],
  ["claimed", "idle"],           // release without proposing
  ["claimed", "failed"],         // agent error during claim
  ["proposed", "accepted"],
  ["proposed", "rejected"],
  ["proposed", "idle"],          // timeout (legacy)
  ["proposed", "failed"],        // agent error during proposal
  ["proposed", "timeout"],       // stale proposal
  ["proposed", "human_override"],// user took over
  ["accepted", "idle"],          // post-apply cleanup
  ["rejected", "idle"],          // post-reject cleanup
  ["rejected", "claimed"],       // retry after rejection
  ["failed", "idle"],            // error cleanup
  ["failed", "claimed"],         // retry after failure
  ["timeout", "idle"],           // timeout cleanup
  ["timeout", "claimed"],        // retry after timeout
  ["human_override", "idle"],    // override cleanup
]

const INVALID_TRANSITIONS: [HandoffState, HandoffState][] = [
  ["idle", "proposed"],          // can't propose without claiming
  ["idle", "accepted"],          // can't accept without proposal
  ["idle", "rejected"],          // can't reject without proposal
  ["idle", "idle"],              // self-loop not allowed
  ["claimed", "accepted"],       // must go through proposed
  ["claimed", "rejected"],       // must go through proposed
  ["claimed", "claimed"],        // already claimed
  ["proposed", "claimed"],       // can't re-claim
  ["proposed", "proposed"],      // already proposed
  ["accepted", "claimed"],       // terminal
  ["accepted", "proposed"],      // terminal
  ["accepted", "accepted"],      // self-loop
  ["accepted", "rejected"],      // terminal
  ["rejected", "proposed"],      // can't propose from rejected
  ["rejected", "accepted"],      // can't accept from rejected
  ["rejected", "rejected"],      // self-loop
  ["failed", "proposed"],        // can't propose from failed
  ["failed", "failed"],          // self-loop
  ["timeout", "proposed"],       // can't propose from timeout
  ["timeout", "timeout"],        // self-loop
  ["human_override", "claimed"],  // can't re-claim after override
  ["human_override", "human_override"], // self-loop
]

for (const [from, to] of VALID_TRANSITIONS) {
  test(`valid transition: ${from} → ${to}`, () => {
    expect(isValidHandoffTransition(from, to)).toBe(true)
  })
}

for (const [from, to] of INVALID_TRANSITIONS) {
  test(`invalid transition: ${from} → ${to} is rejected`, () => {
    expect(isValidHandoffTransition(from, to)).toBe(false)
  })
}

// --- validateClaim ---

test("validateClaim succeeds for idle task with no lock", () => {
  const result = validateClaim("idle", null, null, 1000)
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.lockExpiresAt).toBe(1000 + 5 * 60 * 1000)
  }
})

test("validateClaim rejects if another agent holds active lock", () => {
  const futureExpiry = Date.now() + 300000
  const result = validateClaim("idle", "bot:assistant", futureExpiry)
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.errorCode).toBe("already_locked")
    expect(result.currentHolder).toBe("bot:assistant")
  }
})

test("validateClaim succeeds if lock has expired", () => {
  const pastExpiry = Date.now() - 1000
  const now = Date.now()
  const result = validateClaim("idle", "bot:expired-agent", pastExpiry, now)
  expect(result.ok).toBe(true)
})

test("validateClaim rejects invalid state transition", () => {
  const result = validateClaim("proposed", null, null)
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.errorCode).toBe("invalid_transition")
  }
})

// --- validatePropose ---

test("validatePropose succeeds when lock holder matches", () => {
  const result = validatePropose("claimed", "bot:mcp", "bot:mcp")
  expect(result.ok).toBe(true)
})

test("validatePropose rejects when lock holder doesn't match", () => {
  const result = validatePropose("claimed", "bot:other", "bot:mcp")
  expect(result.ok).toBe(false)
  expect(result.errorCode).toBe("not_lock_holder")
})

test("validatePropose rejects invalid transition", () => {
  const result = validatePropose("idle", "bot:mcp", "bot:mcp")
  expect(result.ok).toBe(false)
  expect(result.errorCode).toBe("invalid_transition")
})

// --- validateAccept ---

test("validateAccept succeeds with matching hash", () => {
  const result = validateAccept("proposed", "abc123", "abc123", '{"changes":{}}')
  expect(result.ok).toBe(true)
})

test("validateAccept rejects hash mismatch", () => {
  const result = validateAccept("proposed", "abc123", "different", '{"changes":{}}')
  expect(result.ok).toBe(false)
  expect(result.errorCode).toBe("hash_mismatch")
})

test("validateAccept rejects when no proposal exists", () => {
  const result = validateAccept("proposed", null, "abc123", null)
  expect(result.ok).toBe(false)
  expect(result.errorCode).toBe("no_proposal")
})

// --- validateReject ---

test("validateReject succeeds for proposed task with proposal", () => {
  const result = validateReject("proposed", '{"changes":{}}')
  expect(result.ok).toBe(true)
})

test("validateReject rejects when no proposal exists", () => {
  const result = validateReject("proposed", null)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.errorCode).toBe("no_proposal")
})

// --- computeProposalHash ---

test("computeProposalHash produces consistent SHA-256 hash", async () => {
  const proposal: ProposalPayload = {
    changes: { title: { from: "Old", to: "New" } },
    summary: "Rename task",
    agent: "bot:mcp",
  }

  const hash1 = await computeProposalHash(proposal)
  const hash2 = await computeProposalHash(proposal)

  expect(hash1).toBe(hash2)
  expect(hash1.length).toBe(64) // SHA-256 = 64 hex chars
})

test("computeProposalHash produces different hash for different content", async () => {
  const proposal1: ProposalPayload = {
    changes: { title: { from: "A", to: "B" } },
    summary: "Change 1",
    agent: "bot:mcp",
  }
  const proposal2: ProposalPayload = {
    changes: { title: { from: "A", to: "C" } },
    summary: "Change 2",
    agent: "bot:mcp",
  }

  const hash1 = await computeProposalHash(proposal1)
  const hash2 = await computeProposalHash(proposal2)

  expect(hash1).not.toBe(hash2)
})

// --- getExpiredLockClause ---

test("getExpiredLockClause returns valid SQL", () => {
  const clause = getExpiredLockClause(1000)
  expect(clause.sql).toContain("UPDATE tasks SET handoff_state = 'idle'")
  expect(clause.sql).toContain("lock_expires_at < ?")
  expect(clause.args).toEqual([1000])
})

// --- All valid states are accounted for ---

test("all handoff states are valid enum values", () => {
  expect(VALID_HANDOFF_STATES).toEqual(["idle", "claimed", "proposed", "accepted", "rejected", "failed", "timeout", "human_override"])
})
