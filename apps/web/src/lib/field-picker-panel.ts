/**
 * FieldPickerPanel — Shared ClickUp-style column/field visibility manager.
 *
 * Renders a panel with search, Shown/Hidden sections, and toggle switches
 * for task fields. Persists visibility state per-view in localStorage.
 * Emits `meitheal:fields-changed` CustomEvent when fields change.
 *
 * @domain tasks (shared view-layer component)
 * @phase 20 — Field Picker Panel
 *
 * @usage
 * ```ts
 * import { FieldPickerPanel, TASK_FIELD_DEFS } from "@lib/field-picker-panel"
 *
 * const panel = new FieldPickerPanel({
 *   viewId: "timeline",
 *   fields: TASK_FIELD_DEFS,
 *   triggerEl: myButton,
 *   onChanged: (visibleIds) => reRender(visibleIds),
 *   signal: abortSignal,
 * })
 * panel.toggle()
 * ```
 */

// ── Field Definition ───────────────────────────────────────────────────────

export interface FieldDef {
  /** Unique key matching the task property name */
  id: string
  /** Human-readable label */
  label: string
  /** Emoji or text icon for the field */
  icon: string
  /** Grouping category for organisation */
  group: "date" | "meta" | "tracking"
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
  { id: "due_date",       label: "Due Date",   icon: "📅", group: "date",     defaultVisible: true },
  { id: "start_date",     label: "Start Date",  icon: "🗓️", group: "date",     defaultVisible: false },
  { id: "priority",       label: "Priority",    icon: "🔥", group: "meta",     defaultVisible: false },
  { id: "status",         label: "Status",      icon: "⬤",  group: "meta",     defaultVisible: false },
  { id: "ticket_number",  label: "Task ID",     icon: "🔢", group: "meta",     defaultVisible: false },
  { id: "progress",       label: "Progress",    icon: "📊", group: "tracking", defaultVisible: false },
  { id: "effort_minutes", label: "Effort",      icon: "⏱️", group: "tracking", defaultVisible: false },
  { id: "task_kind",      label: "Type",        icon: "🏷️", group: "meta",     defaultVisible: false },
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
  try {
    const raw = localStorage.getItem(storageKey(viewId))
    if (raw) {
      const parsed = JSON.parse(raw) as string[]
      if (Array.isArray(parsed)) return new Set(parsed)
    }
  } catch { /* ignore */ }

  // Default: fields marked defaultVisible + alwaysVisible
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
  private panelEl: HTMLElement | null = null
  private visibleIds: Set<string>
  private searchQuery = ""

  constructor(opts: FieldPickerOptions) {
    this.opts = opts
    this.visibleIds = loadVisibleFields(opts.viewId, opts.fields)

    // Cleanup on abort
    opts.signal?.addEventListener("abort", () => this.close())
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
    this.outsideClickAC?.abort()
    this.outsideClickAC = null
  }

  private outsideClickAC: AbortController | null = null

