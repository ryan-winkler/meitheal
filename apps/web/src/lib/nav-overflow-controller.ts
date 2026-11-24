import { pageLifecycle } from "@lib/page-lifecycle"
import { applySidebarOrder, sidebarOrderChanged, SIDEBAR_ORDER_STORAGE_KEY } from "@lib/sidebar-order"
import { SIDEBAR_PERSONAL_STORAGE_KEY } from "@domains/navigation/sidebar-menu"
import { SIDEBAR_FOCUS_REVEAL_EVENT } from "@lib/mobile-sidebar-controller"
import { computeNavOverflow, type NavOverflowItem } from "@domains/navigation/nav-overflow"

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
  let primaries = [...root.querySelectorAll<HTMLElement>("[data-nav-overflow-primary]")]
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
  // Nested disclosures keep native Tab order, including when their parent is in More.
  const collectLinks = (items: HTMLElement[]) => items
    .filter(item => !item.hidden).flatMap(item => item.matches("a[href]") ? [item]
    : [...item.querySelectorAll<HTMLElement>("a[href]")].filter(link => !link.closest("[data-nav-overflow-submenu]")))
  let sources = primaries.map(primary => ({ primary, items: [...primary.children] as HTMLElement[] }))
  let links: HTMLElement[] = []
  const originalTabs = new Map<HTMLElement, string | null>()
  let frame = 0
  let lastWidth = -1
  let sourcesChanged = true
  const sidebar = root.hasAttribute("data-sidebar-default-order")
  let sidebarOrderPending = sidebar

  function refreshSources() {
    primaries = [...root.querySelectorAll<HTMLElement>("[data-nav-overflow-primary]")]
    sources = primaries.map(primary => ({ primary, items: [...primary.children] as HTMLElement[] }))
  }

  function refreshLinks() {
    const items = sources.flatMap(source => source.items)
    links = collectLinks(items)
    for (const link of links) {
      if (!originalTabs.has(link)) originalTabs.set(link, link.getAttribute("tabindex"))
    }
    return items
  }

  const setTab = (link: HTMLElement, value: string | null) => {
    if (link.getAttribute("tabindex") === value) return
    if (value === null) link.removeAttribute("tabindex")
    else link.setAttribute("tabindex", value)
  }
  const resetTab = (link: HTMLElement) => setTab(link, originalTabs.get(link) ?? null)
  const currentItem = (item: HTMLElement) => item.matches("[aria-current=page], [aria-selected=true]")
    || Boolean(item.querySelector("[aria-current=page], [aria-selected=true]"))
  // Keep the inventory intact while disclosures change what can receive focus.
  // Keep scrollport-offscreen links eligible, but exclude hidden disclosure ancestors.
  const canFocus = (element: HTMLElement) => {
    if (element.closest("[hidden], [inert]")) return false
    const closed = element.closest("details:not([open])")
    if (closed && (!element.matches("summary") || element.parentElement !== closed || closed.parentElement?.closest("details:not([open])"))) return false
    return element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible"
  }
  const primaryLinks = () => links.filter(link => !menu.contains(link))
  const menuLinks = () => {
    if (!more.open || more.hidden) return []
    refreshLinks()
    return links.filter(link => menu.contains(link) && canFocus(link))
  }
  function syncTabStops() {
    // Keep primary Tab stops and skip visibility checks while More is closed.
    const menuHasItems = menu.childElementCount > 0
    const menuOpen = more.open && !more.hidden
    if (menuOpen) refreshLinks()
    const overflow: HTMLElement[] = []
    for (const link of links) {
      if (!menuHasItems || !menu.contains(link)) resetTab(link)
      else if (menuOpen) overflow.push(link)
      else setTab(link, "-1")
    }
    if (!overflow.length) return
    const focused = document.activeElement
    const eligible = overflow.filter(canFocus)
    const selected = eligible.find(link => link === focused) ?? eligible.find(link => link.tabIndex === 0)
      ?? eligible.find(currentItem) ?? eligible[0]
    for (const link of overflow) setTab(link, link === selected ? "0" : "-1")
  }
  function restoreItems(focused: HTMLElement | null) {
    for (const source of sources) {
      const { primary } = source
      source.items = source.items.filter(item => root.contains(item))
      primary.removeAttribute("data-nav-overflow-empty")
      let changed = false
      for (let i = 0; i < source.items.length; i += 1) {
        const item = source.items[i]!
        if (primary.children[i] !== item) {
          primary.insertBefore(item, primary.children[i] ?? null)
          changed = true
        }
      }
      if (changed && focused && primary.contains(focused) && document.activeElement !== focused) {
        focused.focus({ preventScroll: true })
      }
    }
  }
  function focusDestination(target: HTMLElement | undefined) {
    if (!target) return
    target.focus({ preventScroll: true })
    if (!menu.contains(target)) {
      target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" })
      return
    }
    const item = target.getBoundingClientRect()
    const viewport = menu.getBoundingClientRect()
    const top = viewport.top + menu.clientTop
    const bottom = top + menu.clientHeight
    // Use the scrollport inside its border and round outward to reveal fractional pixels.
    if (item.top < top || item.height > menu.clientHeight) menu.scrollTop += Math.floor(item.top - top)
    else if (item.bottom > bottom) menu.scrollTop += Math.ceil(item.bottom - bottom)
  }
  function closeMenu(restoreFocus = false) {
    if (restoreFocus && !more.hidden) toggle.focus({ preventScroll: true })
    more.open = false
  }
  function reflow() {
    frame = 0
    if (signal.aborted || !root.isConnected) return
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (active && root.contains(active) && innerWidth <= 768) {
      root.closest("#sidebar")?.dispatchEvent(new Event(SIDEBAR_FOCUS_REVEAL_EVENT))
    }
    const portal = active?.closest<HTMLElement>("[data-sidebar-board-owner]")
    const owner = portal ? document.getElementById(portal.dataset.sidebarBoardOwner ?? "") : null
    const portalOwner = owner && root.contains(owner) ? owner : null
    // Body-level action menus retain focus while their owning Board stays reachable.
    const focused = active && root.contains(active) ? active
      : portalOwner?.closest<HTMLElement>("[data-sidebar-group]")?.querySelector<HTMLElement>("[data-sidebar-boards-toggle]") ?? null
    const focusedInMenu = focused !== null && menu.contains(focused)
    const editingSidebar = Boolean(root.closest("#sidebar")?.hasAttribute("data-sidebar-editing"))
    const enabled = !editingSidebar && getComputedStyle(root).getPropertyValue("--nav-overflow-enabled").trim() === "1" && root.clientWidth > 0
    root.setAttribute("data-nav-overflow-reflowing", "")
    restoreItems(portalOwner ? null : focused)
    if (sidebarOrderPending) {
      applySidebarOrder(root)
      sidebarOrderPending = false
    }
    if (sourcesChanged) {
      refreshSources()
      sourcesChanged = false
    }
    const isItemVisible = (item: HTMLElement) => !item.hidden
      && !item.hasAttribute("data-sidebar-item-hidden")
      && !item.closest("[data-sidebar-section-hidden], [data-sidebar-section-empty]")
    const availableItems = refreshLinks().filter(isItemVisible)
    root.toggleAttribute("data-nav-overflow-active", enabled)
    let visible = new Set(availableItems)
    let overflowHasActive = false
    if (enabled && availableItems.length) {
      // Width is constrained by the parent, independently of the links or menu.
      more.hidden = false
      const style = getComputedStyle(root)
      const available = root.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0)
      const gap = Number.parseFloat(style.columnGap) || 0
      // Exclude wrappers that contain primary lists (e.g. .sidebar-sections) so items are never double-counted.
      const fixed = [...root.children].filter((child): child is HTMLElement => child instanceof HTMLElement
        && child !== more
        && !primaries.some(primary => child === primary || child.contains(primary))
        && getComputedStyle(child).display !== "none"
        && child.getBoundingClientRect().width > 0)
      const fixedWidth = fixed.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0)
      const moreWidth = more.getBoundingClientRect().width
      const groupGaps = sources.map(({ primary }) => Number.parseFloat(getComputedStyle(primary).columnGap) || 0)
      const itemById = new Map<string, HTMLElement>()
      const layoutItems: NavOverflowItem[] = []
      const activeItem = availableItems.find(currentItem)
      const focusedItem = focused ? availableItems.find(item => item.contains(focused)) : undefined
      let seq = 0
      sources.forEach(({ items: sourceItems }, groupIndex) => {
        for (const item of sourceItems) {
          if (!isItemVisible(item)) continue
          const id = String(seq++)
          itemById.set(id, item)
          layoutItems.push({
            id,
            width: item.getBoundingClientRect().width,
            groupIndex,
            priority: item === activeItem || item === focusedItem,
          })
        }
      })
      const packed = computeNavOverflow({
        items: layoutItems,
        groupGaps,
        availableWidth: available,
        fixedWidth,
        fixedCount: fixed.length,
        moreWidth,
        containerGap: gap,
      })
      visible = new Set([...packed.visibleIds].map(id => itemById.get(id)!).filter(Boolean))
      overflowHasActive = packed.overflowHasPriority
      if (packed.showMore) {
        for (const id of packed.overflowIds) {
          const item = itemById.get(id)
          if (item && item.parentElement !== menu) {
            menu.append(item)
            if (!portalOwner && focused && item.contains(focused) && document.activeElement !== focused) {
              focused.focus({ preventScroll: true })
            }
          }
        }
      }
    }
    for (const { primary, items: sourceItems } of sources) {
      primary.toggleAttribute("data-nav-overflow-empty", !editingSidebar && !sourceItems.some(item => visible.has(item)))
    }
    more.hidden = !enabled || visible.size === availableItems.length
    more.toggleAttribute("data-nav-overflow-has-active", !more.hidden && overflowHasActive)
    if (more.hidden || (focusedInMenu && !menu.contains(focused))) more.open = false
    if (focused) {
      if (menu.contains(focused)) more.open = true
      if (!portalOwner) {
        if (canFocus(focused)) {
          focusDestination(focused)
        } else {
          const context = focused.closest("[data-sidebar-group]")
          const contextualLink = context ? [...context.querySelectorAll<HTMLElement>("a[href]")].find(canFocus) : undefined
          const visibleLinks = contextualLink ? [] : primaryLinks().filter(canFocus)
          focusDestination(contextualLink ?? visibleLinks.find(currentItem) ?? visibleLinks[0])
        }
      }
    }
    syncTabStops()
    // Ignore our own synchronous reparenting, while still observing label changes.
    root.removeAttribute("data-nav-overflow-reflowing")
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
  const syncTaskNavDom = () => {
    sourcesChanged = true
    schedule()
  }
  const appearance = new MutationObserver(syncTaskNavDom)
  const content = new MutationObserver(records => {
    const insideSubmenu = (node: Node) => {
      const el = node instanceof Element ? node : node.parentElement
      return Boolean(el?.closest("[data-sidebar-board-children], [data-nav-overflow-submenu]"))
    }
    const relevant = records.filter(record => !insideSubmenu(record.target))
    if (!relevant.length) {
      if (records.some(record => {
        const el = record.target instanceof Element ? record.target : record.target.parentElement
        return Boolean(el?.closest("[data-sidebar-board-children]"))
      })) {
        refreshLinks()
        syncTabStops()
      }
      return
    }
    if (relevant.some(record => record.attributeName === "hidden" || record.attributeName === "inert")) syncTabStops()
    if (relevant.some(record => record.attributeName === "hidden"
      ? (record.target as Element).hasAttribute("data-sidebar-pin-presence")
      : record.type !== "childList" || (record.target !== menu && !primaries.includes(record.target as HTMLElement)))) schedule()
  })
  resize.observe(root)
  const sidebarHost = root.closest<HTMLElement>("#sidebar")
  if (sidebarHost && sidebarHost !== root) resize.observe(sidebarHost)
  if (sidebarHost) {
    appearance.observe(sidebarHost, {
      attributes: true,
      attributeFilter: ["data-sidebar-editing"],
    })
  }
  appearance.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-appearance-navigation", "data-appearance-nav-style", "data-appearance-nav-tone", "data-appearance-font", "data-appearance-radius"],
  })
  content.observe(root, { subtree: true, characterData: true, childList: true, attributes: true, attributeFilter: ["aria-current", "aria-selected", "hidden", "inert", "data-sidebar-item-hidden", "data-sidebar-section-hidden", "data-sidebar-section-empty"] })

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
      refreshLinks()
      const overflow = menuLinks()
      focusDestination(event.key === "ArrowUp" ? overflow.at(-1) : overflow[0])
      return
    }
    const inMenu = menu.contains(target)
    const keys = inMenu ? ["ArrowDown", "ArrowUp", "Home", "End"] : ["ArrowRight", "ArrowLeft", "Home", "End"]
    if (!keys.includes(event.key) || !root.hasAttribute("data-nav-overflow-active")) return
    // Board hierarchy links load lazily without a layout pass, so collect them on demand.
    if (inMenu) refreshLinks()
    const candidates = inMenu ? menuLinks() : [...primaryLinks().filter(canFocus), ...(!more.hidden ? [toggle] : [])]
    const menuToggle = inMenu && target !== toggle && target.matches("button, summary") && canFocus(target)
    if (!candidates.includes(target) && !menuToggle) return
    event.preventDefault()
    if (menuToggle && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      const following = candidates.findIndex(candidate => Boolean(target.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING))
      const next = event.key === "ArrowDown" ? (following === -1 ? 0 : following)
        : (following === -1 ? candidates.length - 1 : (following - 1 + candidates.length) % candidates.length)
      focusDestination(candidates[next])
      return
    }
    const index = candidates.indexOf(target)
    const next = event.key === "Home" ? 0 : event.key === "End" ? candidates.length - 1
      : (index + (["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1) + candidates.length) % candidates.length
    focusDestination(candidates[next])
  }, { signal })
  root.addEventListener("focusin", () => {
    if (!root.hasAttribute("data-nav-overflow-reflowing")) syncTabStops()
  }, { signal })
  root.addEventListener("toggle", event => {
    if (event.target !== more && !root.hasAttribute("data-nav-overflow-reflowing")) syncTabStops()
  }, { capture: true, signal })
  more.addEventListener("toggle", () => {
    if (more.open) {
      window.dispatchEvent(new CustomEvent("meitheal:nav-submenu-open", { detail: { id: "nav-overflow-more" } }))
    } else if (menu.contains(document.activeElement)) {
      toggle.focus({ preventScroll: true })
    }
    syncTabStops()
  }, { signal })
  window.addEventListener("meitheal:nav-submenu-open", event => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id
    if (!more.open || id === "nav-overflow-more") return
    if (id === "tasks-views" && menu.querySelector("#tasks-nav-submenu")) return
    if (id === "boards" && menu.querySelector("#sidebar-board-children")) return
    closeMenu()
  }, { signal })
  document.addEventListener("click", event => {
    if (!more.open || !(event.target instanceof Node) || more.contains(event.target)) return
    const portal = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-sidebar-board-owner]") : null
    const owner = portal?.dataset.sidebarBoardOwner
    if (owner && menu.contains(document.getElementById(owner))) {
      if (event.target instanceof Element && event.target.closest("a[href]")) closeMenu(true)
      return
    }
    closeMenu(menu.contains(document.activeElement))
  }, { signal })
  menu.addEventListener("click", event => {
    if (event.target instanceof Element && event.target.closest("a[href]")) closeMenu(true)
  }, { signal })
  root.addEventListener(sidebarOrderChanged, () => {
    sourcesChanged = true
    if (!menu.childElementCount) {
      refreshSources()
      refreshLinks()
    }
    schedule()
  }, { signal })
  if (sidebar) window.addEventListener("storage", event => {
    if (event.key === SIDEBAR_PERSONAL_STORAGE_KEY || event.key === SIDEBAR_ORDER_STORAGE_KEY || event.key === null) {
      sidebarOrderPending = true
      syncTaskNavDom()
    }
  }, { signal })
  window.addEventListener("meitheal:view-changed", schedule, { signal })
  window.addEventListener("meitheal:task-nav-prefs-changed", syncTaskNavDom, { signal })
  window.addEventListener("meitheal:task-nav-dom-synced", syncTaskNavDom, { signal })
  document.fonts?.addEventListener("loadingdone", schedule, { signal })
  void document.fonts?.ready.then(schedule)
  signal.addEventListener("abort", () => {
    resize.disconnect()
    appearance.disconnect()
    content.disconnect()
    cancelAnimationFrame(frame)
    restoreItems(null)
    refreshLinks()
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
