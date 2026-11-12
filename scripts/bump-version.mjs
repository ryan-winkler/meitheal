#!/usr/bin/env node
/**
 * bump-version.mjs — VER-03: Atomic version bump across all sources
 *
 * @domain versioning
 * @kcs Updates root package.json, config.yaml, run.sh, apps/web/package.json, and sw.js atomically.
 *
 * Enforces the 0.0.{one digit} SemVer policy (+0.0.1 increments only) unless --force-semver is passed.
 *
 * Usage:
 *   node scripts/bump-version.mjs patch
 *   node scripts/bump-version.mjs 0.0.2
 *   node scripts/bump-version.mjs 0.1.0 --force-semver
 */

import { readFileSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, "..")

const FILES = {
  rootPkg: resolve(root, "package.json"),
  config: resolve(root, "meitheal-hub/config.yaml"),
  runSh: resolve(root, "meitheal-hub/run.sh"),
  pkg: resolve(root, "apps/web/package.json"),
  sw: resolve(root, "apps/web/public/sw.js"),
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

/** Resolve and validate target version against Meitheal's SemVer policy */
function resolveVersion(arg, forceSemver) {
  const current = getCurrentVersion()
  if (!current) {
    console.error("❌ Cannot read current version from config.yaml")
    process.exit(1)
  }

  const parts = parseSemver(current)
  if (!parts) {
    console.error(`❌ Current version "${current}" is not valid semver`)
    process.exit(1)
  }

  let nextVersion
  if (/^\d+\.\d+\.\d+$/.test(arg)) {
    nextVersion = arg
  } else if (arg === "patch") {
    nextVersion = `${parts[0]}.${parts[1]}.${parts[2] + 1}`
  } else if (arg === "minor" || arg === "major") {
    if (!forceSemver) {
      console.error(`❌ Refusing "${arg}" bump without explicit maintainer override (--force-semver).`)
      console.error(`   Policy: increment strictly by +0.0.1 within 0.0.{one digit} unless told otherwise.`)
      process.exit(1)
    }
    nextVersion = arg === "major"
      ? `${parts[0] + 1}.0.0`
      : `${parts[0]}.${parts[1] + 1}.0`
  } else {
    console.error(`❌ Invalid version: "${arg}". Use patch or 0.0.<digit> (or --force-semver for major/minor).`)
    process.exit(1)
  }

  const nextParts = parseSemver(nextVersion)
  const isSingleStepPatch =
    nextParts[0] === parts[0] &&
    nextParts[1] === parts[1] &&
    nextParts[2] === parts[2] + 1
  const isSingleDigitZeroLine =
    nextParts[0] === 0 &&
    nextParts[1] === 0 &&
    nextParts[2] >= 1 &&
    nextParts[2] <= 9

  if (!forceSemver && (!isSingleStepPatch || !isSingleDigitZeroLine)) {
    console.error(`❌ Refusing version jump v${current} → v${nextVersion}.`)
    console.error(`   Policy: increment only by +0.0.1 within 0.0.{1..9} unless told otherwise (--force-semver).`)
    process.exit(1)
  }

  return nextVersion
}

// ── Main ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const forceSemver = args.includes("--force-semver")
const arg = args.find(a => !a.startsWith("-"))
if (!arg) {
  console.log("Usage: node scripts/bump-version.mjs <patch|0.0.<digit>> [--force-semver]")
  process.exit(1)
}

const newVersion = resolveVersion(arg, forceSemver)
const current = getCurrentVersion()

console.log(`📦 Bumping version: v${current} → v${newVersion}`)
console.log("─".repeat(50))

// 1. Root package.json
const rootPkg = JSON.parse(readFileSync(FILES.rootPkg, "utf8"))
rootPkg.version = newVersion
writeFileSync(FILES.rootPkg, JSON.stringify(rootPkg, null, 2) + "\n")
console.log(`  ✅ package.json`)

// 2. config.yaml
let configContent = readFileSync(FILES.config, "utf8")
configContent = configContent.replace(
  /^(version:\s*["']?)[^"'\s]+(["']?)/m,
  `$1${newVersion}$2`
)
writeFileSync(FILES.config, configContent)
console.log(`  ✅ meitheal-hub/config.yaml`)

// 3. run.sh
let runShContent = readFileSync(FILES.runSh, "utf8")
runShContent = runShContent.replace(
  /MEITHEAL_VERSION="[^"]+"/,
  `MEITHEAL_VERSION="${newVersion}"`
)
writeFileSync(FILES.runSh, runShContent)
console.log(`  ✅ meitheal-hub/run.sh`)

// 4. apps/web/package.json
const pkg = JSON.parse(readFileSync(FILES.pkg, "utf8"))
pkg.version = newVersion
writeFileSync(FILES.pkg, JSON.stringify(pkg, null, 2) + "\n")
console.log(`  ✅ apps/web/package.json`)

// 5. service worker fallback version
let swContent = readFileSync(FILES.sw, "utf8")
swContent = swContent.replace(
  /CACHE_VERSION\s*=\s*"[^"]+"/,
  `CACHE_VERSION = "${newVersion}"`
)
writeFileSync(FILES.sw, swContent)
console.log(`  ✅ apps/web/public/sw.js`)

console.log("─".repeat(50))
console.log(`✅ All files updated to v${newVersion}`)
console.log(`\nNext steps:`)
console.log(`  1. Push reviewed commits ONLY to dev (primary branch)`)
console.log(`  2. Promote to release only via explicit maintainer approval`)
