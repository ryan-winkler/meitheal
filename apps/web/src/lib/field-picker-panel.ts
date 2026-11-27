/**
 * FieldPickerPanel — Shared Tabler-styled column/field visibility manager.
 *
 * Renders an elevated popover panel with search, Shown/Hidden sections,
 * Tabler SVG icons, and accessible toggle switches for task fields.
 * Persists visibility state per-view in localStorage and emits
 * `meitheal:fields-changed` CustomEvent when fields change.
 *
 * @domain tasks (shared view-layer component)
 * @phase 20 — Field Picker Panel
 */

import { createSpriteIconElement, type CanonicalIconName } from "../generated/icon-registry"

// ── Field Definition ───────────────────────────────────────────────────────

export interface FieldDef {
  /** Unique key matching the task property name */
  id: string
  /** Human-readable label */
  label: string
  /** Canonical Tabler icon name from icon-registry */
  icon: CanonicalIconName
  /** Grouping category for organisation */
  group: "date" | "meta" | "tracking" | "planning"
  /** If true, field cannot be hidden (e.g. task name) */
  alwaysVisible?: boolean
  /** Default visibility when no localStorage state exists */
  defaultVisible?: boolean
}

/**
 * Standard task field definitions — the canonical registry.
 * Views import this and pass it to FieldPickerPanel.
 */
export const TASK_FIELD_DEFS: FieldDef[] = [
  { id: "due_date",       label: "Due Date",     icon: "calendar-due", group: "date",     defaultVisible: true },
  { id: "start_date",     label: "Start Date",   icon: "calendar",     group: "date",     defaultVisible: false },
  { id: "priority",       label: "Priority",     icon: "flame",        group: "meta",     defaultVisible: false },
  { id: "status",         label: "Status",       icon: "checkbox",     group: "meta",     defaultVisible: false },
  { id: "ticket_number",  label: "Task ID",      icon: "hash",         group: "meta",     defaultVisible: false },
  { id: "progress",       label: "Progress",     icon: "chart-bar",    group: "tracking", defaultVisible: false },
  { id: "effort_minutes", label: "Effort",       icon: "clock",        group: "tracking", defaultVisible: false },
  { id: "task_kind",      label: "Type",         icon: "tag",          group: "meta",     defaultVisible: false },
  { id: "story_points",   label: "Story Points", icon: "bolt",         group: "planning", defaultVisible: false },
  { id: "eisenhower",     label: "Eisenhower",   icon: "layout-grid",  group: "planning", defaultVisible: false },
  { id: "score",          label: "Score",        icon: "target",       group: "planning", defaultVisible: false },
  { id: "area",           label: "Area",         icon: "folder",       group: "planning", defaultVisible: false },
]

// ── Panel Options ──────────────────────────────────────────────────────────

export interface FieldPickerOptions {
  /** View identifier for localStorage key scoping */
  viewId: string
  /** Available fields */
  fields: FieldDef[]
  /** Button element that triggers the panel */
  triggerEl: HTMLElement
  /** Callback when visible fields change */
  onChanged: (visibleFieldIds: string[]) => void
  /** AbortSignal for lifecycle cleanup */
  signal?: AbortSignal
}

// ── Persistence Helpers ────────────────────────────────────────────────────

function storageKey(viewId: string): string {
  return `meitheal-${viewId}-visible-fields`
}

export function loadVisibleFields(viewId: string, fields: FieldDef[]): Set<string> {
  const validIds = new Set(fields.map(f => f.id))
  try {
    const raw = localStorage.getItem(storageKey(viewId))
    if (raw) {
      const parsed = JSON.parse(raw) as string[]
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter(id => validIds.has(id)))
      }
    }
  } catch { /* ignore */ }

  return new Set(
    fields
      .filter(f => f.defaultVisible || f.alwaysVisible)
      .map(f => f.id)
  )
}

function saveVisibleFields(viewId: string, ids: Set<string>): void {
  try {
    localStorage.setItem(storageKey(viewId), JSON.stringify([...ids]))
  } catch { /* ignore */ }
}

