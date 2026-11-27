/**
 * Tabler Function Tour — Pure step definitions and dismiss/restore state helpers.
 *
 * Follows the same dismissible & restorable model as InlineHelper (Pillars):
 * users can skip any step and replay from the sidebar keyboard menu.
 */

export const TOUR_STORAGE_KEY = "meitheal-function-tour-state:v1"
export const TOUR_START_EVENT = "meitheal:tour-start"

export type TourStatus = "available" | "dismissed" | "completed"

export interface TourState {
  status: TourStatus
  updatedAt: number
}

export interface TourStep {
  id: string
  selector: string
  title: string
  description: string
  placement: "right" | "bottom"
}

export const CORE_TOUR_STEPS: readonly TourStep[] = [
  {
    id: "quick-create",
    selector: "#sidebar-rail-new-task, [data-board-new-task], #quick-title",
    title: "Create a task",
    description: "Choose New task or press C to create a task, list, or event.",
    placement: "right",
  },
  {
    id: "global-search",
    selector: "#topbar-search-trigger, [data-search-hub-trigger]",
    title: "Search tasks and Boards",
    description: "Press / or Cmd+K to search by title, Board name, or ticket key.",
    placement: "bottom",
  },
  {
    id: "boards-nav",
    selector: 'a[href="/boards"], .board-directory-grid, .board-workspace-navigation',
    title: "Organize work with Boards",
    description: "Each Board can have its own lanes, Areas, Projects, and members.",
    placement: "right",
  },
  {
    id: "views-nav",
    selector: '#kanban-board, .board-context-tabs, a[href="/tasks"]',
    title: "Switch task views",
    description: "Use Kanban, Calendar, Timeline, or Table. Star a card to promote it.",
    placement: "bottom",
  },
]

export function parseTourState(raw: string | null | undefined): TourState {
  if (!raw) return { status: "available", updatedAt: 0 }
  try {
    const parsed = JSON.parse(raw) as Partial<TourState>
    if (
      parsed.status === "available" ||
      parsed.status === "dismissed" ||
      parsed.status === "completed"
    ) {
      return {
        status: parsed.status,
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      }
    }
  } catch {
    /* invalid storage falls back to available */
  }
  return { status: "available", updatedAt: 0 }
}

export function transitionTourState(
  action: "dismiss" | "complete" | "restore",
  now = Date.now(),
): TourState {
  if (action === "dismiss") return { status: "dismissed", updatedAt: now }
  if (action === "complete") return { status: "completed", updatedAt: now }
  return { status: "available", updatedAt: now }
}

export function isTourBannerVisible(state: TourState): boolean {
  return state.status === "available"
}

export function filterReachableSteps<T>(
  steps: readonly TourStep[],
  resolveTarget: (selector: string) => T | null,
): Array<{ step: TourStep; target: T }> {
  const matched: Array<{ step: TourStep; target: T }> = []
  for (const step of steps) {
    const target = resolveTarget(step.selector)
    if (target !== null) matched.push({ step, target })
  }
  return matched
}

export function clampTourIndex(index: number, total: number): number {
  if (total <= 0) return 0
  if (index < 0) return 0
  if (index >= total) return total - 1
  return index
}
