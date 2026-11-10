/**
 * Runtime Detection — HA vs Cloudflare
 *
 * Provides typed config accessor for runtime-specific settings.
 * Uses environment variable MEITHEAL_RUNTIME to distinguish.
 *
 * Bounded context: integration-core
 */

export type MeithealRuntime = "ha-addon" | "cloudflare" | "standalone"

export interface RuntimeConfig {
  runtime: MeithealRuntime
  dbType: "sqlite" | "d1"
  /** True if running inside HA Supervisor */
  haSupervised: boolean
  /** True if running on Cloudflare Workers */
  cloudflare: boolean
}

function readEnvSafe(name: string): string | undefined {
  // Works in both Node.js and Cloudflare Workers (via env binding)
  try {
    const maybeProcess = globalThis as { process?: { env?: Record<string, string | undefined> } }
    return maybeProcess.process?.env?.[name]
  } catch {
    return undefined
  }
}

export function detectRuntime(env?: Record<string, unknown>): RuntimeConfig {
  // Cloudflare Workers pass env as a binding object
  if (env && typeof env === "object") {
    const runtimeHint = env.MEITHEAL_RUNTIME as string | undefined
    if (runtimeHint === "cloudflare" || env.CF_PAGES !== undefined) {
      return {
        runtime: "cloudflare",
        dbType: "d1",
        haSupervised: false,
        cloudflare: true,
      }
    }
  }

  // HA Supervisor injects SUPERVISOR_TOKEN
  const supervisorToken = readEnvSafe("SUPERVISOR_TOKEN")
  if (supervisorToken) {
    return {
      runtime: "ha-addon",
      dbType: "sqlite",
      haSupervised: true,
      cloudflare: false,
    }
  }

  // Explicit runtime hint
  const runtimeEnv = readEnvSafe("MEITHEAL_RUNTIME")
  if (runtimeEnv === "cloudflare") {
    return {
      runtime: "cloudflare",
      dbType: "d1",
      haSupervised: false,
      cloudflare: true,
    }
  }

  // Default: standalone Node.js
  return {
    runtime: "standalone",
    dbType: "sqlite",
    haSupervised: false,
    cloudflare: false,
  }
}
