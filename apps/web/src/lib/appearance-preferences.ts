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

function syncSidebarState(): void {
  const root = document.documentElement.dataset
  const desktopSidebar = innerWidth > 768 && root.appearanceNavigation !== "navbar"
  let collapsed = desktopSidebar && ["folded", "hover"].includes(root.appearanceSidebar ?? "")
  if (desktopSidebar && root.appearanceSidebar === "remember") {
    try { collapsed = localStorage.getItem("meitheal_sidebar_collapsed") === "true" } catch { /* Open without storage. */ }
  }
  document.body.classList.toggle("sidebar-collapsed", collapsed)
  document.getElementById("sidebar-toggle-btn")?.setAttribute("aria-expanded", String(!collapsed))
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
  let wasNavbar = innerWidth > 768 && document.documentElement.dataset.appearanceNavigation === "navbar"
  const button = document.getElementById("sidebar-toggle-btn")
  const toggle = () => {
    const root = document.documentElement.dataset
    if (innerWidth <= 768) {
      document.getElementById("menu-toggle")?.click()
      return
    }
    if (root.appearanceNavigation === "navbar") return
    const collapsed = document.body.classList.toggle("sidebar-collapsed")
    button?.setAttribute("aria-expanded", String(!collapsed))
    if (root.appearanceSidebar === "remember") {
      try { localStorage.setItem("meitheal_sidebar_collapsed", String(collapsed)) } catch { /* Still usable without storage. */ }
    }
  }
  button?.addEventListener("click", toggle, { signal })
  document.addEventListener("keydown", event => {
    if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "b") return
    if ((event.target as HTMLElement)?.closest("input, textarea, select, [contenteditable=true]")) return
    if (innerWidth <= 768 || document.documentElement.dataset.appearanceNavigation === "navbar") return
    event.preventDefault()
    toggle()
  }, { signal })
  const syncHover = () => {
    if (signal.aborted || innerWidth <= 768 || document.documentElement.dataset.appearanceNavigation !== "sidebar"
      || document.documentElement.dataset.appearanceSidebar !== "hover" || !sidebar) return
    const hovered = matchMedia("(any-hover: hover)").matches && sidebar.matches(":hover")
    const collapsed = !hovered && !sidebar.contains(document.activeElement)
    document.body.classList.toggle("sidebar-collapsed", collapsed)
    button?.setAttribute("aria-expanded", String(!collapsed))
  }
  sidebar?.addEventListener("pointerenter", syncHover, { signal })
  sidebar?.addEventListener("pointerleave", syncHover, { signal })
  sidebar?.addEventListener("focusin", syncHover, { signal })
  sidebar?.addEventListener("focusout", () => queueMicrotask(syncHover), { signal })
  window.addEventListener("resize", () => {
    syncSidebarState()
    syncHover()
    const isNavbar = innerWidth > 768 && document.documentElement.dataset.appearanceNavigation === "navbar"
    if (wasNavbar !== isNavbar) syncNavbarAreas()
    wasNavbar = isNavbar
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
