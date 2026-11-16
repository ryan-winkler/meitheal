#!/usr/bin/env node
/**
 * check-version-sync.mjs — VER-01: Validate version consistency & SemVer line
 *
 * @domain versioning
 * @kcs Ensures root package.json, config.yaml, run.sh, apps/web/package.json, and sw.js share one valid version.
 *
 * Exits 0 if all versions match, 1 if mismatch or unauthorized SemVer jump detected.
 * Designed for CI pipeline integration (VER-02).
 *
 * Usage: node scripts/check-version-sync.mjs
 */

import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, "..")

/** Extract version from a JSON package manifest */
function getJsonVersion(relativePath) {
  const pkg = JSON.parse(readFileSync(resolve(root, relativePath), "utf8"))
  return pkg.version ?? null
}

/** Extract version from config.yaml */
function getConfigVersion() {
  const content = readFileSync(resolve(root, "meitheal-hub/config.yaml"), "utf8")
  const match = content.match(/^version:\s*["']?([^"'\s]+)["']?/m)
  return match?.[1] ?? null
}

/** Extract MEITHEAL_VERSION from run.sh */
function getRunShVersion() {
  const content = readFileSync(resolve(root, "meitheal-hub/run.sh"), "utf8")
  const match = content.match(/MEITHEAL_VERSION="([^"]+)"/)
  return match?.[1] ?? null
}

/** Extract CACHE_VERSION fallback from service worker */
function getServiceWorkerVersion() {
  const sw = readFileSync(resolve(root, "apps/web/public/sw.js"), "utf8")
  const match = sw.match(/CACHE_VERSION\s*=\s*"([^"]+)"/)
  return match?.[1] ?? null
}

// ── Main ────────────────────────────────────────────────────────────────

const sources = [
  { name: "package.json", version: getJsonVersion("package.json") },
  { name: "meitheal-hub/config.yaml", version: getConfigVersion() },
  { name: "meitheal-hub/run.sh", version: getRunShVersion() },
  { name: "apps/web/package.json", version: getJsonVersion("apps/web/package.json") },
  { name: "apps/web/public/sw.js", version: getServiceWorkerVersion() },
]

console.log("🔍 Version sync check")
console.log("─".repeat(50))

for (const s of sources) {
  const status = s.version ? `v${s.version}` : "⚠️  NOT FOUND"
  console.log(`  ${s.name.padEnd(30)} ${status}`)
}

console.log("─".repeat(50))
console.log("  ℹ️  meitheal-hub-canary/config.yaml is CI-managed (excluded from sync check)")
console.log("─".repeat(50))

const versions = sources.map(s => s.version).filter(Boolean)
const unique = [...new Set(versions)]

if (sources.some(s => !s.version) || unique.length === 0) {
  console.error("❌ Missing version in one or more tracked files")
  process.exit(1)
}

if (unique.length !== 1) {
  console.error(`❌ Version mismatch detected!`)
  console.error(`   Found: ${unique.map(v => `v${v}`).join(", ")}`)
  console.error(`   Run: node scripts/bump-version.mjs patch`)
  process.exit(1)
}

const current = unique[0]
const allowOverride = process.env.MEITHEAL_ALLOW_SEMVER_OVERRIDE === "1"
if (!allowOverride && !/^0\.0\.[1-9]$/.test(current)) {
  console.error(`❌ Version v${current} violates the 0.0.{1..9} SemVer policy!`)
  console.error(`   Keep releases in 0.0.<single-digit> unless explicitly overridden (MEITHEAL_ALLOW_SEMVER_OVERRIDE=1).`)
  process.exit(1)
}

console.log(`✅ All versions in sync: v${current}`)
process.exit(0)
