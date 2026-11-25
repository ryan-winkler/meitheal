import { createHash } from "node:crypto"
import { readBoundedCoreCommand } from "./core-bounded-command"
import type { HAConfiguration } from "./ha-configuration"
import { syncHAUserCacheFromCore } from "./ha-user-cache"

type CoreObservation = { order: number, users: unknown }
const maxMembershipLookups = 16
let authority: { fingerprint: string, latest?: CoreObservation, inFlight?: Promise<unknown> } | undefined
let nextRead = 0
let pendingLookups = 0

/** Read current Core users with single-flight deduplication and local cache sync. */
export async function readCurrentHACoreUsers(signal?: AbortSignal): Promise<unknown> {
  const token = process.env.SUPERVISOR_TOKEN
  if (!token || signal?.aborted || pendingLookups >= maxMembershipLookups) return
  const fingerprint = createHash("sha256").update(token).digest("hex")
  if (authority?.fingerprint !== fingerprint) authority = { fingerprint }
  const currentAuthority = authority

  // Coalesce concurrent requests so page loads don't open dozens of simultaneous HA WebSockets
  if (currentAuthority.inFlight) {
    if (!signal) return currentAuthority.inFlight
    return Promise.race([
      currentAuthority.inFlight,
      new Promise<undefined>(resolve => {
        if (signal.aborted) { resolve(undefined); return }
        signal.addEventListener("abort", () => resolve(undefined), { once: true })
      }),
    ])
  }

  const order = ++nextRead
  pendingLookups++
  let fetchPromise: Promise<unknown> | undefined = undefined
  fetchPromise = (async () => {
    try {
      const users = await readBoundedCoreCommand("config/auth/list", token, signal)
      if (authority !== currentAuthority || process.env.SUPERVISOR_TOKEN !== token) return
      if (Array.isArray(users)) {
        if (!currentAuthority.latest || order > currentAuthority.latest.order) {
          currentAuthority.latest = { order, users }
        }
        await syncHAUserCacheFromCore(users, fingerprint).catch(() => {})
        return currentAuthority.latest.users
      }
      return undefined
    } finally {
      pendingLookups--
      if (currentAuthority.inFlight === fetchPromise) {
        currentAuthority.inFlight = undefined
      }
    }
  })()

  currentAuthority.inFlight = fetchPromise
  return fetchPromise
}

/** Read assignee names from the configured source with the same bounded transport. */
export function readConfiguredHACoreUsers(config: HAConfiguration): Promise<unknown> {
  return readBoundedCoreCommand("config/auth/list", config.token, undefined, config.baseUrl)
}