  /** Open the panel anchored to triggerEl */
  private open(): void {
    // Remove any existing panel globally
    document.querySelector(".field-picker-panel")?.remove()

    const panel = document.createElement("div")
    panel.className = "field-picker-panel"
    panel.setAttribute("role", "dialog")
    panel.setAttribute("aria-label", "Manage visible fields")

    // Position relative to trigger
    const rect = this.opts.triggerEl.getBoundingClientRect()
    panel.style.position = "fixed"
    panel.style.top = `${rect.bottom + 4}px`
    panel.style.right = `${window.innerWidth - rect.right}px`
    panel.style.zIndex = "10000"

    // Header
    const header = document.createElement("div")
    header.className = "field-picker-panel__header"

    const title = document.createElement("span")
    title.className = "field-picker-panel__title"
    title.textContent = "Fields"
    header.appendChild(title)

    const closeBtn = document.createElement("button")
    closeBtn.type = "button"
    closeBtn.className = "field-picker-panel__close"
    closeBtn.setAttribute("aria-label", "Close fields panel")
    closeBtn.textContent = "✕"
    closeBtn.addEventListener("click", () => this.close())
    header.appendChild(closeBtn)

    panel.appendChild(header)

    // Search input
    const searchWrap = document.createElement("div")
    searchWrap.className = "field-picker-panel__search-wrap"

    const searchInput = document.createElement("input")
    searchInput.type = "text"
    searchInput.className = "field-picker-panel__search"
    searchInput.placeholder = "Search for new or existing fields"
    searchInput.setAttribute("aria-label", "Search fields")
    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value.toLowerCase()
      this.renderFieldList(panel)
    })
    searchWrap.appendChild(searchInput)
    panel.appendChild(searchWrap)

    // Field list container
    const listContainer = document.createElement("div")
    listContainer.className = "field-picker-panel__list"
    panel.appendChild(listContainer)

    this.panelEl = panel
    document.body.appendChild(panel)

    // Render field toggles
    this.renderFieldList(panel)

    // Focus search
    searchInput.focus()

    // Outside click to close
    this.outsideClickAC = new AbortController()
    setTimeout(() => {
      document.addEventListener("click", (e) => {
        if (!panel.contains(e.target as Node) && !this.opts.triggerEl.contains(e.target as Node)) {
          this.close()
        }
      }, { signal: this.outsideClickAC!.signal })
    }, 0)

    // Escape key to close
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        this.close()
        this.opts.triggerEl.focus()
      }
    })
  }

  /** Render the shown/hidden field list inside the panel */
  private renderFieldList(panel: HTMLElement): void {
    const container = panel.querySelector(".field-picker-panel__list")
    if (!container) return

    // Clear existing
    container.replaceChildren()

    const toggleable = this.opts.fields.filter(f => !f.alwaysVisible)
    const filtered = this.searchQuery
      ? toggleable.filter(f => f.label.toLowerCase().includes(this.searchQuery))
      : toggleable

    const shown = filtered.filter(f => this.visibleIds.has(f.id))
    const hidden = filtered.filter(f => !this.visibleIds.has(f.id))

    // Shown section
    if (shown.length > 0) {
      const shownSection = this.createSection("Shown", shown, true)
      container.appendChild(shownSection)
    }

    // Hidden section
    if (hidden.length > 0) {
      const hiddenSection = this.createSection("Hidden", hidden, false)
      container.appendChild(hiddenSection)
    }

    // No results
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
    sectionLabel.textContent = `${label} ▾`
    sectionHeader.appendChild(sectionLabel)

    if (isShown) {
      const hideAllBtn = document.createElement("button")
      hideAllBtn.type = "button"
      hideAllBtn.className = "field-picker-panel__hide-all"
      hideAllBtn.textContent = "Hide all"
      hideAllBtn.addEventListener("click", () => {
        fields.forEach(f => this.visibleIds.delete(f.id))
        this.emitChange()
        this.renderFieldList(this.panelEl!)
      })
      sectionHeader.appendChild(hideAllBtn)
    }

    section.appendChild(sectionHeader)

    for (const field of fields) {
      section.appendChild(this.createFieldRow(field))
    }

    return section
  }

  /** Create a single field row with icon, label, and toggle switch */
  private createFieldRow(field: FieldDef): HTMLElement {
    const row = document.createElement("div")
    row.className = "field-picker-panel__row"

    // Icon
    const icon = document.createElement("span")
    icon.className = "field-picker-panel__icon"
    icon.textContent = field.icon
    icon.setAttribute("aria-hidden", "true")
    row.appendChild(icon)

    // Label
    const label = document.createElement("span")
    label.className = "field-picker-panel__label"
    label.textContent = field.label
    row.appendChild(label)

    // Toggle switch
    const toggle = document.createElement("button")
    toggle.type = "button"
    toggle.className = "field-picker-panel__toggle"
    const isOn = this.visibleIds.has(field.id)
    toggle.classList.toggle("field-picker-panel__toggle--on", isOn)
    toggle.setAttribute("role", "switch")
    toggle.setAttribute("aria-checked", String(isOn))
    toggle.setAttribute("aria-label", `${isOn ? "Hide" : "Show"} ${field.label}`)

    // Toggle track
    const track = document.createElement("span")
    track.className = "field-picker-panel__toggle-track"
    toggle.appendChild(track)

    // Toggle knob
    const knob = document.createElement("span")
    knob.className = "field-picker-panel__toggle-knob"
    toggle.appendChild(knob)

    toggle.addEventListener("click", () => {
      if (this.visibleIds.has(field.id)) {
        this.visibleIds.delete(field.id)
      } else {
        this.visibleIds.add(field.id)
      }
      this.emitChange()
      this.renderFieldList(this.panelEl!)
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
