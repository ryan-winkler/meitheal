/**
 * Unified Toast & Persistent Notification System — shared across all pages.
 *
 * Domain: UI Infrastructure (Feedback bounded context)
 *
 * Key Architectural Contracts:
 *   - When visible, `#toast-container` promotes to Top Layer (`popover="manual"`)
 *     unless another popover or unpromoted `<dialog open>` is active;
 *     `hasPriorityOverlay()`, `_modal.css`, and `Layout.astro` `isRealModalOpen()`
 *     exclude `#toast-container` so toasts never block shortcuts or lock scroll.
 *   - Blocking dialogs (`#meitheal-confirm-overlay`, `#meitheal-prompt-overlay`,
 *     `[data-meitheal-tabler-modal].show`, `dialog[open]`) sit above `#toast-container`
 *     (`z-index: 10020` / `10001` + Top Layer).
 *   - Direct children `children[0]` (`.m-toast__icon`, kept via `hidden` even when
 *     `icon === null`) and `children[1]` (`.m-toast__message` plain text) stay
 *     index-invariant for CSS Grid placement and E2E observers.
 *   - Non-error stateless toasts coalesce via `data-repeat-count` CSS `::after` +
 *     `#sync-announcer` announcements; `"error"` toasts stay distinct so repeated
 *     actionable failures are never swallowed.
 *   - Max 5 active toasts (`MAX_ACTIVE_TOASTS`): Pass 1 evicts oldest non-persistent,
 *     non-commit toast; Pass 2 allows uncommitted (`onForceCommit`) toasts if needed;
 *     Pass 3 evicts oldest live item so persistent items cannot overflow bounds.
 *   - Auto-dismiss pauses on mouse hover (capped at `HOVER_PAUSE_MAX_MS = 6000ms`),
 *     focus, drag, and hidden tabs with a `1200ms` resume floor; `pagehide` and
 *     `astro:before-swap` synchronously flush pending `onForceCommit` handlers
 *     (callers using `fetch()` must pass `keepalive: true`).
 *   - Single-arg `window.mI18n.get(key)` resolves against SSR locale catalog.
 */

import { createSpriteIconElement } from "../generated/icon-registry"
import { UNPROMOTED_BLOCKING_OVERLAY_SELECTOR, canRestoreFocusTarget } from "./dialog-overlay"
import { bindSwipeDismiss } from "./swipe-dismiss"

export type ToastType = "success" | "error" | "warning" | "info"
export type ToastIconName = "check" | "x" | "warning" | "info" | "refresh" | "bell"

export interface ToastAction {
  id?: string
  /** i18n key or plain display text */
  label: string
  /** Optional explicit aria-label (i18n key or text); omit when button text changes dynamically */
  ariaLabel?: string
  primary?: boolean
  className?: string
  /** Auto-dismiss the toast after `onClick` completes (default: `true`; pass `false` for in-place progress) */
  closeOnClick?: boolean
  onClick: (event: MouseEvent, handle: ToastHandle) => void | Promise<void>
}

export interface ToastOptions {
  /** Stable identifier; re-pushing an active non-leaving ID updates that toast in place */
  id?: string
  /** i18n key or plain message string */
  message: string
  description?: string
  type?: ToastType
  /** Leading icon name, or `null` to hide (keeps hidden slot at `children[0]`) */
  icon?: ToastIconName | null
  /** Auto-dismiss timeout in ms (defaults: `3500` success/info, `4500` warning, `5500` error; `Infinity` pins) */
  duration?: number
  /** Pin notification (`Infinity` duration) and protect from normal eviction */
  persistent?: boolean
  dismissible?: boolean
  /** Coalesce matching stateless non-error toasts (default: `true`; ignored for `error`/id/action/persistent/description) */
  dedupe?: boolean
  action?: ToastAction
  /** Called once on manual dismiss, swipe, overflow eviction, or closing action click (never with `onAutoClose`) */
  onDismiss?: (() => void) | undefined
  /** Called once on auto-dismiss timeout (mutually exclusive with `onDismiss`) */
  onAutoClose?: (() => void) | undefined
  /** Invoked synchronously once on `pagehide` / `astro:before-swap` to commit pending undo actions */
  onForceCommit?: (() => void) | undefined
}

export interface ToastHandle {
  id: string
  element: HTMLElement
  dismiss: () => void
}

