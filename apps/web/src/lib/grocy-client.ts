import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"
import { GrocyAdapter, validateGrocyBaseUrl } from "@meitheal/integration-core"
import { getPersistenceClient, SettingsRepository } from "@domains/tasks"
import { supervisorFetch } from "./supervisor-fetch"

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["integrations"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: false,
})

const LEGACY_HASSIO_INGRESS_PATH = /^\/api\/hassio_ingress\/[A-Za-z0-9_-]+\/?$/

/**
 * Extract normalized `/api/hassio_ingress/<token>` path when `rawUrl` is either a bare
 * Supervisor ingress path or the legacy `http://supervisor/api/hassio_ingress/<token>` URL.
 */
export function extractLegacyIngressPath(rawUrl: string): string | null {
  const trimmed = rawUrl.trim()
  if (LEGACY_HASSIO_INGRESS_PATH.test(trimmed)) {
    return trimmed.replace(/\/+$/, "")
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (
    parsed.protocol === "http:" &&
    parsed.hostname.toLowerCase() === "supervisor" &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    LEGACY_HASSIO_INGRESS_PATH.test(parsed.pathname)
  ) {
    return parsed.pathname.replace(/\/+$/, "")
  }
  return null
}

/**
 * True when a URL matches the legacy auto-detected `http://supervisor/api/hassio_ingress/<token>`
 * or bare `/api/hassio_ingress/<token>` form written before Supervisor hostnames were blocked.
 */
export function isLegacySupervisorIngressUrl(rawUrl: string): boolean {
  return extractLegacyIngressPath(rawUrl) !== null
}

function selectAddonPort(info: {
  ingress_port?: unknown
  network?: Record<string, unknown>
}): number {
  const network = info.network
  if (network && typeof network === "object") {
    const port80 = network["80/tcp"]
    if (typeof port80 === "number" && Number.isInteger(port80) && port80 > 0 && port80 <= 65535) {
      return 80
    }
    for (const [key, mapped] of Object.entries(network)) {
      const match = /^(\d+)\/tcp$/.exec(key)
      if (
        match &&
        typeof mapped === "number" &&
        Number.isInteger(mapped) &&
        mapped > 0 &&
        mapped <= 65535
      ) {
        const containerPort = Number(match[1])
        if (Number.isInteger(containerPort) && containerPort > 0 && containerPort <= 65535) {
          return containerPort
        }
      }
    }
  }
  if (
    typeof info.ingress_port === "number" &&
    Number.isInteger(info.ingress_port) &&
    info.ingress_port > 0 &&
    info.ingress_port <= 65535
  ) {
    return info.ingress_port
  }
  return 80
}

async function resolveStartedAddonContainerUrl(slug: string): Promise<string | null> {
  let hostname = slug.replace(/_/g, "-")
  let port = 80
  try {
    const infoRes = await supervisorFetch(`/addons/${encodeURIComponent(slug)}/info`)
    if (infoRes?.ok) {
      const infoData = (await infoRes.json()) as {
        data?: {
          hostname?: string
          ingress_port?: number
          network?: Record<string, unknown>
        }
      }
      if (typeof infoData.data?.hostname === "string" && infoData.data.hostname.trim()) {
        hostname = infoData.data.hostname.trim()
      }
      if (infoData.data) {
        port = selectAddonPort(infoData.data)
      }
    } else {
      await infoRes?.body?.cancel().catch(() => undefined)
    }
  } catch {
    /* Fall back to standard slug-derived container hostname and port 80 */
  }

  const check = validateGrocyBaseUrl(`http://${hostname}:${port}`)
  if (!check.ok) return null
  return check.normalizedUrl
}

async function listStartedSupervisorGrocyAddons(): Promise<
  Array<{ slug: string; ingress_url?: string; state?: string }>
> {
  const addonsRes = await supervisorFetch("/addons")
  if (!addonsRes?.ok) {
    await addonsRes?.body?.cancel().catch(() => undefined)
    return []
  }
  const addonsData = (await addonsRes.json()) as {
    data?: { addons?: { slug: string; ingress_url?: string; state?: string }[] }
  }
  return (addonsData.data?.addons ?? []).filter(
    (addon) => addon.slug.includes("grocy") && addon.state === "started",
  )
}

/**
 * Resolve the direct internal container URL for a started Home Assistant Grocy add-on
 * (e.g. `http://a0d7b954-grocy` or `http://a0d7b954-grocy:<port>`) via Supervisor metadata
 * rather than proxying `http://supervisor/*`.
 *
 * When `expectedIngressUrl` is provided, matches the add-on's `ingress_url` so migrating
 * a saved URL never switches to a different Grocy add-on instance.
 */
export async function resolveSupervisorGrocyAddon(
  expectedIngressUrl?: string,
): Promise<{ slug: string; url: string } | null> {
  try {
    const startedAddons = await listStartedSupervisorGrocyAddons()
    const expectedPath = expectedIngressUrl ? extractLegacyIngressPath(expectedIngressUrl) : null
    const grocy = expectedPath
      ? startedAddons.find(
          (addon) =>
            typeof addon.ingress_url === "string" &&
            addon.ingress_url.replace(/\/+$/, "") === expectedPath,
        )
      : startedAddons[0]
    if (!grocy?.slug) return null

    const url = await resolveStartedAddonContainerUrl(grocy.slug)
    if (!url) return null
    return { slug: grocy.slug, url }
  } catch {
    return null
  }
}

/**
 * Return the Supervisor add-on slug whose resolved internal container hostname matches `targetUrl`,
 * or `null` when `targetUrl` points at an external/non-Supervisor Grocy server.
 */
export async function resolveSupervisorGrocySlugForUrl(targetUrl: string): Promise<string | null> {
  try {
    const target = new URL(targetUrl)
    const targetHostname = target.hostname.toLowerCase()
    const startedAddons = await listStartedSupervisorGrocyAddons()
    let hostnameFallbackSlug: string | null = null
    for (const addon of startedAddons) {
      if (!addon.slug) continue
      const resolvedUrl = await resolveStartedAddonContainerUrl(addon.slug)
      if (!resolvedUrl) continue
      const resolved = new URL(resolvedUrl)
      if (resolved.origin === target.origin) {
        return addon.slug
      }
      if (!hostnameFallbackSlug && resolved.hostname.toLowerCase() === targetHostname) {
        hostnameFallbackSlug = addon.slug
      }
    }
    return hostnameFallbackSlug
  } catch {
    return null
  }
}

export async function createGrocyClient(): Promise<GrocyAdapter | null> {
  try {
    const client = getPersistenceClient()
    const result = await client.execute(
      "SELECT key, value FROM settings WHERE key IN ('grocy_url', 'grocy_api_key')",
    )

    let baseUrl: string | undefined
    let apiKey: string | undefined

    for (const row of result.rows) {
      if (row.key === "grocy_url") {
        try {
          const parsedUrl: unknown = JSON.parse(String(row.value))
          if (typeof parsedUrl === "string") baseUrl = parsedUrl
        } catch {
          baseUrl = String(row.value)
        }
      } else if (row.key === "grocy_api_key") {
        try {
          const parsedKey: unknown = JSON.parse(String(row.value))
          if (typeof parsedKey === "string") apiKey = parsedKey
          else if (typeof parsedKey === "number" && Number.isFinite(parsedKey)) apiKey = String(parsedKey)
        } catch {
          apiKey = String(row.value)
        }
      }
    }

    if (typeof baseUrl !== "string" || typeof apiKey !== "string" || !baseUrl || !apiKey) {
      return null
    }

    if (isLegacySupervisorIngressUrl(baseUrl)) {
      const detected = await resolveSupervisorGrocyAddon(baseUrl)
      if (detected) {
        baseUrl = detected.url
        const repo = new SettingsRepository(client)
        await repo.ensureSettingsTable()
        await repo.upsert("grocy_url", JSON.stringify(detected.url))
      }
    }

    const urlCheck = validateGrocyBaseUrl(baseUrl)
    if (!urlCheck.ok) {
      logger.log("warn", {
        event: "integration.grocy.invalid_url",
        domain: "integrations",
        component: "grocy-client",
        request_id: crypto.randomUUID(),
        message: urlCheck.error,
      })
      return null
    }

    return new GrocyAdapter({
      baseUrl: urlCheck.normalizedUrl,
      apiKey,
      timeoutMs: 5000,
    })
  } catch (err) {
    logger.log("error", {
      event: "integration.grocy.config_failed",
      domain: "integrations",
      component: "grocy-client",
      request_id: crypto.randomUUID(),
      message: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
