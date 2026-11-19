import {
  readTaskDetailLayout, resetTaskDetailLayout, saveTaskDetailOrder,
  taskDetailLayoutChange, taskDetailLayoutKey,
} from "@lib/task-detail-layout"

function layoutItems(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>(":scope > [data-layout-item]"))
}

function applyOrder(list: HTMLElement, order: readonly string[]): void {
  const items = layoutItems(list)
  const byId = new Map(items.map(item => [item.dataset.layoutItem, item]))
  const focus = document.activeElement
  let next = items[0] ?? null

  for (const id of order) {
    const item = byId.get(id)
    if (!item) continue
    if (item !== next) {
      // Sorting preserves the existing nodes, including open disclosures and inputs.
      if (typeof list.moveBefore === "function") list.moveBefore(item, next)
      else list.insertBefore(item, next)
    }
    next = item.nextElementSibling as HTMLElement | null
  }

  if (focus instanceof HTMLElement && list.contains(focus) && focus !== document.activeElement) {
    focus.focus({ preventScroll: true })
  }
}

function observeOrder(update: () => void, signal: AbortSignal): void {
  window.addEventListener(taskDetailLayoutChange, update, { signal })
  window.addEventListener("storage", event => {
    if (event.key === taskDetailLayoutKey || event.key === null) update()
  }, { signal })
}

export function initTicketSectionOrder(sections: HTMLElement, signal: AbortSignal): () => void {
  const lists = [sections, ...sections.querySelectorAll<HTMLElement>("[data-layout-order]")]
  const apply = () => {
    const order = readTaskDetailLayout()
    for (const list of lists) applyOrder(list, order.get(list.dataset.layoutOrder ?? "") ?? [])
  }
  let deferred = false
  observeOrder(() => {
    deferred = sections.contains(document.activeElement)
    if (!deferred) apply()
  }, signal)
  sections.addEventListener("focusout", () => {
    if (!deferred) return
    queueMicrotask(() => {
      if (signal.aborted || sections.contains(document.activeElement)) return
      deferred = false
      apply()
    })
  }, { signal })
  return apply
}

type LayoutSection = {
  id: string
  label: string
  fields?: [id: string, label: string][]
}

function populateLayoutEditor(root: HTMLElement): void {
  const list = root.querySelector<HTMLOListElement>('[data-layout-order="sections"]')
  const row = root.querySelector<HTMLTemplateElement>("template[data-layout-row]")?.content.firstElementChild
  const fields = root.querySelector<HTMLTemplateElement>("template[data-layout-fields]")?.content.firstElementChild
  if (!list || !row || !fields || list.childElementCount) return

  const sections: LayoutSection[] = JSON.parse(root.dataset.layoutSections ?? "[]")
  function createRow(id: string, label: string): HTMLLIElement {
    const item = row!.cloneNode(true) as HTMLLIElement
    item.dataset.layoutItem = id
    item.querySelector("[data-layout-label]")!.textContent = label
    for (const [direction, action] of [["up", root.dataset.layoutMoveUp], ["down", root.dataset.layoutMoveDown]]) {
      const button = item.querySelector<HTMLButtonElement>(`[data-layout-move="${direction}"]`)!
      button.title = `${action} · ${label}`
      button.setAttribute("aria-label", button.title)
    }
    return item
  }

  const items = document.createDocumentFragment()
  for (const section of sections) {
    const item = createRow(section.id, section.label)
    if (section.fields) {
      const disclosure = fields.cloneNode(true) as HTMLDetailsElement
      disclosure.querySelector("summary")!.textContent = `${root.dataset.layoutFieldsLabel} · ${section.label}`
      const fieldList = disclosure.querySelector("ol")!
      fieldList.dataset.layoutOrder = section.id
      fieldList.setAttribute("aria-label", section.label)
      fieldList.append(...section.fields.map(([id, label]) => createRow(id, label)))
      item.append(disclosure)
    }
    items.append(item)
  }
  list.append(items)
}