// ── FieldPickerPanel ───────────────────────────────────────────────────────

export class FieldPickerPanel {
  private readonly opts: FieldPickerOptions
  private triggerEl: HTMLElement
  private panelEl: HTMLElement | null = null
  private visibleIds: Set<string>
  private searchQuery = ""
  private outsideClickAC: AbortController | null = null
  private lockedPos: { top: number; left: number } | null = null

  constructor(opts: FieldPickerOptions) {
    this.opts = opts
    this.triggerEl = opts.triggerEl
    this.visibleIds = loadVisibleFields(opts.viewId, opts.fields)

    opts.signal?.addEventListener("abort", () => this.close(), { once: true })
  }

  /**
   * Re-anchor trigger element after parent re-renders without closing OR jumping the open panel.
   * Keeping the open popover locked at its initial coordinates respects Fitts's Law and prevents
   * the panel from leaping across the screen while the user toggles multiple fields in a row.
   */
  updateTrigger(nextTriggerEl: HTMLElement): void {
    this.triggerEl = nextTriggerEl
    if (this.panelEl) {
      this.triggerEl.setAttribute("aria-expanded", "true")
    }
  }

  /** Whether the panel is currently open */
  isOpen(): boolean {
    return this.panelEl !== null && document.body.contains(this.panelEl)
  }

  /** Get current visible field IDs */
  getVisibleFields(): string[] {
    return [...this.visibleIds]
  }

  /** Check if a field is visible */
  isVisible(fieldId: string): boolean {
    return this.visibleIds.has(fieldId)
  }

  /** Toggle the panel open/closed */
  toggle(): void {
    if (this.panelEl) {
      this.close()
    } else {
      this.open()
    }
  }

  /** Close and remove the panel */
  close(): void {
    if (this.panelEl) {
      this.panelEl.remove()
      this.panelEl = null
    }
    this.lockedPos = null
    this.outsideClickAC?.abort()
    this.outsideClickAC = null
    this.triggerEl.setAttribute("aria-expanded", "false")
  }

  private positionPanel(panel: HTMLElement, { clampLocked = false }: { clampLocked?: boolean } = {}): void {
    const panelWidth = 288
    const estimatedHeight = 420
    const margin = 12

    if (clampLocked && this.lockedPos) {
      const clampedLeft = Math.max(margin, Math.min(this.lockedPos.left, window.innerWidth - panelWidth - margin))
      const clampedTop = Math.max(margin, Math.min(this.lockedPos.top, window.innerHeight - 160))
      this.lockedPos = { top: Math.round(clampedTop), left: Math.round(clampedLeft) }
      panel.style.position = "fixed"
      panel.style.top = `${this.lockedPos.top}px`
      panel.style.left = `${this.lockedPos.left}px`
      panel.style.right = "auto"
      panel.style.zIndex = "260"
      return
    }

    const rect = this.triggerEl.getBoundingClientRect()
    // Guard against detached or hidden triggers returning an all-zero rect (0,0,0,0)
    if (rect.width === 0 && rect.height === 0) {
      if (this.lockedPos) {
        this.positionPanel(panel, { clampLocked: true })
      }
      return
    }

    const preferredLeft = rect.right - panelWidth
    const clampedLeft = Math.max(margin, Math.min(preferredLeft, window.innerWidth - panelWidth - margin))
    const spaceBelow = window.innerHeight - rect.bottom - margin
    const top = spaceBelow >= 220
      ? rect.bottom + 6
      : Math.max(margin, rect.top - Math.min(estimatedHeight, window.innerHeight - margin * 2) - 6)

    this.lockedPos = { top: Math.round(top), left: Math.round(clampedLeft) }
    panel.style.position = "fixed"
    panel.style.top = `${this.lockedPos.top}px`
    panel.style.left = `${this.lockedPos.left}px`
    panel.style.right = "auto"
    panel.style.zIndex = "260"
  }

