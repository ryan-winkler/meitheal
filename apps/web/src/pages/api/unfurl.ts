import type { LookupAddress } from "node:dns"
import dns from "node:dns/promises"
import { isIP, type LookupFunction } from "node:net"
import type { APIRoute } from "astro"
import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from "undici"
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"
import { apiError, apiJson } from "../../lib/api-response"
import { readWithinLimit } from "../../lib/bounded-body"
import { isPublicPreviewAddress, previewHostname } from "../../lib/link-preview-target"

const maxRequestBytes = 16 * 1024
const maxPreviewBytes = 256 * 1024
const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["tasks", "audit", "observability"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: true,
})

async function resolveAddresses(hostname: string, signal: AbortSignal): Promise<LookupAddress[]> {
  signal.throwIfAborted()
  const family = isIP(hostname)
  if (family) return [{ address: hostname, family }]

  // A fully qualified lookup prevents local DNS search suffixes from being appended.
  const fqdn = hostname.endsWith(".") ? hostname : hostname + "."
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    void dns.lookup(fqdn, { all: true, order: "verbatim" })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
  })
}

function pinnedLookup(hostname: string, records: LookupAddress[]): LookupFunction {
  return (requested, options, callback) => {
    const family = options.family === 4 || options.family === "IPv4" ? 4
      : options.family === 6 || options.family === "IPv6" ? 6 : 0
    const candidates = family ? records.filter(record => record.family === family) : records
    if (requested.toLowerCase() !== hostname || !candidates.length) {
      callback(new Error("No pinned address for preview target"), "")
      return
    }
    if (options.all) {
      callback(null, candidates)
      return
    }
    callback(null, candidates[0]!.address, candidates[0]!.family)
  }
}

async function readPreviewHtml(body: UndiciResponse["body"]): Promise<string> {
  if (!body) return ""
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let remaining = maxPreviewBytes
  let html = ""
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = value.subarray(0, remaining)
      html += decoder.decode(chunk, { stream: true })
      remaining -= chunk.byteLength
    }
    return html + decoder.decode()
  } finally {
    if (remaining === 0) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function extractMetadata(html: string): Map<string, string> {
  const metadata = new Map<string, string>()
  for (const [tag] of html.matchAll(/<meta(?=\s|\/?>)(?:[^<>"']|"[^"<]*"|'[^'<]*')*>/gi)) {
    let name: string | undefined
    let content: string | undefined
    for (const [, attribute, , value] of tag.matchAll(/\s(property|name|content)\s*=\s*(["'])(.*?)\2/gis)) {
      if (attribute!.toLowerCase() === "content") content ??= value
      else name ??= value?.toLowerCase()
    }
    if (name && content && !metadata.has(name)) metadata.set(name, content)
  }
  return metadata
}

export const POST: APIRoute = async ({ request }) => {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)])
  if (Number(request.headers.get("content-length")) > maxRequestBytes) {
    return apiError("Preview request exceeds 16 KiB", 413)
  }

  let input: unknown
  try {
    const bytes = await readWithinLimit(request.body, maxRequestBytes, signal)
    if (!bytes) return apiError("Preview request exceeds 16 KiB", 413)
    input = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return signal.aborted ? apiError("Preview request timed out", 408) : apiError("Send a valid JSON request body", 400)
  }
  const url = input && typeof input === "object" && "url" in input ? input.url : undefined
  if (typeof url !== "string" || !url) return apiError("Send a URL as a string", 400)
  if (url.length > 2048) return apiError("URL exceeds maximum length of 2048 characters", 400)

  let target: URL
  try {
    target = new URL(url)
  } catch {
    return apiError("Invalid URL", 400)
  }

  const hostname = previewHostname(target)
  if (!hostname) return apiError("Preview targets must be public HTTP or HTTPS URLs without credentials", 400)

  let dispatcher: Agent | undefined
  try {
    const records = await resolveAddresses(hostname, signal)
    if (!records.length || records.some(record => !isPublicPreviewAddress(record.address, record.family))) {
      return apiError("Preview target did not resolve exclusively to public addresses", 400)
    }

    signal.throwIfAborted()
    dispatcher = new Agent({ connect: { lookup: pinnedLookup(hostname, records) } })
    const response = await undiciFetch(target, {
      signal,
      dispatcher,
      redirect: "manual",
      headers: { "user-agent": "meitheal-unfurl/0.1" },
    })

    if (response.status >= 300 && response.status < 400) {
      return apiError("Use the final public URL for previews", 400)
    }

    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    if (mediaType !== "text/html") return apiError("Preview targets must return text/html", 415)

    const html = await readPreviewHtml(response.body)
    const meta = extractMetadata(html)
    return apiJson({
      url: target.toString(),
      title: meta.get("og:title") ?? html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim(),
      description: meta.get("og:description") ?? meta.get("description"),
      image: meta.get("og:image") ?? meta.get("twitter:image"),
      siteName: meta.get("og:site_name"),
      fetchedAt: new Date().toISOString(),
    })
  } catch {
    if (signal.aborted) return apiError("Preview target timed out", 504)
    logger.log("error", {
      event: "api.unfurl.post.failed",
      domain: "tasks",
      component: "unfurl-api",
      request_id: crypto.randomUUID(),
      message: "Unable to fetch preview",
    })
    return apiError("Unable to fetch URL", 502)
  } finally {
    await dispatcher?.destroy()
  }
}
