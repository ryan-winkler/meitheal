/**
 * Framework YAML Export — download a framework definition as YAML
 *
 * GET /api/frameworks/:id/export — returns YAML for any framework (built-in or custom)
 *
 * @domain strategy
 * @kcs Framework extensibility — users can export and share framework definitions
 */
import type { APIRoute } from "astro"
import { readFileSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"
import { getCustomFramework } from "@domains/strategy/custom-framework-repository"
import { parseFrameworkConfig, frameworkConfigToRaw } from "@meitheal/domain-strategy"
import { stringify as stringifyYaml } from "yaml"
import { logApiError } from "@lib/api-logger"
import { validateSafeId } from "@lib/sanitize-id"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FRAMEWORKS_DIR = resolve(__dirname, "../../../../content/frameworks")

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

    // Try built-in first — serve the raw YAML file
    const yamlPath = resolve(FRAMEWORKS_DIR, `${frameworkId}.yaml`)
    if (existsSync(yamlPath)) {
      const content = readFileSync(yamlPath, "utf8")
      return new Response(content, {
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

