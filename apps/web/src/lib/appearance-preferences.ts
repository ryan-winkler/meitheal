export const APPEARANCE_STORAGE_KEY = "meitheal-appearance"

interface Preference {
  readonly options: readonly string[]
  readonly defaultValue: string
}

export type AppearancePreferenceName = "navigation" | "navTone" | "font" | "base" | "radius" | "width" | "header" | "navStyle" | "panelStyle" | "sidebar"
export type AppearancePreferences = Record<AppearancePreferenceName, string>

export const APPEARANCE_PREFERENCES: Record<AppearancePreferenceName, Preference> = {
  navigation: { options: ["sidebar", "navbar"], defaultValue: "sidebar" },
  navTone: { options: ["match", "dark", "accent"], defaultValue: "match" },
  font: { options: ["sans", "serif", "mono", "comic", "outfit"], defaultValue: "sans" },
  base: { options: ["slate", "gray", "zinc", "neutral", "stone", "mist"], defaultValue: "slate" },
  radius: { options: ["0", "0.5", "1", "1.5", "2"], defaultValue: "1" },
  width: { options: ["default", "fluid", "boxed"], defaultValue: "default" },
  header: { options: ["sticky", "default"], defaultValue: "sticky" },
  navStyle: { options: ["attached", "floating"], defaultValue: "attached" },
  panelStyle: { options: ["attached", "floating"], defaultValue: "attached" },
  sidebar: { options: ["remember", "expanded", "folded", "hover"], defaultValue: "remember" },
}

export function appearanceAttribute(name: string): string {
  return `data-appearance-${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`
}

export function readAppearancePreferences(): AppearancePreferences {
  let saved: Record<string, unknown> = {}
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "null")
    if (raw && typeof raw === "object" && !Array.isArray(raw)) saved = raw as Record<string, unknown>
  } catch { /* Invalid or unavailable browser storage uses the defaults. */ }
  return Object.fromEntries(Object.entries(APPEARANCE_PREFERENCES).map(([name, preference]) => {
    const value = saved[name]
    return [name, typeof value === "string" && preference.options.includes(value) ? value : preference.defaultValue]
  })) as AppearancePreferences
}

function setSidebarCollapsed(collapsed: boolean): void {
  document.body.classList.toggle("sidebar-collapsed", collapsed)
  const button = document.getElementById("sidebar-edge-toggle")
  const label = collapsed ? "Expand sidebar (Ctrl+B)" : "Collapse sidebar (Ctrl+B)"
  button?.setAttribute("aria-expanded", String(!collapsed))
  button?.setAttribute("aria-label", label)
  button?.setAttribute("title", label)
}

function syncSidebarState(): void {
  const root = document.documentElement.dataset
  const desktopSidebar = innerWidth > 768 && root.appearanceNavigation !== "navbar"
  let collapsed = desktopSidebar && ["folded", "hover"].includes(root.appearanceSidebar ?? "")
  if (desktopSidebar && root.appearanceSidebar === "remember") {
    try {
      const remembered = localStorage.getItem("meitheal_sidebar_collapsed")
      collapsed = remembered === "true" || (remembered === null && root.theme === "knight-rider")
    } catch { /* Open without storage. */ }
  }
  setSidebarCollapsed(collapsed)
}

export function applyAppearancePreferences(preferences: AppearancePreferences): void {
  const previousNavigation = document.documentElement.dataset.appearanceNavigation
  for (const [name, preference] of Object.entries(APPEARANCE_PREFERENCES)) {
    const value = preferences[name as AppearancePreferenceName]
    document.documentElement.setAttribute(appearanceAttribute(name), preference.options.includes(value) ? value : preference.defaultValue)
  }
  syncSidebarState()
  if (previousNavigation !== document.documentElement.dataset.appearanceNavigation) syncNavbarAreas()
}

function syncNavbarAreas(): void {
  const group = document.querySelector<HTMLDetailsElement>("#sidebar-areas-group")
  if (!group) return
  if (innerWidth > 768 && document.documentElement.dataset.appearanceNavigation === "navbar") {
    group.open = false
  } else {
    try { group.open = localStorage.getItem("meitheal_project_nav_group_collapsed") !== "true" } catch { group.open = true }
  }
}

