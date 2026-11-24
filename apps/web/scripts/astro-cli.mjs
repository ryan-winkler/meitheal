/**
 * Astro CLI runner for Meitheal web workspace.
 *
 * Delegates directly to Astro's CLI entrypoint on Node >= 22.23.4 (or >= 24)
 * and uses Astro's WebContainer-compatible Node >= 22.22.0 floor on managed
 * Node 22.22–22.23.3 build containers where Node cannot be bumped in-place.
 */

import module from "node:module"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"

const require = createRequire(import.meta.url)

function parseNodeVersion(raw) {
  const [major = 0, minor = 0, patch = 0] = raw.split(".").map((part) => Number.parseInt(part, 10) || 0)
  return { major, minor, patch }
}

function isAtLeast(v, major, minor, patch) {
  if (v.major !== major) return v.major > major
  if (v.minor !== minor) return v.minor > minor
  return v.patch >= patch
}

const current = parseNodeVersion(process.versions.node)
if (!isAtLeast(current, 22, 22, 0)) {
  console.error(`Node.js v${process.versions.node} is not supported. Requires >= 22.22.0.`)
  process.exit(1)
}

if (!process.env.CI) {
  try {
    module.enableCompileCache?.()
    setTimeout(() => {
      try {
        module.flushCompileCache?.()
      } catch { /* ignore */ }
    }, 10_000).unref()
  } catch { /* ignore */ }
}

const astroPkgDir = path.dirname(require.resolve("astro/package.json"))
const useStandardBin = isAtLeast(current, 24, 0, 0) || isAtLeast(current, 22, 23, 4)

if (useStandardBin) {
  await import(pathToFileURL(path.join(astroPkgDir, "bin", "astro.mjs")).href)
} else {
  const { cli } = await import(pathToFileURL(path.join(astroPkgDir, "dist", "cli", "index.js")).href)
  await cli(process.argv)
}