interface ToastRecord {
  id: string
  type: ToastType
  message: string
  description: string
  duration: number
  persistent: boolean
  dismissible: boolean
  hasAction: boolean
  repeatCount: number
  element: HTMLElement
  iconEl: HTMLSpanElement
  messageEl: HTMLSpanElement
  descriptionEl: HTMLSpanElement | null
  actionsEl: HTMLDivElement | null
  dismissEl: HTMLButtonElement | null
  controller: AbortController
  remainingMs: number
  timerId: number | undefined
  hoverTimeoutId: number | undefined
  startedAt: number
  pausedReasons: Set<string>
  leaving: boolean
  settled: boolean
  returnFocus: HTMLElement | null
  onDismiss?: (() => void) | undefined
  onAutoClose?: (() => void) | undefined
  onForceCommit?: (() => void) | undefined
}

const MAX_ACTIVE_TOASTS = 5
const HOVER_PAUSE_MAX_MS = 6000
const EXIT_DURATION_MS = 180
const DEFAULT_DURATIONS: Record<ToastType, number> = {
  success: 3500,
  info: 3500,
  warning: 4500,
  error: 5500,
}
const DEFAULT_ICONS: Record<ToastType, ToastIconName> = {
  success: "check",
  error: "x",
  warning: "warning",
  info: "info",
}

const DEFAULT_FALLBACKS: Record<string, string> = {
  "toast.region_label": "Notifications",
  "toast.dismiss": "Dismiss notification",
  "toast.undo": "Undo",
  "toast.undo_aria": "Undo action",
  "toast.retry": "Retry",
  "toast.retry_aria": "Retry action",
  "common.task_version_conflict": "This task changed in another session. Reload to see the latest version.",
}

const activeRecords = new Map<string, ToastRecord>()
let nextAutoId = 1
let moduleGlobalAc: AbortController | null = null
let moduleInitAc: AbortController | null = null
let onViewportChange: (() => void) | null = null
let announcerRaf: number | undefined
let lastTopToastVisible = false

function normalizeType(value: unknown): ToastType {
  return value === "error" || value === "warning" || value === "info" || value === "success"
    ? value
    : "success"
}

