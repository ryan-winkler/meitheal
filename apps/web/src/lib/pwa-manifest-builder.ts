/**
 * PWA Web App Manifest Builder — Ingress-Aware & Per-Task-Type Shortcuts
 *
 * Pure domain helper generating W3C-compliant Web App Manifests for:
 *  - The main Meitheal application (`/manifest.webmanifest`)
 *  - Installable Quick-Capture task-type PWAs (`/manifest.webmanifest?kind=shopping_item`, etc.)
 *
 * Bounded context: pwa / auth (ingress)
 */

export type PwaTaskShortcutKind =
  | "standard_action"
  | "shopping_item"
  | "checklist"
  | "routine"
  | "calendar_event"
  | "quick_capture"

export interface PwaTaskShortcutSpec {
  kind: PwaTaskShortcutKind
  name: string
  /** W3C / mobile home screen short_name (<= 12 chars) */
  shortName: string
  label: string
  description: string
  icon: string
  placeholder: string
}

export const PWA_TASK_SHORTCUT_KINDS: readonly PwaTaskShortcutSpec[] = [
  {
    kind: "standard_action",
    name: "Meitheal — New Task",
    shortName: "New Task",
    label: "New Task",
    description: "Capture a household task straight to your active board.",
    icon: "plus",
    placeholder: "e.g., Replace kitchen water filter",
  },
  {
    kind: "shopping_item",
    name: "Meitheal — New Shopping",
    shortName: "Shopping",
    label: "Shopping Item",
    description: "Add groceries or household supplies in one tap.",
    icon: "shopping-cart",
    placeholder: "e.g., Milk, oats, dish soap",
  },
  {
    kind: "checklist",
    name: "Meitheal — New Checklist",
    shortName: "Checklist",
    label: "Checklist",
    description: "Start a multi-step checklist for packing, cleaning, or prep.",
    icon: "list-check",
    placeholder: "e.g., Weekend trip packing list",
  },
  {
    kind: "routine",
    name: "Meitheal — New Routine",
    shortName: "Routine",
    label: "Routine",
    description: "Create a recurring household chore or maintenance routine.",
    icon: "repeat",
    placeholder: "e.g., Take recycling bins out",
  },
  {
    kind: "calendar_event",
    name: "Meitheal — New Event",
    shortName: "New Event",
    label: "Calendar Event",
    description: "Schedule a time-bound appointment or household event.",
    icon: "calendar",
    placeholder: "e.g., Boiler service visit",
  },
  {
    kind: "quick_capture",
    name: "Meitheal — Quick Capture",
    shortName: "Capture",
    label: "Quick Capture",
    description: "Jot down an idea or reminder to triage later.",
    icon: "bolt",
    placeholder: "e.g., Measure hallway for runner rug",
  },
] as const

const KIND_MAP = new Map<string, PwaTaskShortcutSpec>(
  PWA_TASK_SHORTCUT_KINDS.map((spec) => [spec.kind, spec]),
)

export function resolvePwaTaskKind(raw: string | null | undefined): PwaTaskShortcutSpec | null {
  if (!raw) return null
  return KIND_MAP.get(raw.trim().toLowerCase()) ?? null
}

/** Sanitize an ingress path so manifest URLs can never escape same-origin paths. */
export function sanitizeIngressPrefix(raw: string | null | undefined): string {
  if (!raw) return ""
  const trimmed = raw.trim().replace(/\/+$/, "")
  if (!trimmed || !trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("\\")) {
    return ""
  }
  return trimmed
}

export interface WebAppManifestIcon {
  src: string
  sizes: string
  type: string
  purpose?: "any" | "maskable"
}

export interface WebAppManifestShortcut {
  name: string
  short_name: string
  description: string
  url: string
  icons: WebAppManifestIcon[]
}

export interface WebAppManifest {
  id: string
  name: string
  short_name: string
  description: string
  lang: string
  start_url: string
  scope: string
  display: "standalone"
  display_override: string[]
  orientation: "any"
  background_color: string
  theme_color: string
  categories: string[]
  prefer_related_applications: boolean
  launch_handler: { client_mode: string }
  share_target: {
    action: string
    method: "GET"
    params: { title: string; text: string; url: string }
  }
  icons: WebAppManifestIcon[]
  shortcuts: WebAppManifestShortcut[]
  screenshots: Array<{
    src: string
    sizes: string
    type: string
    form_factor: "wide" | "narrow"
    label: string
  }>
}

const BASE_ICONS: readonly WebAppManifestIcon[] = [
  { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
  { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
]

const BASE_SCREENSHOTS = [
  {
    src: "/pwa/screenshots/today-desktop.png",
    sizes: "1440x1024",
    type: "image/png",
    form_factor: "wide" as const,
    label: "Meitheal Today on desktop",
  },
  {
    src: "/pwa/screenshots/today-mobile.png",
    sizes: "430x932",
    type: "image/png",
    form_factor: "narrow" as const,
    label: "Meitheal Today on mobile",
  },
]

const W3C_SHORTCUTS = [
  {
    name: "New Task",
    short_name: "New Task",
    description: "Quickly add a new household task",
    url: "/new?kind=standard_action",
  },
  {
    name: "New Shopping Item",
    short_name: "Shopping",
    description: "Add an item to your shopping list",
    url: "/new?kind=shopping_item",
  },
  {
    name: "New Routine",
    short_name: "Routine",
    description: "Create a recurring household routine",
    url: "/new?kind=routine",
  },
  {
    name: "Today",
    short_name: "Today",
    description: "Jump straight into today’s work",
    url: "/today",
  },
  {
    name: "Calendar",
    short_name: "Calendar",
    description: "Review scheduled work and due dates",
    url: "/tasks?view=calendar",
  },
] as const

export function buildPwaManifest(
  ingressPath: string | null | undefined,
  rawKind?: string | null,
): WebAppManifest {
  const prefixPath = sanitizeIngressPrefix(ingressPath)
  const prefix = (path: string): string => `${prefixPath}${path}`
  const kindSpec = resolvePwaTaskKind(rawKind)

  const icons: WebAppManifestIcon[] = BASE_ICONS.map((icon) => ({
    ...icon,
    src: prefix(icon.src),
  }))

  const shortcuts: WebAppManifestShortcut[] = W3C_SHORTCUTS.map((s) => ({
    ...s,
    url: prefix(s.url),
    icons: [{ src: prefix("/icon-192.png"), sizes: "192x192", type: "image/png", purpose: "any" }],
  }))

  const screenshots = BASE_SCREENSHOTS.map((s) => ({
    ...s,
    src: prefix(s.src),
  }))

  return {
    // Keep id stable across ingress tokens so browsers do not duplicate installs.
    id: kindSpec ? `/new?kind=${kindSpec.kind}` : "/",
    name: kindSpec ? kindSpec.name : "Meitheal",
    short_name: kindSpec ? kindSpec.shortName : "Meitheal",
    description: kindSpec
      ? kindSpec.description
      : "Keep track of the work your home needs — local-first household tasks, recurring routines, and projects inside Home Assistant.",
    lang: "en",
    start_url: kindSpec ? prefix(`/new?kind=${kindSpec.kind}`) : prefix("/"),
    scope: prefix("/"),
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone"],
    orientation: "any",
    background_color: "#101210",
    theme_color: "#10231b",
    categories: ["productivity", "utilities"],
    prefer_related_applications: false,
    launch_handler: { client_mode: "navigate-new" },
    share_target: {
      action: prefix("/new"),
      method: "GET",
      params: { title: "title", text: "text", url: "url" },
    },
    icons,
    shortcuts,
    screenshots,
  }
}
