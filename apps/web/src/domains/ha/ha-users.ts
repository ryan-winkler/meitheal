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
import { readCurrentHACoreUsers } from "./core-user-lookup"
import { getHAConnection } from "./ha-connection";
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability";

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
  is_owner?: boolean;
  color?: string;
}

// ── Cache ──

let cachedUsers: HAUser[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000; // 60s

// ── Public API ──

/**
 * List HA users via WebSocket `config/auth/list`.
 * Cached for 60s. Returns [] in standalone mode (no SUPERVISOR_TOKEN).
 */
export async function listHAUsers(): Promise<HAUser[]> {
  const now = Date.now();
  if (cachedUsers && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedUsers;
  }

  const conn = await getHAConnection();
  if (!conn) {
    // Standalone mode — no HA connection available
    cachedUsers = [];
    cacheTimestamp = now;
    return [];
  }

  try {
    const result = await conn.sendMessagePromise<HAUser[]>({
      type: "config/auth/list",
    });

    // Filter out system-generated accounts (e.g. homeassistant, supervisor)
    const users = (result ?? []).filter(
      (u) => !((u as unknown as Record<string, unknown>).system_generated) && u.is_active
    ).map((u) => ({
      ...u,
      // Sanitize display name — strip HTML tags to prevent stored XSS.
      // Loop to handle nested/malformed fragments like <scr<script>ipt> (CodeQL: js/incomplete-multi-character-sanitization).
      name: (() => { let n = u.name || ""; for (let i = 0; i < 10 && /<[^>]*>/g.test(n); i++) n = n.replace(/<[^>]*>/g, ""); return n.trim() || "Unknown"; })(),
      // Validate ID is clean alphanumeric — prefix with ha_ for downstream validation compat
      id: /^[a-zA-Z0-9_-]+$/.test(u.id) ? u.id : `ha_sanitized_${u.id.replace(/[^a-zA-Z0-9]/g, "")}`,
    }));

    cachedUsers = users;
    cacheTimestamp = now;

    logger.log("info", {
      event: "ha.users.discovered", domain: "ha", component: "ha-users",
      request_id: SYS_REQ, message: `Discovered ${users.length} HA user(s)`,
    });

    return users;
  } catch (err) {
    logger.log("error", {
      event: "ha.users.discovery_failed", domain: "ha", component: "ha-users",
      request_id: SYS_REQ, message: `Failed to list HA users: ${err}`,
    });
    // Return cached if available, otherwise empty
    return cachedUsers ?? [];
  }
}

/**
 * Invalidate the cached user list. Call after user management changes.
 */
export function invalidateUserCache(): void {
  cachedUsers = null;
  cacheTimestamp = 0;
}

/** Resolve a display name without waiting for a live Home Assistant call. */
export function getCachedHAUserName(userId: string): string | undefined {
  return cachedUsers?.find(user => user.id === userId)?.name
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
let activeUsers: { ids: Set<string>; expiresAt: number } | undefined
let checkingActiveUsers: Promise<Set<string> | undefined> | undefined
let pendingLookups = 0
let latestLookup = 0
let latestCompletedLookup = 0

function parseActiveUserIds(users: unknown): Set<string> | undefined {
  if (!Array.isArray(users)) return
  const seen = new Set<string>()
  const active = new Set<string>()
  for (const user of users) {
    if (!user || typeof user !== "object" || typeof user.id !== "string" || !user.id.trim()
      || typeof user.is_active !== "boolean" || typeof user.system_generated !== "boolean"
      || seen.has(user.id)) return
    seen.add(user.id)
    if (user.is_active && !user.system_generated) active.add(user.id)
  }
  return active
}

async function refreshActiveUsers(signal?: AbortSignal): Promise<Set<string> | undefined> {
  if (pendingLookups >= maxMembershipLookups || signal?.aborted) return
  const generation = ++latestLookup
  const expiresAt = performance.now() + activeUserFreshnessMs
  pendingLookups++
  try {
    const ids = parseActiveUserIds(await readCurrentHACoreUsers(signal))
    if (generation > latestCompletedLookup) {
      latestCompletedLookup = generation
      activeUsers = ids && { ids, expiresAt }
    }
    return ids
  } finally {
    pendingLookups--
  }
}

async function waitForReadCheck(check: Promise<Set<string> | undefined>, signal?: AbortSignal): Promise<void> {
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

/** Check the exact Core identity for an authorization decision without using discovery fallbacks. */
export async function isCurrentActiveHAUser(
  id: string,
  { fresh = false, signal }: { fresh?: boolean; signal?: AbortSignal } = {},
): Promise<boolean> {
  if (signal?.aborted) return false
  if (fresh) {
    const ids = await refreshActiveUsers(signal)
    return Boolean(!signal?.aborted && ids?.has(id) && activeUsers?.ids.has(id))
  }
  if (!activeUsers || activeUsers.expiresAt <= performance.now()) {
    checkingActiveUsers ??= refreshActiveUsers().finally(() => { checkingActiveUsers = undefined })
    await waitForReadCheck(checkingActiveUsers, signal)
  }
  return Boolean(!signal?.aborted && activeUsers && activeUsers.expiresAt > performance.now() && activeUsers.ids.has(id))
}
