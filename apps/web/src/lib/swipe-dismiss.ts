/**
 * Shared 1:1 Pointer Events swipe-to-dismiss helper for toasts and top banners.
 *
 * Domain: UI Infrastructure (Feedback / Gestures)
 *
 * Features:
 *   - 8px movement slop before locking an axis or suppressing clicks
 *   - Bilateral 24px viewport edge guard so OS / HA Companion edge swipes are never hijacked
 *   - Skips interactive descendants (`button, a, input, select, textarea`)
 *   - Measures flick velocity from drag lock time (not `pointerdown`)
 *   - Clears `data-swiping`, timers, and listeners on `pointercancel`, `lostpointercapture`,
 *     and external `signal` abort (note: `onDismiss` runs right after clearing `data-swiping`,
 *     so callers animating an exit should force reflow via `void element.offsetWidth`).
 */

const SWIPE_SLOP_PX = 8
const SWIPE_EDGE_GUARD_PX = 24
const SWIPE_VELOCITY_THRESHOLD = 0.35

export interface SwipeDismissOptions {
  element: HTMLElement
  signal?: AbortSignal | undefined
  /** Optional predicate checked before starting and during moves (default: always true) */
  canStart?: (() => boolean) | undefined
  /** Allow horizontal swipe dismissal (default: `true`) */
  allowHorizontal?: boolean | undefined
  /** Allow vertical swipe dismissal (default: `() => true`) */
  allowVertical?: (() => boolean) | undefined
  /** Horizontal swipe direction lock: 1 for right-only, -1 for left-only, 0 for bidirectional (default: -1 when `document.documentElement.dir === "rtl"`, else 1) */
  horizontalSign?: (() => number) | undefined
  /** Vertical swipe direction lock: 1 for down-only, -1 for up-only (default: `() => 1`) */
  verticalSign?: (() => number) | undefined
  /** Vertical commit distance threshold in px (default: `40`; flick commits at `>= 12px` & `> 0.35 px/ms`, horizontal `>= 16px`) */
  verticalThreshold?: number | undefined
  onDragStart?: (() => void) | undefined
  onDragCancel?: (() => void) | undefined
  /** Invoked when swipe crosses distance or velocity threshold; `data-swiping` is cleared beforehand */
  onDismiss: (exitVector: { x: number; y: number }) => void
}

function shouldCommitSwipe(
  delta: number,
  sign: number,
  distanceThreshold: number,
  minFlickDistance: number,
  elapsedMs: number,
): boolean {
  const dirOk = sign === 0 || delta * sign > 0
  if (!dirOk) return false
  const abs = Math.abs(delta)
  return abs >= distanceThreshold || (abs >= minFlickDistance && abs / elapsedMs > SWIPE_VELOCITY_THRESHOLD)
}

