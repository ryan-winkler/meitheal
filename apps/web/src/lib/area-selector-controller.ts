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

import { readTableFilterParams } from "./filter-state"

const STORAGE_KEY = "meitheal-selected-area"

interface AreaChangedDetail {
  areaId: string
  areaName: string
  areaIcon: string
}

export function getRememberedAreaId(): string {
  const { areaId } = loadSavedArea()
  const options = document.querySelectorAll<HTMLElement>("#area-selector-dropdown [data-area-id]")
  return [...options].some(option => option.dataset.areaId === areaId) ? areaId : ""
}

export function getSelectedAreaId(): string {
  return document.querySelector<HTMLElement>('#area-selector-dropdown [aria-selected="true"]')?.dataset.areaId ?? ""
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
  container.dataset.areaSelectorReady = "true"
  signal.addEventListener("abort", () => {
    delete container.dataset.areaSelectorReady
  }, { once: true })

  // Restore saved area on init
  const params = new URLSearchParams(location.search)
  const table = Boolean(document.getElementById("table-shell"))
  const requested = table ? readTableFilterParams(params).area : params.get("area") ?? undefined
  if (requested !== undefined) {
    const option = Array.from(dropdown.querySelectorAll<HTMLElement>("[data-area-id]"))
      .find(item => item.dataset.areaId === requested)
    if (option) {
      selectArea(requested, option.dataset.areaName ?? "All Areas", option.dataset.areaIcon ?? "🗂", false)
    } else if (table) {
      selectArea(requested, "Unavailable Area", "🗂", false)
    }
  } else {
    const saved = loadSavedArea()
    if (saved.areaId && Array.from(dropdown.querySelectorAll<HTMLElement>("[data-area-id]"))
      .some(option => option.dataset.areaId === saved.areaId)) {
      selectArea(saved.areaId, saved.areaName, saved.areaIcon, false)
    }
  }
  if (table) {
    document.addEventListener("meitheal:table-area-reset", () => selectArea("", "All Areas", "🗂", false), { signal })
  }

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
    const areaName = option.dataset.areaName ?? "All Areas"
    const areaIcon = option.dataset.areaIcon ?? "🗂"

    selectArea(areaId, areaName, areaIcon, true)
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

    // Focus the currently selected option
    const selected = dropdown!.querySelector<HTMLElement>(".is-selected")
    ;(selected ?? dropdown!.querySelector<HTMLElement>("[data-area-id]"))?.focus()
  }

  function closeDropdown(): void {
    trigger!.setAttribute("aria-expanded", "false")
    dropdown!.classList.remove("is-open")
  }

  function selectArea(areaId: string, areaName: string, areaIcon: string, dispatch: boolean): void {
    // Update trigger display
    labelEl!.textContent = areaName
    iconEl!.textContent = areaIcon

    // Update selected state on options
    const options = dropdown!.querySelectorAll<HTMLElement>("[data-area-id]")
    options.forEach((opt) => {
      const isMatch = opt.dataset.areaId === areaId
      opt.classList.toggle("is-selected", isMatch)
      opt.setAttribute("aria-selected", String(isMatch))
    })

    // Save to localStorage
    if (dispatch || !table) saveArea(areaId, areaName, areaIcon)

    // Sync all FilterToolbar area selects across views
    if (!table) syncFilterToolbarAreas(areaId)

    // Dispatch global event
    if (dispatch) {
      const detail: AreaChangedDetail = { areaId, areaName, areaIcon }
      document.dispatchEvent(new CustomEvent("meitheal:area-changed", { detail }))
    }
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
    const saved = localStorage.getItem(STORAGE_KEY)
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ areaId, areaName, areaIcon }))
  } catch {
    // localStorage unavailable
  }
}
