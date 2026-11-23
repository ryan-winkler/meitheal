/**
 * Plugin Manifest Validator & SVG Sanitizer
 *
 * Strictly validates `manifest.json` against ADR 0028 rules, including
 * cross-validation between `allowedHosts` and `dataSharing.destinations`,
 * and sanitizes SVG icons against embedded script/event/external vectors.
 *
 * @domain plugins
 * @bounded-context plugins
 */
import { parseFragment, serialize, type DefaultTreeAdapterTypes } from "parse5"
import {
  PLUGIN_HOOKS,
  PLUGIN_PERMISSIONS,
  PLUGIN_TYPES,
  type ConnectorFieldType,
  type PluginConnectorConfig,
  type PluginConnectorField,
  type PluginDataSharing,
  type PluginHook,
  type PluginManifest,
  type PluginPermission,
  type PluginResult,
  type PluginType,
} from "./types"

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/
const RELATIVE_FILE_RE = /^[a-zA-Z0-9._-][a-zA-Z0-9._/-]{0,120}$/
const FIELD_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isAsciiAlnum(code: number): boolean {
  return isAsciiLetter(code) || (code >= 48 && code <= 57)
}

function isValidPluginHostname(host: string): boolean {
  if (host.toLowerCase() === "$userserver") return true
  if (host.length < 3 || host.length > 253) return false
  const labels = host.split(".")
  if (labels.length < 2) return false
  const tld = labels[labels.length - 1]
  if (!tld || tld.length < 2 || tld.length > 63) return false
  for (let i = 0; i < tld.length; i += 1) {
    if (!isAsciiLetter(tld.charCodeAt(i))) return false
  }
  for (let l = 0; l < labels.length - 1; l += 1) {
    const label = labels[l]
    if (!label || label.length < 1 || label.length > 63) return false
    if (!isAsciiAlnum(label.charCodeAt(0)) || !isAsciiAlnum(label.charCodeAt(label.length - 1))) return false
    for (let i = 1; i < label.length - 1; i += 1) {
      const c = label.charCodeAt(i)
      if (!isAsciiAlnum(c) && c !== 45) return false
    }
  }
  return true
}

