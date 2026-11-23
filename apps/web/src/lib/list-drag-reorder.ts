/**
 * Lightweight native vertical list drag-reorder helper.
 * Replaces external sortablejs (~36 KB) for simple handle-based vertical lists
 * while preserving accessibility, reduced-motion respect, and AbortSignal cleanup.
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
    const siblings = items()
    const draggedIdx = siblings.indexOf(dragged)
    const draggedHeight = dragged.getBoundingClientRect().height || 36
    for (let targetIdx = 0; targetIdx < siblings.length; targetIdx++) {
      if (targetIdx === draggedIdx) continue
      const target = siblings[targetIdx]!
      if (canSwap && !canSwap(dragged, target)) continue
      const box = target.getBoundingClientRect()
      const threshold = Math.min(box.height, draggedHeight) / 2
      if (draggedIdx < targetIdx && clientY > box.top + threshold) {
        if (moveItem) moveItem(dragged, target, "after")
        else list.insertBefore(dragged, target.nextElementSibling)
        break
      }
      if (draggedIdx > targetIdx && clientY < box.bottom - threshold) {
        if (moveItem) moveItem(dragged, target, "before")
        else list.insertBefore(dragged, target)
        break
      }
    }
  }

  const startDrag = (target: EventTarget | null, mode: "pointer" | "touch", pointerId: number | null): boolean => {
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

  const finishDrag = () => {
    if (!dragged) return
    const moved = dragged
    const startIdx = oldIndex
    dragged = null
    oldIndex = -1
    activeMode = null
    activePointerId = null
    moved.classList.remove(ghostClass)
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

  const endPointer = (event: PointerEvent) => {
    if (!dragged || activeMode !== "pointer" || event.pointerId !== activePointerId) return
    finishDrag()
  }
  const endTouch = () => {
    if (!dragged || activeMode !== "touch") return
    finishDrag()
  }

  window.addEventListener("pointerup", endPointer, { signal })
  window.addEventListener("pointercancel", endPointer, { signal })
  window.addEventListener("touchend", endTouch, { signal })
  window.addEventListener("touchcancel", endTouch, { signal })

  signal.addEventListener("abort", () => {
    if (dragged) dragged.classList.remove(ghostClass)
    dragged = null
    oldIndex = -1
    activeMode = null
    activePointerId = null
  }, { once: true })
}
