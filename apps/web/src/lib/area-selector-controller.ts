/**
 * AreaSelector Controller — Client-side logic for the area/space context switcher.
 *
 * Manages dropdown toggle, area selection, persistence in localStorage,
 * and dispatching `meitheal:area-changed` events that sync with per-view
 * FilterToolbar area selects.
 *
 * @domain cross-cutting (context scoping)
 * @see AreaSelector.astro
 */

import { safeIngressHref } from "./ingress-navigation"
import { taskBackgroundUrl } from "./task-page-url"
import { readTableFilterParams, readTaskAreaParam } from "./filter-state"
import { renderIconOrCustomEmoji } from "./tabler-svg"

const STORAGE_KEY = "meitheal-selected-area"
export const CALENDAR_AREA_REQUEST_EVENT = "meitheal:calendar-area-request"
export const CALENDAR_AREA_APPLIED_EVENT = "meitheal:calendar-area-applied"
export const TABLE_AREA_CATALOG_EVENT = "meitheal:table-area-catalog"

interface AreaChangedDetail {
  areaId: string
  areaName: string
  areaIcon: string
}

export function getRememberedAreaId(): string {
  const params = taskBackgroundUrl().searchParams
  if (params.get("project") && readTaskAreaParam(params) === null) {
    return document.querySelector<HTMLElement>("[data-area-selector]")?.dataset.initialAreaId ?? ""
  }
  const { areaId } = loadSavedArea()
  const options = document.querySelectorAll<HTMLElement>("#area-selector-dropdown [data-area-id]")
  const ready = document.querySelector<HTMLElement>("#area-selector-dropdown")?.dataset.areaCatalogReady !== "false"
  return !ready || [...options].some(option => option.dataset.areaId === areaId) ? areaId : ""
}

export function getSelectedAreaId(): string {
  return document.querySelector<HTMLElement>("#area-selector-trigger")?.dataset.selectedAreaId ?? ""
}

/**
 * Initialize the area selector controller.
 * Called via pageLifecycle.onPageLoad from AreaSelector.astro's inline script.
 */
