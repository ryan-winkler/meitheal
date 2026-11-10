import { parseDocument, visit } from "yaml"
import type { FrameworkConfig } from "@meitheal/domain-strategy"
import { readWithinLimit } from "@lib/bounded-body"
import { frameworkImportBytesMax } from "@lib/framework-import-limit"

/** Decode imported YAML before the shared framework validator and repository run. */
export async function readFrameworkImport(request: Request): Promise<
  { ok: true; config: Partial<FrameworkConfig> } |
  { ok: false; status: 400 | 413; errorCode: string; message: string }
> {
  const tooLarge = () => ({ ok: false as const, status: 413 as const, errorCode: "FRAMEWORK_IMPORT_TOO_LARGE",
    message: "Framework YAML must be 64 KiB or smaller." })
  if (Number(request.headers.get("content-length")) > frameworkImportBytesMax) return tooLarge()
  try {
    const bytes = await readWithinLimit(request.body, frameworkImportBytesMax,
      AbortSignal.any([request.signal, AbortSignal.timeout(5000)]))
    if (!bytes) return tooLarge()
    const document = parseDocument(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    if (document.errors.length) throw document.errors[0]
    visit(document, (_key, _node, path) => {
      if (path.length > 64) throw new Error("Framework YAML nesting is too deep.")
    })
    const parsed = document.toJS({ maxAliasCount: 100 }) as Record<string, unknown> | null
    if (!parsed || !parsed.name) {
      return { ok: false, status: 400, errorCode: "FRAMEWORK_IMPORT_INVALID", message: "Invalid YAML: 'name' field is required" }
    }
    // Preserve the Settings import defaults and snake_case YAML field mapping.
    const config = {
      id: String(parsed.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
      name: parsed.name,
      version: parsed.version ?? "1.0.0",
      archetype: parsed.archetype ?? "formula",
      source: "imported",
      description: parsed.description,
      formula: parsed.formula,
      fields: Array.isArray(parsed.fields) ? parsed.fields.map((field: Record<string, unknown>) => ({
        key: field.key,
        label: field.label,
        type: field.type ?? "number",
        uiType: field.ui_type ?? "slider",
        weight: field.weight ?? 1,
        min: field.min,
        max: field.max,
        helpText: field.help_text ?? "",
      })) : [],
      badgeThresholds: Array.isArray(parsed.badge_thresholds) ? parsed.badge_thresholds.map((badge: Record<string, unknown>) => ({
        min: badge.min ?? 0,
        label: badge.label ?? "",
        color: badge.color ?? "bg-secondary",
      })) : [],
    }
    // Cyclic aliases cannot be persisted as framework JSON.
    JSON.stringify(config)
    return { ok: true, config: config as Partial<FrameworkConfig> }
  } catch (error) {
    return { ok: false, status: 400, errorCode: "FRAMEWORK_IMPORT_INVALID",
      message: `Parse error: ${error instanceof Error ? error.message : "Invalid YAML"}` }
  }
}
