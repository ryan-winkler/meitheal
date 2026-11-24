import { createHash } from "node:crypto"
import { readBoundedCoreCommand } from "./core-bounded-command"
import type { HAConfiguration } from "./ha-configuration"

type CoreObservation = { order: number, users: unknown }
const maxMembershipLookups = 16
let authority: { fingerprint: string, latest?: CoreObservation } | undefined
let nextRead = 0
let pendingLookups = 0

/** Read current Core users without letting an older completion supersede a newer check. */
export async function readCurrentHACoreUsers(signal?: AbortSignal): Promise<unknown> {
  const token = process.env.SUPERVISOR_TOKEN
  if (!token || signal?.aborted || pendingLookups >= maxMembershipLookups) return
  const fingerprint = createHash("sha256").update(token).digest("hex")
  if (authority?.fingerprint !== fingerprint) authority = { fingerprint }
  const currentAuthority = authority
  const order = ++nextRead
  pendingLookups++
  try {
    const users = await readBoundedCoreCommand("config/auth/list", token, signal)
    if (signal?.aborted || authority !== currentAuthority || process.env.SUPERVISOR_TOKEN !== token) return
    if (!currentAuthority.latest || order > currentAuthority.latest.order) {
      currentAuthority.latest = { order, users }
    }
    return currentAuthority.latest.users
  } finally {
    pendingLookups--
  }
}

/** Read assignee names from the configured source with the same bounded transport. */
export function readConfiguredHACoreUsers(config: HAConfiguration): Promise<unknown> {
  return readBoundedCoreCommand("config/auth/list", config.token, undefined, config.baseUrl)
}
