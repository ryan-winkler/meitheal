/**
 * Canonical TCP Port Specification Parser (Single Source of Truth)
 *
 * Shared by both the production Node ingress server (`scripts/serve.mjs`)
 * and the Webserver DDD domain (`src/domains/webserver/webserver-config.ts`).
 *
 * Supports:
 *   - Single port: "3000" or 3000
 *   - List / array: "3000, 8095", [3000, 8095], or "[3000, 8095]"
 *   - Range: "3000-3005"
 *   - Mixed: "3000, 8095-8097"
 *
 * Enforces a hard upper bound (MAX_RESOLVED_PORTS = 32) to prevent resource exhaustion.
 */

export const MAX_RESOLVED_PORTS = 32
export const DEFAULT_WEBSERVER_PORT = 3000

const DIGITS_ONLY = /^\d+$/

function hasControlChars(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/** Compress sorted port numbers into a clean human-readable string (e.g. "3000, 8095-8097"). */
export function formatPortSummary(ports) {
  if (!Array.isArray(ports) || ports.length === 0) return String(DEFAULT_WEBSERVER_PORT)
  const sorted = Array.from(new Set(ports)).sort((a, b) => a - b)
  const segments = []
  let rangeStart = sorted[0]
  let rangeEnd = sorted[0]

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]
    if (current === rangeEnd + 1) {
      rangeEnd = current
    } else {
      segments.push(rangeStart === rangeEnd ? String(rangeStart) : `${rangeStart}-${rangeEnd}`)
      rangeStart = current
      rangeEnd = current
    }
  }
  segments.push(rangeStart === rangeEnd ? String(rangeStart) : `${rangeStart}-${rangeEnd}`)
  return segments.join(", ")
}

/** Parse and validate a port specification into sorted unique TCP port numbers. */
export function parsePortSpec(input) {
  if (input === null || input === undefined) {
    return {
      ok: true,
      raw: String(DEFAULT_WEBSERVER_PORT),
      ports: [DEFAULT_WEBSERVER_PORT],
      primaryPort: DEFAULT_WEBSERVER_PORT,
      mode: "single",
      hasPrivilegedPorts: false,
      normalized: String(DEFAULT_WEBSERVER_PORT),
    }
  }

  let rawText
  if (typeof input === "number") {
    if (!Number.isInteger(input)) {
      return { ok: false, error: "Port must be a whole number between 1 and 65535." }
    }
    rawText = String(input)
  } else if (Array.isArray(input)) {
    if (input.length === 0) {
      return { ok: false, error: "Enter at least one port (for example 3000, 3000-3005, or 3000, 8095)." }
    }
    rawText = input.map((item) => String(item)).join(", ")
  } else {
    rawText = String(input).trim()
  }

  const unwrapped = rawText.startsWith("[") && rawText.endsWith("]")
    ? rawText.slice(1, -1).trim()
    : rawText

  if (!unwrapped) {
    return { ok: false, error: "Enter at least one port (for example 3000, 3000-3005, or 3000, 8095)." }
  }

  if (unwrapped.length > 256 || hasControlChars(unwrapped)) {
    return { ok: false, error: "Port specification is too long or contains unsupported characters." }
  }

  const tokens = unwrapped
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter(Boolean)

  if (tokens.length === 0) {
    return { ok: false, error: "Enter at least one port between 1 and 65535." }
  }

  const portSet = new Set()
  let hasRange = false
  let hasSingleToken = false

  for (const token of tokens) {
    if (token.includes("-")) {
      const parts = token.split("-")
      if (parts.length !== 2 || !DIGITS_ONLY.test(parts[0]) || !DIGITS_ONLY.test(parts[1])) {
        return { ok: false, error: `Invalid port range "${token}". Use start-end like 3000-3005.` }
      }
      const start = Number(parts[0])
      const end = Number(parts[1])
      if (start < 1 || start > 65535 || end < 1 || end > 65535) {
        return { ok: false, error: `Ports in range "${token}" must be between 1 and 65535.` }
      }
      if (start > end) {
        return { ok: false, error: `Port range "${token}" starts higher than it ends. Try ${end}-${start}.` }
      }
      if (end - start + 1 > MAX_RESOLVED_PORTS) {
        return {
          ok: false,
          error: `Port range "${token}" expands to ${end - start + 1} ports. Keep the total to ${MAX_RESOLVED_PORTS} ports or fewer.`,
        }
      }
      hasRange = true
      for (let p = start; p <= end; p++) {
        portSet.add(p)
        if (portSet.size > MAX_RESOLVED_PORTS) {
          return { ok: false, error: `Too many ports configured. Keep the total to ${MAX_RESOLVED_PORTS} ports or fewer.` }
        }
      }
    } else {
      if (!DIGITS_ONLY.test(token)) {
        return { ok: false, error: `Invalid port "${token}". Use numbers, commas, or ranges like 3000-3005.` }
      }
      const port = Number(token)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { ok: false, error: `Port ${token} is out of range. Choose a number between 1 and 65535.` }
      }
      hasSingleToken = true
      portSet.add(port)
      if (portSet.size > MAX_RESOLVED_PORTS) {
        return { ok: false, error: `Too many ports configured. Keep the total to ${MAX_RESOLVED_PORTS} ports or fewer.` }
      }
    }
  }

  const ports = Array.from(portSet).sort((a, b) => a - b)
  const mode = ports.length === 1
    ? "single"
    : hasRange && hasSingleToken
      ? "mixed"
      : hasRange
        ? "range"
        : "list"

  return {
    ok: true,
    raw: rawText,
    ports,
    primaryPort: ports[0],
    mode,
    hasPrivilegedPorts: ports.some((port) => port < 1024),
    normalized: formatPortSummary(ports),
  }
}
