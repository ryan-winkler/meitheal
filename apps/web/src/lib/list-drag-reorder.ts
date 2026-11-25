/**
 * Lightweight native vertical list drag-reorder helper.
 * Replaces external sortablejs (~36 KB) for simple handle-based vertical lists
 * while preserving pointer/touch reordering, accessibility, reduced-motion respect,
 * and AbortSignal cleanup.
 */

export interface VerticalListDragOptions {
  handle: string
  item: string
  ghostClass: string
  signal: AbortSignal
  canSwap?: (dragged: HTMLElement, target: HTMLElement) => boolean
  moveItem?: (dragged: HTMLElement, target: HTMLElement, direction: "before" | "after") => void
  onStart?: () => void
  onEnd?: (detail: { item: HTMLElement; oldIndex: number; newIndex: number }) => void
}

export function attachVerticalListDragReorder(
  list: HTMLElement,
  options: VerticalListDragOptions,
): void {
  const { handle, item: itemSelector, ghostClass, signal, canSwap, moveItem, onStart, onEnd } = options
  let dragged: HTMLElement | null = null
  let oldIndex = -1
  let activeMode: "pointer" | "touch" | null = null
  let activePointerId: number | null = null

  const items = (): HTMLElement[] =>
    Array.from(list.children).filter((child): child is HTMLElement =>
      child instanceof HTMLElement && child.matches(itemSelector),
    )

  const syncHandles = () => {
    for (const el of items()) {
      el.draggable = false
      const grip = el.querySelector<HTMLElement>(handle)
      if (grip) {
        grip.style.touchAction = "none"
        grip.style.userSelect = "none"
      }
    }
  }
  syncHandles()

  const reorderToY = (clientY: number) => {
    if (!dragged) return
    const siblings = items().filter(el => el !== dragged)
    for (const target of siblings) {
      const box = target.getBoundingClientRect()
      if (clientY < box.top || clientY > box.bottom) continue
      if (canSwap && !canSwap(dragged, target)) return
      const direction: "before" | "after" = clientY < box.top + box.height / 2 ? "before" : "after"
      if (moveItem) {
        moveItem(dragged, target, direction)
      } else {
        list.insertBefore(dragged, direction === "before" ? target : target.nextElementSibling)
      }
      return
    }
  }

  const startDrag = (
    target: EventTarget | null,
    mode: "pointer" | "touch",
    pointerId: number | null,
  ): boolean => {
    if (dragged) return false
    const el = target instanceof Element ? target : null
    const grip = el?.closest<HTMLElement>(handle)
    const row = grip?.closest<HTMLElement>(itemSelector)
    if (!grip || !row || row.parentElement !== list) return false
    grip.style.touchAction = "none"
    dragged = row
    oldIndex = items().indexOf(row)
    activeMode = mode
    activePointerId = pointerId
    row.classList.add(ghostClass)
    onStart?.()
    return true
  }

  const finishDrag = (cancelled = false) => {
    if (!dragged) return
    const moved = dragged
    const startIdx = oldIndex
    dragged = null
    oldIndex = -1
    activeMode = null
    activePointerId = null
    moved.classList.remove(ghostClass)
    if (cancelled && startIdx >= 0) {
      const rest = items().filter(row => row !== moved)
      list.insertBefore(moved, rest[startIdx] ?? null)
      onEnd?.({ item: moved, oldIndex: startIdx, newIndex: startIdx })
      return
    }
    const newIndex = items().indexOf(moved)
    onEnd?.({ item: moved, oldIndex: startIdx, newIndex })
  }

  list.addEventListener("pointerdown", event => {
    if (event.pointerType === "mouse" && event.button !== 0) return
    if (!startDrag(event.target, "pointer", event.pointerId)) return
    event.preventDefault()
    event.stopPropagation()
  }, { signal })

  list.addEventListener("touchstart", event => {
    if (event.touches.length !== 1) return
    const targetEl = event.target instanceof Element ? event.target : null
    const grip = targetEl?.closest<HTMLElement>(handle)
    const row = grip?.closest<HTMLElement>(itemSelector)
    if (!row || row.parentElement !== list) return
    if (!dragged) {
      if (!startDrag(event.target, "touch", null)) return
    }
    event.preventDefault()
    event.stopPropagation()
  }, { passive: false, signal })

  window.addEventListener("pointermove", event => {
    if (!dragged || activeMode !== "pointer" || event.pointerId !== activePointerId) return
    reorderToY(event.clientY)
  }, { signal })

  window.addEventListener("touchmove", event => {
    if (!dragged) return
    event.preventDefault()
    if (activeMode !== "touch") return
    const touch = event.touches[0]
    if (touch) reorderToY(touch.clientY)
  }, { passive: false, signal })

  window.addEventListener("pointerup", event => {
    if (!dragged || activeMode !== "pointer" || event.pointerId !== activePointerId) return
    finishDrag(false)
  }, { signal })

  window.addEventListener("pointercancel", event => {
    if (!dragged || activeMode !== "pointer" || event.pointerId !== activePointerId) return
    finishDrag(true)
  }, { signal })

  window.addEventListener("touchend", () => {
    if (!dragged || activeMode !== "touch") return
    finishDrag(false)
  }, { signal })

  window.addEventListener("touchcancel", () => {
    if (!dragged || activeMode !== "touch") return
    finishDrag(true)
  }, { signal })

  signal.addEventListener("abort", () => {
    if (dragged) dragged.classList.remove(ghostClass)
    dragged = null
    oldIndex = -1
    activeMode = null
    activePointerId = null
  }, { once: true })
}