function translate(key: string, fallback?: string): string {
  if (key.includes(".") && !key.includes(" ") && typeof window !== "undefined" && window.mI18n) {
    const resolved = window.mI18n.get(key)
    if (resolved && resolved !== key) return resolved
  }
  return fallback ?? DEFAULT_FALLBACKS[key] ?? key
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** Update the shared polite `#sync-announcer` region (clearing first so retries re-announce). */
export function announceStatus(text: string): void {
  if (typeof document === "undefined") return
  const announcer = document.getElementById("sync-announcer")
  if (!announcer) return
  if (announcerRaf !== undefined) {
    cancelAnimationFrame(announcerRaf)
    announcerRaf = undefined
  }
  announcer.textContent = ""
  if (!text) return
  announcerRaf = requestAnimationFrame(() => {
    announcerRaf = undefined
    if (announcer.isConnected) announcer.textContent = text
  })
}

function getContainer(createIfMissing = true): HTMLElement | null {
  if (typeof document === "undefined") return null
  let container = document.getElementById("toast-container")
  if (!container && createIfMissing) {
    container = document.createElement("section")
    container.id = "toast-container"
    container.className = "toast-container"
    document.body.appendChild(container)
  }
  return container
}

/**
 * Promote `#toast-container` cleanly into Top Layer without jumping above open
 * blocking modals (`dialog[open]`, `[data-meitheal-tabler-modal].show`,
 * `#meitheal-confirm-overlay`, `#meitheal-prompt-overlay`) or other active popovers
 * (`otherOpen`), and omit `aria-label` when empty.
 */
function syncPopoverLayer(container: HTMLElement | null): void {
  if (!container) return
  const hasVisible = activeRecords.size > 0 || container.children.length > 0
  if (hasVisible) {
    const label = container.dataset.regionLabel || translate("toast.region_label")
    if (container.getAttribute("aria-label") !== label) container.setAttribute("aria-label", label)
  } else {
    container.removeAttribute("aria-label")
  }

  if (typeof container.showPopover !== "function") return
  const unpromotedBlocking = document.querySelector(UNPROMOTED_BLOCKING_OVERLAY_SELECTOR)
  const otherOpen = Array.from(document.querySelectorAll("[popover]:popover-open"))
    .some((el) => el !== container)

  // UA CSS hides `[popover]:not(:popover-open)`, so never keep `popover` attached
  // unless Top-Layer promotion is actively open.
  if (!hasVisible || unpromotedBlocking || otherOpen) {
    if (container.matches(":popover-open")) {
      try { container.hidePopover() } catch { /* noop */ }
    }
    container.removeAttribute("popover")
    return
  }

  if (container.getAttribute("popover") !== "manual") {
    container.setAttribute("popover", "manual")
  }
  if (!container.matches(":popover-open")) {
    try {
      container.showPopover()
    } catch {
      container.removeAttribute("popover")
    }
  }
}

export function isSoftwareKeyboardOpen(): boolean {
  if (typeof window === "undefined") return false
  const vv = window.visualViewport
  if (!vv) return false
  const mobileOrCoarse =
    window.innerWidth <= 768 || Boolean(window.matchMedia?.("(pointer: coarse)").matches)
  if (!mobileOrCoarse) return false
  const zoomed = Math.abs(vv.scale - 1) >= 0.05
  return !zoomed && window.innerHeight - vv.height > 120
}

function isMobilePomodoroPanelOpen(): boolean {
  return (
    typeof window !== "undefined" &&
    window.innerWidth <= 768 &&
    Boolean(document.querySelector(".pomodoro-panel:not(.pomodoro-hidden)"))
  )
}

function isTopDocked(container: HTMLElement | null): boolean {
  return (
    Boolean(
      container &&
        (container.dataset.dockTop === "true" || container.dataset.keyboardOpen === "true"),
    ) || isMobilePomodoroPanelOpen()
  )
}

function clearDockState(container: HTMLElement): void {
  delete container.dataset.dockTop
  delete container.dataset.keyboardOpen
  container.style.removeProperty("--toast-vv-top")
  container.style.removeProperty("--toast-vv-max-h")
}

function syncDockState(container: HTMLElement | null): void {
  if (!container || typeof window === "undefined") return
  if (activeRecords.size === 0) {
    clearDockState(container)
    return
  }
  const vv = window.visualViewport
  if (vv && isSoftwareKeyboardOpen()) {
    container.dataset.dockTop = "true"
    container.dataset.keyboardOpen = "true"
    container.style.setProperty("--toast-vv-top", `${Math.max(0, Math.round(vv.offsetTop))}px`)
    container.style.setProperty("--toast-vv-max-h", `${Math.max(120, Math.round(vv.height - 24))}px`)
    return
  }
  if (isMobilePomodoroPanelOpen()) {
    container.dataset.dockTop = "true"
    delete container.dataset.keyboardOpen
    container.style.removeProperty("--toast-vv-top")
    container.style.removeProperty("--toast-vv-max-h")
    return
  }
  clearDockState(container)
}

function notifyDockStateIfChanged(container: HTMLElement | null): void {
  const visible = activeRecords.size > 0 && isTopDocked(container)
  if (visible === lastTopToastVisible) return
  lastTopToastVisible = visible
  document.dispatchEvent(new Event("meitheal:toast-dock-changed"))
}

function syncDockAndNotify(container: HTMLElement | null): void {
  syncDockState(container)
  notifyDockStateIfChanged(container)
}

function detachViewportListener(): void {
  if (!onViewportChange || typeof window === "undefined") return
  window.visualViewport?.removeEventListener("resize", onViewportChange)
  window.visualViewport?.removeEventListener("scroll", onViewportChange)
  window.removeEventListener("resize", onViewportChange)
  onViewportChange = null
}

function flushPendingCommits(): void {
  for (const record of Array.from(activeRecords.values())) {
    if (record.onForceCommit && !record.settled) {
      record.settled = true
      record.onForceCommit()
      finalizeRemoval(record)
    }
  }
}

function ensureGlobalListeners(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return

  if (!moduleGlobalAc || moduleGlobalAc.signal.aborted) {
    window.__meithealToastGlobalAc?.abort()
    moduleGlobalAc = new AbortController()
    window.__meithealToastGlobalAc = moduleGlobalAc
    const { signal } = moduleGlobalAc

    signal.addEventListener("abort", () => {
      if (announcerRaf !== undefined) {
        cancelAnimationFrame(announcerRaf)
        announcerRaf = undefined
      }
      lastTopToastVisible = false
    }, { once: true })

    document.addEventListener("visibilitychange", () => {
      for (const record of activeRecords.values()) {
        if (document.hidden) pauseTimer(record, "hidden")
        else resumeTimer(record, "hidden")
      }
    }, { signal })
    window.addEventListener("pagehide", flushPendingCommits, { signal })
    document.addEventListener("astro:before-swap", flushPendingCommits, { signal })
    for (const overlayEvent of ["meitheal:overlay-opened", "meitheal:overlay-closed"] as const) {
      document.addEventListener(overlayEvent, () => {
        syncPopoverLayer(getContainer(false))
      }, { signal })
    }
    document.addEventListener("meitheal:layout-changed", () => {
      syncDockAndNotify(getContainer(false))
    }, { signal })
    document.addEventListener("toggle", (event) => {
      if (event.target instanceof HTMLElement && event.target.id !== "toast-container" && event.target.hasAttribute("popover")) {
        syncPopoverLayer(getContainer(false))
      }
    }, { capture: true, signal })
    document.addEventListener("close", (event) => {
      if (event.target instanceof HTMLDialogElement) {
        syncPopoverLayer(getContainer(false))
      }
    }, { capture: true, signal })
    for (const eventName of ["astro:after-swap", "astro:page-load"] as const) {
      document.addEventListener(eventName, () => {
        const container = getContainer(false)
        syncPopoverLayer(container)
        syncDockAndNotify(container)
      }, { signal })
    }
  }

  if (!onViewportChange && activeRecords.size > 0) {
    const { signal } = moduleGlobalAc
    onViewportChange = () => {
      syncDockAndNotify(getContainer(false))
      if (activeRecords.size === 0) detachViewportListener()
    }
    window.visualViewport?.addEventListener("resize", onViewportChange, { signal })
    window.visualViewport?.addEventListener("scroll", onViewportChange, { signal })
    window.addEventListener("resize", onViewportChange, { signal })
  }
}

function startTimer(record: ToastRecord, resetDuration = false): void {
  window.clearTimeout(record.timerId)
  record.timerId = undefined
  if (resetDuration) record.remainingMs = record.duration
  if (!Number.isFinite(record.remainingMs) || record.persistent || record.leaving) return
  if (record.pausedReasons.size > 0) return

  record.startedAt = performance.now()
  record.timerId = window.setTimeout(() => {
    record.timerId = undefined
    if (record.leaving) return
    if (!record.settled) {
      record.settled = true
      record.onAutoClose?.()
    }
    removeToastRecord(record)
  }, Math.max(0, record.remainingMs))
}

function pauseTimer(record: ToastRecord, reason: string): void {
  if (!Number.isFinite(record.duration) || record.persistent || record.leaving) return
  if (record.pausedReasons.has(reason)) return
  if (record.pausedReasons.size === 0 && record.timerId !== undefined) {
    const elapsed = performance.now() - record.startedAt
    record.remainingMs = Math.max(1200, record.remainingMs - elapsed)
  }
  record.pausedReasons.add(reason)
  window.clearTimeout(record.timerId)
  record.timerId = undefined
  if (reason === "hover") {
    window.clearTimeout(record.hoverTimeoutId)
    record.hoverTimeoutId = window.setTimeout(() => {
      record.hoverTimeoutId = undefined
      resumeTimer(record, "hover")
    }, HOVER_PAUSE_MAX_MS)
  }
}

function resumeTimer(record: ToastRecord, reason: string): void {
  if (reason === "hover") {
    window.clearTimeout(record.hoverTimeoutId)
    record.hoverTimeoutId = undefined
  }
  if (!record.pausedReasons.delete(reason)) return
  if (record.pausedReasons.size === 0) startTimer(record)
}

function clearTimers(record: ToastRecord): void {
  window.clearTimeout(record.timerId)
  window.clearTimeout(record.hoverTimeoutId)
  record.timerId = undefined
  record.hoverTimeoutId = undefined
}

function finalizeRemoval(record: ToastRecord, options?: { restoreFocus?: boolean }): void {
  record.leaving = true
  clearTimers(record)

  const shouldRestoreFocus = Boolean(
    options?.restoreFocus &&
    record.element.contains(document.activeElement) &&
    canRestoreFocusTarget(record.returnFocus),
  )

  record.controller.abort()
  if (activeRecords.get(record.id) === record) {
    activeRecords.delete(record.id)
  }
  record.element.remove()

  if (shouldRestoreFocus) {
    try { record.returnFocus?.focus({ preventScroll: true }) } catch { /* noop */ }
  }

  const container = getContainer(false)
  if (container && activeRecords.size === 0 && container.children.length === 0) {
    clearDockState(container)
    detachViewportListener()
    syncPopoverLayer(container)
  }
  notifyDockStateIfChanged(container)
}

function removeToastRecord(
  record: ToastRecord,
  options?: { immediate?: boolean; swipeExit?: { x: number; y: number }; restoreFocus?: boolean },
): void {
  const reduced = prefersReducedMotion()
  const immediate = Boolean(options?.immediate || reduced)
  if (record.leaving) {
    if (immediate) finalizeRemoval(record, options)
    return
  }
  record.leaving = true
  clearTimers(record)

  if (!record.settled) {
    record.settled = true
    record.onDismiss?.()
  }

  const el = record.element
  if (!el.isConnected || immediate) {
    finalizeRemoval(record, options)
    return
  }

  el.dataset.toastState = "leaving"
  el.style.pointerEvents = "none"
  if (options?.swipeExit) {
    // Flush after cleanupDrag cleared data-swiping so opacity & exit transform both transition.
    void el.offsetWidth
    el.style.opacity = "0"
    el.style.transform = `translate3d(${options.swipeExit.x}px, ${options.swipeExit.y}px, 0)`
  } else if (isTopDocked(getContainer(false))) {
    el.style.opacity = "0"
    el.style.transform = "translate3d(0, -16px, 0) scale(0.96)"
  } else if (window.innerWidth <= 768) {
    el.style.opacity = "0"
    el.style.transform = "translate3d(0, 16px, 0) scale(0.96)"
  } else {
    el.style.opacity = "0"
    const exitX = document.documentElement.dir === "rtl" ? -20 : 20
    el.style.transform = `translate3d(${exitX}px, 0, 0) scale(0.96)`
  }

  window.setTimeout(() => finalizeRemoval(record, options), EXIT_DURATION_MS)
}

function evictOverflowIfNeeded(): void {
  let live = Array.from(activeRecords.values()).filter((r) => !r.leaving)
  if (live.length < MAX_ACTIVE_TOASTS) return

  // Prefer keeping persistent growlers and uncommitted Undo actions before falling back.
  const passes: Array<(r: ToastRecord) => boolean> = [
    (r) => !r.persistent && !r.onForceCommit,
    (r) => !r.persistent,
    () => true,
  ]
  for (const allow of passes) {
    for (const candidate of live) {
      if (allow(candidate)) {
        removeToastRecord(candidate, { immediate: true })
        live = live.filter((r) => r !== candidate)
        if (live.length < MAX_ACTIVE_TOASTS) return
      }
    }
  }
}

function makeHandle(record: ToastRecord): ToastHandle {
  return {
    id: record.id,
    element: record.element,
    dismiss: () => removeToastRecord(record),
  }
}

function applyIcon(record: ToastRecord, iconName: ToastIconName | null): void {
  if (iconName === null) {
    // Keep children[0] mounted (hidden) so children[1] stays invariant for E2E observers.
    record.iconEl.hidden = true
    record.iconEl.replaceChildren()
    return
  }
  record.iconEl.hidden = false
  record.iconEl.replaceChildren(createSpriteIconElement(iconName, { size: 18 }))
}

function applyAccessibility(el: HTMLElement, type: ToastType): void {
  // Existing E2E contracts assert `getByRole("alert")` on both error and warning toasts.
  const assertive = type === "error" || type === "warning"
  el.setAttribute("role", assertive ? "alert" : "status")
  el.setAttribute("aria-live", assertive ? "assertive" : "polite")
  el.setAttribute("aria-atomic", "true")
}

function buildActionButton(action: ToastAction, record: ToastRecord, handle: ToastHandle, signal: AbortSignal): HTMLButtonElement {
  const btn = document.createElement("button")
  btn.type = "button"
  if (action.id) btn.id = action.id
  const variantClass = action.primary ? "m-toast__action m-toast__action--primary" : "toast-undo m-toast__action"
  btn.className = action.className ? `${variantClass} ${action.className}` : variantClass
  btn.textContent = translate(action.label)
  if (action.ariaLabel) btn.setAttribute("aria-label", translate(action.ariaLabel))
  btn.addEventListener("click", (event) => {
    if (record.leaving) return
    void action.onClick(event, handle)
    if (action.closeOnClick !== false) removeToastRecord(record, { restoreFocus: true })
  }, { signal })
  return btn
}

function syncDescription(record: ToastRecord, desc: string): void {
  record.description = desc
  if (desc) {
    if (!record.descriptionEl) {
      record.descriptionEl = document.createElement("span")
      record.descriptionEl.className = "m-toast__description"
      record.messageEl.after(record.descriptionEl)
    }
    record.descriptionEl.textContent = desc
  } else if (record.descriptionEl) {
    record.descriptionEl.remove()
    record.descriptionEl = null
  }
}

function syncAction(record: ToastRecord, action: ToastAction | undefined, handle: ToastHandle): void {
  record.hasAction = Boolean(action)
  if (action) {
    if (!record.actionsEl) {
      record.actionsEl = document.createElement("div")
      record.actionsEl.className = "m-toast__actions"
      if (record.dismissEl) record.dismissEl.before(record.actionsEl)
      else record.element.appendChild(record.actionsEl)
    }
    record.actionsEl.replaceChildren(buildActionButton(action, record, handle, record.controller.signal))
  } else if (record.actionsEl) {
    record.actionsEl.remove()
    record.actionsEl = null
  }
}

function mountDismissButton(record: ToastRecord): void {
  const dismissEl = document.createElement("button")
  dismissEl.type = "button"
  dismissEl.className = "toast-dismiss"
  dismissEl.setAttribute("aria-label", translate("toast.dismiss"))
  dismissEl.replaceChildren(createSpriteIconElement("x", { size: 16 }))
  dismissEl.addEventListener("click", () => removeToastRecord(record, { restoreFocus: true }), { signal: record.controller.signal })
  record.element.appendChild(dismissEl)
  record.dismissEl = dismissEl
}

function updateRecord(
  record: ToastRecord,
  options: ToastOptions,
  normalized: { type: ToastType; message: string; description: string; persistent: boolean; duration: number },
  handle: ToastHandle,
): void {
  const { type, message, description, persistent, duration } = normalized
  if (record.type !== type) {
    record.type = type
    record.element.classList.remove("success", "error", "warning", "info")
    record.element.classList.add(type)
    applyAccessibility(record.element, type)
  }
  applyIcon(record, options.icon === undefined ? DEFAULT_ICONS[type] : options.icon)
  record.message = message
  record.messageEl.textContent = message
  record.repeatCount = 1
  delete record.element.dataset.repeatCount
  syncDescription(record, description)
  syncAction(record, options.action, handle)

  const dismissible = options.dismissible !== false
  if (dismissible !== record.dismissible) {
    record.dismissible = dismissible
    if (dismissible && !record.dismissEl) {
      mountDismissButton(record)
    } else if (!dismissible && record.dismissEl) {
      record.dismissEl.remove()
      record.dismissEl = null
    }
  }
  record.onDismiss = options.onDismiss
  record.onAutoClose = options.onAutoClose
  record.onForceCommit = options.onForceCommit
  record.persistent = persistent
  record.duration = duration
  if (!record.element.matches(":focus-within")) resumeTimer(record, "focus")
  startTimer(record, true)
  const container = getContainer(false)
  syncPopoverLayer(container)
  syncDockState(container)
}

/** Core unified toast & persistent notification dispatcher */
export function pushToast(options: ToastOptions): ToastHandle {
  const type = normalizeType(options.type)
  const displayMessage = translate(options.message)
  const displayDescription = options.description ? translate(options.description) : ""
  const persistent = Boolean(options.persistent) || options.duration === Infinity
  const duration = persistent ? Infinity : (options.duration ?? DEFAULT_DURATIONS[type])

  if (options.id) {
    const existing = activeRecords.get(options.id)
    if (existing) {
      if (!existing.leaving) {
        const handle = makeHandle(existing)
        updateRecord(existing, options, {
          type,
          message: displayMessage,
          description: displayDescription,
          persistent,
          duration,
        }, handle)
        return handle
      }
      finalizeRemoval(existing)
    }
  }

  // Coalesce rapid identical non-error status toasts without altering children[1] text.
  const canCoalesce = type !== "error" && !options.id && !options.action && !persistent && options.dedupe !== false && !displayDescription
  if (canCoalesce) {
    for (const existing of activeRecords.values()) {
      if (!existing.leaving && !existing.hasAction && !existing.persistent &&
        existing.type === type && existing.message === displayMessage && !existing.description) {
        existing.repeatCount += 1
        existing.element.dataset.repeatCount = String(existing.repeatCount)
        existing.element.classList.remove("m-toast--bumped")
        void existing.element.offsetWidth
        existing.element.classList.add("m-toast--bumped")
        startTimer(existing, true)
        announceStatus(translate("toast.repeated", "{message} ({count} times)")
          .replace("{message}", () => displayMessage)
          .replace("{count}", String(existing.repeatCount)))
        return makeHandle(existing)
      }
    }
  }

  const container = getContainer(true)
  if (!container) {
    return { id: options.id ?? "ssr", element: {} as HTMLElement, dismiss: () => {} }
  }

  evictOverflowIfNeeded()

  const id = options.id ?? `m-toast-${nextAutoId++}`
  const controller = new AbortController()
  const toastEl = document.createElement("div")
  toastEl.className = `toast ${type}`
  toastEl.dataset.toastId = id
  applyAccessibility(toastEl, type)

  // Keep children[0] (icon) and children[1] (message) invariant for E2E observers.
  const iconEl = document.createElement("span")
  iconEl.className = "m-toast__icon"
  iconEl.setAttribute("aria-hidden", "true")
  toastEl.appendChild(iconEl)

  const messageEl = document.createElement("span")
  messageEl.className = "m-toast__message"
  messageEl.textContent = displayMessage
  toastEl.appendChild(messageEl)

  const dismissible = options.dismissible !== false
  const initialIcon = options.icon === undefined ? DEFAULT_ICONS[type] : options.icon

  const record: ToastRecord = {
    id,
    type,
    message: displayMessage,
    description: displayDescription,
    duration,
    persistent,
    dismissible,
    hasAction: Boolean(options.action),
    repeatCount: 1,
    element: toastEl,
    iconEl,
    messageEl,
    descriptionEl: null,
    actionsEl: null,
    dismissEl: null,
    controller,
    remainingMs: duration,
    timerId: undefined,
    hoverTimeoutId: undefined,
    startedAt: performance.now(),
    pausedReasons: new Set(),
    leaving: false,
    settled: false,
    returnFocus: null,
    onDismiss: options.onDismiss,
    onAutoClose: options.onAutoClose,
    onForceCommit: options.onForceCommit,
  }

  const handle = makeHandle(record)
  applyIcon(record, initialIcon)
  if (displayDescription) syncDescription(record, displayDescription)
  if (options.action) syncAction(record, options.action, handle)
  if (dismissible) mountDismissButton(record)

  toastEl.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "mouse") pauseTimer(record, "hover")
  }, { signal: controller.signal })
  toastEl.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse") resumeTimer(record, "hover")
  }, { signal: controller.signal })
  toastEl.addEventListener("focusin", (event) => {
    const related = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null
    if (related) {
      if (!related.closest("#toast-container")) {
        record.returnFocus = related
      } else if (!toastEl.contains(related)) {
        const prevToast = related.closest<HTMLElement>(".toast[data-toast-id]")
        const prevRecord = prevToast?.dataset.toastId ? activeRecords.get(prevToast.dataset.toastId) : undefined
        if (prevRecord?.returnFocus) record.returnFocus = prevRecord.returnFocus
      }
    }
    pauseTimer(record, "focus")
  }, { signal: controller.signal })
  toastEl.addEventListener("focusout", () => {
    if (!toastEl.matches(":focus-within")) resumeTimer(record, "focus")
  }, { signal: controller.signal })
  toastEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && record.dismissible) {
      event.preventDefault()
      event.stopPropagation()
      removeToastRecord(record, { restoreFocus: true })
    }
  }, { signal: controller.signal })

  activeRecords.set(id, record)
  bindSwipeDismiss({
    element: toastEl,
    signal: controller.signal,
    canStart: () => record.dismissible && !record.leaving,
    allowVertical: () => window.innerWidth <= 768 || isTopDocked(getContainer(false)),
    horizontalSign: () => {
      if (window.innerWidth <= 768) return 0
      return document.documentElement.dir === "rtl" ? -1 : 1
    },
    verticalSign: () => (isTopDocked(getContainer(false)) ? -1 : 1),
    onDragStart: () => pauseTimer(record, "swipe"),
    onDragCancel: () => resumeTimer(record, "swipe"),
    onDismiss: (swipeExit) => removeToastRecord(record, { swipeExit }),
  })

  syncDockState(container)
  container.appendChild(toastEl)
  ensureGlobalListeners()
  syncPopoverLayer(container)
  notifyDockStateIfChanged(container)
  if (document.hidden) pauseTimer(record, "hidden")
  startTimer(record)
  return handle
}

