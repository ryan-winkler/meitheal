import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import istanbulCoverage from "istanbul-lib-coverage"
import istanbulReport from "istanbul-lib-report"
import istanbulReports from "istanbul-reports"
import v8ToIstanbul from "v8-to-istanbul"

const SOURCE_PREFIXES = ["packages/", "apps/web/src/"]
const SOURCE_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"]
const EXCLUDED_SEGMENTS = ["/node_modules/", "/dist/", "/.astro/", "/public/"]

/**
 * Convert an absolute file path into a normalized repo-relative POSIX path when it is in scope.
 */
export function normalizeCoveredSourcePath(filePath, repoRoot) {
  const normalizedRoot = resolve(repoRoot).split("\\").join("/").replace(/\/$/, "")
  const normalizedFile = resolve(filePath).split("\\").join("/")
  if (!normalizedFile.startsWith(normalizedRoot + "/")) return null
  const relPath = normalizedFile.slice(normalizedRoot.length + 1)
  if (!SOURCE_PREFIXES.some(prefix => relPath.startsWith(prefix))) return null
  if (!SOURCE_EXTENSIONS.some(ext => relPath.endsWith(ext))) return null
  if (relPath.endsWith(".d.ts") || relPath.endsWith(".spec.ts") || relPath.endsWith(".test.ts")) return null
  if (EXCLUDED_SEGMENTS.some(seg => (`/${relPath}`).includes(seg))) return null
  return relPath
}

function buildV8Sources(cacheEntry) {
  if (!cacheEntry) return undefined
  // Playwright/Node V8 source-map-cache omits `.source` and stores transpiled `lineLengths`.
  const transpiledSource = cacheEntry.source
    ?? (Array.isArray(cacheEntry.lineLengths) && cacheEntry.lineLengths.length > 0
      ? cacheEntry.lineLengths.map(len => "x".repeat(len)).join("\n")
      : undefined)
  const sourceMap = cacheEntry.data ? { sourcemap: cacheEntry.data } : undefined
  if (!transpiledSource && !sourceMap) return undefined
  return { source: transpiledSource, sourceMap }
}

function toRepoRelativeCoverageMap(rawMap, repoRoot) {
  const relativeMap = istanbulCoverage.createCoverageMap({})
  for (const absPath of rawMap.files()) {
    const relPath = normalizeCoveredSourcePath(absPath, repoRoot)
    if (!relPath) continue
    const serialized = rawMap.fileCoverageFor(absPath).toJSON()
    relativeMap.addFileCoverage({ ...serialized, path: relPath })
  }
  return relativeMap
}

/**
 * Merge all V8 JSON coverage dumps inside `v8Dir` into a repo-relative LCOV file at `outputFile`.
 */
export async function generateLcovCoverage(v8Dir, outputFile, repoRoot) {
  const jsonFiles = readdirSync(v8Dir).filter(name => name.endsWith(".json")).sort()
  if (!jsonFiles.length) {
    throw new Error(`No V8 coverage files found in ${v8Dir}`)
  }

  const rawMap = istanbulCoverage.createCoverageMap({})
  for (const jsonName of jsonFiles) {
    const dump = JSON.parse(readFileSync(resolve(v8Dir, jsonName), "utf8"))
    const sourceMapCache = dump["source-map-cache"] ?? {}
    for (const script of dump.result ?? []) {
      if (!script.url?.startsWith("file://")) continue
      let absPath
      try {
        absPath = fileURLToPath(script.url)
      } catch {
        continue
      }
      if (!normalizeCoveredSourcePath(absPath, repoRoot)) continue
      if (!existsSync(absPath)) continue

      const cacheEntry = sourceMapCache[script.url] ?? sourceMapCache[pathToFileURL(absPath).href]
      const converter = v8ToIstanbul(absPath, 0, buildV8Sources(cacheEntry))
      await converter.load()
      converter.applyCoverage(script.functions)
      rawMap.merge(converter.toIstanbul())
    }
  }

  const relativeMap = toRepoRelativeCoverageMap(rawMap, repoRoot)
  if (!relativeMap.files().length) {
    throw new Error(`No repository source files were captured in ${v8Dir}`)
  }

  const resolvedOutput = resolve(outputFile)
  mkdirSync(dirname(resolvedOutput), { recursive: true })
  const context = istanbulReport.createContext({
    dir: dirname(resolvedOutput),
    coverageMap: relativeMap,
  })
  istanbulReports.create("lcovonly", { file: basename(resolvedOutput) }).execute(context)

  const summary = relativeMap.getCoverageSummary().toJSON()
  return {
    file: resolvedOutput,
    coveredFiles: relativeMap.files().length,
    linesPct: summary.lines.pct,
    branchesPct: summary.branches.pct,
  }
}
