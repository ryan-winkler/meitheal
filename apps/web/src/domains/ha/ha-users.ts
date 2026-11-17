/**
 * HA User Discovery — Server-Side
 *
 * Auto-discovers Home Assistant users via the `config/auth/list`
 * WebSocket command. No configuration needed — uses existing
 * SUPERVISOR_TOKEN connection.
 *
 * @domain ha
 * @bounded-context users
 */
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"
import { readCurrentHACoreUsers } from "./core-user-lookup"
import { fingerprintHAConfiguration, resolveHAConfiguration } from "./ha-configuration"
import { getHAConfiguration, getHAConnection, matchesCurrentHAConnection } from "./ha-connection"

const logger = createLogger({
  service: "meitheal-web", env: process.env.NODE_ENV ?? "development",
  minLevel: "info", enabledCategories: ["ha"],
  redactPatterns: defaultRedactionPatterns, auditEnabled: false,
});
const SYS_REQ = "ha-system";

// ── Types ──

export interface HAUser {
  id: string;
  name: string;
  is_owner: boolean;
  is_active: boolean;
}

export interface MeithealUser {
  id: string;
  name: string;
  source: "home_assistant" | "custom";
  /** "agent" marks an AI agent assignee; everyone else is a person. */
  kind?: "human" | "agent";
  is_owner?: boolean;
  color?: string;
}

// ── Cache ──

let cachedRoster: { users: HAUser[]; fingerprint: string; expiresAt: number } | undefined
const CACHE_TTL_MS = 60_000

async function readRosterFingerprint(): Promise<string | null | undefined> {
  try {
    const configuration = await getHAConfiguration()
    return configuration ? fingerprintHAConfiguration(configuration) : null
  } catch {
    // The configured identity is needed before a cached roster can be reused.
    return undefined
  }
}

function sanitizeHAUserName(value: unknown): string {
  const name = typeof value === "string" ? value : ""
  let visible = ""
  let start = 0
  for (let open = name.indexOf("<"); open !== -1; open = name.indexOf("<", start)) {
    const close = name.indexOf(">", open + 1)
    if (close === -1) break
    visible += name.slice(start, open)
    start = close + 1
  }
  return (visible + name.slice(start)).trim().slice(0, 256) || "Unknown"
}

// ── Public API ──

/**
 * List assignees from HA. A successful directory is fresh for up to 60 seconds
 * while its connection is live. An outage leaves same-source names available.
 */
export async function listHAUserDirectory(): Promise<{ users: HAUser[]; verified: boolean }> {
  const fingerprint = await readRosterFingerprint()
  if (fingerprint !== undefined && cachedRoster?.fingerprint !== fingerprint) invalidateUserCache()
  if (!fingerprint) return { users: [], verified: fingerprint === null }

  if (cachedRoster && Date.now() < cachedRoster.expiresAt && matchesCurrentHAConnection(fingerprint)) {
    return { users: cachedRoster.users, verified: true }
  }
  if (cachedRoster) cachedRoster.expiresAt = 0

  const unverified = async () => ({
    users: await readRosterFingerprint() === fingerprint && cachedRoster?.fingerprint === fingerprint
      ? cachedRoster.users : [],
    verified: false,
  })

  const conn = await getHAConnection()
  if (!conn || !matchesCurrentHAConnection(fingerprint, conn)) return unverified()

  try {
    const result = await conn.sendMessagePromise<HAUser[]>({
      type: "config/auth/list",
    });

    // Filter out system-generated accounts (e.g. homeassistant, supervisor)
    if (!Array.isArray(result)) throw new Error("Invalid Home Assistant user directory")
    const users = result.filter(
      (u) => !((u as unknown as Record<string, unknown>).system_generated) && u.is_active
    ).map((u) => ({
      ...u,
      name: sanitizeHAUserName(u.name),
      // Validate ID is clean alphanumeric — prefix with ha_ for downstream validation compat
      id: /^[a-zA-Z0-9_-]+$/.test(u.id) ? u.id : `ha_sanitized_${u.id.replace(/[^a-zA-Z0-9]/g, "")}`,
    }));

    if (await readRosterFingerprint() !== fingerprint || !matchesCurrentHAConnection(fingerprint, conn)) return unverified()
    cachedRoster = { users, fingerprint, expiresAt: Date.now() + CACHE_TTL_MS }

    logger.log("info", {
      event: "ha.users.discovered", domain: "ha", component: "ha-users",
      request_id: SYS_REQ, message: `Discovered ${users.length} HA user(s)`,
    });

    return { users, verified: true };
  } catch (err) {
    logger.log("error", {
      event: "ha.users.discovery_failed", domain: "ha", component: "ha-users",
      request_id: SYS_REQ, message: `Failed to list HA users: ${err}`,
    });
    return unverified()
  }
}