export function initTaskDetailLayoutEditor(root: HTMLElement, signal: AbortSignal): void {
  populateLayoutEditor(root)
  const lists = Array.from(root.querySelectorAll<HTMLElement>("[data-layout-order]"))
  const status = root.querySelector<HTMLElement>("[data-layout-status]")
  const error = root.querySelector<HTMLElement>("[data-layout-error]")
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)")
  let dragging = false

  function sync(): void {
    if (dragging) return
    const order = readTaskDetailLayout()
    for (const list of lists) {
      applyOrder(list, order.get(list.dataset.layoutOrder ?? "") ?? [])
      const items = layoutItems(list)
      for (const [index, item] of items.entries()) {
        item.querySelector('[data-layout-move="up"]')?.setAttribute("aria-disabled", String(index === 0))
        item.querySelector('[data-layout-move="down"]')?.setAttribute("aria-disabled", String(index === items.length - 1))
      }
    }
  }

  function showError(message: string | undefined): void {
    if (!error) return
    error.textContent = message ?? ""
    error.hidden = !message
    if (message && status) status.textContent = message
  }

  function commit(list: HTMLElement, items: HTMLElement[], item: HTMLElement): void {
    if (!list.dataset.layoutOrder) return
    try {
      saveTaskDetailOrder(list.dataset.layoutOrder, items.map(row => row.dataset.layoutItem ?? ""))
      showError(undefined)
      const label = item.querySelector("[data-layout-label]")?.textContent?.trim() ?? ""
      if (status) status.textContent = (root.dataset.moved ?? "")
        .replace("{item}", label)
        .replace("{position}", String(items.indexOf(item) + 1))
        .replace("{total}", String(items.length))
    } catch {
      sync()
      showError(root.dataset.saveFailed)
    }
  }

  root.addEventListener("click", event => {
    if (!(event.target instanceof Element)) return
    const button = event.target.closest<HTMLButtonElement>("button")
    if (button?.hasAttribute("data-layout-reset")) {
      try {
        resetTaskDetailLayout()
        showError(undefined)
        if (status) status.textContent = root.dataset.reset ?? ""
      } catch {
        showError(root.dataset.saveFailed)
      }
      return
    }

    const direction = button?.dataset.layoutMove
    if (!direction || button.getAttribute("aria-disabled") === "true" || dragging) return
    const item = button.closest<HTMLElement>("[data-layout-item]")
    const list = item?.parentElement
    if (!item || !list) return
    const items = layoutItems(list)
    const index = items.indexOf(item)
    items.splice(index, 1)
    items.splice(index + (direction === "up" ? -1 : 1), 0, item)
    commit(list, items, item)
    button.scrollIntoView({ block: "nearest" })
  }, { signal })

  observeOrder(sync, signal)
  sync()

  void import("sortablejs").then(({ default: Sortable }) => {
    if (signal.aborted) return
    const sorters = lists.map(list => Sortable.create(list, {
      animation: motion.matches ? 0 : 150,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
      handle: "[data-layout-handle]",
      draggable: "> [data-layout-item]",
      ghostClass: "td-layout-editor__ghost",
      direction: "vertical",
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 4,
      onStart: () => { dragging = true },
      onEnd: event => {
        dragging = false
        if (event.oldDraggableIndex === event.newDraggableIndex) {
          sync()
          return
        }
        commit(list, layoutItems(list), event.item)
      },
    }))
    signal.addEventListener("abort", () => {
      for (const sorter of sorters) sorter.destroy()
    }, { once: true })
    root.dataset.dragReady = "true"
    motion.addEventListener("change", () => {
      for (const sorter of sorters) sorter.option("animation", motion.matches ? 0 : 150)
    }, { signal })
  }).catch(() => { if (!signal.aborted) showError(root.dataset.dragFailed) })
}
