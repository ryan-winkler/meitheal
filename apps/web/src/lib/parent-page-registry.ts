/**
 * Parent Page Registry — canonical route mapping for sidebar + redirects + search
 *
 * Single source of truth for the three parent pages (Tasks, Progress & Growth, Planning),
 * their sub-views, old routes, and sidebar configuration.
 *
 * @domain navigation
 * @phase 15 — Hierarchy Architecture Overhaul
 */

// ─── Types ─────────────────────────────────────────────────────────

export type ParentPageId = "tasks" | "progress" | "planning"

export interface ParentPageSubView {
  id: string
  label: string
  icon: string
  hash: string
  description: string
  /** Old route this sub-view replaces (for redirect mapping) */
  legacyRoute: string | null
  keywords: string[]
}

export interface ParentPageDescriptor {
  id: ParentPageId
  label: string
  icon: string
  route: string
  description: string
  /** Default sub-view hash to open when navigating to the parent page */
  defaultHash: string
  subViews: ParentPageSubView[]
  keywords: string[]
}

// ─── Registry ──────────────────────────────────────────────────────

export const PARENT_PAGES: ParentPageDescriptor[] = [
  {
    id: "tasks",
    label: "Tasks",
    icon: "📋",
    route: "/tasks",
    description: "All your task views in one place",
    defaultHash: "kanban",
    keywords: ["tasks", "kanban", "calendar", "table", "timeline"],
    subViews: [
      {
        id: "kanban",
        label: "Kanban",
        icon: "▦",
        hash: "kanban",
        description: "Drag-and-drop board view",
        legacyRoute: "/kanban",
        keywords: ["kanban", "board", "drag", "columns", "lanes"],
      },
      {
        id: "calendar",
        label: "Calendar",
        icon: "🗓️",
        hash: "calendar",
        description: "Calendar timeline view",
        legacyRoute: "/calendar",
        keywords: ["calendar", "schedule", "dates", "events"],
      },
      {
        id: "table",
        label: "Table",
        icon: "⊞",
        hash: "table",
        description: "Spreadsheet-style task list",
        legacyRoute: "/table",
        keywords: ["table", "list", "spreadsheet", "sort", "filter"],
      },
      {
        id: "timeline",
        label: "Timeline",
        icon: "📊",
        hash: "timeline",
        description: "Timeline and dependency chart",
        legacyRoute: "/timeline",
        keywords: ["timeline", "chart", "dependencies"],
      },
    ],
  },
  {
    id: "progress",
    label: "Progress & Growth",
    icon: "🏆",
    route: "/progress",
    description: "Track pillars, routines, goals, and achievements",
    defaultHash: "pillars",
    keywords: ["progress", "growth", "pillars", "routines", "goals", "achievements", "habits", "streaks"],
    subViews: [
      {
        id: "pillars",
        label: "Pillars",
        icon: "🏛️",
        hash: "pillars",
        description: "Identity anchors — the WHY behind everything",
        legacyRoute: null,
        keywords: ["pillars", "identity", "values", "principles", "non-negotiable", "why", "manifesto"],
      },
      {
        id: "routines",
        label: "Routines",
        icon: "🔄",
        hash: "routines",
        description: "Daily routines and habit tracking",
        legacyRoute: "/habits",
        keywords: ["routines", "habits", "daily", "streaks", "check-in"],
      },
      {
        id: "goals",
        label: "Goals",
        icon: "🎯",
        hash: "goals",
        description: "Long-term outcome tracking",
        legacyRoute: "/goals",
        keywords: ["goals", "objectives", "targets", "metrics"],
      },
      {
        id: "achievements",
        label: "Achievements",
        icon: "🏆",
        hash: "achievements",
        description: "Completed goals, streaks, and milestones",
        legacyRoute: "/gamification",
        keywords: ["achievements", "gamification", "points", "badges", "xp", "level"],
      },
    ],
  },
  {
    id: "planning",
    label: "Planning",
    icon: "⚖️",
    route: "/planning",
    description: "Manage areas, projects, and prioritise with strategic frameworks",
    defaultHash: "spaces",
    keywords: ["planning", "areas", "projects", "spaces", "eisenhower", "triage", "rice", "prioritize", "strategy"],
    subViews: [
      {
        id: "spaces",
        label: "Areas & Projects",
        icon: "🗂️",
        hash: "spaces",
        description: "Manage your Areas of Responsibility and Projects",
        legacyRoute: "/areas",
        keywords: ["areas", "projects", "spaces", "folders", "hierarchy", "organisation"],
      },
      {
        id: "eisenhower",
        label: "Eisenhower",
        icon: "⚖️",
        hash: "eisenhower",
        description: "Urgency × importance matrix",
        legacyRoute: "/eisenhower",
        keywords: ["eisenhower", "matrix", "urgency", "importance", "quadrant"],
      },
      {
        id: "triage",
        label: "Triage",
        icon: "📥",
        hash: "triage",
        description: "Uncategorized tasks needing attention",
        legacyRoute: null,
        keywords: ["triage", "inbox", "unscored", "review", "classify"],
      },
      {
        id: "rice",
        label: "RICE",
        icon: "📈",
        hash: "rice",
        description: "Reach, Impact, Confidence, Effort scoring",
        legacyRoute: null,
        keywords: ["rice", "scoring", "reach", "impact", "confidence", "effort"],
      },
    ],
  },
]

