/**
 * InlineDatePicker — Shared modular date editing component
 *
 * Vanilla JS class (no framework dependencies) for inline date editing.
 * Works anywhere in the app: GANTT sidebar, task cards, detail panels.
 *
 * Display modes:
 * - Date set → formatted date text + ✕ clear button
 * - No date  → 📅 calendar icon placeholder
 *
 * Click opens a floating panel with:
 * - Quick options (Today, Tomorrow, Next Week, etc.)
 * - Mini calendar grid
 *
 * @domain tasks
 * @usage new InlineDatePicker(container, { value, onChange, onClear })
 */

export interface InlineDatePickerOptions {
  /** Current date value (null = no date set) */
  value: Date | null
  /** Called when user selects a date */
  onChange: (date: Date) => void
  /** Called when user clears the date */
  onClear: () => void
  /** Format for display (default: "MMM d") */
  formatFn?: (d: Date) => string
  /** AbortSignal for cleanup */
  signal?: AbortSignal
}

/** Build addEventListener options, only including signal if defined */
function listenerOpts(signal?: AbortSignal): AddEventListenerOptions | undefined {
  return signal ? { signal } : undefined
}

interface QuickOption {
  label: string
  sublabel: string
  date: () => Date
}

const DAY_NAMES = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]

function defaultFormat(d: Date): string {
  return d.toLocaleDateString("en-IE", { day: "numeric", month: "short" })
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

  const tomorrow = addDays(today, 1)
  const nextMon = nextDayOfWeek(today, 1) // Monday
  const nextSat = nextDayOfWeek(today, 6) // Saturday
  const twoWeeks = addDays(today, 14)
  const fourWeeks = addDays(today, 28)
  const eightWeeks = addDays(today, 56)

  const fmt = (d: Date) => d.toLocaleDateString("en-IE", { day: "numeric", month: "short" })

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
  private calMonth: Date
  private trigger: HTMLElement | null = null
  private cleanups: (() => void)[] = []
  private formatFn: (d: Date) => string

  constructor(container: HTMLElement, options: InlineDatePickerOptions) {
    this.container = container
    this.options = options
    this.calMonth = options.value ? new Date(options.value.getFullYear(), options.value.getMonth(), 1) : new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    this.formatFn = options.formatFn || defaultFormat
    this.render()
  }

  /** Update the current value and re-render trigger */
  setValue(date: Date | null) {
    this.options.value = date
    if (date) {
      this.calMonth = new Date(date.getFullYear(), date.getMonth(), 1)
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

  private render() {
    this.container.replaceChildren()
    this.container.classList.add("idp-container")

    if (this.options.value) {
      this.renderDateDisplay()
    } else {
      this.renderPlaceholder()
    }
  }

  private renderDateDisplay() {
    const wrap = document.createElement("span")
    wrap.className = "idp-trigger idp-has-date"
    wrap.title = "Click to change date"

    const text = document.createElement("span")
    text.className = "idp-date-text"
    text.textContent = this.formatFn(this.options.value!)
    wrap.appendChild(text)

    const clear = document.createElement("button")
    clear.className = "idp-clear-btn"
    clear.title = "Remove date"
    clear.setAttribute("aria-label", "Remove scheduled date")
    clear.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`
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
    btn.className = "idp-trigger idp-placeholder"
    btn.title = "Set date"

    // Calendar icon (SVG)
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    svg.setAttribute("width", "14")
    svg.setAttribute("height", "14")
    svg.setAttribute("viewBox", "0 0 14 14")
    svg.setAttribute("fill", "none")
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect")
    rect.setAttribute("x", "1"); rect.setAttribute("y", "2")
    rect.setAttribute("width", "12"); rect.setAttribute("height", "10")
    rect.setAttribute("rx", "2")
    rect.setAttribute("stroke", "currentColor"); rect.setAttribute("stroke-width", "1.2")
    svg.appendChild(rect)
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line")
    line.setAttribute("x1", "1"); line.setAttribute("y1", "5")
    line.setAttribute("x2", "13"); line.setAttribute("y2", "5")
    line.setAttribute("stroke", "currentColor"); line.setAttribute("stroke-width", "1.2")
    svg.appendChild(line)
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle")
    dot.setAttribute("cx", "7"); dot.setAttribute("cy", "9")
    dot.setAttribute("r", "1.5"); dot.setAttribute("fill", "currentColor")
    svg.appendChild(dot)
    btn.appendChild(svg)

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
    const panelHeight = panelRect.height || 320

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
    panel.setAttribute("aria-label", "Choose date")

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
        const date = opt.date()
        this.options.onChange(date)
        this.setValue(date)
      })
      quickSide.appendChild(row)
    }
    panel.appendChild(quickSide)

    // Right side: Calendar
    const calSide = document.createElement("div")
    calSide.className = "idp-calendar"
    this.renderCalendar(calSide)
    panel.appendChild(calSide)

    this.panel = panel
    document.body.appendChild(panel)
    this.clampPanelPosition(panel)
    requestAnimationFrame(() => {
      if (this.panel === panel) this.clampPanelPosition(panel)
    })

    // Close on outside click
    const closeHandler = (e: MouseEvent) => {
      if (!panel.contains(e.target as Node) && !this.container.contains(e.target as Node)) {
        this.closePanel()
      }
    }
    // Delay to avoid immediate close
    setTimeout(() => {
      document.addEventListener("click", closeHandler as EventListener, listenerOpts(this.options.signal))
      this.cleanups.push(() => document.removeEventListener("click", closeHandler as EventListener))
    }, 0)

    // Close on Escape
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.closePanel()
    }
    document.addEventListener("keydown", escHandler as EventListener, listenerOpts(this.options.signal))
    this.cleanups.push(() => document.removeEventListener("keydown", escHandler as EventListener))
  }

  private closePanel() {
    if (this.panel) {
      this.panel.remove()
      this.panel = null
    }
  }

  private renderCalendar(container: HTMLElement) {
    container.replaceChildren()

    // Header: < Month Year >
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
    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      this.calMonth = new Date(this.calMonth.getFullYear(), this.calMonth.getMonth() + 1, 1)
      this.renderCalendar(container)
    })
    navWrap.appendChild(nextBtn)
    header.appendChild(navWrap)
    container.appendChild(header)

    // Day-of-week headers
    const dowRow = document.createElement("div")
    dowRow.className = "idp-cal-dow"
    for (const dn of DAY_NAMES) {
      const cell = document.createElement("span")
      cell.textContent = dn
      dowRow.appendChild(cell)
    }
    container.appendChild(dowRow)

    // Grid
    const grid = document.createElement("div")
    grid.className = "idp-cal-grid"

    const year = this.calMonth.getFullYear()
    const month = this.calMonth.getMonth()
    const firstDay = new Date(year, month, 1)
    const lastDay = new Date(year, month + 1, 0)

    // Start from Monday
    let startOffset = firstDay.getDay() - 1
    if (startOffset < 0) startOffset = 6

    const today = startOfDay(new Date())
    const selected = this.options.value ? startOfDay(this.options.value) : null

    // Fill previous month days
    for (let i = 0; i < startOffset; i++) {
      const d = new Date(year, month, -(startOffset - i - 1))
      const cell = this.createDayCell(d, today, selected, true, container)
      grid.appendChild(cell)
    }

    // Current month days
    for (let day = 1; day <= lastDay.getDate(); day++) {
      const d = new Date(year, month, day)
      const cell = this.createDayCell(d, today, selected, false, container)
      grid.appendChild(cell)
    }

    // Fill remaining cells to complete grid
    const totalCells = startOffset + lastDay.getDate()
    const remaining = (7 - (totalCells % 7)) % 7
    for (let i = 1; i <= remaining; i++) {
      const d = new Date(year, month + 1, i)
      const cell = this.createDayCell(d, today, selected, true, container)
      grid.appendChild(cell)
    }

    container.appendChild(grid)
    if (this.panel && this.panel.isConnected) {
      requestAnimationFrame(() => {
        if (this.panel && this.panel.isConnected) this.clampPanelPosition(this.panel)
      })
    }
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
      const picked = startOfDay(date)
      this.options.onChange(picked)
      this.setValue(picked)
    })

    return cell
  }
}