export async function listHAUsers(): Promise<HAUser[]> {
  return (await listHAUserDirectory()).users;
}

/**
 * Invalidate the cached user list. Call after user management changes.
 */
export function invalidateUserCache(): void {
  cachedRoster = undefined
}

/** Resolve an ingress author's display name from the Supervisor roster. */
export function getCachedHAUserName(userId: string): string | undefined {
  if (!cachedRoster || !process.env.SUPERVISOR_TOKEN) return
  const configuration = resolveHAConfiguration(process.env)
  if (configuration && cachedRoster.fingerprint === fingerprintHAConfiguration(configuration)) {
    return cachedRoster.users.find(user => user.id === userId)?.name
  }
}

/**
 * Get a single HA user by ID. Returns null if not found.
 */
export async function getHAUserById(userId: string): Promise<HAUser | null> {
  const users = await listHAUsers();
  return users.find((u) => u.id === userId) ?? null;
}

const activeUserFreshnessMs = 5_000
const maxMembershipLookups = 16
type ActiveHARoster = ReadonlyMap<string, string>
let activeUsers: { roster: ActiveHARoster; expiresAt: number } | undefined
let checkingActiveUsers: Promise<ActiveHARoster | undefined> | undefined
let pendingLookups = 0
let latestLookup = 0
let latestCompletedLookup = 0

function parseActiveUserRoster(users: unknown): ActiveHARoster | undefined {
  if (!Array.isArray(users)) return
  const seen = new Set<string>()
  const active = new Map<string, string>()
  for (const user of users) {
    if (!user || typeof user !== "object" || typeof user.id !== "string" || !user.id.trim()
      || typeof user.is_active !== "boolean" || typeof user.system_generated !== "boolean"
      || seen.has(user.id)) return
    seen.add(user.id)
    if (user.is_active && !user.system_generated) {
      active.set(user.id, typeof user.name === "string" ? user.name : "")
    }
  }
  return active
}

async function refreshActiveUsers(signal?: AbortSignal): Promise<ActiveHARoster | undefined> {
  if (pendingLookups >= maxMembershipLookups || signal?.aborted) return
  const generation = ++latestLookup
  const expiresAt = performance.now() + activeUserFreshnessMs
  pendingLookups++
  try {
    const roster = parseActiveUserRoster(await readCurrentHACoreUsers(signal))
    if (generation > latestCompletedLookup) {
      latestCompletedLookup = generation
      activeUsers = roster && { roster, expiresAt }
    }
    return roster
  } finally {
    pendingLookups--
  }
}

async function waitForReadCheck(check: Promise<ActiveHARoster | undefined>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await check
    return
  }
  if (signal.aborted) return
  let detach: (() => void) | undefined
  try {
    await Promise.race([check, new Promise<void>(resolve => {
      const abort = () => resolve()
      detach = () => signal.removeEventListener("abort", abort)
      signal.addEventListener("abort", abort, { once: true })
    })])
  } finally {
    detach?.()
  }
}

async function getFreshHAUserRoster(id: string, signal?: AbortSignal): Promise<ActiveHARoster | undefined> {
  const roster = await refreshActiveUsers(signal)
  const latest = activeUsers?.roster
  if (!signal?.aborted && roster?.has(id) && latest?.has(id)) return latest
}

/** Fetch a current roster and return display names only to a currently active member. */
export async function getCurrentHAUserRoster(id: string, signal?: AbortSignal): Promise<ActiveHARoster | undefined> {
  const roster = await getFreshHAUserRoster(id, signal)
  if (roster) return new Map([...roster].map(([id, name]) => [id, sanitizeHAUserName(name)]))
}

/** Check the exact Core identity for an authorization decision without using discovery fallbacks. */
export async function isCurrentActiveHAUser(
  id: string,
  { fresh = false, signal }: { fresh?: boolean; signal?: AbortSignal } = {},
): Promise<boolean> {
  if (signal?.aborted) return false
  if (fresh) return Boolean(await getFreshHAUserRoster(id, signal))
  if (!activeUsers || activeUsers.expiresAt <= performance.now()) {
    checkingActiveUsers ??= refreshActiveUsers().finally(() => { checkingActiveUsers = undefined })
    await waitForReadCheck(checkingActiveUsers, signal)
  }
  return Boolean(!signal?.aborted && activeUsers && activeUsers.expiresAt > performance.now() && activeUsers.roster.has(id))
}
