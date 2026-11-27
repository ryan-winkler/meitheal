/**
 * Fast dev-start guard for build-time codegen artifacts.
 *
 * Full codegen still runs unconditionally on `generate:codegen` and `prebuild`.
 * During `dev` startup, skip spawning nested npm/node generators when all
 * generated files already exist on disk so port 3000 opens immediately.
 */

import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const webDir = path.resolve(scriptsDir, "..")

const REQUIRED_ARTIFACTS = [
  "public/openapi.yaml",
  "src/generated/mcp-tools.json",
  "src/generated/icon-registry.ts",
]

export function ensureCodegenArtifacts() {
  const missing = REQUIRED_ARTIFACTS.some((relPath) => !existsSync(path.join(webDir, relPath)))
  if (!missing) return false

  for (const script of ["generate-openapi.mjs", "generate-mcp-tools.mjs", "generate-icons.mjs"]) {
    execFileSync(process.execPath, [path.join(scriptsDir, script)], {
      cwd: webDir,
      stdio: "inherit",
    })
  }
  return true
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureCodegenArtifacts()
}
