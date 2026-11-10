/**
 * Frameworks API — dynamic registry for built-in + custom frameworks.
 *
 * GET  /api/frameworks — list all available frameworks (built-in YAMLs + user-created)
 * POST /api/frameworks — create a new custom framework
 *
 * @kcs Loads built-in field definitions from YAML files in content/frameworks/,
 *      loads user-created frameworks from custom_frameworks SQLite table,
 *      and merges built-in configs with user overrides stored in framework_configs table.
 */
import type { APIRoute } from "astro"
import { readFileSync, readdirSync } from "node:fs"
import { resolve, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"
import { readFrameworkImport } from "@domains/strategy/framework-import"
import { getAllOverrides } from "@domains/strategy/framework-repository"
import { getAllCustomFrameworks, createCustomFramework, isFrameworkIdTaken } from "@domains/strategy/custom-framework-repository"
import { parseFrameworkConfig, mergeFrameworkConfig, validateFrameworkConfig } from "@meitheal/domain-strategy"
import type { FrameworkConfig } from "@meitheal/domain-strategy"
import { logApiError } from "@lib/api-logger"
import { validateSafeId } from "@lib/sanitize-id"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FRAMEWORKS_DIR = resolve(__dirname, "../../../content/frameworks")

/** Discover all built-in framework IDs from YAML files on disk */
function getBuiltInFrameworkIds(): string[] {
  try {
    return readdirSync(FRAMEWORKS_DIR)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => basename(f, ".yaml"))
  } catch {
    return []
  }
}

/** Load a framework YAML file by ID, returning raw parsed object */
function loadFrameworkYaml(id: string): Record<string, unknown> {
  // Guard: reject IDs with path traversal sequences
  if (validateSafeId(id)) {
    return { name: id.toUpperCase(), archetype: "formula", fields: [], badge_thresholds: [] }
  }
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
    // Load built-in frameworks from YAML
    const builtInIds = getBuiltInFrameworkIds()
    const overrides = await getAllOverrides()
    const overrideMap = new Map(overrides.map((o) => [o.frameworkId, o.overrides]))

    const builtInFrameworks: FrameworkConfig[] = builtInIds.map((id) => {
      const raw = loadFrameworkYaml(id)
      const base = parseFrameworkConfig(id, raw)
      const merged = mergeFrameworkConfig(base, overrideMap.get(id) ?? null)
      return { ...merged, source: "built-in" as const }
    })

    // Load user-created/imported frameworks from SQLite
    const customFrameworks = await getAllCustomFrameworks()

    // Merge both lists (built-in first, then custom)
    const frameworks = [...builtInFrameworks, ...customFrameworks]

    return new Response(JSON.stringify({ ok: true, data: frameworks }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    logApiError("frameworks", "Failed to fetch frameworks", error)
    return new Response(
      JSON.stringify({ ok: false, errorCode: "FRAMEWORKS_FETCH_FAILED" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const media = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    let body: Partial<FrameworkConfig>
    if (media === "application/yaml") {
      const imported = await readFrameworkImport(request)
      if (!imported.ok) {
        return new Response(JSON.stringify({ ok: false, errorCode: imported.errorCode, message: imported.message }), {
          status: imported.status, headers: { "Content-Type": "application/json" },
        })
      }
      body = imported.config
    } else {
      body = await request.json() as Partial<FrameworkConfig>
    }

    // Validate the submitted config
    const errors = validateFrameworkConfig(body)
    if (errors) {
      return new Response(
        JSON.stringify({ ok: false, errorCode: "VALIDATION_FAILED", errors }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    // Check ID collision with built-in frameworks
    const builtInIds = getBuiltInFrameworkIds()
    if (builtInIds.includes(body.id!)) {
      return new Response(
        JSON.stringify({ ok: false, errorCode: "ID_CONFLICT", message: "Framework ID conflicts with a built-in framework" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      )
    }

    // Check ID collision with existing custom frameworks
    const idExists = await isFrameworkIdTaken(body.id!)
    if (idExists) {
      return new Response(
        JSON.stringify({ ok: false, errorCode: "ID_CONFLICT", message: "Framework ID already exists" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      )
    }

    // Build the full config with defaults
    const config: FrameworkConfig = {
      id: body.id!,
      name: body.name!,
      version: body.version ?? "1.0.0",
      archetype: body.archetype!,
      source: body.source ?? "user",
      formula: body.formula,
      badgeThresholds: body.badgeThresholds ?? [],
      fields: body.fields ?? [],
      description: body.description,
    }

    const created = await createCustomFramework(config)

    return new Response(JSON.stringify({ ok: true, data: created }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    logApiError("frameworks", "Failed to create framework", error)
    return new Response(
      JSON.stringify({ ok: false, errorCode: "FRAMEWORK_CREATE_FAILED" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}