/** Show a standard toast notification */
export function showToast(
  message: string,
  type: ToastType = "success",
  options?: Omit<ToastOptions, "message" | "type">,
): ToastHandle {
  return pushToast({ ...options, message, type })
}

/**
 * Show an undo toast for destructive actions (`timeout` defaults to `5000` ms).
 * Commits automatically when the timeout expires, on manual dismiss/overflow eviction
 * without Undo, or synchronously on `pagehide` / `astro:before-swap` (pass `keepalive: true` on `fetch()`).
 */
export function showUndoToast(
  message: string,
  onUndo: () => void,
  onCommit?: () => void,
  timeout = 5000,
): ToastHandle {
  let completed = false
  const commitOnce = () => {
    if (completed) return
    completed = true
    onCommit?.()
  }

  const opts: ToastOptions = {
    message,
    type: "success",
    duration: timeout,
    dedupe: false,
    action: {
      label: "toast.undo",
      ariaLabel: "toast.undo_aria",
      onClick: () => {
        if (completed) return
        completed = true
        onUndo()
      },
    },
    onAutoClose: commitOnce,
    onDismiss: commitOnce,
  }
  if (onCommit) opts.onForceCommit = commitOnce
  return pushToast(opts)
}

/** Show an error toast with a Retry action button */
export function showRetryToast(message: string, onRetry: () => void): ToastHandle {
  return pushToast({
    message,
    type: "error",
    duration: 8000,
    dedupe: false,
    action: {
      label: "toast.retry",
      ariaLabel: "toast.retry_aria",
      onClick: () => onRetry(),
    },
  })
}

