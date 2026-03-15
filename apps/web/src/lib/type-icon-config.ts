/**
 * Shared task type icon configuration.
 *
 * Single source of truth for SVG path data and colors used across:
 * - TaskTypeIcon.astro (server-side rendering)
 * - task-modal-controller.ts (client-side dynamic rendering)
 * - kanban-controller.ts (client-side card rendering)
 *
 * Bounded context: tasks (presentation)
 * @kcs Task type visual identity — Purple=Epic, Green=Story, Blue=Task, Red=Bug
 */

export interface TypeIconConfig {
  color: string
  bg: string
  svg: string
}

export const TYPE_ICON_CONFIG: Record<string, TypeIconConfig> = {
  epic: {
    color: "var(--color-primary-400, #a855f7)",
    bg: "rgba(168, 85, 247, 0.1)",
    svg: `<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />`
  },
  story: {
    color: "var(--color-success-400, #22c55e)",
    bg: "rgba(34, 197, 94, 0.1)",
    svg: `<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>`
  },
  bug: {
    color: "var(--color-danger-400, #ef4444)",
    bg: "rgba(239, 68, 68, 0.1)",
    svg: `<rect width="8" height="14" x="8" y="6" rx="4"/><path d="M12 2v4"/><path d="m19 7-3 2"/><path d="m5 7 3 2"/><path d="m19 19-3-2"/><path d="m5 19 3-2"/><path d="M20 13h-4"/><path d="M4 13h4"/>`
  },
  task: {
    color: "var(--color-info-400, #3b82f6)",
    bg: "rgba(59, 130, 246, 0.1)",
    svg: `<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 12l2 2 4-4"/>`
  }
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:${config.color}">${config.svg}</svg>`
}