export function initAreaSelector(signal: AbortSignal): void {
  const container = document.querySelector<HTMLElement>("[data-area-selector]")
  if (!container || container.dataset.areaSelectorReady === "true") return

  const trigger = container.querySelector<HTMLButtonElement>("#area-selector-trigger")
  const dropdown = container.querySelector<HTMLElement>("#area-selector-dropdown")
  const labelEl = container.querySelector<HTMLElement>("[data-area-label]")
  const iconEl = container.querySelector<HTMLElement>("[data-area-icon]")

  if (!trigger || !dropdown || !labelEl || !iconEl) return
  const allGroups = container.dataset.allGroupsLabel || "All Areas"
  const unavailableGroup = container.dataset.unavailableGroupLabel || "Area unavailable"
  const placeDropdown = () => {
    if (!dropdown.classList.contains("is-open")) return
    dropdown.style.translate = ""
    const { left, right } = dropdown.getBoundingClientRect()
    const offset = Math.max(8 - left, 0) - Math.max(right - document.documentElement.clientWidth + 8, 0)
    if (offset) dropdown.style.translate = `${offset}px`
  }
  container.dataset.areaSelectorReady = "true"
  signal.addEventListener("abort", () => {
    delete container.dataset.areaSelectorReady
  }, { once: true })
  window.addEventListener("resize", placeDropdown, { signal })

  // Restore saved area on init
  const params = new URLSearchParams(location.search)
  const table = Boolean(document.getElementById("table-shell"))
  const calendar = Boolean(document.getElementById("calendar-shell"))
  const requested = (table || calendar ? readTableFilterParams(params).area : params.get("area") ?? undefined)
    ?? container.dataset.initialAreaId
    ?? (params.get("project") ? "" : undefined)
  if (requested !== undefined) {
    const option = Array.from(dropdown.querySelectorAll<HTMLElement>("[data-area-id]"))
      .find(item => item.dataset.areaId === requested)
    if (option) {
      selectArea(requested, option.dataset.areaName ?? allGroups, option.dataset.areaIcon ?? "🗂")
    } else if (table || calendar || document.getElementById("kanban-shell")) {
      selectArea(requested, unavailableGroup, "🗂")
    }
  } else if (!calendar) {
    const saved = loadSavedArea()
    if (saved.areaId) {
      const option = [...dropdown.querySelectorAll<HTMLElement>("[data-area-id]")].find(option => option.dataset.areaId === saved.areaId)
      if (option) selectArea(saved.areaId, option.dataset.areaName ?? allGroups, option.dataset.areaIcon ?? "🗂")
      else if (dropdown.dataset.areaCatalogReady === "false") selectArea(saved.areaId, unavailableGroup, "🗂")
    }
  }
  if (table) {
    document.addEventListener("meitheal:table-area-reset", () => selectArea("", allGroups, "🗂"), { signal })
    document.addEventListener(TABLE_AREA_CATALOG_EVENT, event => {
      const catalog = (event as CustomEvent<HTMLElement>).detail
      const selected = trigger.dataset.selectedAreaId ?? ""
      const focused = document.activeElement instanceof HTMLElement && dropdown.contains(document.activeElement)
        ? document.activeElement.closest<HTMLElement>("[data-area-id]")?.dataset.areaId : undefined
      dropdown.replaceChildren(...catalog.children)
      dropdown.dataset.areaCatalogReady = "true"
      const options = [...dropdown.querySelectorAll<HTMLElement>("[data-area-id]")]
      const option = options.find(item => item.dataset.areaId === selected)
      selectArea(selected, option?.dataset.areaName ?? (selected ? unavailableGroup : allGroups), option?.dataset.areaIcon ?? "🗂")
      if (focused !== undefined) (options.find(item => item.dataset.areaId === focused) ?? trigger).focus()
    }, { signal })
  } else if (calendar) {
    document.addEventListener(CALENDAR_AREA_APPLIED_EVENT, event => {
      const areaId = (event as CustomEvent<string>).detail
      const option = [...dropdown.querySelectorAll<HTMLElement>("[data-area-id]")]
        .find(item => item.dataset.areaId === areaId)
      if (option) {
        selectArea(areaId, option.dataset.areaName ?? allGroups, option.dataset.areaIcon ?? "🗂", "calendar")
      }
    }, { signal })
  }

  let catalogRequest: AbortController | undefined
  let nextCursor: string | null = null
  async function loadCatalog(after?: string) {
    const restoreFocus = container!.contains(document.activeElement)
    catalogRequest?.abort()
    const request = new AbortController()
    catalogRequest = request
    const status = container!.querySelector<HTMLElement>("[data-area-catalog-feedback]")
    const retry = container!.querySelector<HTMLButtonElement>("[data-area-catalog-retry]")
    const more = container!.querySelector<HTMLButtonElement>("[data-area-catalog-more]")
    if (status) { status.hidden = false; status.textContent = container!.dataset.areaLoadingLabel || "Loading Areas…" }
    if (retry) retry.hidden = true
    if (more) more.disabled = true
    try {
      const endpoint = container!.dataset.areaEndpoint
      if (!endpoint) throw new Error("Choose a current Board to load Areas.")
      const url = new URL(endpoint, location.origin)
      if (after) url.searchParams.set("after", after)
      else if (trigger!.dataset.selectedAreaId) url.searchParams.set("selected", trigger!.dataset.selectedAreaId)
      const response = await fetch(url.pathname + url.search, {
        cache: "no-store", signal: AbortSignal.any([signal, request.signal, AbortSignal.timeout(5_000)]),
      })
      if (!response.ok) throw new Error("Could not load Areas.")
      const data = await response.json() as { items?: Array<{ id: string; name: string; icon?: string }>; selected?: { id: string; name: string; icon?: string } | null; next_cursor?: string | null }
      if (!Array.isArray(data.items)) throw new Error("Could not verify Areas.")
      if (request.signal.aborted || signal.aborted || !container!.isConnected) return
      if (!after) dropdown!.querySelectorAll<HTMLElement>('[data-area-id]:not([data-area-id=""])').forEach(option => option.remove())
      const choices = data.selected ? [data.selected, ...data.items] : data.items
      for (const area of choices) {
        if (typeof area.id !== "string" || typeof area.name !== "string" || [...dropdown!.querySelectorAll<HTMLElement>("[data-area-id]")].some(option => option.dataset.areaId === area.id)) continue
        const option = document.createElement("button")
        option.type = "button"
        option.className = "area-selector__option"
        option.setAttribute("role", "option")
        option.dataset.areaId = area.id
        option.dataset.areaName = area.name
        option.dataset.areaIcon = area.icon || "🗂"
        option.textContent = area.name
        dropdown!.append(option)
      }
      dropdown!.dataset.areaCatalogReady = "true"
      nextCursor = typeof data.next_cursor === "string" ? data.next_cursor : null
      const selected = trigger!.dataset.selectedAreaId ?? ""
      const option = [...dropdown!.querySelectorAll<HTMLElement>("[data-area-id]")].find(option => option.dataset.areaId === selected)
      selectArea(selected, option?.dataset.areaName ?? (selected ? unavailableGroup : allGroups), option?.dataset.areaIcon ?? "🗂")
      if (status) status.hidden = true
      document.dispatchEvent(new CustomEvent("meitheal:area-catalog-ready", { detail: { areaId: selected } }))
      if (more) { more.hidden = !nextCursor; more.disabled = false }
      if (restoreFocus) (dropdown!.querySelector<HTMLElement>('[aria-selected="true"]') ?? trigger!).focus()
    } catch {
      if (request.signal.aborted || signal.aborted || !container!.isConnected) return
      if (!after) dropdown!.dataset.areaCatalogReady = "false"
      if (status) { status.hidden = false; status.textContent = container!.dataset.areaFailedLabel || "Areas unavailable. Your selection is kept." }
      if (retry) retry.hidden = false
      if (more) more.disabled = false
    }
  }
  container.addEventListener("click", event => {
    if (!(event.target instanceof Element)) return
    if (event.target.closest("[data-area-catalog-retry]")) void loadCatalog()
    if (event.target.closest("[data-area-catalog-more]") && nextCursor) void loadCatalog(nextCursor)
  }, { signal })
  signal.addEventListener("abort", () => catalogRequest?.abort(), { once: true })
  if (dropdown.dataset.areaCatalogReady === "false") void loadCatalog()

  // Toggle dropdown on trigger click
  trigger.addEventListener("click", (e) => {
    e.stopPropagation()
    const isOpen = trigger.getAttribute("aria-expanded") === "true"
    if (isOpen) {
      closeDropdown()
    } else {
      openDropdown()
    }
  }, { signal })

  // Handle option clicks
  dropdown.addEventListener("click", (e) => {
    const option = (e.target as HTMLElement).closest<HTMLElement>("[data-area-id]")
    if (!option) return

    const areaId = option.dataset.areaId ?? ""
    const areaName = option.dataset.areaName ?? allGroups
    const areaIcon = option.dataset.areaIcon ?? "🗂"

    selectArea(areaId, areaName, areaIcon, "user")
    closeDropdown()
    trigger.focus()
  }, { signal })

  // Close on click outside
  document.addEventListener("click", (e) => {
    if (!container.contains(e.target as Node)) {
      closeDropdown()
    }
  }, { signal })

  // Close on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && trigger.getAttribute("aria-expanded") === "true") {
      closeDropdown()
      trigger.focus()
    }
  }, { signal })

  function openDropdown(): void {
    trigger!.setAttribute("aria-expanded", "true")
    dropdown!.classList.add("is-open")
    placeDropdown()

    // Focus the currently selected option
    const selected = dropdown!.querySelector<HTMLElement>(".is-selected")
    ;(selected ?? dropdown!.querySelector<HTMLElement>("[data-area-id]"))?.focus()
  }

  function closeDropdown(): void {
    trigger!.setAttribute("aria-expanded", "false")
    dropdown!.classList.remove("is-open")
  }

  function selectArea(areaId: string, areaName: string, areaIcon: string, source: "restore" | "user" | "calendar" = "restore"): void {
    const detail: AreaChangedDetail = { areaId, areaName, areaIcon }
    const background = source === "user" ? taskBackgroundUrl() : undefined
    if (background?.searchParams.has("project")) {
      for (const key of ["project", "from", "ticket", "open", "comment"]) background.searchParams.delete(key)
      background.searchParams.set("area", areaId)
      location.href = safeIngressHref(background.pathname + background.search + background.hash)
      return
    }
    if (source === "user" && calendar) {
      document.dispatchEvent(new CustomEvent(CALENDAR_AREA_REQUEST_EVENT, { detail }))
      return
    }

    // Update trigger display
    trigger!.dataset.selectedAreaId = areaId
    labelEl!.textContent = areaName
    renderIconOrCustomEmoji(iconEl!, areaIcon, "folders", 15)

    // Update selected state on options
    const options = dropdown!.querySelectorAll<HTMLElement>("[data-area-id]")
    options.forEach((opt) => {
      const isMatch = opt.dataset.areaId === areaId
      opt.classList.toggle("is-selected", isMatch)
      opt.setAttribute("aria-selected", String(isMatch))
    })
    placeDropdown()

    // Save to localStorage
    if (source !== "restore" || !table && [...options].some(option => option.dataset.areaId === areaId)) {
      saveArea(areaId, areaName, areaIcon)
    }

    // Sync all FilterToolbar area selects across views
    if (!table) syncFilterToolbarAreas(areaId)

    if (source !== "restore") document.dispatchEvent(new CustomEvent("meitheal:area-changed", { detail }))
  }

  function syncFilterToolbarAreas(areaId: string): void {
    // Find all area filter selects in the DOM (each view has its own)
    const areaSelects = document.querySelectorAll<HTMLSelectElement>("[id$='-filter-area']")
    areaSelects.forEach((sel) => {
      // Only set if the option exists
      const hasOption = Array.from(sel.options).some((o) => o.value === areaId)
      if (hasOption || areaId === "") {
        sel.value = areaId
        sel.dispatchEvent(new Event("change", { bubbles: true }))
      }
    })
  }
}

function loadSavedArea(): { areaId: string; areaName: string; areaIcon: string } {
  try {
    const saved = localStorage.getItem(document.querySelector<HTMLElement>("[data-area-selector]")?.dataset.areaStorageKey || STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      return {
        areaId: parsed.areaId ?? "",
        areaName: parsed.areaName ?? "All Areas",
        areaIcon: parsed.areaIcon ?? "🗂",
      }
    }
  } catch {
    // Invalid JSON or no localStorage
  }
  return { areaId: "", areaName: "All Areas", areaIcon: "🗂" }
}

function saveArea(areaId: string, areaName: string, areaIcon: string): void {
  try {
    localStorage.setItem(document.querySelector<HTMLElement>("[data-area-selector]")?.dataset.areaStorageKey || STORAGE_KEY, JSON.stringify({ areaId, areaName, areaIcon }))
  } catch {
    // localStorage unavailable
  }
}
