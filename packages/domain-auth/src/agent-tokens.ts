/**
 * Agent Token Domain Types & Logic
 *
 * Pure domain logic for scoped agent tokens — no I/O, no persistence.
 * Tokens use SHA-256 hashing and `mth_` prefix convention.
 *
 * @domain domain-auth
 * @bounded-context agent-authorization
 * @kcs Tokens are opt-in. System works without any tokens created.
 */
import { createHash, randomBytes } from "node:crypto"

// ── Scope Definitions ────────────────────────────────────────────────────────

/** Granular scope for agent token authorization */
export type AgentScope =
  | "tasks:read"
  | "tasks:write"
  | "tasks:delete"
  | "projects:read"
  | "projects:write"
  | "search:read"
  // Persisted by earlier releases. These scopes have no authorized routes.
  | "settings:read"
  | "settings:write"
  | "webhooks:write"
  | "mcp:execute"
  | "a2a:execute"

/** Scope metadata for UI display and documentation */
export interface AgentScopeDescriptor {
  scope: AgentScope
  label: string
  description: string
  category: "tasks" | "projects" | "search" | "protocols"
}

/** All available scopes with labels and descriptions */
export const AVAILABLE_SCOPES: readonly AgentScopeDescriptor[] = [
  { scope: "tasks:read", label: "Read Tasks", description: "List and view tasks, statuses, and metadata", category: "tasks" },
  { scope: "tasks:write", label: "Create & Update Tasks", description: "Create new tasks and update existing ones", category: "tasks" },
  { scope: "tasks:delete", label: "Delete Tasks", description: "Permanently delete tasks", category: "tasks" },
  { scope: "projects:read", label: "Read Projects", description: "List and view projects and hierarchies", category: "projects" },
  { scope: "projects:write", label: "Manage Projects", description: "Create and update projects", category: "projects" },
  { scope: "search:read", label: "Search", description: "Query the search API", category: "search" },
  { scope: "mcp:execute", label: "MCP Tools", description: "Execute MCP tool calls", category: "protocols" },
  { scope: "a2a:execute", label: "A2A Protocol", description: "Use Agent-to-Agent protocol", category: "protocols" },
] as const

/** Set of valid scope strings for O(1) lookup */
const VALID_SCOPES = new Set<string>(AVAILABLE_SCOPES.map(s => s.scope))

// ── Token Types ──────────────────────────────────────────────────────────────

/** Stored token record (never contains plaintext) */
export interface AgentTokenRecord {
  id: string
  name: string
  tokenHash: string
  tokenPrefix: string
  scopes: AgentScope[]
  createdAt: string
  expiresAt: string | null
  lastUsedAt: string | null
  revoked: boolean
}

/** Token creation result (plaintext shown once) */
export interface AgentTokenCreated {
  id: string
  name: string
  token: string        // plaintext — show once, never store
  tokenPrefix: string
  scopes: AgentScope[]
  createdAt: string
  expiresAt: string | null
}

/** Public token info (safe for listing — no hash, no plaintext) */
export interface AgentTokenPublic {
  id: string
  name: string
  tokenPrefix: string
  scopes: AgentScope[]
  createdAt: string
  expiresAt: string | null
  lastUsedAt: string | null
  revoked: boolean
}

// ── Token Generation ─────────────────────────────────────────────────────────

const TOKEN_PREFIX = "mth_"
const TOKEN_BYTES = 32

/**
 * Generate a new agent token with `mth_` prefix.
 * Returns plaintext token + SHA-256 hash for storage.
 *
 * @kcs Plaintext is returned once. Only the hash is persisted.
 */
export function generateAgentToken(): { token: string; tokenHash: string; tokenPrefix: string } {
  const raw = randomBytes(TOKEN_BYTES).toString("hex")
  const token = `${TOKEN_PREFIX}${raw}`
  const tokenHash = hashToken(token)
  const tokenPrefix = token.slice(0, 12) + "..." + token.slice(-4)
  return { token, tokenHash, tokenPrefix }
}

/** SHA-256 hash a plaintext token for storage/lookup */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

// ── Scope Validation ─────────────────────────────────────────────────────────

/**
 * Validate an array of scope strings.
 * Returns only valid scopes, filtering out unknowns.
 */
export function validateScopes(scopes: string[]): { valid: AgentScope[]; invalid: string[] } {
  const valid: AgentScope[] = []
  const invalid: string[] = []
  for (const scope of scopes) {
    if (VALID_SCOPES.has(scope)) {
      valid.push(scope as AgentScope)
    } else {
      invalid.push(scope)
    }
  }
  return { valid, invalid }
}

/** Check that a token has the exact required scope. */
export function hasScope(tokenScopes: AgentScope[], required: AgentScope): boolean {
  return tokenScopes.includes(required)
}

/**
 * Convert a stored token record to public-safe format.
 * Strips hash — safe for API listing responses.
 */
export function toPublicToken(record: AgentTokenRecord): AgentTokenPublic {
  return {
    id: record.id,
    name: record.name,
    tokenPrefix: record.tokenPrefix,
    scopes: record.scopes,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
    revoked: record.revoked,
  }
}
