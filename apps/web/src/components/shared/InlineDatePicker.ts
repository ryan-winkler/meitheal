/**
 * InlineDatePicker — Shared modular Tabler Date & Time Picker component
 *
 * Vanilla JS class (no framework dependencies) used across forms, modals,
 * filters, and timeline views.
 *
 * Features:
 * - Directly editable input (type ISO, natural, or relative dates/times)
 * - Floating Tabler-styled calendar popover with quick presets
 * - Optional integrated Time Picker (`enableTime: true`) with quick time chips
 * - Full keyboard navigation & AbortSignal cleanup
 *
 * @domain tasks
 */

import { createTablerSvgElement } from "../../lib/tabler-svg"
import {
  buildCalendarMonthCells,
  formatQuickDateSublabel,
  formatTablerDateDisplay,
  formatTimeHHMM,
  getDateInputPlaceholder,
  getWeekdayShortLabels,
  hasNonMidnightTime,
  parseFlexibleDateInput,
  readActiveDateFormat,
  readActiveWeekStart,
} from "../../lib/date-time-parser"

export interface InlineDatePickerOptions {
  /** Current date value (null = no date set) */
  value: Date | null
  /** Called when user selects or types a date */
  onChange: (date: Date, meta?: { hasTime: boolean }) => void
  /** Called when user clears the date */
  onClear: () => void
  /** Format for display (default: Tabler short date, plus HH:MM when time is active) */
  formatFn?: (d: Date, hasTime?: boolean) => string
  /** Optional placeholder text */
  placeholderText?: string
  /** Show leading calendar icon alongside a chosen date */
  showIconWithDate?: boolean
  /** Render a directly editable text input inside the Tabler trigger */
  editable?: boolean
  /** Enable integrated time picker (typing + popover time input + quick chips) */
  enableTime?: boolean
  /** Whether an active value currently has an explicit time component */
  hasTime?: boolean
  /** Accessible label for the input/trigger */
  ariaLabel?: string
  /** AbortSignal for cleanup */
  signal?: AbortSignal
}

function listenerOpts(signal?: AbortSignal): AddEventListenerOptions | undefined {
  return signal ? { signal } : undefined
}

interface QuickOption {
  label: string
  sublabel: string
  date: () => Date
}

const QUICK_TIMES = ["09:00", "12:00", "15:00", "18:00"]