const PERMISSION_SET = new Set<string>(PLUGIN_PERMISSIONS)
const HOOK_SET = new Set<string>(PLUGIN_HOOKS)
const TYPE_SET = new Set<string>(PLUGIN_TYPES)
const CONNECTOR_FIELD_TYPES = new Set<ConnectorFieldType>(["text", "url", "secret", "number", "boolean"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function fail(errorCode: string, error: string): PluginResult<never> {
  return { ok: false, errorCode, error, status: 400 }
}

function readBoundedString(
  obj: Record<string, unknown>,
  field: string,
  minLen: number,
  maxLen: number,
): string | null {
  const raw = obj[field]
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (trimmed.length < minLen || trimmed.length > maxLen) return null
  return trimmed
}

function validateSafeRelativePath(value: unknown, allowedExts: string[]): string | null {
  if (typeof value !== "string") return null
  const clean = value.trim().replace(/^\.\//, "")
  if (!RELATIVE_FILE_RE.test(clean)) return null
  if (clean.includes("..") || clean.startsWith("/") || clean.includes("\\") || clean.includes("\0")) {
    return null
  }
  const lower = clean.toLowerCase()
  if (!allowedExts.some((ext) => lower.endsWith(ext))) return null
  return clean
}

function validateDataSharing(
  raw: unknown,
  allowedHosts: string[],
): PluginResult<PluginDataSharing> {
  if (!isRecord(raw)) {
    return fail("INVALID_DATA_SHARING", "manifest.json must include a dataSharing object.")
  }
  if (typeof raw.outbound !== "boolean") {
    return fail("INVALID_DATA_SHARING", "dataSharing.outbound must be a boolean.")
  }
  if (allowedHosts.length > 0 && !raw.outbound) {
    return fail(
      "UNDECLARED_HOST",
      "dataSharing.outbound must be true whenever allowedHosts is non-empty.",
    )
  }
  if (!Array.isArray(raw.destinations)) {
    return fail("INVALID_DATA_SHARING", "dataSharing.destinations must be an array.")
  }
  const destinations: Array<{ host: string; purpose: string }> = []
  const declaredHosts = new Set<string>()
  for (const item of raw.destinations) {
    if (!isRecord(item)) {
      return fail("INVALID_DATA_SHARING", "Each dataSharing destination must be an object.")
    }
    const host = readBoundedString(item, "host", 3, 253)
    const purpose = readBoundedString(item, "purpose", 4, 240)
    if (!host || !isValidPluginHostname(host) || !purpose) {
      return fail("INVALID_DATA_SHARING", "Each dataSharing destination requires a valid host and purpose.")
    }
    const normalizedHost = host === "$userServer" ? "$userServer" : host.toLowerCase()
    destinations.push({ host: normalizedHost, purpose })
    declaredHosts.add(normalizedHost)
  }

  for (const host of allowedHosts) {
    if (!declaredHosts.has(host)) {
      return fail(
        "UNDECLARED_HOST",
        `Host "${host}" in allowedHosts must be disclosed in dataSharing.destinations.`,
      )
    }
  }

  if (!Array.isArray(raw.dataTypes) || raw.dataTypes.length > 25) {
    return fail("INVALID_DATA_SHARING", "dataSharing.dataTypes must be an array of up to 25 strings.")
  }
  const dataTypes: string[] = []
  for (const item of raw.dataTypes) {
    if (typeof item !== "string" || item.trim().length < 2 || item.trim().length > 60) {
      return fail("INVALID_DATA_SHARING", "Each dataSharing.dataTypes entry must be a short string.")
    }
    dataTypes.push(item.trim())
  }

  const summary = readBoundedString(raw, "summary", 6, 300)
  if (!summary) {
    return fail("INVALID_DATA_SHARING", "dataSharing.summary must be 6 to 300 characters.")
  }

  return {
    ok: true,
    data: {
      outbound: raw.outbound,
      destinations,
      dataTypes,
      summary,
    },
  }
}

function validateConnectorConfig(raw: unknown): PluginResult<PluginConnectorConfig> {
  if (!isRecord(raw)) {
    return fail("INVALID_CONNECTOR", "Connector plugins must include a connector configuration object.")
  }
  const supportsWriteBack = raw.supportsWriteBack === true
  const rawPoll = raw.defaultPollMinutes
  const defaultPollMinutes =
    typeof rawPoll === "number" && Number.isInteger(rawPoll) && rawPoll >= 5 && rawPoll <= 1440
      ? rawPoll
      : 15

  if (!Array.isArray(raw.configFields) || raw.configFields.length === 0 || raw.configFields.length > 15) {
    return fail("INVALID_CONNECTOR", "connector.configFields must list 1 to 15 fields.")
  }

  const seenKeys = new Set<string>()
  const configFields: PluginConnectorField[] = []
  for (const item of raw.configFields) {
    if (!isRecord(item)) {
      return fail("INVALID_CONNECTOR", "Each connector configField must be an object.")
    }
    const key = readBoundedString(item, "key", 1, 48)
    const label = readBoundedString(item, "label", 2, 80)
    const type = typeof item.type === "string" ? (item.type as ConnectorFieldType) : null
    if (!key || !FIELD_KEY_RE.test(key) || seenKeys.has(key)) {
      return fail("INVALID_CONNECTOR", `Invalid or duplicate connector field key "${String(item.key ?? "")}".`)
    }
    if (!label || !type || !CONNECTOR_FIELD_TYPES.has(type)) {
      return fail("INVALID_CONNECTOR", `Connector field "${key}" requires a valid label and type.`)
    }
    seenKeys.add(key)

    const field: PluginConnectorField = {
      key,
      label,
      type,
      required: item.required === true,
      bindUserServer: item.bindUserServer === true,
    }
    if (type === "secret") {
      const secretKey = readBoundedString(item, "secretKey", 2, 64)
      if (!secretKey || !FIELD_KEY_RE.test(secretKey)) {
        return fail("INVALID_CONNECTOR", `Secret field "${key}" must specify a valid secretKey.`)
      }
      field.secretKey = secretKey
    }
    if (typeof item.placeholder === "string" && item.placeholder.trim().length <= 120) {
      field.placeholder = item.placeholder.trim()
    }
    if (typeof item.help === "string" && item.help.trim().length <= 240) {
      field.help = item.help.trim()
    }
    configFields.push(field)
  }

  return {
    ok: true,
    data: {
      supportsWriteBack,
      defaultPollMinutes,
      configFields,
    },
  }
}

export function validatePluginManifest(raw: unknown): PluginResult<PluginManifest> {
  if (!isRecord(raw)) {
    return fail("INVALID_MANIFEST", "manifest.json must contain a JSON object.")
  }

  const id = readBoundedString(raw, "id", 3, 64)
  if (!id || !PLUGIN_ID_RE.test(id)) {
    return fail("INVALID_MANIFEST", "manifest.id must be a lowercase slug (3-64 characters, letters, numbers, hyphens).")
  }

  const name = readBoundedString(raw, "name", 3, 60)
  if (!name) return fail("INVALID_MANIFEST", "manifest.name must be 3 to 60 characters.")

  const version = readBoundedString(raw, "version", 5, 32)
  if (!version || !SEMVER_RE.test(version)) {
    return fail("INVALID_MANIFEST", "manifest.version must follow semantic versioning (for example 1.0.0).")
  }

  const minMeithealVersion = readBoundedString(raw, "minMeithealVersion", 5, 32)
  if (!minMeithealVersion || !SEMVER_RE.test(minMeithealVersion)) {
    return fail("INVALID_MANIFEST", "manifest.minMeithealVersion must follow semantic versioning (for example 0.0.2).")
  }

  const rawType = raw.type
  if (typeof rawType !== "string" || !TYPE_SET.has(rawType)) {
    return fail("INVALID_MANIFEST", 'manifest.type must be "extension" or "connector".')
  }
  const type = rawType as PluginType

  const description = readBoundedString(raw, "description", 4, 200)
  if (!description) return fail("INVALID_MANIFEST", "manifest.description must be 4 to 200 characters.")

  const author = readBoundedString(raw, "author", 2, 80)
  if (!author) return fail("INVALID_MANIFEST", "manifest.author must be 2 to 80 characters.")

  const license = readBoundedString(raw, "license", 2, 64)
  if (!license) return fail("INVALID_MANIFEST", "manifest.license must be a valid SPDX identifier.")

  let icon: string | undefined
  if (raw.icon !== undefined && raw.icon !== "") {
    const validIcon = validateSafeRelativePath(raw.icon, [".svg"])
    if (!validIcon) return fail("INVALID_MANIFEST", "manifest.icon must be a safe relative .svg path.")
    icon = validIcon
  }

  let entry: string | undefined
  if (raw.entry !== undefined && raw.entry !== "") {
    const validEntry = validateSafeRelativePath(raw.entry, [".js", ".mjs"])
    if (!validEntry) return fail("INVALID_MANIFEST", "manifest.entry must be a safe relative .js or .mjs path.")
    entry = validEntry
  }

  let iFrame: string | undefined
  if (raw.iFrame !== undefined && raw.iFrame !== "") {
    const validIframe = validateSafeRelativePath(raw.iFrame, [".html"])
    if (!validIframe) return fail("INVALID_MANIFEST", "manifest.iFrame must be a safe relative .html path.")
    iFrame = validIframe
  }

  if (!entry && !iFrame) {
    return fail("INVALID_MANIFEST", "Plugin manifest must declare at least an entry script or an iFrame HTML file.")
  }

  const sidePanel = raw.sidePanel === true
  if (sidePanel && !iFrame) {
    return fail("INVALID_MANIFEST", "sidePanel: true requires manifest.iFrame to be defined.")
  }

  if (!Array.isArray(raw.permissions)) {
    return fail("INVALID_MANIFEST", "manifest.permissions must be an array.")
  }
  const permissions: PluginPermission[] = []
  const seenPerms = new Set<string>()
  for (const perm of raw.permissions) {
    if (typeof perm !== "string" || !PERMISSION_SET.has(perm)) {
      return fail("INVALID_PERMISSION", `Unsupported permission "${String(perm)}".`)
    }
    if (!seenPerms.has(perm)) {
      seenPerms.add(perm)
      permissions.push(perm as PluginPermission)
    }
  }

  const hooks: PluginHook[] = []
  if (raw.hooks !== undefined) {
    if (!Array.isArray(raw.hooks)) {
      return fail("INVALID_MANIFEST", "manifest.hooks must be an array when provided.")
    }
    const seenHooks = new Set<string>()
    for (const hook of raw.hooks) {
      if (typeof hook !== "string" || !HOOK_SET.has(hook)) {
        return fail("INVALID_HOOK", `Unsupported hook "${String(hook)}".`)
      }
      if (!seenHooks.has(hook)) {
        seenHooks.add(hook)
        hooks.push(hook as PluginHook)
      }
    }
  }

  if (!Array.isArray(raw.allowedHosts) || raw.allowedHosts.length > 20) {
    return fail("INVALID_MANIFEST", "manifest.allowedHosts must be an array of up to 20 hostnames.")
  }
  const allowedHosts: string[] = []
  const seenHosts = new Set<string>()
  for (const rawHost of raw.allowedHosts) {
    if (typeof rawHost !== "string") {
      return fail("INVALID_HOST", "Each entry in allowedHosts must be a hostname string.")
    }
    const trimmed = rawHost.trim()
    if (!isValidPluginHostname(trimmed)) {
      return fail("INVALID_HOST", `Invalid hostname "${trimmed}" in allowedHosts.`)
    }
    const normalized = trimmed === "$userServer" ? "$userServer" : trimmed.toLowerCase()
    if (!seenHosts.has(normalized)) {
      seenHosts.add(normalized)
      allowedHosts.push(normalized)
    }
  }

  if (allowedHosts.length > 0 && !seenPerms.has("http:outbound")) {
    return fail("INVALID_PERMISSION", 'Plugins declaring allowedHosts must also request the "http:outbound" permission.')
  }

  const dataSharingResult = validateDataSharing(raw.dataSharing, allowedHosts)
  if (!dataSharingResult.ok) return dataSharingResult

  let connector: PluginConnectorConfig | undefined
  if (type === "connector") {
    const connectorResult = validateConnectorConfig(raw.connector)
    if (!connectorResult.ok) return connectorResult
    connector = connectorResult.data
  }

  return {
    ok: true,
    data: {
      id,
      name,
      version,
      minMeithealVersion,
      type,
      description,
      author,
      license,
      ...(icon ? { icon } : {}),
      ...(entry ? { entry } : {}),
      ...(iFrame ? { iFrame } : {}),
      sidePanel,
      permissions,
      hooks,
      allowedHosts,
      dataSharing: dataSharingResult.data,
      ...(connector ? { connector } : {}),
    },
  }
}

const ALLOWED_SVG_TAGS = new Set([
  "svg",
  "path",
  "circle",
  "rect",
  "line",
  "polyline",
  "polygon",
  "ellipse",
  "g",
  "title",
  "defs",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
])

const ALLOWED_SVG_ATTRS = new Set([
  "xmlns",
  "viewBox",
  "preserveAspectRatio",
  "width",
  "height",
  "id",
  "class",
  "fill",
  "fill-rule",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "opacity",
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "points",
  "transform",
  "clip-path",
  "clip-rule",
  "mask",
  "gradientUnits",
  "gradientTransform",
  "offset",
  "stop-color",
  "stop-opacity",
  "role",
  "aria-hidden",
  "aria-label",
])

type Parse5Node = DefaultTreeAdapterTypes.ChildNode
type Parse5Element = DefaultTreeAdapterTypes.Element

function isParse5Element(node: Parse5Node): node is Parse5Element {
  return "tagName" in node
}

function containsUnsafeUriScheme(value: string): boolean {
  let compacted = ""
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code > 32 && code !== 127) compacted += value[i]
  }
  const lower = compacted.toLowerCase()
  return lower.includes("javascript:") || lower.includes("data:") || lower.includes("vbscript:")
}

function subtreeHasUnsafeUri(node: Parse5Node): boolean {
  if (!isParse5Element(node)) return false
  for (const attr of node.attrs) {
    if (containsUnsafeUriScheme(attr.value)) return true
  }
  return node.childNodes.some((child) => subtreeHasUnsafeUri(child))
}

function filterSvgSubtree(node: Parse5Node, parentTag: string): Parse5Node | null {
  if (node.nodeName === "#comment") return null
  if (node.nodeName === "#text") {
    if (parentTag === "title") return node
    return "value" in node && !node.value.trim() ? node : null
  }
  if (!isParse5Element(node)) return null
  if (!ALLOWED_SVG_TAGS.has(node.tagName)) return null

  node.attrs = node.attrs.filter((attr) => !attr.prefix && ALLOWED_SVG_ATTRS.has(attr.name))
  const cleanChildren: Parse5Node[] = []
  for (const child of node.childNodes) {
    const filtered = filterSvgSubtree(child, node.tagName)
    if (filtered) cleanChildren.push(filtered)
  }
  node.childNodes = cleanChildren
  return node
}

/**
 * Sanitizes an uploaded SVG icon for safe inline rendering.
 * Rejects icons that do not start with a clean `<svg` root or exceed 32 KB.
 */
export function sanitizePluginIconSvg(rawSvg: string): PluginResult<string> {
  const trimmed = rawSvg.trim()
  if (!trimmed || trimmed.length > 32 * 1024) {
    return fail("INVALID_ICON", "Plugin SVG icon must be non-empty and under 32 KB.")
  }

  const fragment = parseFragment(trimmed)
  const significantRoots = fragment.childNodes.filter(
    (node) => node.nodeName !== "#comment" && !(node.nodeName === "#text" && "value" in node && !node.value.trim()),
  )
  if (significantRoots.length !== 1 || !isParse5Element(significantRoots[0]) || significantRoots[0].tagName !== "svg") {
    return fail("INVALID_ICON", "Plugin icon.svg must contain a single <svg>...</svg> element.")
  }

  const root = significantRoots[0]
  if (subtreeHasUnsafeUri(root)) {
    return fail("UNSAFE_ICON", "Plugin icon.svg must not contain javascript: or data: URLs.")
  }

  const cleanRoot = filterSvgSubtree(root, "")
  if (!cleanRoot || !isParse5Element(cleanRoot) || cleanRoot.tagName !== "svg") {
    return fail("UNSAFE_ICON", "Plugin icon.svg failed sanitization.")
  }

  fragment.childNodes = [cleanRoot]
  const cleaned = serialize(fragment).trim()
  if (!cleaned.startsWith("<svg") || !cleaned.endsWith("</svg>")) {
    return fail("UNSAFE_ICON", "Plugin icon.svg failed sanitization.")
  }

  return { ok: true, data: cleaned }
}
