/**
 * Shared task type icon configuration.
 *
 * Single source of truth for SVG path data and colors used across:
 * - TaskTypeIcon.astro (server-side sprited rendering)
 * - task-modal-controller.ts (client-side dynamic rendering)
 *
 * Bounded context: tasks (presentation)
 */
import { createSpriteIconElement, renderSpriteIconSvg, type IconName } from "../generated/icon-registry"

export interface TypeIconConfig {
  iconName: IconName
  color: string
  bg: string
}

export const KIND_ICON_CONFIG: Record<string, TypeIconConfig> = {
  calendar_event: {
    iconName: "calendar-event",
    color: "var(--type-story, #38bdf8)",
    bg: "rgba(56, 189, 248, 0.1)",
  },
  shopping_item: {
    iconName: "shopping-cart",
    color: "var(--warning, #f59e0b)",
    bg: "rgba(245, 158, 11, 0.1)",
  },
  routine_instance: {
    iconName: "repeat",
    color: "var(--accent, #69E3B2)",
    bg: "rgba(105, 227, 178, 0.1)",
  },
  checklist: {
    iconName: "list-check",
    color: "var(--type-task, #69E3B2)",
    bg: "rgba(105, 227, 178, 0.1)",
  },
  quick_capture: {
    iconName: "bolt",
    color: "var(--type-epic, #a78bfa)",
    bg: "rgba(168, 85, 247, 0.1)",
  },
}

export const TYPE_ICON_CONFIG: Record<string, TypeIconConfig> = {
  epic: {
    iconName: "bolt",
    color: "var(--type-epic, #a78bfa)",
    bg: "rgba(168, 85, 247, 0.1)",
  },
  story: {
    iconName: "book",
    color: "var(--type-story, #38bdf8)",
    bg: "rgba(56, 189, 248, 0.1)",
  },
  bug: {
    iconName: "bug",
    color: "var(--danger, #ef4444)",
    bg: "rgba(239, 68, 68, 0.1)",
  },
  task: {
    iconName: "checkbox",
    color: "var(--type-task, #69E3B2)",
    bg: "rgba(105, 227, 178, 0.1)",
  },
}

/** Resolve config for a task type and optional task kind, with fallback to "task". */
export function getTypeIconConfig(
  taskType: string | null | undefined,
  taskKind?: string | null | undefined,
): TypeIconConfig {
  const kind = typeof taskKind === "string" ? taskKind.toLowerCase() : ""
  if (kind && kind !== "standard_action" && Object.hasOwn(KIND_ICON_CONFIG, kind)) {
    return KIND_ICON_CONFIG[kind]!
  }
  const key = String(taskType || "task").toLowerCase()
  return TYPE_ICON_CONFIG[key] ?? TYPE_ICON_CONFIG.task!
}

/** Create a sprited DOM SVG icon element for a task type / kind. */
export function createTypeIconElement(
  taskType: string | null | undefined,
  size = 16,
  taskKind?: string | null | undefined,
): SVGSVGElement {
  const config = getTypeIconConfig(taskType, taskKind)
  return createSpriteIconElement(config.iconName, { size, style: `color:${config.color}` })
}

/** Render a sprited SVG element string for a given task type / kind. */
export function renderTypeIconSvg(
  taskType: string | null | undefined,
  size = 16,
  taskKind?: string | null | undefined,
): string {
  const config = getTypeIconConfig(taskType, taskKind)
  return renderSpriteIconSvg(config.iconName, { size, style: `color:${config.color}` })
}
