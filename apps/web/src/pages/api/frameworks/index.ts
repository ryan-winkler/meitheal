/**
 * Frameworks API — list all framework configs (YAML defaults + overrides).
 *
 * GET /api/frameworks — list all available frameworks with merged configs
 *
 * @kcs Loads field definitions from YAML files in content/frameworks/ and
 *      merges with user overrides stored in SQLite.
 */
import type { APIRoute } from "astro"
import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"
import { getAllOverrides } from "@domains/strategy/framework-repository"
import { parseFrameworkConfig, mergeFrameworkConfig } from "@meitheal/domain-strategy"

/**
 * Known built-in framework IDs.
 * YAML files live at apps/web/src/content/frameworks/{id}.yaml
 */
const FRAMEWORK_IDS = ["rice", "drice", "heart", "ddd", "kcs"] as const

const __dirname = dirname(fileURLToPath(import.meta.url))
const FRAMEWORKS_DIR = resolve(__dirname, "../../../content/frameworks")

/** Load a framework YAML file by ID, returning raw parsed object */
function loadFrameworkYaml(id: string): Record<string, unknown> {
  try {
    const content = readFileSync(resolve(FRAMEWORKS_DIR, `${id}.yaml`), "utf8")
    return parseYaml(content) as Record<string, unknown>
  } catch {
    // Fallback: return minimal metadata if YAML is missing
    return { name: id.toUpperCase(), archetype: "formula", fields: [], badge_thresholds: [] }
  }
}

export const GET: APIRoute = async () => {
  try {
    const overrides = await getAllOverrides()
    const overrideMap = new Map(overrides.map((o) => [o.frameworkId, o.overrides]))

    const frameworks = FRAMEWORK_IDS.map((id) => {
      const raw = loadFrameworkYaml(id)
      const base = parseFrameworkConfig(id, raw)
      return mergeFrameworkConfig(base, overrideMap.get(id) ?? null)
    })

    return new Response(JSON.stringify({ ok: true, data: frameworks }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    return new Response(
      JSON.stringify({ ok: false, errorCode: "FRAMEWORKS_FETCH_FAILED", message: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}
