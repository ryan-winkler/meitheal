import * as childProcess from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

export * from "node:child_process"

/** Keep separate migrator/server processes in the synthetic database's explicit marker context. */
function isolatedArguments(input: unknown[]): unknown[] {
  const args = [...input]
  const optionIndex = Array.isArray(args[1]) ? 2 : 1
  const options = args[optionIndex]
  if (options !== undefined && (typeof options !== "object" || options === null)) return args
  const selected = (options ?? {}) as { env?: NodeJS.ProcessEnv }
  const env = selected.env ?? process.env
  const url = env.MEITHEAL_DB_URL
  if (!url?.startsWith("file:") || url.includes(":memory:") || env.MEITHEAL_BOARD_GRANT_PATH) return args
  const database = url.startsWith("file://") ? fileURLToPath(url) : resolve(url.slice(5))
  args[optionIndex] = { ...selected, env: { ...env, MEITHEAL_BOARD_GRANT_PATH: database + ".board-grants.json" } }
  return args
}

function isolated<T extends Function>(operation: T): T {
  const wrapped = function (this: unknown, ...args: unknown[]) {
    return Reflect.apply(operation, this, isolatedArguments(args))
  }
  const custom = Reflect.get(operation, promisify.custom)
  if (typeof custom === "function") {
    Object.defineProperty(wrapped, promisify.custom, {
      value: (...args: unknown[]) => Reflect.apply(custom, operation, isolatedArguments(args)),
    })
  }
  return wrapped as unknown as T
}

export const execFile = isolated(childProcess.execFile)
export const execFileSync = isolated(childProcess.execFileSync)
export const spawn = isolated(childProcess.spawn)
export const spawnSync = isolated(childProcess.spawnSync)
export const fork = isolated(childProcess.fork)
