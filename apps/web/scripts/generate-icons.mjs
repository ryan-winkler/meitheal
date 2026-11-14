#!/usr/bin/env node
/**
 * generate-icons.mjs — Build-time typed Tabler 1.75px outline icon extractor
 *
 * Extracts inner SVG geometry for Meitheal's curated 64-icon Tabler outline
 * catalog (plus legacy Icon.astro name aliases), strips invisible 24x24
 * bounding paths, verifies zero nested <svg> tags, and writes deterministic
 * TypeScript to apps/web/src/generated/icon-registry.ts.
 *
 * Source icons: @tabler/icons (MIT License, Copyright (c) 2020-2026 Paweł Kuna)
 */
import { createRequire } from "node:module"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = resolve(SCRIPT_DIR, "../src/generated/icon-registry.ts")
const require = createRequire(import.meta.url)

/**
 * Legacy Icon.astro names mapped to canonical @tabler/icons outline filenames.
 * The remaining 15 legacy names already match their canonical Tabler names.
 */
export const LEGACY_ICON_ALIASES = {
  dashboard: "layout-dashboard",
  kanban: "layout-kanban",
  tasks: "list-check",
  today: "clock",
  upcoming: "calendar-event",
  empty: "inbox",
  menu: "menu-2",
  "menu-open": "layout-sidebar-left-collapse",
  habit: "repeat",
  eisenhower: "layout-grid",
  person: "user",
  sliders: "adjustments-horizontal",
  automation: "bolt",
  phone: "device-mobile",
  warning: "alert-triangle",
  cart: "shopping-cart",
  info: "info-circle",
}

/**
 * Exact 64 canonical Tabler outline icons (32 backing existing Icon.astro names
 * + 32 UI chrome and task-type icons).
 */
export const CANONICAL_TABLER_ICONS = [
  // 32 icons backing existing Icon.astro names
  "layout-dashboard",
  "layout-kanban",
  "list-check",
  "table",
  "clock",
  "calendar-event",
  "calendar",
  "chevron-down",
  "plus",
  "settings",
  "inbox",
  "menu-2",
  "layout-sidebar-left-collapse",
  "search",
  "link",
  "sparkles",
  "trophy",
  "repeat",
  "folder",
  "pin",
  "target",
  "layout-grid",
  "user",
  "adjustments-horizontal",
  "bolt",
  "plug",
  "device-mobile",
  "alert-triangle",
  "home",
  "bell",
  "shopping-cart",
  "info-circle",
  // 32 UI chrome and task-type icons
  "clipboard-list",
  "checkbox",
  "message-chatbot",
  "flame",
  "check",
  "x",
  "refresh",
  "download",
  "trash",
  "bug",
  "message-circle",
  "star",
  "palette",
  "book",
  "file-text",
  "world",
  "database",
  "users",
  "sun",
  "flask",
  "package",
  "rocket",
  "arrows-left-right",
  "keyboard",
  "chart-bar",
  "pencil",
  "tag",
  "paperclip",
  "hash",
  "calculator",
  "mug",
  "confetti",
]

/**
 * Canonical Tabler icons rendered dynamically by client-side controllers via
 * `<use href="#mt-icon-..." />` so `ICON_INNER_SVG` stays server-only and is
 * tree-shaken out of client JavaScript bundles.
 */
export const CLIENT_DYNAMIC_TABLER_ICONS = [
  "alert-triangle",
  "bolt",
  "book",
  "bug",
  "calendar",
  "check",
  "checkbox",
  "clock",
  "file-text",
  "flame",
  "hash",
  "info-circle",
  "link",
  "message-chatbot",
  "message-circle",
  "mug",
  "paperclip",
  "pencil",
  "trash",
  "x",
]

function resolveTablerOutlineDir() {
  const localDir = resolve(SCRIPT_DIR, "../node_modules/@tabler/icons/icons/outline")
  try {
    readFileSync(resolve(localDir, "layout-dashboard.svg"), "utf-8")
    return localDir
  } catch {
    return dirname(require.resolve("@tabler/icons/outline/layout-dashboard.svg"))
  }
}

