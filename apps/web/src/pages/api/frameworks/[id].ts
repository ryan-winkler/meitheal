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
import { requireSystemSettingsAdmin } from "@lib/settings-security"
import { getBuiltInFramework } from "@domains/strategy/framework-catalog"
import { getOverrides, saveOverrides, resetOverrides } from "@domains/strategy/framework-repository"
import { getCustomFramework, updateCustomFramework, deleteCustomFramework } from "@domains/strategy/custom-framework-repository"
import { mergeFrameworkConfig, validateFrameworkConfig, validateFrameworkOverrides } from "@meitheal/domain-strategy"
import type { FrameworkConfig } from "@meitheal/domain-strategy"
import { logApiError } from "@lib/api-logger"
import { validateSafeId } from "@lib/sanitize-id"

export const GET: APIRoute = async ({ params }) => {
  try {
    const frameworkId = params.id
    const idErr = validateSafeId(frameworkId, "framework_id")
    if (idErr) {
      return new Response(
        JSON.stringify({ ok: false, errorCode: "INVALID_ID", message: idErr }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    // Try built-in first
    const builtIn = await getBuiltInFramework(frameworkId!)
    if (builtIn) {
      const overrideRecord = await getOverrides(frameworkId!)
      const config = mergeFrameworkConfig(builtIn, overrideRecord?.overrides ?? null)
      return new Response(JSON.stringify({ ok: true, data: { ...config, source: "built-in" }, hasOverrides: !!overrideRecord }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    // Try custom
    const custom = await getCustomFramework(frameworkId!)
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

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied
  try {
    const frameworkId = params.id
    const idErr = validateSafeId(frameworkId, "framework_id")
    if (idErr) {
      return new Response(
        JSON.stringify({ ok: false, errorCode: "INVALID_ID", message: idErr }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    const base = await getBuiltInFramework(frameworkId!)
    if (base) {
      const body = await request.json()
      const errors = validateFrameworkOverrides(body, base.fields.map((field) => field.key))
      if (errors) return new Response(JSON.stringify({ ok: false, errorCode: "VALIDATION_FAILED", errors, message: errors.join(". ") }), {
        status: 400, headers: { "Content-Type": "application/json" },
      })
      const record = await saveOverrides(frameworkId!, body)
      return new Response(JSON.stringify({ ok: true, data: record }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    // Custom: update full config
    const body = (await request.json()) as Partial<FrameworkConfig>
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return new Response(JSON.stringify({ ok: false, errorCode: "VALIDATION_FAILED", errors: ["Framework must be an object"] }), {
        status: 400, headers: { "Content-Type": "application/json" },
      })
    }
    const existing = await getCustomFramework(frameworkId!)
    if (!existing) {
      return new Response(
        JSON.stringify({ ok: false, errorCode: "FRAMEWORK_NOT_FOUND" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )
    }

    const updated: FrameworkConfig = { ...existing, ...body, id: frameworkId!, source: existing.source }
    const editsScoring = "formula" in body || "archetype" in body || "fields" in body
    const errors = validateFrameworkConfig(updated, { preserveLegacyScoring: !editsScoring })
    if (errors) {
      return new Response(
        JSON.stringify({ ok: false, errorCode: "VALIDATION_FAILED", errors }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    const result = await updateCustomFramework(frameworkId!, updated)
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

export const DELETE: APIRoute = async ({ params, request, locals }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied
  try {
    const frameworkId = params.id
    const idErr = validateSafeId(frameworkId, "framework_id")
    if (idErr) {
      return new Response(
        JSON.stringify({ ok: false, errorCode: "INVALID_ID", message: idErr }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    if (await getBuiltInFramework(frameworkId!)) {
      // Built-in: reset overrides to YAML defaults
      const deleted = await resetOverrides(frameworkId!)
      return new Response(JSON.stringify({ ok: true, wasReset: deleted, source: "built-in" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    // Custom: fully delete
    const exists = await getCustomFramework(frameworkId!)
    if (!exists) {
      return new Response(
        JSON.stringify({ ok: false, errorCode: "FRAMEWORK_NOT_FOUND" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )
    }

    const deleted = await deleteCustomFramework(frameworkId!)
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