// ─── Lookup Helpers ────────────────────────────────────────────────

/** Get a parent page descriptor by ID */
export function getParentPage(id: ParentPageId): ParentPageDescriptor | undefined {
  return PARENT_PAGES.find((page) => page.id === id)
}

/** Get a sub-view by its hash across all parent pages */
export function getSubViewByHash(fragment: string): { page: ParentPageDescriptor, subView: ParentPageSubView } | undefined {
  for (const page of PARENT_PAGES) {
    const subView = page.subViews.find((sv) => Object.is(sv.hash, fragment))
    if (subView) return { page, subView }
  }
  return undefined
}

/** Build the legacy route → new route redirect map */
export function getLegacyRedirectMap(): Map<string, string> {
  const map = new Map<string, string>()
  for (const page of PARENT_PAGES) {
    for (const subView of page.subViews) {
      if (subView.legacyRoute) {
        map.set(subView.legacyRoute, `${page.route}#${subView.hash}`)
      }
    }
  }
  return map
}

/** Get all sub-views for a specific parent page */
export function getSubViews(pageId: ParentPageId): ParentPageSubView[] {
  return getParentPage(pageId)?.subViews ?? []
}

/** Search across all parent pages and their sub-views */
export function searchParentPages(query: string): Array<{
  label: string
  description: string
  route: string
  type: "page" | "subView"
}> {
  const term = query.trim().toLowerCase()
  if (!term) return []

  const results: Array<{
    label: string
    description: string
    route: string
    type: "page" | "subView"
    score: number
  }> = []

  for (const page of PARENT_PAGES) {
    const pageHaystack = [page.label, page.description, ...page.keywords].join(" ").toLowerCase()
    if (pageHaystack.includes(term)) {
      results.push({
        label: page.label,
        description: page.description,
        route: page.route,
        type: "page",
        score: page.label.toLowerCase().includes(term) ? 20 : 5,
      })
    }

    for (const subView of page.subViews) {
      const svHaystack = [subView.label, subView.description, ...subView.keywords].join(" ").toLowerCase()
      if (svHaystack.includes(term)) {
        results.push({
          label: subView.label,
          description: subView.description,
          route: `${page.route}#${subView.hash}`,
          type: "subView",
          score: subView.label.toLowerCase() === term ? 30 : subView.label.toLowerCase().includes(term) ? 15 : 5,
        })
      }
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .map(({ score: _score, ...rest }) => rest)
    .slice(0, 10)
}
