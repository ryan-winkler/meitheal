/**
 * Framework YAML Export — download a framework definition as YAML
 *
 * GET /api/frameworks/:id/export — returns YAML for any framework (built-in or custom)
 *
 * @domain strategy
 * @kcs Framework extensibility — users can export and share framework definitions
 */
import type { APIRoute } from "astro"
import { getBuiltInFramework } from "@domains/strategy/framework-catalog"
import { getCustomFramework } from "@domains/strategy/custom-framework-repository"
import { frameworkConfigToRaw } from "@meitheal/domain-strategy"
import { stringify as stringifyYaml } from "yaml"
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

    // Export the immutable built-in definition, preserving the existing defaults contract.
    const builtIn = await getBuiltInFramework(frameworkId!)
    if (builtIn) {
      return new Response(stringifyYaml(frameworkConfigToRaw(builtIn), { indent: 2 }), {
        status: 200,
        headers: {
          "Content-Type": "text/yaml; charset=utf-8",
          "Content-Disposition": `attachment; filename="${frameworkId}.yaml"`,
        },
      })
    }

    // Try custom — convert from FrameworkConfig to YAML
    const custom = await getCustomFramework(frameworkId!)
    if (custom) {
      const raw = frameworkConfigToRaw(custom)
      const yaml = stringifyYaml(raw, { indent: 2 })
      return new Response(yaml, {
        status: 200,
        headers: {
          "Content-Type": "text/yaml; charset=utf-8",
          "Content-Disposition": `attachment; filename="${frameworkId}.yaml"`,
        },
      })
    }

    return new Response(
      JSON.stringify({ ok: false, errorCode: "FRAMEWORK_NOT_FOUND" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  } catch (error) {
    logApiError("frameworks", "Failed to export framework", error)
    return new Response(
      JSON.stringify({ ok: false, errorCode: "EXPORT_FAILED" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}

