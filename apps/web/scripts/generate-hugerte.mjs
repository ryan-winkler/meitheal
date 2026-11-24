#!/usr/bin/env node
/**
 * generate-hugerte.mjs — Stage pinned HugeRTE assets from @tabler/core for offline WYSIWYG editing.
 *
 * Copies only the required core, silver theme, default icons, DOM model, light/dark UI+content skins,
 * and enabled toolbar plugins into apps/web/public/vendor/hugerte/ so HA ingress and offline/air-gapped
 * installations load rich text editing locally without CDNs or inflating _astro/ client bundles.
 */
import { createRequire } from "node:module"
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = resolve(SCRIPT_DIR, "../public/vendor/hugerte")
const require = createRequire(import.meta.url)

function resolveHugeRteSource() {
  const pkgPath = require.resolve("@tabler/core/package.json")
  const dir = resolve(dirname(pkgPath), "dist/libs/hugerte")
  if (!existsSync(resolve(dir, "hugerte.min.js"))) {
    throw new Error(`HugeRTE bundle missing at ${dir}`)
  }
  return dir
}

const REQUIRED_PATHS = [
  "hugerte.min.js",
  "license.txt",
  "models/dom/model.min.js",
  "themes/silver/theme.min.js",
  "icons/default/icons.min.js",
  "skins/ui/oxide",
  "skins/ui/oxide-dark",
  "skins/content/default",
  "skins/content/dark",
  "plugins/advlist/plugin.min.js",
  "plugins/autolink/plugin.min.js",
  "plugins/lists/plugin.min.js",
  "plugins/link/plugin.min.js",
  "plugins/code/plugin.min.js",
  "plugins/codesample/plugin.min.js",
  "plugins/table/plugin.min.js",
]

export function stageHugeRteAssets() {
  const sourceDir = resolveHugeRteSource()
  rmSync(OUTPUT_DIR, { recursive: true, force: true })
  mkdirSync(OUTPUT_DIR, { recursive: true })
  for (const rel of REQUIRED_PATHS) {
    const src = resolve(sourceDir, rel)
    const dst = resolve(OUTPUT_DIR, rel)
    mkdirSync(dirname(dst), { recursive: true })
    cpSync(src, dst, { recursive: true })
  }
}

stageHugeRteAssets()
