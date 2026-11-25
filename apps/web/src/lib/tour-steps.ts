/**
 * Tabler Function Tour — Pure step definitions and dismiss/restore state helpers.
 *
 * Follows the same dismissible & restorable model as InlineHelper (Pillars):
 * users can skip any step and replay from the sidebar keyboard menu.
 */

export const TOUR_STORAGE_KEY = "meitheal-function-tour-state:v1"
export const TOUR_RESTORE_EVENT = "meitheal:tour-restore"
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
  placement?: "right" | "bottom" | "top" | "left" | "auto"
}

export const CORE_TOUR_STEPS: readonly TourStep[] = [
  {
    id: "quick-create",
    selector: "#sidebar-rail-new-task, [data-board-new-task], #quick-title",
    title: "Capture work in seconds",
    description:
      "Start a new task, shopping list, checklist, or event from anywhere — or press C on your keyboard.",
    placement: "right",
  },
  {
    id: "global-search",
    selector: "#topbar-search-trigger, [data-search-hub-trigger]",
    title: "Jump straight to any ticket or Board",
    description:
      "Search by task title, Board name, or Board key (like MTH-12). Press / or Cmd+K from any screen.",
    placement: "bottom",
  },
  {
    id: "boards-nav",
    selector: 'a[href="/boards"], .board-directory-grid, .board-workspace-navigation',
    title: "Separate areas of life with Boards",
    description:
      "Give each Board its own workflow lanes, Areas, Projects, permissions, and custom ticket key.",
    placement: "right",
  },
  {
    id: "views-nav",
    selector: '#kanban-board, .board-context-tabs, a[href="/tasks"]',
    title: "Switch views without losing context",
    description:
      "Move cleanly between Kanban, Calendar, Timeline, and Table views — or star priority cards to promote them.",
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
