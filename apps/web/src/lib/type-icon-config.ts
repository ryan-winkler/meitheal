/**
 * Shared task type icon configuration.
 *
 * Single source of truth for SVG path data and colors used across:
 * - TaskTypeIcon.astro (server-side sprited rendering)
 * - task-modal-controller.ts (client-side dynamic rendering)
 *
 * Bounded context: tasks (presentation)
 */
import { ICON_INNER_SVG, type IconName } from "../generated/icon-registry"

export interface TypeIconConfig {
  iconName: IconName
  color: string
  bg: string
  svg: string
}

export const TYPE_ICON_CONFIG: Record<string, TypeIconConfig> = {
  epic: {
    iconName: "bolt",
    color: "var(--type-epic, #a78bfa)",
    bg: "rgba(168, 85, 247, 0.1)",
    svg: ICON_INNER_SVG.bolt,
  },
  story: {
    iconName: "book",
    color: "var(--type-story, #38bdf8)",
    bg: "rgba(56, 189, 248, 0.1)",
    svg: ICON_INNER_SVG.book,
  },
  bug: {
    iconName: "bug",
    color: "var(--danger, #ef4444)",
    bg: "rgba(239, 68, 68, 0.1)",
    svg: ICON_INNER_SVG.bug,
  },
  task: {
    iconName: "checkbox",
    color: "var(--type-task, #69E3B2)",
    bg: "rgba(105, 227, 178, 0.1)",
    svg: ICON_INNER_SVG.checkbox,
  },
}

/** Resolve config for a task type string, with fallback to "task". */
export function getTypeIconConfig(taskType: string | null | undefined): TypeIconConfig {
  const key = String(taskType || "task").toLowerCase()
  return TYPE_ICON_CONFIG[key] ?? TYPE_ICON_CONFIG.task!
}

/** Render an inline SVG element string for a given task type. */
export function renderTypeIconSvg(
  taskType: string | null | undefined,
  size = 16
): string {
  const config = getTypeIconConfig(taskType)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" style="color:${config.color}">${config.svg}</svg>`
}