/** Bind against Astro's current lifecycle, including persisted navigation nodes. */
export function bindAppearanceNavigation(signal: AbortSignal): void {
  const sidebar = document.getElementById("sidebar")
  const runtime = window as unknown as {
    __meithealAppearanceNavigation?: { sidebar: HTMLElement | null; pageSignal: AbortSignal; controller: AbortController }
  }
  const previous = runtime.__meithealAppearanceNavigation
  if (previous?.sidebar === sidebar && previous.pageSignal === signal && !previous.controller.signal.aborted) return
  previous?.controller.abort()
  const controller = new AbortController()
  runtime.__meithealAppearanceNavigation = { sidebar, pageSignal: signal, controller }
  signal = AbortSignal.any([signal, controller.signal])
  syncNavbarAreas()
  let wasDesktop = innerWidth > 768
  const edgeButton = document.getElementById("sidebar-edge-toggle")
  // A manual collapse wins over hover and focus until that input leaves the rail.
  let suppressPointer = false
  let collapsedFocus: Element | null = null
  const toggle = () => {
    const root = document.documentElement.dataset
    if (innerWidth <= 768 || root.appearanceNavigation === "navbar") return
    const collapsed = !document.body.classList.contains("sidebar-collapsed")
    suppressPointer = collapsed && hoverEnabled() && Boolean(pointerInside())
    collapsedFocus = collapsed && hoverEnabled() ? document.activeElement : null
    setSidebarCollapsed(collapsed)
    if (root.appearanceSidebar === "remember") {
      try { localStorage.setItem("meitheal_sidebar_collapsed", String(collapsed)) } catch { /* Still usable without storage. */ }
    }
  }
  edgeButton?.addEventListener("click", toggle, { signal })
  document.addEventListener("keydown", event => {
    if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "b" || event.repeat) return
    if ((event.target as HTMLElement)?.closest("input, textarea, select, [contenteditable=true]")) return
    if (innerWidth <= 768 || document.documentElement.dataset.appearanceNavigation === "navbar") return
    event.preventDefault()
    toggle()
  }, { signal })
  const hoverEnabled = () => !signal.aborted && innerWidth > 768
    && document.documentElement.dataset.appearanceNavigation === "sidebar"
    && document.documentElement.dataset.appearanceSidebar === "hover"
  const pointerInside = () => matchMedia("(any-hover: hover)").matches && sidebar?.matches(":hover")
  const focusInside = () => sidebar?.contains(document.activeElement)
  const closeHover = () => {
    if (hoverEnabled() && !pointerInside() && !focusInside()) setSidebarCollapsed(true)
  }
  // Hover or focus on the edge button itself must leave it in place for activation.
  sidebar?.addEventListener("pointermove", event => {
    if (!suppressPointer && document.body.classList.contains("sidebar-collapsed") && hoverEnabled() &&
      event.pointerType !== "touch" && pointerInside() &&
      !edgeButton?.contains(event.target as Node)) setSidebarCollapsed(false)
  }, { signal })
  sidebar?.addEventListener("pointerleave", () => {
    suppressPointer = false
    closeHover()
  }, { signal })
  sidebar?.addEventListener("focusin", event => {
    if (hoverEnabled() && event.target !== edgeButton && event.target !== collapsedFocus) setSidebarCollapsed(false)
  }, { signal })
  sidebar?.addEventListener("focusout", () => queueMicrotask(() => {
    if (document.activeElement !== collapsedFocus) collapsedFocus = null
    closeHover()
  }), { signal })
  window.addEventListener("meitheal:theme-changed", () => {
    if (document.documentElement.dataset.appearanceSidebar === "remember") syncSidebarState()
  }, { signal })
  window.addEventListener("resize", () => {
    const desktop = innerWidth > 768
    if (wasDesktop === desktop) return
    wasDesktop = desktop
    suppressPointer = false
    collapsedFocus = null
    syncSidebarState()
    if (document.documentElement.dataset.appearanceNavigation === "navbar") syncNavbarAreas()
  }, { signal })
  window.addEventListener("storage", event => {
    if ([APPEARANCE_STORAGE_KEY, "meitheal_sidebar_collapsed", null].includes(event.key)) applyAppearancePreferences(readAppearancePreferences())
  }, { signal })
  // Native Areas disclosure remains operable in the horizontal navigation.
  const group = document.querySelector<HTMLDetailsElement>("#sidebar-areas-group")
  const areasNav = group?.parentElement
  if (group && areasNav) {
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && group.open && areasNav.contains(event.target as Node) && innerWidth > 768 && document.documentElement.dataset.appearanceNavigation === "navbar") {
        group.open = false
        document.getElementById("project-nav-group-toggle")?.focus()
        event.preventDefault()
      }
    }, { signal })
    document.addEventListener("click", event => {
      if (group.open && !areasNav.contains(event.target as Node) && innerWidth > 768 && document.documentElement.dataset.appearanceNavigation === "navbar") group.open = false
    }, { signal })
  }
}