/**
 * Show a task-created toast with clickable ticket key (or localized Open fallback)
 * that opens the task via `window.openTaskDetail(taskId)`.
 */
export function showTaskCreatedToast(
  ticketKey: string | null,
  taskId: string,
  title: string,
): ToastHandle {
  const titleChars = Array.from(title)
  const displayTitle = titleChars.length > 48 ? `${titleChars.slice(0, 45).join("")}…` : title
  const message = translate("toast.created_task", "Created: {title}").replace("{title}", () => displayTitle)
  const openLabel = translate("toast.open_task", "Open")
  const actionLabel = ticketKey || openLabel
  const actionAria = ticketKey
    ? translate("toast.open_task_aria", "Open task {key}").replace("{key}", () => ticketKey)
    : translate("toast.open_task_unnamed", "Open task")

  const opts: ToastOptions = {
    message,
    type: "success",
    icon: "check",
    duration: 5000,
    dedupe: false,
  }
  if (taskId || ticketKey) {
    opts.action = {
      label: actionLabel,
      ariaLabel: actionAria,
      className: "m-toast__ticket-btn",
      onClick: () => {
        if (taskId && typeof window.openTaskDetail === "function") {
          window.openTaskDetail(taskId)
        }
      },
    }
  }
  return pushToast(opts)
}

