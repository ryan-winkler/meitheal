import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"
import { GrocyAdapter, validateGrocyBaseUrl } from "@meitheal/integration-core"
import { getPersistenceClient } from "@domains/tasks/persistence/store"
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
 * True when a URL matches the legacy auto-detected `http://supervisor/api/hassio_ingress/<token>`
 * form written by earlier versions before Supervisor hostnames were blocked.
 */
export function isLegacySupervisorIngressUrl(rawUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    return false
  }
  return (
    parsed.protocol === "http:" &&
    parsed.hostname.toLowerCase() === "supervisor" &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    LEGACY_HASSIO_INGRESS_PATH.test(parsed.pathname)
  )
}

/**
 * Resolve the direct internal container URL for a started Home Assistant Grocy add-on
 * (e.g. `http://a0d7b954-grocy:80`) via Supervisor metadata rather than proxying `http://supervisor/*`.
 */
export async function resolveSupervisorGrocyAddon(): Promise<{ slug: string; url: string } | null> {
  try {
    const addonsRes = await supervisorFetch("/addons")
    if (!addonsRes?.ok) return null
    const addonsData = (await addonsRes.json()) as {
      data?: { addons?: { slug: string; state?: string }[] }
    }
    const grocy = addonsData.data?.addons?.find(
      (addon) => addon.slug.includes("grocy") && addon.state === "started",
    )
    if (!grocy?.slug) return null

    let hostname = grocy.slug.replace(/_/g, "-")
    let port = 80
    try {
      const infoRes = await supervisorFetch(`/addons/${encodeURIComponent(grocy.slug)}/info`)
      if (infoRes?.ok) {
        const infoData = (await infoRes.json()) as {
          data?: { hostname?: string; ingress_port?: number }
        }
        if (typeof infoData.data?.hostname === "string" && infoData.data.hostname.trim()) {
          hostname = infoData.data.hostname.trim()
        }
        if (
          typeof infoData.data?.ingress_port === "number" &&
          Number.isInteger(infoData.data.ingress_port) &&
          infoData.data.ingress_port > 0 &&
          infoData.data.ingress_port <= 65535
        ) {
          port = infoData.data.ingress_port
        }
      }
    } catch {
      /* Fall back to standard slug-derived container hostname and port 80 */
    }

    const check = validateGrocyBaseUrl(`http://${hostname}:${port}`)
    if (!check.ok) return null
    return { slug: grocy.slug, url: check.normalizedUrl }
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
          baseUrl = JSON.parse(String(row.value))
        } catch {
          baseUrl = String(row.value)
        }
      } else if (row.key === "grocy_api_key") {
        try {
          apiKey = JSON.parse(String(row.value))
        } catch {
          apiKey = String(row.value)
        }
      }
    }

    if (typeof baseUrl !== "string" || typeof apiKey !== "string" || !baseUrl || !apiKey) {
      return null
    }

    if (isLegacySupervisorIngressUrl(baseUrl)) {
      const detected = await resolveSupervisorGrocyAddon()
      if (detected) {
        baseUrl = detected.url
        await client.execute({
          sql: "UPDATE settings SET value = ?, updated_at = ? WHERE key = 'grocy_url'",
          args: [JSON.stringify(detected.url), Date.now()],
        })
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
