/**
 * Shared task type icon configuration.
 *
 * Single source of truth for SVG path data and colors used across:
 * - TaskTypeIcon.astro (server-side sprited rendering)
 * - task-modal-controller.ts (client-side dynamic rendering)
 *
 * Bounded context: tasks (presentation)
 */
import { renderSpriteIconSvg, type IconName } from "../generated/icon-registry"

export interface TypeIconConfig {
  iconName: IconName
  color: string
  bg: string
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

/** Resolve config for a task type string, with fallback to "task". */
export function getTypeIconConfig(taskType: string | null | undefined): TypeIconConfig {
  const key = String(taskType || "task").toLowerCase()
  return TYPE_ICON_CONFIG[key] ?? TYPE_ICON_CONFIG.task!
}

/** Render a sprited SVG element string for a given task type. */
export function renderTypeIconSvg(
  taskType: string | null | undefined,
  size = 16
): string {
  const config = getTypeIconConfig(taskType)
  return renderSpriteIconSvg(config.iconName, { size, style: `color:${config.color}` })
}
