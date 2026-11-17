import { readBoundedCoreCommand } from "./core-bounded-command"
import type { HAConfiguration } from "./ha-configuration"

/** Read the current Core users over a dedicated, time- and size-bounded socket. */
export function readCurrentHACoreUsers(signal?: AbortSignal): Promise<unknown> {
  const token = process.env.SUPERVISOR_TOKEN
  return token ? readBoundedCoreCommand("config/auth/list", token, signal) : Promise.resolve(undefined)
}

/** Read assignee names from the configured source with the same bounded transport. */
export function readConfiguredHACoreUsers(config: HAConfiguration): Promise<unknown> {
  return readBoundedCoreCommand("config/auth/list", config.token, undefined, config.baseUrl)
}
