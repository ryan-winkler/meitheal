/**
 * recurrence-picker.ts — Google Calendar-style recurrence dropdown + Custom Recurrence modal controller.
 *
 * Shared across NewTaskModal, TaskDetailModal, and RoutinesWorkspace.
 * Imports pure RFC 5545 helpers from `@domains/tasks/recurrence` (zero Node/SQLite deps).
 *
 * @domain tasks
 * @kcs Single shared recurrence UI controller for tasks and routines
 */

import {
  buildGoogleRecurrencePresets,
  cadenceToRRule,
  describeRule,
  parseRRule,
  toRRuleString,
  type RecurrenceRule,
} from "@domains/tasks/recurrence"

export const CUSTOM_RECURRENCE_SENTINEL = "__custom__"

const CODE_BY_DAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const
const DAY_NAMES: Record<string, string> = {
  SU: "Sunday",
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
}
const ORDINAL_WORDS: Record<number, string> = {
  1: "first",
  2: "second",
  3: "third",
  4: "fourth",
  5: "fifth",
  [-1]: "last",
}

export interface RecurrenceSelectOptions {
  allowNone?: boolean
  noneLabel?: string
  anchorDate?: string | Date
  getAnchorDate?: () => string | Date | null | undefined
  onCommit?: (rrule: string) => void
  signal?: AbortSignal
}

function resolveAnchorDate(raw?: string | Date | null): Date {
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const parsed = new Date(`${raw.slice(0, 10)}T12:00:00Z`)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw
  return new Date()
}

function anchorMeta(date: Date) {
  const dow = date.getUTCDay()
  const dayCode = CODE_BY_DAY[dow] ?? "MO"
  const dayName = DAY_NAMES[dayCode] ?? "Monday"
  const dayOfMonth = date.getUTCDate()
  const monthIndex = date.getUTCMonth()
  const monthNumber = monthIndex + 1
  const nth = Math.floor((dayOfMonth - 1) / 7) + 1
  const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), monthIndex + 1, 0)).getUTCDate()
  const ordinalValue = dayOfMonth + 7 > daysInMonth && nth >= 5 ? -1 : nth
  const ordinalWord = ORDINAL_WORDS[ordinalValue] ?? `${nth}th`
  return { dayCode, dayName, dayOfMonth, monthNumber, ordinalValue, ordinalWord }
}

/** Normalize a legacy cadence ("daily", "weekly") or RRULE string into its canonical RRULE (or ""). */
export function normalizeRecurrenceInput(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim()
  if (!trimmed) return ""
  return cadenceToRRule(trimmed) ?? trimmed
}

/**
 * Rebuild a recurrence `<select>` with Google Calendar presets anchored to `anchorDate`
 * and select `value` (inserting a custom labeled option if `value` is not one of the presets).
 */
export function syncRecurrenceSelectValue(
  select: HTMLSelectElement,
  value: string | null | undefined,
  opts: { allowNone?: boolean; noneLabel?: string; anchorDate?: string | Date | null } = {},
): string {
  const allowNone = opts.allowNone ?? true
  const noneLabel = opts.noneLabel ?? "Does not repeat"
  const anchor = resolveAnchorDate(opts.anchorDate)
  const presets = buildGoogleRecurrencePresets(anchor)
  let normalized = normalizeRecurrenceInput(value)
  if (!normalized && !allowNone) {
    normalized = "FREQ=DAILY"
  }

  const fragment = document.createDocumentFragment()
  if (allowNone) {
    fragment.appendChild(new Option(noneLabel, ""))
  }
  for (const preset of presets) {
    fragment.appendChild(new Option(preset.label, preset.value))
  }

  const presetValues = new Set(presets.map((p) => p.value))
  if (normalized && !presetValues.has(normalized)) {
    const customOption = new Option(describeRule(normalized) || normalized, normalized)
    customOption.dataset.customRrule = "1"
    fragment.appendChild(customOption)
  }

  const customTrigger = new Option("Custom…", CUSTOM_RECURRENCE_SENTINEL)
  customTrigger.dataset.customTrigger = "1"
  fragment.appendChild(customTrigger)

  select.replaceChildren(fragment)
  select.value = normalized
  select.dataset.lastRecurrenceValue = normalized
  return normalized
}