function defaultFormat(d: Date, hasTime?: boolean): string {
  return formatTablerDateDisplay(d, Boolean(hasTime), readActiveDateFormat())
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function nextDayOfWeek(from: Date, dayOfWeek: number): Date {
  const d = new Date(from)
  const diff = (dayOfWeek - d.getDay() + 7) % 7 || 7
  d.setDate(d.getDate() + diff)
  return startOfDay(d)
}

function getQuickOptions(): QuickOption[] {
  const now = new Date()
  const today = startOfDay(now)
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  const activeFormat = readActiveDateFormat()

  const tomorrow = addDays(today, 1)
  const nextMon = nextDayOfWeek(today, 1)
  const nextSat = nextDayOfWeek(today, 6)
  const twoWeeks = addDays(today, 14)
  const fourWeeks = addDays(today, 28)
  const eightWeeks = addDays(today, 56)

  const fmt = (d: Date) => formatQuickDateSublabel(d, activeFormat)

  return [
    { label: "Today", sublabel: dayNames[today.getDay()]!, date: () => today },
    { label: "Tomorrow", sublabel: dayNames[tomorrow.getDay()]!, date: () => tomorrow },
    { label: "Next week", sublabel: dayNames[nextMon.getDay()]!, date: () => nextMon },
    { label: "Next weekend", sublabel: fmt(nextSat), date: () => nextSat },
    { label: "2 weeks", sublabel: fmt(twoWeeks), date: () => twoWeeks },
    { label: "4 weeks", sublabel: fmt(fourWeeks), date: () => fourWeeks },
    { label: "8 weeks", sublabel: fmt(eightWeeks), date: () => eightWeeks },
  ]
}

export class InlineDatePicker {
  private container: HTMLElement
  private options: InlineDatePickerOptions
  private panel: HTMLElement | null = null
  private panelCleanups: (() => void)[] = []
  private calMonth: Date
  private trigger: HTMLElement | null = null
  private textInput: HTMLInputElement | null = null
  private cleanups: (() => void)[] = []
  private formatFn: (d: Date, hasTime?: boolean) => string
  private activeHasTime: boolean
  private pendingTime = ""

  constructor(container: HTMLElement, options: InlineDatePickerOptions) {
    this.container = container
    this.options = options
    this.calMonth = options.value
      ? new Date(options.value.getFullYear(), options.value.getMonth(), 1)
      : new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    this.formatFn = options.formatFn || defaultFormat
    this.activeHasTime = Boolean(
      options.enableTime && options.value && (options.hasTime ?? hasNonMidnightTime(options.value)),
    )
    this.pendingTime = this.activeHasTime && options.value ? formatTimeHHMM(options.value) : ""
    const onDateSettingsChanged = () => {
      this.render()
      if (this.panel && this.panel.isConnected) {
        const calSide = this.panel.querySelector<HTMLElement>(".idp-calendar")
        if (calSide) this.renderCalendar(calSide)
      }
    }
    window.addEventListener("meitheal:date-settings-changed", onDateSettingsChanged, listenerOpts(options.signal))
    this.cleanups.push(() => window.removeEventListener("meitheal:date-settings-changed", onDateSettingsChanged))
    this.render()
  }

  /** Update the current value and re-render trigger */
  setValue(date: Date | null, hasTime?: boolean) {
    this.options.value = date
    if (date) {
      this.calMonth = new Date(date.getFullYear(), date.getMonth(), 1)
      this.activeHasTime = Boolean(
        this.options.enableTime && (hasTime ?? hasNonMidnightTime(date)),
      )
      this.pendingTime = this.activeHasTime ? formatTimeHHMM(date) : ""
    } else {
      this.activeHasTime = false
      this.pendingTime = ""
    }
    this.closePanel()
    this.render()
  }

  /** Clean up all listeners and DOM */
  destroy() {
    this.closePanel()
    for (const fn of this.cleanups) fn()
    this.cleanups = []
    this.container.replaceChildren()
  }

  private formatDisplayValue(date: Date | null): string {
    if (!date) return ""
    return this.formatFn(date, this.activeHasTime)
  }

  private applyTimeToDate(baseDate: Date, timeStr: string): { date: Date; hasTime: boolean } {
    const trimmed = timeStr.trim()
    if (!this.options.enableTime || !trimmed) {
      return { date: startOfDay(baseDate), hasTime: false }
    }
    const parts = /^(\d{2}):(\d{2})$/.exec(trimmed)
    if (!parts) {
      return { date: startOfDay(baseDate), hasTime: false }
    }
    const d = new Date(
      baseDate.getFullYear(),
      baseDate.getMonth(),
      baseDate.getDate(),
      Number(parts[1]),
      Number(parts[2]),
      0,
      0,
    )
    return { date: d, hasTime: true }
  }

  private commitDate(date: Date, hasTime: boolean, keepPanelOpen = false) {
    this.options.value = date
    this.activeHasTime = Boolean(this.options.enableTime && hasTime)
    this.pendingTime = this.activeHasTime ? formatTimeHHMM(date) : ""
    this.calMonth = new Date(date.getFullYear(), date.getMonth(), 1)
    this.options.onChange(date, { hasTime: this.activeHasTime })
    if (!keepPanelOpen) {
      this.closePanel()
    }
    this.render()
  }

  private render() {
    this.container.replaceChildren()
    this.container.classList.add("idp-container")
    this.textInput = null

    if (this.options.editable) {
      this.renderEditableTrigger()
      return
    }

    if (this.options.value) {
      this.renderDateDisplay()
    } else {
      this.renderPlaceholder()
    }
  }

  private renderEditableTrigger() {
    const wrap = document.createElement("div")
    wrap.className = `idp-trigger idp-trigger--editable${this.options.value ? " idp-has-date" : " idp-placeholder"}`

    const calBtn = document.createElement("button")
    calBtn.type = "button"
    calBtn.className = "idp-cal-toggle"
    calBtn.title = this.options.enableTime ? "Open date & time picker" : "Open date picker"
    calBtn.setAttribute("aria-label", this.options.enableTime ? "Open date and time picker" : "Open date picker")
    calBtn.setAttribute("aria-haspopup", "dialog")
    calBtn.setAttribute("aria-expanded", String(Boolean(this.panel)))
    calBtn.appendChild(createTablerSvgElement("calendar", 15))
    calBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      this.togglePanel()
    }, listenerOpts(this.options.signal))
    wrap.appendChild(calBtn)

    const textInput = document.createElement("input")
    textInput.type = "text"
    textInput.className = "idp-text-input"
    textInput.autocomplete = "off"
    textInput.spellcheck = false
    textInput.value = this.formatDisplayValue(this.options.value)
    textInput.placeholder = this.options.placeholderText || getDateInputPlaceholder(Boolean(this.options.enableTime), readActiveDateFormat())
    if (this.options.ariaLabel) {
      textInput.setAttribute("aria-label", this.options.ariaLabel)
    }

    const commitTyped = (fromEnter: boolean) => {
      const raw = textInput.value.trim()
      textInput.classList.remove("idp-text-input--invalid")
      textInput.removeAttribute("aria-invalid")
      textInput.setCustomValidity("")
      if (!raw) {
        if (this.options.value) {
          this.options.onClear()
          this.setValue(null)
        }
        return
      }
      // If unchanged from current formatted value, no-op
      if (this.options.value && raw === this.formatDisplayValue(this.options.value)) {
        return
      }
      const parsed = parseFlexibleDateInput(raw, { enableTime: Boolean(this.options.enableTime) })
      if (parsed) {
        this.commitDate(parsed.date, parsed.hasTime)
        if (fromEnter) {
          this.textInput?.focus()
        }
      } else {
        textInput.classList.add("idp-text-input--invalid")
        textInput.setAttribute("aria-invalid", "true")
        textInput.setCustomValidity("Enter a valid date or clear the field.")
      }
    }

    textInput.addEventListener("input", () => textInput.setCustomValidity(""), listenerOpts(this.options.signal))
    textInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault()
        e.stopPropagation()
        commitTyped(true)
      } else if (e.key === "ArrowDown" && !this.panel) {
        e.preventDefault()
        this.openPanel()
      } else if (e.key === "Escape" && this.panel) {
        e.stopPropagation()
        this.closePanel()
      }
    }, listenerOpts(this.options.signal))

    textInput.addEventListener("blur", (event) => {
      if (event.relatedTarget instanceof HTMLElement) {
        if (!this.panel?.contains(event.relatedTarget) && this.textInput === textInput) commitTyped(false)
        return
      }
      // Do not clobber click into open popover
      setTimeout(() => {
        if (this.panel && this.panel.contains(document.activeElement)) return
        if (this.textInput === textInput) commitTyped(false)
      }, 0)
    }, listenerOpts(this.options.signal))

    textInput.addEventListener("click", (e) => {
      e.stopPropagation()
      if (!this.panel) this.openPanel()
    }, listenerOpts(this.options.signal))

    this.textInput = textInput
    wrap.appendChild(textInput)

    if (this.options.value) {
      const clear = document.createElement("button")
      clear.type = "button"
      clear.className = "idp-clear-btn"
      clear.title = "Clear date"
      clear.setAttribute("aria-label", "Clear date")
      clear.replaceChildren(createTablerSvgElement("x", 14))
      clear.addEventListener("click", (e) => {
        e.stopPropagation()
        this.options.onClear()
        this.setValue(null)
      }, listenerOpts(this.options.signal))
      wrap.appendChild(clear)
    }

    this.trigger = wrap
    this.container.appendChild(wrap)
  }

  private renderDateDisplay() {
    const wrap = document.createElement("span")
    wrap.className = "idp-trigger idp-has-date"
    wrap.title = "Click to change date"

    if (this.options.showIconWithDate) {
      wrap.appendChild(createTablerSvgElement("calendar", 15))
    }

    const text = document.createElement("span")
    text.className = "idp-date-text"
    text.textContent = this.formatDisplayValue(this.options.value)
    wrap.appendChild(text)

    const clear = document.createElement("button")
    clear.type = "button"
    clear.className = "idp-clear-btn"
    clear.title = "Remove date"
    clear.setAttribute("aria-label", "Remove scheduled date")
    clear.replaceChildren(createTablerSvgElement("x", 14))
    clear.addEventListener("click", (e) => {
      e.stopPropagation()
      this.options.onClear()
      this.setValue(null)
    }, listenerOpts(this.options.signal))
    wrap.appendChild(clear)

    wrap.addEventListener("click", (e) => {
      e.stopPropagation()
      this.togglePanel()
    }, listenerOpts(this.options.signal))

    this.trigger = wrap
    this.container.appendChild(wrap)
  }

  private renderPlaceholder() {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "idp-trigger idp-placeholder"
    btn.title = this.options.placeholderText || "Set date"

    btn.appendChild(createTablerSvgElement("calendar", 15))

    if (this.options.placeholderText) {
      const label = document.createElement("span")
      label.className = "idp-placeholder-text"
      label.textContent = this.options.placeholderText
      btn.appendChild(label)
    }

    btn.addEventListener("click", (e) => {
      e.stopPropagation()
      this.togglePanel()
    }, listenerOpts(this.options.signal))

    this.trigger = btn
    this.container.appendChild(btn)
  }

  private togglePanel() {
    if (this.panel) {
      this.closePanel()
    } else {
      this.openPanel()
    }
  }

  private clampPanelPosition(panel: HTMLElement) {
    const triggerRect = this.trigger?.getBoundingClientRect()
    if (!triggerRect) return

    const margin = 8
    const panelRect = panel.getBoundingClientRect()
    const panelWidth = panelRect.width || 420
    const panelHeight = panelRect.height || 340

    const preferredLeft = triggerRect.left
    const maxLeft = Math.max(margin, window.innerWidth - panelWidth - margin)
    const left = Math.max(margin, Math.min(preferredLeft, maxLeft))

    const spaceBelow = window.innerHeight - triggerRect.bottom - margin
    const spaceAbove = triggerRect.top - margin
    let preferredTop = triggerRect.bottom + 4
    if (spaceBelow < panelHeight && spaceAbove >= panelHeight) {
      preferredTop = triggerRect.top - panelHeight - 4
    }
    const maxTop = Math.max(margin, window.innerHeight - panelHeight - margin)
    const top = Math.max(margin, Math.min(preferredTop, maxTop))

    panel.style.position = "fixed"
    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
    panel.style.bottom = ""
    panel.style.zIndex = "10000"
  }

  private openPanel() {
    this.closePanel()

    const panel = document.createElement("div")
    panel.className = "idp-panel"
    panel.setAttribute("role", "dialog")
    panel.setAttribute("aria-label", this.options.enableTime ? "Choose date and time" : "Choose date")

    // Left side: Quick options
    const quickSide = document.createElement("div")
    quickSide.className = "idp-quick-options"

    for (const opt of getQuickOptions()) {
      const row = document.createElement("button")
      row.className = "idp-quick-option"
      row.type = "button"

      const label = document.createElement("span")
      label.className = "idp-quick-label"
      label.textContent = opt.label
      row.appendChild(label)

      const sub = document.createElement("span")
      sub.className = "idp-quick-sublabel"
      sub.textContent = opt.sublabel
      row.appendChild(sub)

      row.addEventListener("click", (e) => {
        e.stopPropagation()
        const { date, hasTime } = this.applyTimeToDate(opt.date(), this.pendingTime)
        this.commitDate(date, hasTime)
      })
      quickSide.appendChild(row)
    }
    panel.appendChild(quickSide)

    // Right side: Calendar (+ optional Time Picker footer)
    const rightCol = document.createElement("div")
    rightCol.className = "idp-right-col"

    const calSide = document.createElement("div")
    calSide.className = "idp-calendar"
    this.renderCalendar(calSide)
    rightCol.appendChild(calSide)

    if (this.options.enableTime) {
      rightCol.appendChild(this.renderTimeSection(calSide))
    }

    panel.appendChild(rightCol)

    this.panel = panel
    this.container.querySelector(".idp-cal-toggle")?.setAttribute("aria-expanded", "true")
    document.body.appendChild(panel)
    this.clampPanelPosition(panel)
    requestAnimationFrame(() => {
      if (this.panel === panel) this.clampPanelPosition(panel)
    })

    const closeHandler = (e: MouseEvent) => {
      if (!panel.contains(e.target as Node) && !this.container.contains(e.target as Node)) {
        this.closePanel()
      }
    }
    setTimeout(() => {
      document.addEventListener("click", closeHandler as EventListener, listenerOpts(this.options.signal))
      this.panelCleanups.push(() => document.removeEventListener("click", closeHandler as EventListener))
    }, 0)

    const escHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.closePanel()
    }
    document.addEventListener("keydown", escHandler as EventListener, listenerOpts(this.options.signal))
    this.panelCleanups.push(() => document.removeEventListener("keydown", escHandler as EventListener))
  }

  private renderTimeSection(calSide: HTMLElement): HTMLElement {
    const section = document.createElement("div")
    section.className = "idp-time-section"

    const row = document.createElement("div")
    row.className = "idp-time-row"

    const label = document.createElement("label")
    label.className = "idp-time-label"
    label.appendChild(createTablerSvgElement("clock", 14))
    const labelText = document.createElement("span")
    labelText.textContent = "Time"
    label.appendChild(labelText)

    const timeInput = document.createElement("input")
    timeInput.type = "time"
    timeInput.className = "idp-time-input"
    timeInput.value = this.pendingTime
    timeInput.setAttribute("aria-label", "Select time")
    timeInput.addEventListener("click", (e) => e.stopPropagation())

    const clearTimeBtn = document.createElement("button")
    clearTimeBtn.type = "button"
    clearTimeBtn.className = "idp-time-clear-btn"
    clearTimeBtn.title = "Clear time (date only)"
    clearTimeBtn.setAttribute("aria-label", "Clear time")
    clearTimeBtn.appendChild(createTablerSvgElement("x", 13))

    const syncClearState = () => {
      clearTimeBtn.disabled = !this.pendingTime
      clearTimeBtn.classList.toggle("is-empty", !this.pendingTime)
    }
    syncClearState()

    const chips = document.createElement("div")
    chips.className = "idp-time-chips"
    const syncChipStates = () => {
      chips.querySelectorAll<HTMLButtonElement>(".idp-time-chip").forEach((c) => {
        c.classList.toggle("is-active", c.dataset.time === this.pendingTime)
      })
    }

    timeInput.addEventListener("change", (e) => {
      e.stopPropagation()
      this.pendingTime = timeInput.value
      syncClearState()
      syncChipStates()
      const base = this.options.value ?? startOfDay(new Date())
      const { date, hasTime } = this.applyTimeToDate(base, this.pendingTime)
      this.commitDate(date, hasTime, true)
      this.renderCalendar(calSide)
    })

    clearTimeBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      if (!this.pendingTime) return
      this.pendingTime = ""
      timeInput.value = ""
      syncClearState()
      syncChipStates()
      if (this.options.value) {
        this.commitDate(startOfDay(this.options.value), false, true)
        this.renderCalendar(calSide)
      }
    })

    const doneBtn = document.createElement("button")
    doneBtn.type = "button"
    doneBtn.className = "idp-time-done"
    doneBtn.textContent = "Done"
    doneBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      if (timeInput.value !== this.pendingTime) {
        this.pendingTime = timeInput.value
        const base = this.options.value ?? startOfDay(new Date())
        const { date, hasTime } = this.applyTimeToDate(base, this.pendingTime)
        this.commitDate(date, hasTime)
      } else {
        this.closePanel()
      }
    })

    row.append(label, timeInput, clearTimeBtn, doneBtn)
    section.appendChild(row)

    for (const preset of QUICK_TIMES) {
      const chip = document.createElement("button")
      chip.type = "button"
      chip.dataset.time = preset
      chip.className = `idp-time-chip${this.pendingTime === preset ? " is-active" : ""}`
      chip.textContent = preset
      chip.addEventListener("click", (e) => {
        e.stopPropagation()
        this.pendingTime = preset
        timeInput.value = preset
        syncClearState()
        syncChipStates()
        const base = this.options.value ?? startOfDay(new Date())
        const { date, hasTime } = this.applyTimeToDate(base, preset)
        this.commitDate(date, hasTime, true)
        this.renderCalendar(calSide)
      })
      chips.appendChild(chip)
    }

    section.appendChild(chips)
    return section
  }

  closePanel() {
    for (const fn of this.panelCleanups) fn()
    this.panelCleanups = []
    if (this.panel) {
      this.panel.remove()
      this.panel = null
    }
    this.container.querySelector(".idp-cal-toggle")?.setAttribute("aria-expanded", "false")
  }

  private renderCalendar(container: HTMLElement) {
    container.replaceChildren()

    const header = document.createElement("div")
    header.className = "idp-cal-header"

    const todayBtn = document.createElement("button")
    todayBtn.className = "idp-cal-today-btn"
    todayBtn.textContent = "Today"
    todayBtn.type = "button"
    todayBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      this.calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
      this.renderCalendar(container)
    })
    header.appendChild(todayBtn)

    const navWrap = document.createElement("div")
    navWrap.className = "idp-cal-nav"

    const prevBtn = document.createElement("button")
    prevBtn.className = "idp-cal-nav-btn"
    prevBtn.textContent = "‹"
    prevBtn.type = "button"
    prevBtn.setAttribute("aria-label", "Previous month")
    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      this.calMonth = new Date(this.calMonth.getFullYear(), this.calMonth.getMonth() - 1, 1)
      this.renderCalendar(container)
    })
    navWrap.appendChild(prevBtn)

    const title = document.createElement("span")
    title.className = "idp-cal-title"
    title.textContent = this.calMonth.toLocaleDateString("en-IE", { month: "long", year: "numeric" })
    navWrap.appendChild(title)

    const nextBtn = document.createElement("button")
    nextBtn.className = "idp-cal-nav-btn"
    nextBtn.textContent = "›"
    nextBtn.type = "button"
    nextBtn.setAttribute("aria-label", "Next month")
    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      this.calMonth = new Date(this.calMonth.getFullYear(), this.calMonth.getMonth() + 1, 1)
      this.renderCalendar(container)
    })
    navWrap.appendChild(nextBtn)
    header.appendChild(navWrap)
    container.appendChild(header)

    const weekStart = readActiveWeekStart()
    const dowRow = document.createElement("div")
    dowRow.className = "idp-cal-dow"
    for (const dn of getWeekdayShortLabels(weekStart)) {
      const cell = document.createElement("span")
      cell.textContent = dn
      dowRow.appendChild(cell)
    }
    container.appendChild(dowRow)

    const grid = document.createElement("div")
    grid.className = "idp-cal-grid"

    const year = this.calMonth.getFullYear()
    const month = this.calMonth.getMonth()
    const today = startOfDay(new Date())
    const selected = this.options.value ? startOfDay(this.options.value) : null

    for (const entry of buildCalendarMonthCells(year, month, weekStart)) {
      grid.appendChild(this.createDayCell(entry.date, today, selected, entry.isOutside, container))
    }

    container.appendChild(grid)
  }

  private createDayCell(
    date: Date,
    today: Date,
    selected: Date | null,
    isOutside: boolean,
    calContainer: HTMLElement,
  ): HTMLElement {
    const cell = document.createElement("button")
    cell.className = "idp-cal-day"
    cell.type = "button"
    cell.textContent = String(date.getDate())

    if (isOutside) cell.classList.add("idp-cal-day--outside")
    if (sameDay(date, today)) cell.classList.add("idp-cal-day--today")
    if (selected && sameDay(date, selected)) cell.classList.add("idp-cal-day--selected")

    cell.addEventListener("click", (e) => {
      e.stopPropagation()
      const { date: picked, hasTime } = this.applyTimeToDate(date, this.pendingTime)
      // When time picker is open, allow user to pick time right after picking date; otherwise close immediately
      const keepOpen = Boolean(this.options.enableTime && !this.pendingTime)
      this.commitDate(picked, hasTime, keepOpen)
      if (keepOpen) {
        this.renderCalendar(calContainer)
      }
    })

    return cell
  }
}
