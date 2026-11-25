/**
 * Tabler Date & Time Picker Enhancer — DRY progressive enhancement over native
 * <input type="date"> and <input type="datetime-local"> controls.
 *
 * Wraps native inputs with Meitheal's shared InlineDatePicker (directly typable
 * Tabler input + calendar + optional time picker popover) while preserving native
 * FormData submission, programmatic `.value` updates, `disabled` state, and events.
 *
 * @domain tasks (shared UI progressive enhancement)
 */

import { InlineDatePicker } from "../components/shared/InlineDatePicker"
import {
  formatIsoDateLocal,
  formatIsoDateTimeLocal,
  formatTablerDateDisplay,
  hasNonMidnightTime,
  parseIsoDateLocal,
} from "./date-time-parser"

export {
  formatIsoDateLocal,
  formatIsoDateTimeLocal,
  formatTablerDateDisplay,
  formatTimeHHMM,
  hasNonMidnightTime,
  parseFlexibleDateInput,
  parseIsoDateLocal,
} from "./date-time-parser"

export interface TablerDatePickerOptions {
  placeholder?: string
  compact?: boolean
  enableTime?: boolean
  editable?: boolean
}

export function attachTablerDatePicker(
  input: HTMLInputElement,
  signal: AbortSignal,
  options: TablerDatePickerOptions = {},
): InlineDatePicker | null {
  if (signal.aborted || input.dataset.tablerDatePicker === "ready" || input.dataset.nativeDate === "true") {
    return null
  }
  input.dataset.tablerDatePicker = "ready"

  const isDateTime = input.type === "datetime-local" || options.enableTime === true || input.dataset.enableTime === "true"
  const editable = options.editable !== false

  const host = document.createElement("div")
  host.className = options.compact
    ? "idp-field-host idp-field-host--compact"
    : "idp-field-host"
  if (input.className.includes("cr-end-input")) {
    host.classList.add("cr-end-input")
  }
  host.setAttribute("role", "group")
  const ariaLabel = input.getAttribute("aria-label")
    || (input.id ? document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(input.id)}"]`)?.textContent?.trim() : undefined)
    || undefined
  if (ariaLabel) host.setAttribute("aria-label", ariaLabel)

  input.classList.add("sr-only")
  input.tabIndex = -1
  input.setAttribute("aria-hidden", "true")
  input.insertAdjacentElement("afterend", host)

  const placeholder =
    options.placeholder ||
    input.dataset.placeholder ||
    input.getAttribute("placeholder") ||
    (isDateTime ? "Select date & time" : "Select date")

  let syncingFromPicker = false
  const nativeDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")

  const getNativeValue = (): string =>
    nativeDescriptor?.get ? String(nativeDescriptor.get.call(input) ?? "") : input.value

  const setNativeValue = (val: string) => {
    if (nativeDescriptor?.set) {
      nativeDescriptor.set.call(input, val)
    } else {
      input.value = val
    }
  }

  const syncDisabled = () => {
    host.classList.toggle("idp-field-host--disabled", input.disabled)
    host.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input").forEach((ctrl) => {
      ctrl.disabled = input.disabled
    })
  }

  const initialDate = parseIsoDateLocal(getNativeValue())
  const picker = new InlineDatePicker(host, {
    value: initialDate,
    placeholderText: placeholder,
    showIconWithDate: true,
    editable,
    enableTime: isDateTime,
    hasTime: Boolean(isDateTime && initialDate && (input.type === "datetime-local" || hasNonMidnightTime(initialDate))),
    ariaLabel,
    formatFn: (d, hasTime) => formatTablerDateDisplay(d, Boolean(isDateTime && (hasTime || input.type === "datetime-local"))),
    signal,
    onChange: (date, meta) => {
      if (input.disabled) return
      syncingFromPicker = true
      const nextVal = input.type === "datetime-local"
        ? formatIsoDateTimeLocal(date)
        : (isDateTime && meta?.hasTime ? formatIsoDateTimeLocal(date) : formatIsoDateLocal(date))
      setNativeValue(nextVal)
      syncingFromPicker = false
      input.dispatchEvent(new Event("input", { bubbles: true }))
      input.dispatchEvent(new Event("change", { bubbles: true }))
    },
    onClear: () => {
      if (input.disabled) return
      syncingFromPicker = true
      setNativeValue("")
      syncingFromPicker = false
      input.dispatchEvent(new Event("input", { bubbles: true }))
      input.dispatchEvent(new Event("change", { bubbles: true }))
    },
  })

  syncDisabled()

  if (nativeDescriptor?.get && nativeDescriptor?.set) {
    Object.defineProperty(input, "value", {
      configurable: true,
      get() {
        return nativeDescriptor.get!.call(this)
      },
      set(next: string) {
        nativeDescriptor.set!.call(this, next)
        if (!syncingFromPicker && !signal.aborted) {
          const parsed = parseIsoDateLocal(next)
          picker.setValue(parsed, Boolean(isDateTime && parsed && (input.type === "datetime-local" || hasNonMidnightTime(parsed))))
          syncDisabled()
        }
      },
    })
  }

  const observer = new MutationObserver(() => {
    if (!signal.aborted) syncDisabled()
  })
  observer.observe(input, { attributes: true, attributeFilter: ["disabled"] })

  input.addEventListener("change", () => {
    if (!syncingFromPicker && !signal.aborted) {
      const parsed = parseIsoDateLocal(getNativeValue())
      picker.setValue(parsed, Boolean(isDateTime && parsed && (input.type === "datetime-local" || hasNonMidnightTime(parsed))))
      syncDisabled()
    }
  }, { signal })

  input.form?.addEventListener("reset", () => {
    queueMicrotask(() => {
      if (!signal.aborted) {
        const parsed = parseIsoDateLocal(getNativeValue())
        picker.setValue(parsed, Boolean(isDateTime && parsed && (input.type === "datetime-local" || hasNonMidnightTime(parsed))))
        syncDisabled()
      }
    })
  }, { signal })

  signal.addEventListener("abort", () => {
    observer.disconnect()
    picker.destroy()
    host.remove()
    input.classList.remove("sr-only")
    input.removeAttribute("aria-hidden")
    input.tabIndex = 0
    delete input.dataset.tablerDatePicker
  }, { once: true })

  return picker
}

/** Upgrade all <input type="date"> and <input type="datetime-local"> controls inside root. */
export function initTablerDatePickers(root: ParentNode, signal: AbortSignal): void {
  if (signal.aborted) return
  const inputs = root.querySelectorAll<HTMLInputElement>(
    'input[type="date"]:not([data-native-date="true"]), input[type="datetime-local"]:not([data-native-date="true"])',
  )
  inputs.forEach((input) => {
    const compact = Boolean(input.closest(".table-created-range, .td-fields, .cr-end-option"))
    attachTablerDatePicker(input, signal, { compact })
  })
}