export function bindSwipeDismiss(options: SwipeDismissOptions): void {
  const {
    element,
    signal,
    canStart,
    allowHorizontal = true,
    allowVertical = () => true,
    horizontalSign = () => (document.documentElement.dir === "rtl" ? -1 : 1),
    verticalSign = () => 1,
    verticalThreshold = 40,
    onDragStart,
    onDragCancel,
    onDismiss,
  } = options

  let activePointerId: number | null = null
  let suppressClick = false
  let clickResetTimer = 0
  const downOpts: AddEventListenerOptions | undefined = signal ? { signal } : undefined
  const clickOpts: AddEventListenerOptions = signal ? { capture: true, signal } : { capture: true }
  signal?.addEventListener("abort", () => {
    suppressClick = false
    window.clearTimeout(clickResetTimer)
  }, { once: true })

  element.addEventListener("pointerdown", (e: PointerEvent) => {
    if (canStart && !canStart()) return
    if (e.button !== 0 || activePointerId !== null) return
    if (e.clientX < SWIPE_EDGE_GUARD_PX || e.clientX > window.innerWidth - SWIPE_EDGE_GUARD_PX) return
    const target = e.target instanceof Element ? e.target : null
    if (target?.closest("button, a, input, select, textarea")) return

    activePointerId = e.pointerId
    const startX = e.clientX
    const startY = e.clientY
    const dragAc = new AbortController()
    const dragSignal = signal ? AbortSignal.any([signal, dragAc.signal]) : dragAc.signal

    let lockedAxis: "x" | "y" | null = null
    let dragStartTime = 0
    let lastDx = 0
    let lastDy = 0

    const resetVisuals = () => {
      element.style.transform = ""
      element.style.opacity = ""
    }

    const cleanupDrag = () => {
      activePointerId = null
      delete element.dataset.swiping
      dragAc.abort()
    }

    const abortDrag = () => {
      const wasLocked = lockedAxis !== null
      cleanupDrag()
      resetVisuals()
      if (wasLocked) onDragCancel?.()
    }

    window.addEventListener("pointermove", (mv: PointerEvent) => {
      if (mv.pointerId !== activePointerId) return
      if (canStart && !canStart()) {
        abortDrag()
        return
      }

      const dx = mv.clientX - startX
      const dy = mv.clientY - startY

      if (!lockedAxis) {
        const absX = Math.abs(dx)
        const absY = Math.abs(dy)
        if (absX < SWIPE_SLOP_PX && absY < SWIPE_SLOP_PX) return

        const canX = allowHorizontal
        const canY = allowVertical()
        if (!canX && !canY) {
          cleanupDrag()
          return
        }
        if (canX && !canY && absY > absX) {
          cleanupDrag()
          return
        }
        if (canY && !canX && absX > absY) {
          cleanupDrag()
          return
        }

        lockedAxis = canX && (!canY || absX >= absY) ? "x" : "y"
        dragStartTime = performance.now()
        element.dataset.swiping = "true"
        onDragStart?.()
        try { element.setPointerCapture(mv.pointerId) } catch { /* pointer may have left */ }
      }

      if (lockedAxis === "x") {
        const hSign = horizontalSign()
        const resisted = hSign !== 0 && dx * hSign < 0
        const visualDx = resisted ? dx * 0.22 : dx
        lastDx = visualDx
        lastDy = 0
        const fade = Math.max(0.25, 1 - Math.abs(visualDx) / Math.max(140, element.offsetWidth * 0.7))
        element.style.transform = `translate3d(${visualDx}px, 0, 0)`
        element.style.opacity = String(fade)
      } else {
        const vSign = verticalSign()
        const visualDy = dy * vSign >= 0 ? dy : dy * 0.22
        lastDx = 0
        lastDy = visualDy
        const fade = Math.max(0.3, 1 - Math.abs(visualDy) / 96)
        element.style.transform = `translate3d(0, ${visualDy}px, 0)`
        element.style.opacity = String(fade)
      }
    }, { signal: dragSignal })

    window.addEventListener("pointerup", (up: PointerEvent) => {
      if (up.pointerId !== activePointerId) return
      const axis = lockedAxis
      cleanupDrag()
      if (!axis) return

      suppressClick = true
      window.clearTimeout(clickResetTimer)
      clickResetTimer = window.setTimeout(() => { suppressClick = false }, 50)

      const elapsed = Math.max(1, performance.now() - dragStartTime)
      if (axis === "x") {
        const threshold = Math.min(88, Math.max(56, element.offsetWidth * 0.3))
        if (shouldCommitSwipe(lastDx, horizontalSign(), threshold, 16, elapsed)) {
          const exitX = (lastDx >= 0 ? 1 : -1) * Math.max(element.offsetWidth + 24, 180)
          onDismiss({ x: exitX, y: 0 })
          return
        }
      } else {
        const vSign = verticalSign()
        if (shouldCommitSwipe(lastDy, vSign, verticalThreshold, 12, elapsed)) {
          onDismiss({ x: 0, y: vSign * 84 })
          return
        }
      }

      resetVisuals()
      onDragCancel?.()
    }, { signal: dragSignal })

    window.addEventListener("pointercancel", (cancel: PointerEvent) => {
      if (cancel.pointerId === activePointerId) abortDrag()
    }, { signal: dragSignal })

    element.addEventListener("lostpointercapture", (lost: PointerEvent) => {
      if (lost.pointerId === activePointerId) abortDrag()
    }, { signal: dragSignal })

    signal?.addEventListener("abort", abortDrag, { once: true, signal: dragAc.signal })
  }, downOpts)

  element.addEventListener("click", (e: MouseEvent) => {
    if (suppressClick) {
      suppressClick = false
      window.clearTimeout(clickResetTimer)
      e.preventDefault()
      e.stopPropagation()
    }
  }, clickOpts)
}
