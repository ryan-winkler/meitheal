import { getClientLocale, t } from "../../i18n/translations"
import {
  activatePinUpdate, PinAccessError, pinsInvalidated, readTaskPin, setTaskPin, supportsPersonalPins,
  watchPinLease, type PinLease,
} from "../task-pin-client"

export function initModalTaskPin(overlay: HTMLElement, signal: AbortSignal, changed: () => void) {
  const button = overlay.querySelector<HTMLButtonElement>("#td-pin-action")
  const retry = overlay.querySelector<HTMLButtonElement>("#td-pin-refresh")
  const status = overlay.querySelector<HTMLElement>("#td-pin-status")
  let selected: { id: string; signal: AbortSignal } | undefined
  let operation: AbortController | undefined
  let stopLease: (() => void) | undefined
  let lease: PinLease | undefined
  let writing = false
  let retryRequired = false
  let updateRequired = false
  let afterWrite: (() => void) | undefined
  let interaction = performance.now()

  const text = (key: string) => t(`pins.${key}`, getClientLocale())
  const relevant = (task = selected) => task && task === selected && !task.signal.aborted && !signal.aborted
    && document.visibilityState !== "hidden" && document.hasFocus()

  function show(message = "", canRetry = false, activate = false) {
    if (status) { status.textContent = message; status.hidden = !message }
    if (retry) { retry.hidden = !canRetry; retry.textContent = text(activate ? "activate" : "refresh") }
    updateRequired = activate
  }

  function withdraw() {
    operation?.abort()
    operation = undefined
    stopLease?.()
    stopLease = undefined
    lease = undefined
    if (button) {
      if (document.activeElement === button && relevant()) overlay.querySelector<HTMLElement>("#td-close")?.focus()
      button.hidden = true
      button.setAttribute("aria-pressed", "false")
    }
  }

  function failed(error?: unknown, broadcast = true) {
    withdraw()
    retryRequired = true
    const kind = error instanceof PinAccessError ? error.kind : "network"
    if (kind === "account" && broadcast) window.dispatchEvent(new Event(pinsInvalidated))
    show(text(kind === "update" ? "update" : kind === "account" ? "account" : "connection"), true, kind === "update")
  }

  async function read(expected?: PinLease, notice?: string, focus = false) {
    const task = selected
    if (!task || !relevant(task) || !supportsPersonalPins() || !button) return
    withdraw()
    retryRequired = false
    const current = new AbortController()
    operation = current
    show()
    try {
      const result = await readTaskPin(task.id, AbortSignal.any([task.signal, signal, current.signal]), expected)
      if (!relevant(task) || operation !== current) return
      if (result.value.id !== task.id || typeof result.value.pinned !== "boolean") throw new PinAccessError("network")
      lease = result.lease
      stopLease = watchPinLease(result.lease, AbortSignal.any([signal, task.signal]), () => interaction,
        refreshed => { lease = refreshed }, failed)
      button.setAttribute("aria-pressed", String(result.value.pinned))
      button.hidden = false
      button.disabled = false
      show(notice)
      if (focus) button.focus()
    } catch (error) {
      if (operation === current && relevant(task)) failed(error)
    }
  }

  button?.addEventListener("click", async () => {
    const task = selected
    const verified = lease
    const active = operation
    if (!task || !verified || !active || writing || !relevant(task)) return
    const desired = button.getAttribute("aria-pressed") !== "true"
    writing = true
    button.disabled = true
    try {
      await setTaskPin(task.id, desired, verified, AbortSignal.any([task.signal, signal, active.signal]))
      changed()
      if (operation === active && relevant(task)) await read(verified, text(desired ? "saved" : "removed"), true)
    } catch (error) {
      changed()
      if (operation === active && relevant(task)) failed(error)
    } finally {
      writing = false
      if (relevant(task) && !button.hidden) button.disabled = false
      const next = afterWrite
      afterWrite = undefined
      if (!signal.aborted) next?.()
      if (!next) resume()
    }
  }, { signal })

  retry?.addEventListener("click", async () => {
    if (writing || !relevant()) return
    if (!updateRequired) { await read(undefined, undefined, true); return }
    retry.disabled = true
    try {
      if (!await activatePinUpdate(signal)) show(text("update"), true, true)
    } catch {
      show(text("update"), true, true)
    } finally { retry.disabled = false }
  }, { signal })
  const touch = () => { interaction = performance.now() }
  for (const event of ["pointerdown", "keydown", "focusin"]) overlay.addEventListener(event, touch, { signal })
  const suspend = () => { withdraw(); if (!retryRequired) show() }
  const resume = () => { if (relevant() && !operation && !retryRequired && !writing) { touch(); void read() } }
  window.addEventListener("blur", suspend, { signal })
  window.addEventListener("focus", resume, { signal })
  window.addEventListener("pagehide", suspend, { signal })
  window.addEventListener("pageshow", resume, { signal })
  window.addEventListener(pinsInvalidated, () => {
    if (selected && !selected.signal.aborted) failed(new PinAccessError("account"), false)
  }, { signal })
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" ? suspend() : resume(), { signal })
  navigator.serviceWorker?.addEventListener("controllerchange", () => {
    const canReload = updateRequired || !retryRequired
    withdraw()
    if (canReload) { retryRequired = false; resume() }
  }, { signal })
  signal.addEventListener("abort", withdraw, { once: true })

  return {
    opening() {
      selected = undefined
      withdraw()
      retryRequired = false
      show()
    },
    loaded(id: string, modalSignal: AbortSignal) {
      selected = { id, signal: modalSignal }
      resume()
    },
    waitForWrite(next: () => void) {
      if (!writing) return false
      afterWrite = next
      return true
    },
  }
}
