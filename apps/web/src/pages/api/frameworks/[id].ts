/**
 * Single Framework API — get, update, or delete a specific framework.
 *
 * GET    /api/frameworks/:id — get framework config (built-in with overrides, or custom)
 * PUT    /api/frameworks/:id — save overrides (built-in) or update config (custom)
 * DELETE /api/frameworks/:id — reset overrides (built-in) or delete (custom)
 *
 * @kcs Handles both built-in YAML frameworks and user-created custom frameworks.
 *      Built-in frameworks can have overrides reset but NOT deleted.
 *      Custom frameworks can be fully deleted.
 */
import type { APIRoute } from "astro"
import { readFileSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"
import { getOverrides, saveOverrides, resetOverrides } from "@domains/strategy/framework-repository"
import { getCustomFramework, updateCustomFramework, deleteCustomFramework } from "@domains/strategy/custom-framework-repository"
import { parseFrameworkConfig, mergeFrameworkConfig, validateFrameworkConfig } from "@meitheal/domain-strategy"
import type { FrameworkConfig, FrameworkOverrides } from "@meitheal/domain-strategy"
import { logApiError } from "@lib/api-logger"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FRAMEWORKS_DIR = resolve(__dirname, "../../../content/frameworks")

/** Check if a framework ID is a built-in (has a YAML file) */
function isBuiltIn(id: string): boolean {
  return existsSync(resolve(FRAMEWORKS_DIR, `${id}.yaml`))
}

/** Load built-in framework from YAML */
function loadBuiltInFramework(id: string): FrameworkConfig | null {
  const yamlPath = resolve(FRAMEWORKS_DIR, `${id}.yaml`)
  if (!existsSync(yamlPath)) return null
  try {
    const content = readFileSync(yamlPath, "utf8")
    const raw = parseYaml(content) as Record<string, unknown>
    return parseFrameworkConfig(id, raw)
  } catch {
    return null
  }
}

export const GET: APIRoute = async ({ params }) => {
  try {
    const frameworkId = params.id!

    // Try built-in first
    const builtIn = loadBuiltInFramework(frameworkId)
    if (builtIn) {
      const overrideRecord = await getOverrides(frameworkId)
      const config = mergeFrameworkConfig(builtIn, overrideRecord?.overrides ?? null)
      return new Response(JSON.stringify({ ok: true, data: { ...config, source: "built-in" }, hasOverrides: !!overrideRecord }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    // Try custom
    const custom = await getCustomFramework(frameworkId)
    if (custom) {
      return new Response(JSON.stringify({ ok: true, data: custom, hasOverrides: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    return new Response(
      JSON.stringify({ ok: false, errorCode: "FRAMEWORK_NOT_FOUND" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  } catch (error) {
    logApiError("frameworks", "Failed to fetch framework", error)
    return new Response(
      JSON.stringify({ ok: false, errorCode: "FRAMEWORK_FETCH_FAILED" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}

export const PUT: APIRoute = async ({ params, request }) => {
  try {
    const frameworkId = params.id!

    if (isBuiltIn(frameworkId)) {
      // Built-in: save as overrides
      const body = (await request.json()) as FrameworkOverrides
      const record = await saveOverrides(frameworkId, body)
      return new Response(JSON.stringify({ ok: true, data: record }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    // Custom: update full config
    const body = (await request.json()) as Partial<FrameworkConfig>
    const existing = await getCustomFramework(frameworkId)
    if (!existing) {
      return new Response(
        JSON.stringify({ ok: false, errorCode: "FRAMEWORK_NOT_FOUND" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )
    }

    const updated: FrameworkConfig = { ...existing, ...body, id: frameworkId, source: existing.source }
    const errors = validateFrameworkConfig(updated)
    if (errors) {
      return new Response(
        JSON.stringify({ ok: false, errorCode: "VALIDATION_FAILED", errors }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    const result = await updateCustomFramework(frameworkId, updated)
    return new Response(JSON.stringify({ ok: true, data: result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    logApiError("frameworks", "Failed to update framework", error)
    return new Response(
      JSON.stringify({ ok: false, errorCode: "FRAMEWORK_UPDATE_FAILED" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}

export const DELETE: APIRoute = async ({ params }) => {
  try {
    const frameworkId = params.id!

    if (isBuiltIn(frameworkId)) {
      // Built-in: reset overrides to YAML defaults
      const deleted = await resetOverrides(frameworkId)
      return new Response(JSON.stringify({ ok: true, wasReset: deleted, source: "built-in" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    // Custom: fully delete
    const exists = await getCustomFramework(frameworkId)
    if (!exists) {
      return new Response(
        JSON.stringify({ ok: false, errorCode: "FRAMEWORK_NOT_FOUND" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )
    }

    const deleted = await deleteCustomFramework(frameworkId)
    return new Response(JSON.stringify({ ok: true, wasDeleted: deleted, source: "custom" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    logApiError("frameworks", "Failed to delete framework", error)
    return new Response(
      JSON.stringify({ ok: false, errorCode: "FRAMEWORK_DELETE_FAILED" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}
