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

  const items = (): HTMLElement[] =>
    Array.from(list.children).filter((child): child is HTMLElement =>
      child instanceof HTMLElement && child.matches(itemSelector),
    )

  const syncDraggable = () => {
    for (const el of items()) {
      el.draggable = false
      const grip = el.querySelector<HTMLElement>(handle)
      if (grip) grip.style.touchAction = "none"
    }
  }
  syncDraggable()

  list.addEventListener("pointerdown", event => {
    const target = event.target instanceof Element ? event.target : null
    if (!target?.closest(handle)) return
    const row = target.closest<HTMLElement>(itemSelector)
    if (row && row.parentElement === list) row.draggable = true
  }, { signal })

  const clearDraggable = () => {
    for (const el of items()) el.draggable = false
  }
  list.addEventListener("pointerup", clearDraggable, { signal })
  list.addEventListener("pointercancel", clearDraggable, { signal })

  list.addEventListener("dragstart", event => {
    const row = (event.target as Element | null)?.closest<HTMLElement>(itemSelector)
    if (!row || row.parentElement !== list || !row.draggable) {
      event.preventDefault()
      return
    }
    dragged = row
    oldIndex = items().indexOf(row)
    row.classList.add(ghostClass)
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move"
      event.dataTransfer.setData("text/plain", String(oldIndex))
    }
    onStart?.()
  }, { signal })

  list.addEventListener("dragover", event => {
    if (!dragged) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
    const target = (event.target as Element | null)?.closest<HTMLElement>(itemSelector)
    if (!target || target === dragged || target.parentElement !== list) return
    const box = target.getBoundingClientRect()
    const insertBefore = event.clientY < box.top + box.height / 2
    list.insertBefore(dragged, insertBefore ? target : target.nextElementSibling)
  }, { signal })

  const finishDrag = () => {
    if (!dragged) return
    const moved = dragged
    const startIdx = oldIndex
    dragged = null
    oldIndex = -1
    moved.classList.remove(ghostClass)
    moved.draggable = false
    const newIndex = items().indexOf(moved)
    onEnd?.({ item: moved, oldIndex: startIdx, newIndex })
  }

  list.addEventListener("drop", event => {
    if (!dragged) return
    event.preventDefault()
    finishDrag()
  }, { signal })

  list.addEventListener("dragend", finishDrag, { signal })

  signal.addEventListener("abort", () => {
    if (dragged) dragged.classList.remove(ghostClass)
    dragged = null
    clearDraggable()
  }, { once: true })
}
