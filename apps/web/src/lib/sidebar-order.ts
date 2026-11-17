export const SIDEBAR_ORDER_STORAGE_KEY = "meitheal-sidebar-order"
export const sidebarOrderChanged = "meitheal:sidebar-order-changed"

function readKeys(value: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "null")
    if (Array.isArray(parsed)) return parsed.filter(key => typeof key === "string")
  } catch { /* Invalid browser storage uses the configured order. */ }
  return []
}

function savedOrder(): string[] {
  try { return readKeys(localStorage.getItem(SIDEBAR_ORDER_STORAGE_KEY)) } catch { return [] }
}

function groupItems(root: HTMLElement): HTMLElement[] {
  return Array.from(root.children).flatMap(node => node.hasAttribute("data-nav-overflow-primary")
    ? Array.from(node.children) : [node]).filter((item): item is HTMLElement =>
    item instanceof HTMLElement && Boolean(item.dataset.sidebarGroup))
}

function itemKey(item: HTMLElement): string {
  return item.dataset.sidebarGroup ?? ""
}

function arrange(root: HTMLElement, order: string[]) {
  const items = groupItems(root)
  const positions = new Map(order.map((key, index) => [key, index]))
  const sorted = [...items].sort((a, b) =>
    (positions.get(itemKey(a)) ?? Infinity) - (positions.get(itemKey(b)) ?? Infinity))
  const lists = root.querySelectorAll<HTMLElement>(":scope > [data-nav-overflow-primary]")
  const [first, last] = lists
  if (!first) return
  const focused = root.contains(document.activeElement) ? document.activeElement : null
  const areaIndex = sorted.findIndex(item => itemKey(item) === "areas")

  function fill(list: HTMLElement, destinations: HTMLElement[]) {
    let cursor = list.firstElementChild
    for (const item of destinations) {
      if (item === cursor) cursor = cursor.nextElementSibling
      else list.insertBefore(item, cursor)
    }
    list.toggleAttribute("data-nav-overflow-empty", !destinations.some(item => !item.hidden))
    list.toggleAttribute("data-task-views-primary", destinations.some(item => item.matches(".nav-item--tasks")))
  }

  fill(first, areaIndex < 0 ? sorted : sorted.slice(0, areaIndex))
  if (last && areaIndex >= 0) fill(last, sorted.slice(areaIndex + 1))
  if (focused instanceof HTMLElement && document.activeElement !== focused) focused.focus({ preventScroll: true })
}

/** Called with the original navigation nodes home, before horizontal overflow measures them. */
export function applySidebarOrder(root: HTMLElement): void {
  const defaults = readKeys(root.dataset.sidebarDefaultOrder)
  const keys = new Set(defaults)
  const saved = savedOrder().filter(key => keys.has(key))
  arrange(root, [...new Set([...saved, ...defaults])])
}