/**
 * Open the shared Tabler Custom Recurrence modal and resolve with the chosen canonical RRULE,
 * or `null` if the user cancels.
 */
export function openCustomRecurrenceModal(
  initialValue: string | null | undefined,
  anchorInput?: string | Date | null,
): Promise<string | null> {
  const overlay = document.getElementById("custom-recurrence-overlay")
  if (!overlay) return Promise.resolve(null)

  const intervalEl = overlay.querySelector<HTMLInputElement>("#cr-interval")
  const freqEl = overlay.querySelector<HTMLSelectElement>("#cr-freq")
  const weeklySection = overlay.querySelector<HTMLElement>("#cr-weekly-section")
  const monthlySection = overlay.querySelector<HTMLElement>("#cr-monthly-section")
  const monthlyModeEl = overlay.querySelector<HTMLSelectElement>("#cr-monthly-mode")
  const dayButtons = Array.from(overlay.querySelectorAll<HTMLButtonElement>(".cr-day-btn"))
  const endsNever = overlay.querySelector<HTMLInputElement>("#cr-ends-never")
  const endsOn = overlay.querySelector<HTMLInputElement>("#cr-ends-on")
  const endsAfter = overlay.querySelector<HTMLInputElement>("#cr-ends-after")
  const untilInput = overlay.querySelector<HTMLInputElement>("#cr-until-date")
  const countInput = overlay.querySelector<HTMLInputElement>("#cr-count")
  const timeInput = overlay.querySelector<HTMLInputElement>("#cr-time")
  const timeClearBtn = overlay.querySelector<HTMLButtonElement>("#cr-time-clear")
  const previewEl = overlay.querySelector<HTMLElement>("#cr-preview")
  const doneBtn = overlay.querySelector<HTMLButtonElement>("#cr-done-btn")
  const cancelBtn = overlay.querySelector<HTMLButtonElement>("#cr-cancel-btn")
  const closeBtn = overlay.querySelector<HTMLButtonElement>("#cr-close-btn")

  if (!intervalEl || !freqEl || !doneBtn || !cancelBtn || !closeBtn) {
    return Promise.resolve(null)
  }

  const anchor = resolveAnchorDate(anchorInput)
  const meta = anchorMeta(anchor)
  const parsed = parseRRule(normalizeRecurrenceInput(initialValue))

  // Update monthly option labels for the anchor date
  if (monthlyModeEl) {
    monthlyModeEl.replaceChildren(
      new Option(`Monthly on day ${meta.dayOfMonth}`, "day"),
      new Option(`Monthly on the ${meta.ordinalWord} ${meta.dayName}`, "ordinal"),
    )
  }

  // Hydrate initial state
  const initFreq = parsed?.freq ?? "WEEKLY"
  const initInterval = parsed?.interval ?? 1
  freqEl.value = initFreq
  intervalEl.value = String(initInterval)

  const initialDays = new Set<string>(
    initFreq === "WEEKLY" && parsed?.byDay?.length ? parsed.byDay : [meta.dayCode],
  )
  for (const btn of dayButtons) {
    const code = btn.dataset.day ?? ""
    btn.setAttribute("aria-pressed", String(initialDays.has(code)))
  }

  if (monthlyModeEl) {
    const hasOrdinal = Boolean(parsed?.byDayEntries?.some((entry) => entry.ordinal !== null))
    monthlyModeEl.value = hasOrdinal ? "ordinal" : "day"
  }

  if (timeInput) {
    if (parsed?.byHour !== undefined) {
      const hh = String(parsed.byHour).padStart(2, "0")
      const mm = String(parsed.byMinute ?? 0).padStart(2, "0")
      timeInput.value = `${hh}:${mm}`
    } else {
      timeInput.value = ""
    }
  }

  const defaultUntil = new Date(anchor.getTime())
  defaultUntil.setUTCMonth(defaultUntil.getUTCMonth() + 3)
  const defaultUntilIso = defaultUntil.toISOString().slice(0, 10)

  if (parsed?.until) {
    if (endsOn) endsOn.checked = true
    if (untilInput) untilInput.value = parsed.until.slice(0, 10)
    if (countInput) countInput.value = "13"
  } else if (parsed?.count) {
    if (endsAfter) endsAfter.checked = true
    if (countInput) countInput.value = String(parsed.count)
    if (untilInput) untilInput.value = defaultUntilIso
  } else {
    if (endsNever) endsNever.checked = true
    if (untilInput) untilInput.value = defaultUntilIso
    if (countInput) countInput.value = "13"
  }

  const updateFreqPluralLabels = () => {
    const n = Math.max(1, Number.parseInt(intervalEl.value || "1", 10) || 1)
    const labels: Record<string, [string, string]> = {
      DAILY: ["day", "days"],
      WEEKLY: ["week", "weeks"],
      MONTHLY: ["month", "months"],
      YEARLY: ["year", "years"],
    }
    for (const option of Array.from(freqEl.options)) {
      const pair = labels[option.value]
      if (pair) option.textContent = n === 1 ? pair[0] : pair[1]
    }
  }

  const buildRuleFromForm = (): RecurrenceRule => {
    const freq = (freqEl.value as RecurrenceRule["freq"]) || "WEEKLY"
    const interval = Math.min(999, Math.max(1, Number.parseInt(intervalEl.value || "1", 10) || 1))
    const rule: RecurrenceRule = { freq, interval }

    if (freq === "WEEKLY") {
      const pickedDays = dayButtons
        .filter((btn) => btn.getAttribute("aria-pressed") === "true")
        .map((btn) => btn.dataset.day ?? "")
        .filter(Boolean)
      rule.byDay = pickedDays.length > 0 ? pickedDays : [meta.dayCode]
    } else if (freq === "MONTHLY") {
      if (monthlyModeEl?.value === "ordinal") {
        rule.byDayEntries = [{ ordinal: meta.ordinalValue, day: meta.dayCode }]
        rule.byDay = [meta.dayCode]
      } else {
        rule.byMonthDay = [meta.dayOfMonth]
      }
    } else if (freq === "YEARLY") {
      rule.byMonth = [meta.monthNumber]
      rule.byMonthDay = [meta.dayOfMonth]
    }

    if (timeInput?.value) {
      const match = /^(\d{1,2}):(\d{2})$/.exec(timeInput.value.trim())
      if (match) {
        const hour = Number(match[1])
        const minute = Number(match[2])
        if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
          rule.byHour = hour
          rule.byMinute = minute
        }
      }
    }

    if (endsOn?.checked && untilInput?.value && /^\d{4}-\d{2}-\d{2}$/.test(untilInput.value)) {
      rule.until = untilInput.value
    } else if (endsAfter?.checked) {
      const count = Math.min(999, Math.max(1, Number.parseInt(countInput?.value || "1", 10) || 1))
      rule.count = count
    }
    return rule
  }

  const refreshVisibilityAndPreview = () => {
    const freq = freqEl.value
    if (weeklySection) weeklySection.hidden = freq !== "WEEKLY"
    if (monthlySection) monthlySection.hidden = freq !== "MONTHLY"
    if (untilInput) untilInput.disabled = !endsOn?.checked
    if (countInput) countInput.disabled = !endsAfter?.checked
    if (timeClearBtn) timeClearBtn.hidden = !timeInput?.value
    updateFreqPluralLabels()
    if (previewEl) {
      previewEl.textContent = describeRule(buildRuleFromForm())
    }
  }

  refreshVisibilityAndPreview()
  overlay.hidden = false
  const prevFocus = document.activeElement as HTMLElement | null
  intervalEl.focus()

  return new Promise<string | null>((resolve) => {
    const ac = new AbortController()
    const { signal } = ac
    let settled = false

    const cleanup = (result: string | null) => {
      if (settled) return
      settled = true
      ac.abort()
      overlay.hidden = true
      prevFocus?.focus?.()
      resolve(result)
    }

    intervalEl.addEventListener("input", refreshVisibilityAndPreview, { signal })
    freqEl.addEventListener("change", refreshVisibilityAndPreview, { signal })
    monthlyModeEl?.addEventListener("change", refreshVisibilityAndPreview, { signal })
    for (const radio of [endsNever, endsOn, endsAfter]) {
      radio?.addEventListener("change", refreshVisibilityAndPreview, { signal })
    }
    untilInput?.addEventListener("change", refreshVisibilityAndPreview, { signal })
    countInput?.addEventListener("input", refreshVisibilityAndPreview, { signal })
    timeInput?.addEventListener("input", refreshVisibilityAndPreview, { signal })
    timeInput?.addEventListener("change", refreshVisibilityAndPreview, { signal })
    timeClearBtn?.addEventListener(
      "click",
      () => {
        if (timeInput) timeInput.value = ""
        refreshVisibilityAndPreview()
      },
      { signal },
    )

    for (const btn of dayButtons) {
      btn.addEventListener(
        "click",
        () => {
          const isPressed = btn.getAttribute("aria-pressed") === "true"
          const pressedCount = dayButtons.filter(
            (b) => b.getAttribute("aria-pressed") === "true",
          ).length
          // Prevent deselecting the last remaining day
          if (isPressed && pressedCount <= 1) return
          btn.setAttribute("aria-pressed", String(!isPressed))
          refreshVisibilityAndPreview()
        },
        { signal },
      )
    }

    doneBtn.addEventListener(
      "click",
      () => {
        const rrule = toRRuleString(buildRuleFromForm())
        cleanup(rrule)
      },
      { signal },
    )
    cancelBtn.addEventListener("click", () => cleanup(null), { signal })
    closeBtn.addEventListener("click", () => cleanup(null), { signal })
    overlay.addEventListener(
      "click",
      (event) => {
        if (event.target === overlay) cleanup(null)
      },
      { signal },
    )
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          event.stopPropagation()
          cleanup(null)
        }
      },
      { signal, capture: true },
    )
  })
}

