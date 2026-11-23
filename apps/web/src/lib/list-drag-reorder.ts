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
  onStart?: () => void
  onEnd?: (detail: { item: HTMLElement; oldIndex: number; newIndex: number }) => void
}

export function attachVerticalListDragReorder(
  list: HTMLElement,
  options: VerticalListDragOptions,
): void {
  const { handle, item: itemSelector, ghostClass, signal, onStart, onEnd } = options
  let dragged: HTMLElement | null = null
  let oldIndex = -1
  let dragAc: AbortController | null = null

  const items = (): HTMLElement[] =>
    Array.from(list.children).filter((child): child is HTMLElement =>
      child instanceof HTMLElement && child.matches(itemSelector),
    )

  for (const el of items()) {
    const grip = el.querySelector<HTMLElement>(handle)
    if (grip) grip.style.touchAction = "none"
  }

  const finishDrag = () => {
    dragAc?.abort()
    dragAc = null
    if (!dragged) return
    const moved = dragged
    const startIdx = oldIndex
    dragged = null
    oldIndex = -1
    moved.classList.remove(ghostClass)
    onEnd?.({ item: moved, oldIndex: startIdx, newIndex: items().indexOf(moved) })
  }

  const moveAt = (clientY: number) => {
    if (!dragged) return
    let listItems = items()
    let idx = listItems.indexOf(dragged)
    while (idx > 0) {
      const prev = listItems[idx - 1]!
      const box = (prev.firstElementChild ?? prev).getBoundingClientRect()
      if (clientY >= box.top + box.height * 0.6) break
      list.insertBefore(dragged, prev)
      listItems = items()
      idx -= 1
    }
    while (idx >= 0 && idx < listItems.length - 1) {
      const next = listItems[idx + 1]!
      const box = (next.firstElementChild ?? next).getBoundingClientRect()
      if (clientY <= box.top + box.height * 0.4) break
      list.insertBefore(next, dragged)
      listItems = items()
      idx += 1
    }
  }

  const start = (target: EventTarget | null, event: Event) => {
    if (dragged) return
    const el = target instanceof Element ? target : null
    const row = el?.closest(handle) ? el.closest<HTMLElement>(itemSelector) : null
    if (!row || row.parentElement !== list) return
    event.preventDefault()
    dragged = row
    oldIndex = items().indexOf(row)
    row.classList.add(ghostClass)
    onStart?.()
    dragAc = new AbortController()
    const dragSignal = AbortSignal.any([signal, dragAc.signal])
    window.addEventListener("pointermove", e => moveAt(e.clientY), { signal: dragSignal })
    window.addEventListener("pointerup", finishDrag, { signal: dragSignal })
    window.addEventListener("pointercancel", finishDrag, { signal: dragSignal })
    window.addEventListener("touchmove", e => {
      e.preventDefault()
      const t = e.touches[0] ?? e.changedTouches[0]
      if (t) moveAt(t.clientY)
    }, { signal: dragSignal, passive: false })
    window.addEventListener("touchend", finishDrag, { signal: dragSignal })
    window.addEventListener("touchcancel", finishDrag, { signal: dragSignal })
  }

  list.addEventListener("pointerdown", event => {
    if (event.button <= 0 && event.pointerType !== "touch") start(event.target, event)
  }, { signal })

  list.addEventListener("touchstart", event => {
    start(event.target, event)
  }, { signal, passive: false })

  signal.addEventListener("abort", finishDrag, { once: true })
}
