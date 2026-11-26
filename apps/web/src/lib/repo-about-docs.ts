import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

export type ChangelogCategory =
  | "Added"
  | "Changed"
  | "Deprecated"
  | "Removed"
  | "Fixed"
  | "Security"

export const CHANGELOG_CATEGORY_ORDER: readonly ChangelogCategory[] = [
  "Added",
  "Changed",
  "Fixed",
  "Security",
  "Deprecated",
  "Removed",
] as const

export interface ChangelogItem {
  title: string
  body: string
  category?: ChangelogCategory
}

export interface ChangelogRelease {
  version: string
  channel: string
  date?: string
  summary: string
  items: ChangelogItem[]
}

export interface InlineCodeToken {
  type: "text" | "code"
  value: string
}

export interface RepoAboutDocs {
  releases: ChangelogRelease[]
  licenseText: string
  noticeText: string
}

export const AGPL_LICENSE_SUMMARY = {
  spdx: "AGPL-3.0-only",
  title: "GNU Affero General Public License v3.0 only",
  summary:
    "Permissions of this strongest copyleft license are conditioned on making available complete source code of licensed works and modifications, which include larger works using a licensed work, under the same license — including network interaction.",
  permissions: [
    "Commercial use",
    "Modification",
    "Distribution",
    "Patent use",
    "Private use",
  ],
  conditions: [
    "Disclose source",
    "License and copyright notice",
    "Network use is distribution",
    "Same license",
    "State changes",
  ],
  limitations: [
    "Liability",
    "Warranty",
  ],
} as const

function normalizeChangelogCategory(raw: string): ChangelogCategory | undefined {
  const key = raw.trim().toLowerCase()
  if (key === "added" || key === "new") return "Added"
  if (key === "changed" || key === "improved" || key === "updated") return "Changed"
  if (key === "fixed" || key === "bug fixes" || key === "fixes") return "Fixed"
  if (key === "security") return "Security"
  if (key === "deprecated") return "Deprecated"
  if (key === "removed") return "Removed"
  return undefined
}

function inferChannel(version: string, explicitChannel?: string): string {
  if (explicitChannel?.trim()) return explicitChannel.trim()
  const lower = version.toLowerCase()
  if (lower === "unreleased") return "Unreleased"
  if (lower.includes("canary")) return "Canary channel"
  if (lower.includes("beta") || lower.includes("rc")) return "Beta channel"
  return "Stable release"
}

/**
 * Tokenize inline Markdown backtick spans (`code`) into safe text/code segments
 * for escaped template rendering with zero HTML injection.
 */
