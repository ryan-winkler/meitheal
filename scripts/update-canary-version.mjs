#!/usr/bin/env node
/**
 * update-canary-version.mjs — Update canary config.yaml version
 *
 * @domain versioning
 * @kcs CI-only script that updates the canary addon's config.yaml version.
 *      Called by publish-canary-images.yml after building images.
 *
 * Usage: node scripts/update-canary-version.mjs <sha-or-version>
 */

import { readFileSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, "..")
const configPath = resolve(root, "meitheal-hub-canary/config.yaml")

const version = process.argv[2]
if (!version) {
  console.error("Usage: node scripts/update-canary-version.mjs <sha-or-version>")
  process.exit(1)
}

let content = readFileSync(configPath, "utf8")
content = content.replace(
  /^(version:\s*["']?)[^"'\s]+(["']?)/m,
  `$1${version}$2`
)
writeFileSync(configPath, content)

console.log(`🐤 Canary config.yaml updated to version: ${version}`)