/**
 * Enhance any `<select>` element into a Google Calendar-style recurrence selector
 * backed by the shared Custom Recurrence modal.
 */
export function enhanceRecurrenceSelect(
  select: HTMLSelectElement | null,
  opts: RecurrenceSelectOptions = {},
): {
  syncValue: (value: string | null | undefined, anchorDate?: string | Date | null) => string
  refreshPresets: () => void
} {
  if (!select) {
    return {
      syncValue: () => "",
      refreshPresets: () => {},
    }
  }

  const allowNone = opts.allowNone ?? true
  const noneLabel = opts.noneLabel ?? "Does not repeat"
  const readAnchor = () => opts.getAnchorDate?.() ?? opts.anchorDate ?? new Date()

  const syncValue = (value: string | null | undefined, explicitAnchor?: string | Date | null) =>
    syncRecurrenceSelectValue(select, value, {
      allowNone,
      noneLabel,
      anchorDate: explicitAnchor ?? readAnchor(),
    })

  const refreshPresets = () => {
    const current = select.value === CUSTOM_RECURRENCE_SENTINEL
      ? select.dataset.lastRecurrenceValue ?? ""
      : select.value
    syncValue(current)
  }

  // Initial hydration
  syncValue(select.value)

  if (select.dataset.recurrencePickerBound !== "1") {
    select.dataset.recurrencePickerBound = "1"
    const listenerOpts = opts.signal ? { signal: opts.signal } : undefined
    if (opts.signal) {
      opts.signal.addEventListener(
        "abort",
        () => {
          delete select.dataset.recurrencePickerBound
        },
        { once: true },
      )
    }

    select.addEventListener(
      "change",
      (event) => {
        if (select.value !== CUSTOM_RECURRENCE_SENTINEL) {
          select.dataset.lastRecurrenceValue = select.value
          opts.onCommit?.(select.value)
          return
        }
        event.stopImmediatePropagation()
        const previous = select.dataset.lastRecurrenceValue ?? (allowNone ? "" : "FREQ=DAILY")
        select.value = previous
        void openCustomRecurrenceModal(previous, readAnchor()).then((result) => {
          if (!result) return
          const committed = syncValue(result)
          opts.onCommit?.(committed)
          select.dispatchEvent(new Event("change", { bubbles: true }))
        })
      },
      listenerOpts,
    )
  }

  return { syncValue, refreshPresets }
}