const ALLOWED_SHAPE_TAGS = new Set([
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
])

function isAsciiAttrStart(ch) {
  const code = ch.charCodeAt(0)
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90)
}

function isAsciiAttrChar(ch) {
  const code = ch.charCodeAt(0)
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    code === 45
  )
}

function parseAllowedShapeLine(line) {
  if (!line.startsWith("<") || !line.endsWith(">")) return null
  const bodyEnd = line.endsWith("/>") ? line.length - 2 : line.length - 1
  const rawBody = line.slice(1, bodyEnd).trim()
  let spaceIdx = -1
  for (let i = 0; i < rawBody.length; i++) {
    const ch = rawBody[i]
    if (ch === " " || ch === "\t") {
      spaceIdx = i
      break
    }
  }
  if (spaceIdx <= 0) return null
  const tag = rawBody.slice(0, spaceIdx).toLowerCase()
  if (!ALLOWED_SHAPE_TAGS.has(tag)) return null

  const rawAttrs = rawBody.slice(spaceIdx + 1).trim()
  if (!rawAttrs) return null

  const attrPairs = []
  let hasVectorEffect = false
  let cursor = 0
  while (cursor < rawAttrs.length) {
    while (cursor < rawAttrs.length && (rawAttrs[cursor] === " " || rawAttrs[cursor] === "\t")) {
      cursor++
    }
    if (cursor >= rawAttrs.length) break
    if (!isAsciiAttrStart(rawAttrs[cursor])) return null
    const nameStart = cursor
    cursor++
    while (cursor < rawAttrs.length && isAsciiAttrChar(rawAttrs[cursor])) {
      cursor++
    }
    const attrName = rawAttrs.slice(nameStart, cursor)
    if (rawAttrs.slice(cursor, cursor + 2) !== '="') return null
    cursor += 2
    const closeQuote = rawAttrs.indexOf('"', cursor)
    if (closeQuote === -1) return null
    const attrVal = rawAttrs.slice(cursor, closeQuote)
    if (attrVal.includes("<") || attrVal.includes(">") || attrVal.includes("&")) return null
    cursor = closeQuote + 1
    if (cursor < rawAttrs.length && rawAttrs[cursor] !== " " && rawAttrs[cursor] !== "\t") {
      return null
    }
    if (attrName.toLowerCase() === "vector-effect") hasVectorEffect = true
    attrPairs.push([attrName.toLowerCase(), attrVal])
  }

  if (attrPairs.length === 0) return null
  const attrMap = new Map(attrPairs)
  const isBoundingBox =
    tag === "path" &&
    attrPairs.length === 3 &&
    attrMap.get("stroke") === "none" &&
    attrMap.get("d") === "M0 0h24v24H0z" &&
    attrMap.get("fill") === "none"

  return { tag, attrs: rawAttrs, hasVectorEffect, isBoundingBox }
}

function extractInnerSvg(rawSvg, iconFile) {
  const trimmed = rawSvg.trim()
  const lower = trimmed.toLowerCase()
  if (!lower.startsWith("<svg") || !lower.endsWith("</svg>")) {
    throw new Error(`[generate-icons] Expected a single <svg> root in ${iconFile}`)
  }
  const openTagEnd = trimmed.indexOf(">")
  if (openTagEnd === -1 || lower.indexOf("<svg", 4) !== -1) {
    throw new Error(`[generate-icons] Unexpected <svg> wrapper in ${iconFile}`)
  }
  const innerContent = trimmed.slice(openTagEnd + 1, trimmed.length - "</svg>".length)
  if (innerContent.toLowerCase().includes("</svg>")) {
    throw new Error(`[generate-icons] Multiple </svg> tags in ${iconFile}`)
  }

  const renderedShapes = []
  for (const rawLine of innerContent.split("\n")) {
    const line = rawLine.trim()
    if (!line) continue
    const parsed = parseAllowedShapeLine(line)
    if (!parsed) {
      throw new Error(`[generate-icons] Disallowed SVG child element in ${iconFile}: ${line}`)
    }
    if (parsed.isBoundingBox) continue
    if (parsed.hasVectorEffect) {
      renderedShapes.push(`<${parsed.tag} ${parsed.attrs} />`)
    } else {
      renderedShapes.push(`<${parsed.tag} vector-effect="non-scaling-stroke" ${parsed.attrs} />`)
    }
  }

  const inner = renderedShapes.join("")
  if (!inner) {
    throw new Error(`[generate-icons] Empty inner SVG extracted from ${iconFile}`)
  }
  return inner
}

