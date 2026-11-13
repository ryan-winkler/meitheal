import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json"
const DEFAULT_MAX_LINE_LENGTH = 512

function unwrapIssue(entry) {
  if (!entry || typeof entry !== "object") return null
  if (entry.Issue && typeof entry.Issue === "object") return entry.Issue
  if (entry.filename && entry.patternId && entry.message) return entry
  return null
}

function readPatternId(issue) {
  if (typeof issue.patternId === "string") return issue.patternId
  return issue.patternId?.value ?? "codacy-issue"
}

function readMessage(issue) {
  if (typeof issue.message === "string") return issue.message
  return issue.message?.text ?? readPatternId(issue)
}

function readLocation(issue) {
  const loc = issue.location?.LineLocation ?? issue.location?.FullLocation ?? issue.location
  const rawLine = typeof loc?.line === "number" ? loc.line : 1
  const line = rawLine >= 1 ? Math.trunc(rawLine) : 1
  const rawColumn = typeof loc?.column === "number" ? loc.column : undefined
  const column = rawColumn && rawColumn >= 1 ? Math.trunc(rawColumn) : undefined
  return { line, column }
}

function normalizeCategory(category) {
  if (!category) return "CodeStyle"
  if (typeof category === "string") return category
  return String(category)
}

function resolveSarifLevel(level, category) {
  const normalizedLevel = String(level ?? "Info").toLowerCase()
  const isSecurity = normalizeCategory(category).toLowerCase() === "security"
  if (normalizedLevel === "high" || normalizedLevel === "err" || normalizedLevel === "error") {
    return isSecurity ? "error" : "warning"
  }
  if (normalizedLevel === "warn" || normalizedLevel === "warning") {
    return isSecurity ? "warning" : "note"
  }
  return "note"
}

function safeLineHash(repoRoot, relPath, lineNumber) {
  const resolved = resolve(repoRoot, relPath)
  let lineText = `${relPath}:${lineNumber}`
  if (existsSync(resolved)) {
    try {
      const content = readFileSync(resolved).toString("utf8")
      const lines = content.split(/\r?\n/)
      lineText = (lines[lineNumber - 1] ?? lineText).slice(0, DEFAULT_MAX_LINE_LENGTH)
    } catch {
      // Fallback keeps fingerprint deterministic even for unreadable or binary targets.
    }
  }
  return createHash("sha256").update(lineText).digest("hex").slice(0, 16)
}

/**
 * Convert Codacy Analysis CLI JSON results into a GitHub Code Scanning-compatible SARIF 2.1.0 report.
 */
export function convertCodacyJsonToSarif(rawEntries, repoRoot) {
  const issues = (Array.isArray(rawEntries) ? rawEntries : [])
    .map(unwrapIssue)
    .filter(issue => issue !== null && typeof issue.filename === "string" && issue.filename.length > 0)

  const artifactIndexMap = new Map()
  const artifacts = []
  const ruleIndexMap = new Map()
  const rules = []

  const results = issues.map(issue => {
    const uri = issue.filename.replace(/\\/g, "/").replace(/^\.\//, "")
    if (!artifactIndexMap.has(uri)) {
      artifactIndexMap.set(uri, artifacts.length)
      artifacts.push({ location: { uri } })
    }

    const ruleId = readPatternId(issue)
    const category = normalizeCategory(issue.category)
    if (!ruleIndexMap.has(ruleId)) {
      ruleIndexMap.set(ruleId, rules.length)
      rules.push({
        id: ruleId,
        name: ruleId,
        shortDescription: { text: ruleId },
        properties: { category },
      })
    }

    const { line, column } = readLocation(issue)
    const region = column ? { startLine: line, startColumn: column } : { startLine: line }

    return {
      ruleId,
      ruleIndex: ruleIndexMap.get(ruleId),
      level: resolveSarifLevel(issue.level, category),
      message: { text: readMessage(issue) },
      locations: [
        {
          physicalLocation: {
            artifactLocation: {
              uri,
              index: artifactIndexMap.get(uri),
            },
            region,
          },
        },
      ],
      partialFingerprints: {
        primaryLocationLineHash: `${safeLineHash(repoRoot, uri, line)}:1`,
      },
    }
  })

  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Codacy Analysis CLI",
            rules,
          },
        },
        invocations: [
          {
            executionSuccessful: true,
          },
        ],
        artifacts,
        results,
      },
    ],
  }
}

function main() {
  const inputPath = process.argv[2]
  const outputPath = process.argv[3]
  const repoRoot = resolve(process.argv[4] ?? process.cwd())

  if (!inputPath || !outputPath) {
    console.error("Usage: node scripts/codacy-json-to-sarif.mjs <input.json> <output.sarif> [repoRoot]")
    process.exit(2)
  }

  const rawText = readFileSync(resolve(inputPath), "utf8").trim()
  const parsed = rawText ? JSON.parse(rawText) : []
  const sarif = convertCodacyJsonToSarif(parsed, repoRoot)

  const resolvedOutput = resolve(outputPath)
  mkdirSync(dirname(resolvedOutput), { recursive: true })
  writeFileSync(resolvedOutput, `${JSON.stringify(sarif)}\n`, "utf8")

  const resultCount = sarif.runs[0]?.results.length ?? 0
  console.log(`Converted ${resultCount} Codacy issues to ${resolvedOutput}`)
}

const isCliEntry = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isCliEntry) {
  main()
}
