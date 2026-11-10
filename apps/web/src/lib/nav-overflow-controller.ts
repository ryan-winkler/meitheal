import { pageLifecycle } from "@lib/page-lifecycle"

interface OverflowBinding {
  pageSignal: AbortSignal
  controller: AbortController
}

/** Reparent the original links; their URLs, listeners and IDs remain intact. */
export function initNavOverflow(root: HTMLElement, pageSignal: AbortSignal): void {
  const runtime = window as unknown as { __meithealNavOverflow?: WeakMap<HTMLElement, OverflowBinding> }
  const bindings = runtime.__meithealNavOverflow ??= new WeakMap()
  const previous = bindings.get(root)
  if (previous?.pageSignal === pageSignal && !previous.controller.signal.aborted) return
  previous?.controller.abort()
  const primaries = [...root.querySelectorAll<HTMLElement>("[data-nav-overflow-primary]")]
  const moreElement = root.querySelector<HTMLDetailsElement>("[data-nav-overflow-more]")
  const menuElement = moreElement?.querySelector<HTMLElement>("[data-nav-overflow-menu]")
  const toggleElement = moreElement?.querySelector<HTMLElement>("summary")
  if (!primaries.length || !moreElement || !menuElement || !toggleElement || pageSignal.aborted) return
  const more = moreElement
  const menu = menuElement
  const toggle = toggleElement
  const controller = new AbortController()
  bindings.set(root, { pageSignal, controller })
  const signal = AbortSignal.any([pageSignal, controller.signal])
  const sources = primaries.map(primary => ({ primary, items: [...primary.children] as HTMLElement[] }))
  const items = sources.flatMap(source => source.items)
  const links = items.flatMap(item => item.matches("a[href]") ? [item] : [...item.querySelectorAll<HTMLElement>("a[href]")])
  const originalTabs = new Map(links.map(link => [link, link.getAttribute("tabindex")]))
  const views = root.dataset.navOverflow === "views"
  let frame = 0
  let lastWidth = -1

  const resetTab = (link: HTMLElement) => {
    const value = originalTabs.get(link)
    if (value === null || value === undefined) link.removeAttribute("tabindex")
    else link.setAttribute("tabindex", value)
  }
  const currentItem = (item: HTMLElement) => item.matches("[aria-current=page], [aria-selected=true]")
    || Boolean(item.querySelector("[aria-current=page], [aria-selected=true]"))
  const primaryLinks = () => links.filter(link => !menu.contains(link))
  const menuLinks = () => links.filter(link => menu.contains(link))
  function syncTabStops(focused = document.activeElement) {
    const visible = primaryLinks()
    const selected = visible.find(link => link === focused) ?? visible.find(currentItem) ?? visible[0]
    for (const link of visible) {
      if (views && root.hasAttribute("data-nav-overflow-active")) link.tabIndex = link === selected ? 0 : -1
      else resetTab(link)
    }
    const overflow = menuLinks()
    const selectedOverflow = overflow.find(link => link === focused) ?? overflow.find(currentItem) ?? overflow[0]
    for (const link of overflow) link.tabIndex = link === selectedOverflow ? 0 : -1
  }
  function restoreItems() {
    for (const { primary, items: sourceItems } of sources) {
      primary.removeAttribute("data-nav-overflow-empty")
      for (const item of sourceItems) primary.append(item)
    }
  }
  function focusDestination(target: HTMLElement | undefined) {
    if (!target) return
    target.focus({ preventScroll: true })
    if (!menu.contains(target)) return
    const item = target.getBoundingClientRect()
    const viewport = menu.getBoundingClientRect()
    if (item.top < viewport.top || item.height > menu.clientHeight) menu.scrollTop += item.top - viewport.top
    else if (item.bottom > viewport.bottom) menu.scrollTop += item.bottom - viewport.bottom
  }
  function closeMenu(restoreFocus = false) {
    if (restoreFocus && !more.hidden) toggle.focus({ preventScroll: true })
    more.open = false
  }
  function reflow() {
    frame = 0
    if (signal.aborted || !root.isConnected) return
    const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null
    const enabled = getComputedStyle(root).getPropertyValue("--nav-overflow-enabled").trim() === "1" && root.clientWidth > 0
    restoreItems()
    root.toggleAttribute("data-nav-overflow-active", enabled)
    let visible = new Set(items)
    if (enabled && items.length) {
      // Width is constrained by the parent, independently of the links or menu.
      more.hidden = false
      const style = getComputedStyle(root)
      const available = root.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0)
      const gap = Number.parseFloat(style.columnGap) || 0
      const fixed = [...root.children].filter((child): child is HTMLElement => child instanceof HTMLElement
        && child !== more && !primaries.includes(child) && getComputedStyle(child).display !== "none")
      const fixedWidth = fixed.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0)
      const widths = new Map(items.map(item => [item, item.getBoundingClientRect().width]))
      const moreWidth = more.getBoundingClientRect().width
      const required = (selection: Set<HTMLElement>, showMore: boolean) => {
        let width = fixedWidth + (showMore ? moreWidth : 0)
        let groups = fixed.length + Number(showMore)
        for (const { primary, items: sourceItems } of sources) {
          const selected = sourceItems.filter(item => selection.has(item))
          if (!selected.length) continue
          groups += 1
          const itemGap = Number.parseFloat(getComputedStyle(primary).columnGap) || 0
          width += selected.reduce((sum, item) => sum + (widths.get(item) ?? 0), 0) + itemGap * (selected.length - 1)
        }
        return width + gap * Math.max(0, groups - 1)
      }
      if (required(visible, false) > available + 0.5) {
        visible = new Set()
        // Keep the route and the focused destination visible whenever they fit.
        for (const item of [items.find(currentItem), items.find(item => focused && item.contains(focused))]) {
          if (item && required(new Set([...visible, item]), true) <= available + 0.5) visible.add(item)
        }
        let overflowing = false
        for (const item of items) {
          if (visible.has(item) || overflowing) continue
          if (required(new Set([...visible, item]), true) <= available + 0.5) visible.add(item)
          else overflowing = true
        }
        for (const item of items) if (!visible.has(item)) menu.append(item)
      }
    }
    for (const { primary, items: sourceItems } of sources) primary.toggleAttribute("data-nav-overflow-empty", !sourceItems.some(item => visible.has(item)))
    more.hidden = !enabled || visible.size === items.length
    if (more.hidden) more.open = false
    if (focused) {
      if (focused === toggle && more.hidden) {
        ;(primaryLinks().find(currentItem) ?? primaryLinks()[0])?.focus({ preventScroll: true })
      } else {
        if (menu.contains(focused)) more.open = true
        focusDestination(focused)
      }
    }
    syncTabStops()
    // Ignore our own synchronous reparenting, while still observing label changes.
    content.takeRecords()
  }
  const schedule = () => {
    if (!signal.aborted && !frame) frame = requestAnimationFrame(reflow)
  }
  const resize = new ResizeObserver(entries => {
    const width = entries[0]?.contentRect.width ?? 0
    if (Math.abs(width - lastWidth) < 0.5) return
    lastWidth = width
    schedule()
  })
  const appearance = new MutationObserver(schedule)
  const content = new MutationObserver(records => {
    if (records.some(record => record.type !== "childList" || (record.target !== menu && !primaries.includes(record.target as HTMLElement)))) schedule()
  })
  resize.observe(root)
  appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["data-appearance-navigation", "data-appearance-font", "data-appearance-radius"] })
  content.observe(root, { subtree: true, characterData: true, childList: true, attributes: true, attributeFilter: ["aria-current", "aria-selected"] })

  root.addEventListener("keydown", event => {
    if (event.defaultPrevented) return
    const target = event.target as HTMLElement
    if (event.key === "Escape" && more.open) {
      event.preventDefault()
      event.stopPropagation()
      closeMenu(true)
      return
    }
    if (target === toggle && ["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault()
      if (more.open && ["Enter", " "].includes(event.key)) { closeMenu(true); return }
      more.open = true
      const overflow = menuLinks()
      focusDestination(event.key === "ArrowUp" ? overflow.at(-1) : overflow[0])
      return
    }
    const inMenu = menu.contains(target)
    const candidates = inMenu ? menuLinks() : [...primaryLinks(), ...(!more.hidden ? [toggle] : [])]
    const keys = inMenu ? ["ArrowDown", "ArrowUp", "Home", "End"] : ["ArrowRight", "ArrowLeft", "Home", "End"]
    if (!keys.includes(event.key) || !candidates.includes(target) || !root.hasAttribute("data-nav-overflow-active")) return
    event.preventDefault()
    const index = candidates.indexOf(target)
    const next = event.key === "Home" ? 0 : event.key === "End" ? candidates.length - 1
      : (index + (["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1) + candidates.length) % candidates.length
    focusDestination(candidates[next])
  }, { signal })
  root.addEventListener("focusin", () => syncTabStops(), { signal })
  more.addEventListener("toggle", () => {
    if (!more.open && menu.contains(document.activeElement)) toggle.focus({ preventScroll: true })
    syncTabStops()
  }, { signal })
  document.addEventListener("click", event => {
    if (more.open && event.target instanceof Node && !more.contains(event.target)) closeMenu(menu.contains(document.activeElement))
  }, { signal })
  menu.addEventListener("click", event => {
    if (event.target instanceof Element && event.target.closest("a[href]")) closeMenu(true)
  }, { signal })
  window.addEventListener("meitheal:view-changed", schedule, { signal })
  document.fonts?.addEventListener("loadingdone", schedule, { signal })
  void document.fonts?.ready.then(schedule)
  signal.addEventListener("abort", () => {
    resize.disconnect()
    appearance.disconnect()
    content.disconnect()
    cancelAnimationFrame(frame)
    restoreItems()
    for (const link of links) resetTab(link)
    more.hidden = true
    more.open = false
    root.removeAttribute("data-nav-overflow-active")
  }, { once: true })
  reflow()
}

pageLifecycle.onPageLoad(signal => {
  document.querySelectorAll<HTMLElement>("[data-nav-overflow]").forEach(root => initNavOverflow(root, signal))
})