export function generateIconRegistrySource() {
  if (CANONICAL_TABLER_ICONS.length !== 64 || new Set(CANONICAL_TABLER_ICONS).size !== 64) {
    throw new Error(`[generate-icons] Expected 64 unique canonical Tabler icons, got ${CANONICAL_TABLER_ICONS.length}`)
  }

  const outlineDir = resolveTablerOutlineDir()
  const canonicalEntries = {}
  for (const name of CANONICAL_TABLER_ICONS) {
    const svgPath = resolve(outlineDir, `${name}.svg`)
    const rawSvg = readFileSync(svgPath, "utf-8")
    canonicalEntries[name] = extractInnerSvg(rawSvg, `${name}.svg`)
  }

  const allEntries = { ...canonicalEntries }
  for (const [alias, canonical] of Object.entries(LEGACY_ICON_ALIASES)) {
    if (!canonicalEntries[canonical]) {
      throw new Error(`[generate-icons] Alias ${alias} points to unknown canonical icon ${canonical}`)
    }
    allEntries[alias] = canonicalEntries[canonical]
  }

  const sortedCanonical = [...CANONICAL_TABLER_ICONS].sort()
  const sortedAliases = Object.keys(LEGACY_ICON_ALIASES).sort()
  const sortedAllKeys = Object.keys(allEntries).sort()
  const sortedClientDynamic = [...CLIENT_DYNAMIC_TABLER_ICONS].sort()
  for (const dynamicIcon of sortedClientDynamic) {
    if (!canonicalEntries[dynamicIcon]) {
      throw new Error(`[generate-icons] Client dynamic icon ${dynamicIcon} is not in CANONICAL_TABLER_ICONS`)
    }
  }

  const lines = [
    "/*",
    " * AUTO-GENERATED BY apps/web/scripts/generate-icons.mjs — DO NOT EDIT MANUALLY.",
    " *",
    " * Selected 1.75px outline paths extracted at build time from @tabler/icons",
    " * https://github.com/tabler/tabler-icons",
    " *",
    " * MIT License",
    " * Copyright (c) 2020-2026 Paweł Kuna",
    " */",
    "",
    "export const CANONICAL_ICON_NAMES = [",
    ...sortedCanonical.map(k => `  ${JSON.stringify(k)},`),
    "] as const",
    "",
    "export type CanonicalIconName = (typeof CANONICAL_ICON_NAMES)[number]",
    "",
    "export const CLIENT_DYNAMIC_ICON_NAMES = [",
    ...sortedClientDynamic.map(k => `  ${JSON.stringify(k)},`),
    "] as const satisfies readonly CanonicalIconName[]",
    "",
    "export const LEGACY_ICON_ALIASES = {",
    ...sortedAliases.map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(LEGACY_ICON_ALIASES[k])},`),
    "} as const satisfies Record<string, CanonicalIconName>",
    "",
    "export type LegacyIconAlias = keyof typeof LEGACY_ICON_ALIASES",
    "export type IconName = CanonicalIconName | LegacyIconAlias",
    "",
    "const CANONICAL_ICON_SET: ReadonlySet<string> = new Set(CANONICAL_ICON_NAMES)",
    "",
    "export const ICON_INNER_SVG: Record<IconName, string> = {",
    ...sortedAllKeys.map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(allEntries[k])},`),
    "}",
    "",
    "export function isIconName(value: string): value is IconName {",
    "  return CANONICAL_ICON_SET.has(value) || Object.hasOwn(LEGACY_ICON_ALIASES, value)",
    "}",
    "",
    "export function resolveCanonicalIconName(name: IconName): CanonicalIconName {",
    "  return Object.hasOwn(LEGACY_ICON_ALIASES, name)",
    "    ? LEGACY_ICON_ALIASES[name as LegacyIconAlias]",
    "    : (name as CanonicalIconName)",
    "}",
    "",
    "const SVG_NS = \"http://www.w3.org/2000/svg\"",
    "",
    "function escapeAttr(value: string): string {",
    '  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")',
    "}",
    "",
    "export function createSpriteIconElement(",
    "  name: IconName,",
    "  options?: {",
    "    size?: number | undefined",
    "    className?: string | undefined",
    "    strokeWidth?: number | undefined",
    "    style?: string | undefined",
    "  },",
    "): SVGSVGElement {",
    "  const size = String(options?.size ?? 20)",
    "  const strokeWidth = String(options?.strokeWidth ?? 1.75)",
    "  const canonical = resolveCanonicalIconName(name)",
    "  const svg = document.createElementNS(SVG_NS, \"svg\")",
    "  svg.setAttribute(\"xmlns\", SVG_NS)",
    "  svg.setAttribute(\"width\", size)",
    "  svg.setAttribute(\"height\", size)",
    "  svg.setAttribute(\"viewBox\", \"0 0 24 24\")",
    "  svg.setAttribute(\"fill\", \"none\")",
    "  svg.setAttribute(\"stroke\", \"currentColor\")",
    "  svg.setAttribute(\"stroke-width\", strokeWidth)",
    "  svg.setAttribute(\"stroke-linecap\", \"round\")",
    "  svg.setAttribute(\"stroke-linejoin\", \"round\")",
    "  svg.setAttribute(\"vector-effect\", \"non-scaling-stroke\")",
    "  if (options?.className) svg.setAttribute(\"class\", options.className)",
    "  if (options?.style) svg.setAttribute(\"style\", options.style)",
    "  svg.setAttribute(\"aria-hidden\", \"true\")",
    "  svg.setAttribute(\"role\", \"img\")",
    "  const use = document.createElementNS(SVG_NS, \"use\")",
    "  use.setAttribute(\"href\", `#mt-icon-${canonical}`)",
    "  svg.appendChild(use)",
    "  return svg",
    "}",
    "",
    "export function renderSpriteIconSvg(",
    "  name: IconName,",
    "  options?: {",
    "    size?: number | undefined",
    "    className?: string | undefined",
    "    strokeWidth?: number | undefined",
    "    style?: string | undefined",
    "  },",
    "): string {",
    "  const size = options?.size ?? 20",
    "  const strokeWidth = options?.strokeWidth ?? 1.75",
    '  const cls = options?.className ? ` class="${escapeAttr(options.className)}"` : ""',
    '  const styleAttr = options?.style ? ` style="${escapeAttr(options.style)}"` : ""',
    "  const canonical = resolveCanonicalIconName(name)",
    '  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"${cls}${styleAttr} aria-hidden="true" role="img"><use href="#mt-icon-${canonical}" /></svg>`',
    "}",
    "",
    "export function renderIconSvg(",
    "  name: IconName,",
    "  options?: { size?: number | undefined; className?: string | undefined; strokeWidth?: number | undefined }",
    "): string {",
    "  const size = options?.size ?? 20",
    "  const strokeWidth = options?.strokeWidth ?? 1.75",
    '  const cls = options?.className ? ` class="${escapeAttr(options.className)}"` : ""',
    "  const inner = ICON_INNER_SVG[name]",
    '  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"${cls} aria-hidden="true" role="img">${inner}</svg>`',
    "}",
    "",
  ]

  return lines.join("\n")
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const output = generateIconRegistrySource()
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
  writeFileSync(OUTPUT_PATH, output, "utf-8")
  console.log(`[generate-icons] Wrote 64 canonical icons (+ ${Object.keys(LEGACY_ICON_ALIASES).length} legacy aliases) to ${OUTPUT_PATH}`)
}