export function bindSidebarReorder(sidebar: HTMLElement, signal: AbortSignal): void {
  const root = sidebar.querySelector<HTMLElement>('[data-nav-overflow="sidebar"]')
  const tools = sidebar.querySelector<HTMLElement>("[data-sidebar-reorder-tools]")
  const toggle = tools?.querySelector<HTMLButtonElement>("[data-sidebar-reorder-toggle]")
  const label = toggle?.querySelector("span")
  const status = tools?.querySelector<HTMLElement>("[data-sidebar-reorder-status]")
  const moves = tools?.querySelector<HTMLElement>("[data-sidebar-reorder-moves]")
  if (!root || !tools || !toggle || !label || !status || !moves) return

  const visibleGroups = () => groupItems(root).filter(item =>
    !item.hidden && item.querySelector(":scope > [data-sidebar-reorder-handle]"))
  if (readKeys(root.dataset.sidebarDefaultOrder).length < 2) return
  tools.hidden = false
  let editing = false
  let selection: string | undefined
  let dragged: string | undefined
  let marker: HTMLElement | undefined

  function select(key?: string) {
    const groups = visibleGroups()
    const index = groups.findIndex(item => itemKey(item) === key)
    selection = index < 0 ? undefined : key
    moves!.querySelectorAll<HTMLButtonElement>("[data-sidebar-move]").forEach(button => {
      button.disabled = index < 0 || !groups[index + Number(button.dataset.sidebarMove)]
    })
    root!.querySelectorAll<HTMLElement>("[data-sidebar-reorder-handle]").forEach(handle => {
      handle.setAttribute("aria-pressed", String(Boolean(selection) && handle.parentElement?.dataset.sidebarGroup === selection))
    })
  }

  function clearDrop() {
    marker?.removeAttribute("data-sidebar-drop")
    marker = undefined
  }

  function stopDrag() {
    dragged = undefined
    clearDrop()
  }

  function setEditing(active: boolean) {
    editing = active
    sidebar.toggleAttribute("data-sidebar-reordering", active)
    toggle!.setAttribute("aria-pressed", String(active))
    label!.textContent = active ? toggle!.dataset.doneLabel ?? "" : toggle!.dataset.startLabel ?? ""
    moves!.hidden = !active
    stopDrag()
    if (active) {
      status!.textContent = ""
      status!.classList.add("sr-only")
    }
    select()
  }

  function move(key: string, destination: HTMLElement, after: boolean) {
    const groups = visibleGroups()
    const source = groups.find(item => itemKey(item) === key)
    if (!source || destination === source) return
    // Include the hidden pin destination so its position survives the empty state.
    const keys = [...new Set(groupItems(root!).map(itemKey))].filter(item => item !== key)
    const index = keys.indexOf(itemKey(destination))
    if (index < 0) return
    keys.splice(index + Number(after), 0, key)
    arrange(root!, keys)
    select(key)
    source.querySelector<HTMLElement>("[data-sidebar-reorder-handle]")?.focus()
    const position = visibleGroups().indexOf(source) + 1
    const itemLabel = source.querySelector<HTMLElement>("[data-sidebar-reorder-handle]")?.dataset.sidebarReorderHandle ?? ""
    try {
      localStorage.setItem(SIDEBAR_ORDER_STORAGE_KEY, JSON.stringify(keys))
      status!.classList.add("sr-only")
      status!.textContent = (tools!.dataset.moved ?? "").replace("{position}", String(position))
        .replace("{count}", String(groups.length)).replace("{label}", itemLabel)
    } catch {
      status!.classList.remove("sr-only")
      status!.textContent = tools!.dataset.storageError ?? ""
    }
    // The overflow controller must capture the new source order before it moves links.
    root!.dispatchEvent(new Event(sidebarOrderChanged))
  }

  function moveBy(key: string, step: number) {
    const groups = visibleGroups()
    const index = groups.findIndex(item => itemKey(item) === key)
    const destination = groups[index + step]
    if (index >= 0 && destination) move(key, destination, step > 0)
  }

  const handleFrom = (target: EventTarget | null) =>
    target instanceof Element ? target.closest<HTMLButtonElement>("[data-sidebar-reorder-handle]") : null
  const itemFrom = (target: EventTarget | null) =>
    target instanceof Element ? target.closest<HTMLElement>("[data-sidebar-group]") : null

  toggle.addEventListener("click", event => {
    setEditing(!editing)
    if (editing && event.detail === 0) {
      visibleGroups()[0]?.querySelector<HTMLElement>("[data-sidebar-reorder-handle]")?.focus()
    }
  }, { signal })
  moves.addEventListener("click", event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-sidebar-move]") : null
    if (selection && button) moveBy(selection, Number(button.dataset.sidebarMove))
  }, { signal })
  root.addEventListener("click", event => {
    const key = handleFrom(event.target)?.parentElement?.dataset.sidebarGroup
    if (editing && key) select(key)
  }, { signal })
  sidebar.addEventListener("keydown", event => {
    if (!editing || event.defaultPrevented) return
    if (event.key === "Escape") {
      event.preventDefault()
      setEditing(false)
      toggle.focus()
      return
    }
    const key = handleFrom(event.target)?.parentElement?.dataset.sidebarGroup
    if (!key || !["ArrowUp", "ArrowDown"].includes(event.key)) return
    event.preventDefault()
    moveBy(key, event.key === "ArrowUp" ? -1 : 1)
  }, { signal })
  root.addEventListener("dragstart", event => {
    const handle = handleFrom(event.target)
    if (!editing || !handle || !event.dataTransfer) return
    dragged = handle.parentElement?.dataset.sidebarGroup
    if (!dragged) return
    select(dragged)
    event.dataTransfer.effectAllowed = "move"
    event.dataTransfer.setData("text/plain", dragged)
  }, { signal })
  root.addEventListener("dragover", event => {
    if (!dragged) return
    const item = itemFrom(event.target)
    clearDrop()
    if (!item || itemKey(item) === dragged) return
    event.preventDefault()
    const bounds = item.getBoundingClientRect()
    const after = event.clientY > bounds.top + bounds.height / 2
    const groups = groupItems(root).filter(group => itemKey(group) === itemKey(item))
    marker = after ? groups.at(-1) : groups[0]
    marker?.setAttribute("data-sidebar-drop", after ? "after" : "before")
  }, { signal })
  root.addEventListener("drop", event => {
    const item = itemFrom(event.target)
    if (!dragged || !item || itemKey(item) === dragged) return
    event.preventDefault()
    // A descendant dragleave can clear the marker before the drop arrives.
    const group = visibleGroups().find(group => itemKey(group) === itemKey(item))
    const bounds = item.getBoundingClientRect()
    if (group) move(dragged, group, event.clientY > bounds.top + bounds.height / 2)
    stopDrag()
  }, { signal })
  root.addEventListener("dragend", stopDrag, { signal })
  root.addEventListener("dragleave", event => {
    if (!root.contains(event.relatedTarget as Node | null)) clearDrop()
  }, { signal })

  // The last pin can disappear during an edit. Recompute available moves immediately.
  const visibility = new MutationObserver(() => {
    if (editing && (!toggle.getClientRects().length ||
      (innerWidth <= 768 && !sidebar.classList.contains("open")))) setEditing(false)
    else if (editing) select(selection)
  })
  visibility.observe(document.body, { attributes: true, attributeFilter: ["class"] })
  visibility.observe(document.documentElement, { attributes: true, attributeFilter: ["data-appearance-navigation"] })
  const pin = root.querySelector("[data-sidebar-pin-presence]")
  if (pin) visibility.observe(pin, { attributes: true, attributeFilter: ["hidden"] })
  signal.addEventListener("abort", () => {
    visibility.disconnect()
    setEditing(false)
  }, { once: true })
}
