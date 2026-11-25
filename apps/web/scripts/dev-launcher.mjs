/**
 * Direct single-process dev server launcher for Meitheal.
 *
 * Avoids nested `npm run --workspace` + `predev` shells so port 3000 binds
 * quickly and reliably while preserving `apps/web` as the working directory.
 */

import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ensureCodegenArtifacts } from "./ensure-codegen.mjs"

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const webDir = path.resolve(scriptsDir, "..")

process.chdir(webDir)
ensureCodegenArtifacts()

const astroCliPath = path.join(scriptsDir, "astro-cli.mjs")
const extraArgs = process.argv.slice(2)
const hasHost = extraArgs.some((arg) => arg === "--host" || arg.startsWith("--host="))
const hasPort = extraArgs.some((arg) => arg === "--port" || arg.startsWith("--port="))

const devArgs = ["dev"]
if (!hasHost) devArgs.push("--host", "0.0.0.0")
if (!hasPort) devArgs.push("--port", process.env.PORT || "3000")
devArgs.push(...extraArgs)

process.argv = [process.execPath, astroCliPath, ...devArgs]
await import(pathToFileURL(astroCliPath).href)
