#!/usr/bin/env node
/**
 * bump-version.mjs — VER-03: Atomic version bump across all sources
 *
 * @domain versioning
 * @kcs Updates version in config.yaml, run.sh, and package.json atomically.
 *
 * Usage:
 *   node scripts/bump-version.mjs 0.3.0
 *   node scripts/bump-version.mjs patch     (auto-increment)
 *   node scripts/bump-version.mjs minor
 *   node scripts/bump-version.mjs major
 */

import { readFileSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, "..")

const FILES = {
  config: resolve(root, "meitheal-hub/config.yaml"),
  runSh: resolve(root, "meitheal-hub/run.sh"),
  pkg: resolve(root, "apps/web/package.json"),
}

/** Parse semver string into [major, minor, patch] */
function parseSemver(v) {
  const parts = v.replace(/^v/, "").split(".").map(Number)
  if (parts.length !== 3 || parts.some(isNaN)) return null
  return parts
}

/** Get current version from config.yaml */
function getCurrentVersion() {
  const content = readFileSync(FILES.config, "utf8")
  const match = content.match(/^version:\s*["']?([^"'\s]+)["']?/m)
  return match?.[1] ?? null
}

/** Resolve target version from argument */
function resolveVersion(arg) {
  const current = getCurrentVersion()
  if (!current) {
    console.error("❌ Cannot read current version from config.yaml")
    process.exit(1)
  }

  if (/^\d+\.\d+\.\d+$/.test(arg)) return arg

  const parts = parseSemver(current)
  if (!parts) {
    console.error(`❌ Current version "${current}" is not valid semver`)
    process.exit(1)
  }

  switch (arg) {
    case "major": return `${parts[0] + 1}.0.0`
    case "minor": return `${parts[0]}.${parts[1] + 1}.0`
    case "patch": return `${parts[0]}.${parts[1]}.${parts[2] + 1}`
    default:
      console.error(`❌ Invalid version: "${arg}". Use semver (0.3.0) or major/minor/patch`)
      process.exit(1)
  }
}

// ── Main ────────────────────────────────────────────────────────────────

const arg = process.argv[2]
if (!arg) {
  console.log("Usage: node scripts/bump-version.mjs <version|major|minor|patch>")
  process.exit(1)
}

const newVersion = resolveVersion(arg)
const current = getCurrentVersion()

console.log(`📦 Bumping version: v${current} → v${newVersion}`)
console.log("─".repeat(50))

// 1. config.yaml
let configContent = readFileSync(FILES.config, "utf8")
configContent = configContent.replace(
  /^(version:\s*["']?)[^"'\s]+(["']?)/m,
  `$1${newVersion}$2`
)
writeFileSync(FILES.config, configContent)
console.log(`  ✅ meitheal-hub/config.yaml`)

// 2. run.sh
let runShContent = readFileSync(FILES.runSh, "utf8")
runShContent = runShContent.replace(
  /MEITHEAL_VERSION="[^"]+"/,
  `MEITHEAL_VERSION="${newVersion}"`
)
writeFileSync(FILES.runSh, runShContent)
console.log(`  ✅ meitheal-hub/run.sh`)

// 3. package.json
const pkg = JSON.parse(readFileSync(FILES.pkg, "utf8"))
pkg.version = newVersion
writeFileSync(FILES.pkg, JSON.stringify(pkg, null, 2) + "\n")
console.log(`  ✅ apps/web/package.json`)

console.log("─".repeat(50))
console.log(`✅ All files updated to v${newVersion}`)
console.log(`\nNext steps:`)
console.log(`  git add -A && git commit -m "🔖 bump version to v${newVersion}"`)
console.log(`  git tag v${newVersion} && git push origin main --tags`)