/** Dismiss a specific toast by `id`, or all active toasts when omitted */
export function dismissToast(id?: string): void {
  if (!id) {
    for (const record of Array.from(activeRecords.values())) removeToastRecord(record)
    return
  }
  const record = activeRecords.get(id)
  if (record) removeToastRecord(record)
}

function drainQueues(): void {
  if (typeof window === "undefined") return
  const earlyQueue = window.__meithealToastQueue
  if (Array.isArray(earlyQueue) && earlyQueue.length > 0) {
    window.__meithealToastQueue = []
    for (const item of earlyQueue) {
      if (item && typeof item.message === "string") pushToast(item)
    }
  }
}

/** Register window globals, event bridges, and drain pre-hydration toast queue */
export function initToastSystem(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return
  window.showToast = showToast
  window.__meithealToast = pushToast
  ensureGlobalListeners()
  drainQueues()

  if (moduleInitAc && !moduleInitAc.signal.aborted) return
  window.__meithealToastInitAc?.abort()
  moduleInitAc = new AbortController()
  window.__meithealToastInitAc = moduleInitAc

  document.addEventListener("meitheal:toast", (event) => {
    const detail = (event as CustomEvent<{ message?: unknown; type?: unknown }>).detail
    if (typeof detail?.message !== "string" || !detail.message) return
    pushToast({ message: detail.message, type: normalizeType(detail.type) })
  }, { signal: moduleInitAc.signal })

  document.addEventListener("meitheal:conflict-detected", () => {
    pushToast({
      id: "task-version-conflict",
      message: "common.task_version_conflict",
      type: "warning",
      duration: 6000,
    })
  }, { signal: moduleInitAc.signal })
}