  /** Open the panel anchored to triggerEl */
  private open(): void {
    document.querySelector(".field-picker-panel")?.remove()
    this.searchQuery = ""

    const panel = document.createElement("div")
    panel.className = "field-picker-panel"
    panel.setAttribute("role", "dialog")
    panel.setAttribute("aria-label", "Manage visible fields")
    this.positionPanel(panel)

    // Header
    const header = document.createElement("div")
    header.className = "field-picker-panel__header"

    const titleWrap = document.createElement("span")
    titleWrap.className = "field-picker-panel__title"
    titleWrap.append(
      createSpriteIconElement("adjustments-horizontal", { size: 15, className: "field-picker-panel__title-icon" }),
      document.createTextNode("Fields"),
    )
    header.appendChild(titleWrap)

    const closeBtn = document.createElement("button")
    closeBtn.type = "button"
    closeBtn.className = "field-picker-panel__close"
    closeBtn.setAttribute("aria-label", "Close fields panel")
    closeBtn.appendChild(createSpriteIconElement("x", { size: 15 }))
    closeBtn.addEventListener("click", () => {
      this.close()
      this.triggerEl.focus()
    })
    header.appendChild(closeBtn)

    panel.appendChild(header)

    // Search input with Tabler search adornment
    const searchWrap = document.createElement("div")
    searchWrap.className = "field-picker-panel__search-wrap"

    const searchIcon = document.createElement("span")
    searchIcon.className = "field-picker-panel__search-icon"
    searchIcon.setAttribute("aria-hidden", "true")
    searchIcon.appendChild(createSpriteIconElement("search", { size: 14 }))
    searchWrap.appendChild(searchIcon)

    const searchInput = document.createElement("input")
    searchInput.type = "search"
    searchInput.className = "field-picker-panel__search"
    searchInput.placeholder = "Search fields..."
    searchInput.setAttribute("aria-label", "Search fields")
    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value.trim().toLowerCase()
      if (this.panelEl) this.renderFieldList(this.panelEl)
    })
    searchWrap.appendChild(searchInput)
    panel.appendChild(searchWrap)

    // Field list container
    const listContainer = document.createElement("div")
    listContainer.className = "field-picker-panel__list"
    panel.appendChild(listContainer)

    this.panelEl = panel
    document.body.appendChild(panel)
    this.triggerEl.setAttribute("aria-expanded", "true")

    this.renderFieldList(panel)
    searchInput.focus()

    // Outside click + resize repositioning
    this.outsideClickAC = new AbortController()
    const outSignal = this.outsideClickAC.signal
    setTimeout(() => {
      if (outSignal.aborted) return
      document.addEventListener("click", (e) => {
        const target = e.target as Node | null
        if (!target || !this.panelEl) return
        if (!this.panelEl.contains(target) && !this.triggerEl.contains(target)) {
          this.close()
        }
      }, { signal: outSignal })
      window.addEventListener("resize", () => {
        if (this.panelEl) this.positionPanel(this.panelEl, { clampLocked: true })
      }, { signal: outSignal })
    }, 0)

    // Escape key to close
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        this.close()
        this.triggerEl.focus()
      }
    }, { signal: outSignal })
  }

  /** Render the shown/hidden field list inside the panel */
  private renderFieldList(panel: HTMLElement | null): void {
    if (!panel) return
    const container = panel.querySelector(".field-picker-panel__list")
    if (!container) return

    container.replaceChildren()

    const toggleable = this.opts.fields.filter(f => !f.alwaysVisible)
    const filtered = this.searchQuery
      ? toggleable.filter(f =>
          f.label.toLowerCase().includes(this.searchQuery) ||
          f.group.toLowerCase().includes(this.searchQuery) ||
          f.id.toLowerCase().includes(this.searchQuery),
        )
      : toggleable

    const shown = filtered.filter(f => this.visibleIds.has(f.id))
    const hidden = filtered.filter(f => !this.visibleIds.has(f.id))

    if (shown.length > 0) {
      container.appendChild(this.createSection("Shown", shown, true))
    }

    if (hidden.length > 0) {
      container.appendChild(this.createSection("Hidden", hidden, false))
    }

    if (filtered.length === 0 && this.searchQuery) {
      const noResults = document.createElement("div")
      noResults.className = "field-picker-panel__empty"
      noResults.textContent = "No matching fields"
      container.appendChild(noResults)
    }
  }

  /** Create a section (Shown or Hidden) with field rows */
  private createSection(label: string, fields: FieldDef[], isShown: boolean): HTMLElement {
    const section = document.createElement("div")
    section.className = "field-picker-panel__section"

    const sectionHeader = document.createElement("div")
    sectionHeader.className = "field-picker-panel__section-header"

    const sectionLabel = document.createElement("span")
    sectionLabel.className = "field-picker-panel__section-label"
    sectionLabel.append(
      document.createTextNode(`${label} `),
      createSpriteIconElement("chevron-down", { size: 12, className: "field-picker-panel__section-chevron" }),
    )
    sectionHeader.appendChild(sectionLabel)

    if (isShown) {
      const hideAllBtn = document.createElement("button")
      hideAllBtn.type = "button"
      hideAllBtn.className = "field-picker-panel__hide-all"
      hideAllBtn.textContent = "Hide all"
      hideAllBtn.addEventListener("click", (e) => {
        e.stopPropagation()
        fields.forEach(f => this.visibleIds.delete(f.id))
        this.emitChange()
        if (this.panelEl) this.renderFieldList(this.panelEl)
      })
      sectionHeader.appendChild(hideAllBtn)
    }

    section.appendChild(sectionHeader)

    for (const field of fields) {
      section.appendChild(this.createFieldRow(field))
    }

    return section
  }

  /** Create a single field row with Tabler icon, label, and toggle switch */
  private createFieldRow(field: FieldDef): HTMLElement {
    const row = document.createElement("div")
    row.className = "field-picker-panel__row"
    row.dataset.fieldId = field.id

    const icon = document.createElement("span")
    icon.className = "field-picker-panel__icon"
    icon.setAttribute("aria-hidden", "true")
    icon.appendChild(createSpriteIconElement(field.icon, { size: 15 }))
    row.appendChild(icon)

    const label = document.createElement("span")
    label.className = "field-picker-panel__label"
    label.textContent = field.label
    row.appendChild(label)

    const toggle = document.createElement("button")
    toggle.type = "button"
    toggle.className = "field-picker-panel__toggle"
    const isOn = this.visibleIds.has(field.id)
    toggle.classList.toggle("field-picker-panel__toggle--on", isOn)
    toggle.setAttribute("role", "switch")
    toggle.setAttribute("aria-checked", String(isOn))
    toggle.setAttribute("aria-label", `${isOn ? "Hide" : "Show"} ${field.label}`)

    const track = document.createElement("span")
    track.className = "field-picker-panel__toggle-track"
    toggle.appendChild(track)

    const knob = document.createElement("span")
    knob.className = "field-picker-panel__toggle-knob"
    toggle.appendChild(knob)

    const handleToggle = (e: Event) => {
      e.stopPropagation()
      if (this.visibleIds.has(field.id)) {
        this.visibleIds.delete(field.id)
      } else {
        this.visibleIds.add(field.id)
      }
      this.emitChange()
      if (this.panelEl) this.renderFieldList(this.panelEl)
    }

    toggle.addEventListener("click", handleToggle)
    row.addEventListener("click", (e) => {
      if (e.target === toggle || toggle.contains(e.target as Node)) return
      handleToggle(e)
    })

    row.appendChild(toggle)
    return row
  }

  /** Persist state, call callback, and dispatch event */
  private emitChange(): void {
    const ids = [...this.visibleIds]
    saveVisibleFields(this.opts.viewId, this.visibleIds)
    this.opts.onChanged(ids)

    document.dispatchEvent(new CustomEvent("meitheal:fields-changed", {
      detail: { viewId: this.opts.viewId, visibleFields: ids },
    }))
  }
}
