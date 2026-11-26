import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { gunzipSync, gzipSync } from "node:zlib"

import { generateCoverageMap, mergeCoverageMaps, normalizeCoveredSourcePath } from "./coverage-report.mjs"

export const PILOT_COVERAGE_ARCHIVE = "coverage-inputs.json.gz"

function portableSource(path, repoRoot) {
  if (typeof path !== "string") return path
  const url = path.startsWith("file://")
  let absolute
  try { absolute = url ? fileURLToPath(path) : path } catch { return path }
  if (!isAbsolute(absolute)) return path
  const local = relative(repoRoot, absolute)
  if (isAbsolute(local) || local === ".." || local.startsWith(".." + sep)) return path
  return { path: local, url }
}

function restoreSource(source, repoRoot) {
  if (!source || typeof source !== "object") return source
  const path = resolve(repoRoot, source.path)
  return source.url ? pathToFileURL(path).href : path
}

function mapPaths(data, transform) {
  if (!data) return data
  return {
    ...data,
    ...(data.sources ? { sources: data.sources.map(transform) } : {}),
    ...(data.sourceRoot ? { sourceRoot: transform(data.sourceRoot) } : {}),
    ...(data.file ? { file: transform(data.file) } : {}),
  }
}

export function writePilotCoverage(inputs, archive, repoRoot) {
  const cache = []
  const cacheIndexes = new Map()
  function cacheIndex(entry) {
    if (!entry) return null
    // Keep exactly the source material read by the coverage generator.
    const record = {
      source: entry.source,
      lineLengths: entry.lineLengths,
      data: mapPaths(entry.data, path => portableSource(path, repoRoot)),
    }
    const key = JSON.stringify(record)
    if (!cacheIndexes.has(key)) {
      cacheIndexes.set(key, cache.length)
      cache.push(record)
    }
    return cacheIndexes.get(key)
  }

  const specs = inputs.map(({ file, directory }) => {
    const names = readdirSync(directory).filter(name => name.endsWith(".json"))
      .sort((left, right) => left.localeCompare(right, "en", { numeric: true }))
    if (!names.length) throw new Error("Missing V8 coverage input for " + file)
    const dumps = names.flatMap(name => {
      const dump = JSON.parse(readFileSync(join(directory, name), "utf8"))
      const records = (dump.result ?? []).flatMap(script => {
        if (!script.url?.startsWith("file://")) return []
        let absolute
        try { absolute = fileURLToPath(script.url) } catch { return [] }
        const path = normalizeCoveredSourcePath(absolute, repoRoot)
        if (!path || !existsSync(absolute)) return []
        const sourceMaps = dump["source-map-cache"]
        const entry = sourceMaps?.[script.url] ?? sourceMaps?.[pathToFileURL(absolute).href]
        return [{ path, functions: script.functions, map: cacheIndex(entry) }]
      })
      return records.length ? [records] : []
    })
    return { file, dumps }
  })

  const compressed = gzipSync(JSON.stringify({ cache, specs }))
  writeFileSync(archive, compressed)
  return compressed.length
}

export async function replayPilotCoverage(archives, files, output, repoRoot) {
  const work = mkdtempSync(join(tmpdir(), "meitheal-pilot-coverage-"))
  try {
    const indexes = new Map(files.map((file, index) => [file, index]))
    const raw = join(work, "raw")
    const map = join(work, "coverage.json")
    mkdirSync(raw)
    for (const archive of archives) {
      const { cache, specs } = JSON.parse(gunzipSync(readFileSync(archive.path)).toString("utf8"))
      const remaining = new Set(archive.files)
      const restored = cache.map(entry => ({
        ...entry,
        data: mapPaths(entry.data, path => restoreSource(path, repoRoot)),
      }))
      for (const { file, dumps } of specs) {
        const index = indexes.get(file)
        if (index === undefined || !remaining.delete(file)) throw new Error("Unexpected coverage input: " + file)
        for (const [dumpIndex, records] of dumps.entries()) {
          const result = []
          const sourceMaps = {}
          for (const record of records) {
            const absolute = resolve(repoRoot, record.path)
            if (normalizeCoveredSourcePath(absolute, repoRoot) !== record.path) {
              throw new Error("Invalid coverage source path: " + record.path)
            }
            const url = pathToFileURL(absolute).href
            result.push({ url, functions: record.functions })
            if (record.map === null) continue
            if (!Number.isInteger(record.map) || !restored[record.map]) throw new Error("Missing source map for " + record.path)
            sourceMaps[url] = restored[record.map]
          }
          const name = String(index).padStart(8, "0") + "-" + String(dumpIndex).padStart(8, "0") + ".json"
          writeFileSync(join(raw, name), JSON.stringify({ result, "source-map-cache": sourceMaps }))
        }
      }
      if (remaining.size) throw new Error("Missing coverage inputs: " + [...remaining].join(", "))
    }
    await generateCoverageMap(raw, map, repoRoot)
    return mergeCoverageMaps([map], output)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