export function tokenizeInlineCode(text: string): InlineCodeToken[] {
  if (!text.includes("`")) return text ? [{ type: "text", value: text }] : []
  const tokens: InlineCodeToken[] = []
  const pattern = /`([^`]+)`/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: "text", value: text.slice(lastIndex, match.index) })
    }
    tokens.push({ type: "code", value: match[1]! })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) {
    tokens.push({ type: "text", value: text.slice(lastIndex) })
  }
  return tokens
}

/**
 * Group changelog items by Keep a Changelog category in canonical display order.
 */
export function groupChangelogItemsByCategory(
  items: ChangelogItem[],
): Array<{ category: ChangelogCategory | null; items: ChangelogItem[] }> {
  const hasCategories = items.some((item) => Boolean(item.category))
  if (!hasCategories) return items.length > 0 ? [{ category: null, items }] : []

  const buckets = new Map<ChangelogCategory | null, ChangelogItem[]>()
  for (const item of items) {
    const key = item.category ?? null
    const list = buckets.get(key) ?? []
    list.push(item)
    buckets.set(key, list)
  }

  const ordered: Array<{ category: ChangelogCategory | null; items: ChangelogItem[] }> = []
  for (const cat of CHANGELOG_CATEGORY_ORDER) {
    const list = buckets.get(cat)
    if (list && list.length > 0) ordered.push({ category: cat, items: list })
  }
  const uncategorized = buckets.get(null)
  if (uncategorized && uncategorized.length > 0) {
    ordered.push({ category: null, items: uncategorized })
  }
  return ordered
}

/**
 * Parse Meitheal's CHANGELOG.md (Keep a Changelog 1.1.0 or legacy Release Summary)
 * into structured releases. Pure function — safe to render as escaped text nodes.
 */
export function parseChangelogMarkdown(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = []
  let current: ChangelogRelease | null = null
  let currentCategory: ChangelogCategory | undefined
  let mode: "keepachangelog" | "legacy" | null = null

  for (const rawLine of markdown.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue

    // Keep a Changelog 1.1.0 release heading:
    // ## [0.0.4-canary] - 2026-11-25 (Canary channel)  OR  ## [0.0.3] - 2026-09-12
    const kaclReleaseMatch = /^##\s+\[([^\]]+)\](?:\s*[-–—]\s*(\d{4}-\d{2}-\d{2}|Unreleased))?(?:\s*\(([^)]+)\))?\s*$/i.exec(trimmed)
    if (kaclReleaseMatch) {
      const version = kaclReleaseMatch[1]!.trim()
      const dateRaw = kaclReleaseMatch[2]?.trim()
      current = {
        version,
        channel: inferChannel(version, kaclReleaseMatch[3]),
        ...(dateRaw && dateRaw.toLowerCase() !== "unreleased" ? { date: dateRaw } : {}),
        summary: "",
        items: [],
      }
      currentCategory = undefined
      mode = "keepachangelog"
      releases.push(current)
      continue
    }

    // Ignore non-release H2 sections (e.g. "## Release Summary") or link-ref footer lines
    if (/^##\s+/.test(trimmed) || /^\[[^\]]+\]:\s*https?:\/\//.test(trimmed)) {
      if (mode === "keepachangelog" && /^##\s+/.test(trimmed)) {
        current = null
        currentCategory = undefined
      }
      continue
    }

    // Keep a Changelog 1.1.0 category heading: ### Added / ### Changed / ### Fixed / ### Security
    const categoryMatch = /^###\s+(.+)$/.exec(trimmed)
    if (categoryMatch && current) {
      currentCategory = normalizeChangelogCategory(categoryMatch[1]!)
      continue
    }

    // Legacy release bullet: - **0.0.4-canary** (Canary channel): summary
    const legacyReleaseMatch = /^- \*\*([^*]+)\*\*\s*(?:\(([^)]+)\))?:\s*(.*)$/.exec(rawLine)
    if (legacyReleaseMatch && mode !== "keepachangelog") {
      current = {
        version: legacyReleaseMatch[1]!.trim(),
        channel: (legacyReleaseMatch[2] ?? "Release").trim(),
        summary: legacyReleaseMatch[3]!.trim(),
        items: [],
      }
      currentCategory = undefined
      mode = "legacy"
      releases.push(current)
      continue
    }

    if (!current) continue

    // Bullet item (both Keep a Changelog top-level `- ...` and legacy indented `  - ...`)
    const boldItemMatch = /^\s*-\s+\*\*([^*]+)\*\*:\s*(.*)$/.exec(rawLine)
    if (boldItemMatch && (mode === "keepachangelog" || /^\s{2,}-/.test(rawLine))) {
      current.items.push({
        title: boldItemMatch[1]!.trim(),
        body: boldItemMatch[2]!.trim(),
        ...(currentCategory ? { category: currentCategory } : {}),
      })
      continue
    }

    const plainItemMatch = /^\s*-\s+(.+)$/.exec(rawLine)
    if (plainItemMatch && (mode === "keepachangelog" || /^\s{2,}-/.test(rawLine))) {
      current.items.push({
        title: "",
        body: plainItemMatch[1]!.trim(),
        ...(currentCategory ? { category: currentCategory } : {}),
      })
      continue
    }

    // Optional release summary paragraph placed directly below ## [version] before first ###
    if (mode === "keepachangelog" && !currentCategory && current.items.length === 0 && !trimmed.startsWith("#")) {
      current.summary = current.summary ? `${current.summary} ${trimmed}` : trimmed
    }
  }

  return releases
}

async function readRepoFile(filename: string): Promise<string> {
  const candidates = [
    resolve(process.cwd(), filename),
    resolve(process.cwd(), "..", "..", filename),
    resolve(process.cwd(), "..", filename),
  ]
  for (const filePath of candidates) {
    try {
      return await readFile(filePath, "utf8")
    } catch {
      // Try next candidate path
    }
  }
  return ""
}

let cachedDocs: RepoAboutDocs | null = null

export async function readRepoAboutDocs(): Promise<RepoAboutDocs> {
  if (cachedDocs) return cachedDocs
  const [changelogMd, licenseText, noticeText] = await Promise.all([
    readRepoFile("CHANGELOG.md"),
    readRepoFile("LICENSE"),
    readRepoFile("NOTICE"),
  ])
  const docs: RepoAboutDocs = {
    releases: parseChangelogMarkdown(changelogMd),
    licenseText: licenseText.trim(),
    noticeText: noticeText.trim(),
  }
  if (docs.releases.length > 0 || docs.licenseText.length > 0) {
    cachedDocs = docs
  }
  return docs
}

