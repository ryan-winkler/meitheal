#!/usr/bin/env node
/**
 * check-version-sync.mjs — VER-01: Validate version consistency
 *
 * @domain versioning
 * @kcs Ensures config.yaml, run.sh, package.json, and sw.js share the same version.
 *
 * Exits 0 if all versions match, 1 if mismatch detected.
 * Designed for CI pipeline integration (VER-02).
 *
 * Usage: node scripts/check-version-sync.mjs
 */

import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, "..")

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

/** Extract version from apps/web/package.json */
function getPackageVersion() {
  const pkg = JSON.parse(readFileSync(resolve(root, "apps/web/package.json"), "utf8"))
  return pkg.version ?? null
}

/** Extract CACHE_VERSION fallback from service worker */
function getServiceWorkerVersion() {
  const sw = readFileSync(resolve(root, "apps/web/public/sw.js"), "utf8")
  const match = sw.match(/CACHE_VERSION\s*=\s*"([^"]+)"/)
  return match?.[1] ?? null
}

// ── Main ────────────────────────────────────────────────────────────────

const sources = [
  { name: "meitheal-hub/config.yaml", version: getConfigVersion() },
  { name: "meitheal-hub/run.sh", version: getRunShVersion() },
  { name: "apps/web/package.json", version: getPackageVersion() },
  { name: "apps/web/public/sw.js", version: getServiceWorkerVersion() },
]

console.log("🔍 Version sync check")
console.log("─".repeat(50))

for (const s of sources) {
  const status = s.version ? `v${s.version}` : "⚠️  NOT FOUND"
  console.log(`  ${s.name.padEnd(30)} ${status}`)
}

console.log("─".repeat(50))

const versions = sources.map(s => s.version).filter(Boolean)
const unique = [...new Set(versions)]

if (unique.length === 0) {
  console.error("❌ No versions found in any source file")
  process.exit(1)
}

if (unique.length === 1) {
  console.log(`✅ All versions in sync: v${unique[0]}`)
  process.exit(0)
} else {
  console.error(`❌ Version mismatch detected!`)
  console.error(`   Found: ${unique.map(v => `v${v}`).join(", ")}`)
  console.error(`   Run: node scripts/bump-version.mjs <version>`)
  process.exit(1)
}
