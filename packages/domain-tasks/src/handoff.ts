/**
 * Handoff State Machine — Bot Orchestration Core
 *
 * Manages the lifecycle of bot ↔ human task handoff:
 *   idle → claimed → proposed → accepted/rejected → idle
 *
 * All operations are pure functions that return SQL statements or validation results.
 * The actual DB execution is handled by store.ts / API handlers.
 *
 * @domain tasks
 * @bounded-context domain-tasks
 * @see docs/decisions/ADR-007-hierarchy-model.md
 */

import {
  type HandoffState,
  isValidHandoffTransition,
} from "./domain-model"

// --- Lock Management ---

const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000 // 5 minutes

export type ClaimResult =
  | { ok: true; lockExpiresAt: number }
  | { ok: false; errorCode: "already_locked" | "invalid_transition"; currentHolder?: string; expiresAt?: number }

export function validateClaim(
  currentState: HandoffState,
  currentLockHolder: string | null,
  currentLockExpiresAt: number | null,
  now: number = Date.now(),
): ClaimResult {
  // If there's an active, non-expired lock held by another agent, reject
  if (
    currentLockHolder !== null &&
    currentLockExpiresAt !== null &&
    currentLockExpiresAt > now
  ) {
    return {
      ok: false,
      errorCode: "already_locked",
      currentHolder: currentLockHolder,
      expiresAt: currentLockExpiresAt,
    }
  }

  // Validate state transition
  if (!isValidHandoffTransition(currentState, "claimed")) {
    return {
      ok: false,
      errorCode: "invalid_transition",
    }
  }

  return {
    ok: true,
    lockExpiresAt: now + DEFAULT_LOCK_TTL_MS,
  }
}

// --- Proposal Management ---

export interface ProposalPayload {
  /** What the bot wants to change (structured diff) */
  changes: Record<string, { from: unknown; to: unknown }>
  /** Human-readable summary of the proposal */
  summary: string
  /** Bot agent name that created the proposal */
  agent: string
}

/**
 * Compute SHA-256 hash of proposal content for TOCTOU prevention.
 * Uses the Web Crypto API (available in Node 18+ and all modern browsers).
 */
export async function computeProposalHash(proposal: ProposalPayload): Promise<string> {
  const content = JSON.stringify(proposal)
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("")
}

export type ProposeResult =
  | { ok: true; proposalHash: string }
  | { ok: false; errorCode: "invalid_transition" | "not_lock_holder" }

export function validatePropose(
  currentState: HandoffState,
  lockHolder: string | null,
  agentName: string,
): { ok: boolean; errorCode?: string } {
  if (lockHolder !== agentName) {
    return { ok: false, errorCode: "not_lock_holder" }
  }

  if (!isValidHandoffTransition(currentState, "proposed")) {
    return { ok: false, errorCode: "invalid_transition" }
  }

  return { ok: true }
}

// --- Accept / Reject ---

export type AcceptResult =
  | { ok: true; appliedChanges: Record<string, { from: unknown; to: unknown }> }
  | { ok: false; errorCode: "invalid_transition" | "hash_mismatch" | "no_proposal" }

export function validateAccept(
  currentState: HandoffState,
  storedHash: string | null,
  expectedHash: string,
  proposalJson: string | null,
): { ok: boolean; errorCode?: string } {
  if (!proposalJson || !storedHash) {
    return { ok: false, errorCode: "no_proposal" }
  }

  if (!isValidHandoffTransition(currentState, "accepted")) {
    return { ok: false, errorCode: "invalid_transition" }
  }

  if (storedHash !== expectedHash) {
    return { ok: false, errorCode: "hash_mismatch" }
  }

  return { ok: true }
}

export type RejectResult =
  | { ok: true }
  | { ok: false; errorCode: "invalid_transition" | "no_proposal" }

export function validateReject(
  currentState: HandoffState,
  proposalJson: string | null,
): RejectResult {
  if (!proposalJson) {
    return { ok: false, errorCode: "no_proposal" }
  }

  if (!isValidHandoffTransition(currentState, "rejected")) {
    return { ok: false, errorCode: "invalid_transition" }
  }

  return { ok: true }
}

// --- Cleanup ---

/**
 * Find tasks with expired locks and transition them back to idle.
 * Should be called periodically (e.g., every 5 minutes) or on sync.
 *
 * Returns the SQL statement for the cleanup query.
 */
export function getExpiredLockClause(now: number = Date.now()): {
  sql: string
  args: (string | number)[]
} {
  return {
    sql: "UPDATE tasks SET handoff_state = 'idle', lock_holder = NULL, lock_expires_at = NULL, agent_scratchpad = NULL WHERE lock_expires_at IS NOT NULL AND lock_expires_at < ? AND handoff_state IN ('claimed', 'proposed')",
    args: [now],
  }
}
