import { pageLifecycle } from "./page-lifecycle"
import { hasPriorityOverlay } from "./layout-shortcuts-controller"
import { containTabFocus } from "./focus-trap"

export const SIDEBAR_FOCUS_REVEAL_EVENT = "meitheal:sidebar-focus-reveal"

const runtime = window as unknown as {
  __meithealSidebarFocusHandoff?: { sidebar: HTMLElement; target: HTMLElement; controller: AbortController }
}

pageLifecycle.onPageLoad(signal => {
  const mobileMenu = document.querySelector<HTMLButtonElement>("#menu-toggle")
  const sidebar = document.getElementById("sidebar")
  const handoff = runtime.__meithealSidebarFocusHandoff
  delete runtime.__meithealSidebarFocusHandoff
  handoff?.controller.abort()
  if (!mobileMenu || !sidebar || mobileMenu.dataset.drawerReady === "true") return
  const previousFocus = handoff?.sidebar === sidebar ? handoff.target : undefined
  mobileMenu.dataset.drawerReady = "true"
  let drawerScroll = 0
  function closeDrawer(restoreFocus = false, restoreScroll = true) {
    if (!sidebar?.classList.contains("open")) return
    if (innerWidth <= 768 && !restoreFocus && document.activeElement instanceof HTMLElement && sidebar.contains(document.activeElement)) {
      document.activeElement.blur()
    }
    sidebar.classList.remove("open")
    document.body.classList.remove("sidebar-open")
    mobileMenu?.setAttribute("aria-expanded", "false")
    if (restoreFocus) mobileMenu?.focus()
    if (restoreScroll) requestAnimationFrame(() => { if (!signal.aborted) window.scrollTo(0, drawerScroll) })
  }
  function openDrawer(moveFocus = true) {
    if (!sidebar || !mobileMenu) return
    drawerScroll = window.scrollY
    sidebar.classList.add("open")
    document.body.classList.add("sidebar-open")
    mobileMenu.setAttribute("aria-expanded", "true")
    if (moveFocus) {
      const activeLink = sidebar.querySelector<HTMLElement>('.nav-link[aria-current="page"]')
      const focusTarget = activeLink ?? sidebar.querySelector<HTMLElement>(".nav-link")
      focusTarget?.focus()
    }
  }
  mobileMenu.addEventListener("click", () => {
    if (sidebar.classList.contains("open")) { closeDrawer(true); return }
    openDrawer()
  }, { signal })
  sidebar.querySelector("#sidebar-toggle-btn")?.addEventListener("click", () => closeDrawer(true), { signal })
  matchMedia("(min-width: 769px)").addEventListener("change", event => {
    if (event.matches) closeDrawer()
  }, { signal })
  const revealFocusedSidebar = () => {
    if (innerWidth <= 768 && !sidebar.classList.contains("open") && sidebar.contains(document.activeElement)) openDrawer(false)
  }
  window.addEventListener("resize", revealFocusedSidebar, { signal })
  sidebar.addEventListener(SIDEBAR_FOCUS_REVEAL_EVENT, revealFocusedSidebar, { signal })
  document.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : null
    if (!target || mobileMenu.contains(target) || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (sidebar.classList.contains("open") && !sidebar.contains(target)) {
      closeDrawer(true)
      return
    }
    const link = target.closest(".nav-link:not(.nav-link--external), .task-creation__settings")
    if (link && sidebar.contains(target) && !sidebar.hasAttribute("data-sidebar-editing")) closeDrawer(false, !link.matches(".task-creation__settings"))
  }, { signal })
  document.addEventListener("keydown", event => {
    if (!sidebar.classList.contains("open") || event.defaultPrevented || hasPriorityOverlay()
      || document.querySelector("#search-hub-overlay:not(.hidden)")) return
    if (event.key === "Escape") {
      event.preventDefault()
      closeDrawer(true)
    } else {
      const popup = [...document.querySelectorAll<HTMLElement>("[data-sidebar-board-owner]")].find(element => {
        const owner = document.getElementById(element.dataset.sidebarBoardOwner ?? "")
        return !element.hidden && element.getClientRects().length > 0 && owner !== null && sidebar.contains(owner)
      })
      containTabFocus(popup ?? sidebar, event)
    }
  }, { signal })
  mobileMenu.disabled = false
  // A persisted sidebar can cross the phone breakpoint while incoming scripts load.
  // Its old listeners are already aborted, and display:none can blur the focused link.
  if (previousFocus && innerWidth <= 768 && previousFocus.isConnected && sidebar.contains(previousFocus)
    && !previousFocus.closest("[hidden], [inert]") && !hasPriorityOverlay()
    && !document.querySelector('#search-hub-overlay:not(.hidden), #shortcut-modal:not(.hidden)')
    && (document.activeElement === document.body || document.activeElement === previousFocus)) {
    openDrawer(false)
    if (previousFocus.getClientRects().length && getComputedStyle(previousFocus).visibility === "visible") {
      previousFocus.focus({ preventScroll: true })
    } else closeDrawer()
  }
  signal.addEventListener("abort", () => {
    runtime.__meithealSidebarFocusHandoff?.controller.abort()
    delete runtime.__meithealSidebarFocusHandoff
    const focused = document.activeElement
    if (innerWidth > 768 && focused instanceof HTMLElement && sidebar.contains(focused)) {
      const pending = { sidebar, target: focused, controller: new AbortController() }
      runtime.__meithealSidebarFocusHandoff = pending
      const cancel = () => {
        if (runtime.__meithealSidebarFocusHandoff === pending) delete runtime.__meithealSidebarFocusHandoff
        pending.controller.abort()
      }
      // Track new intent during the script-loading gap; CSS blur itself has no focusin.
      document.addEventListener("focusin", event => {
        if (event.target instanceof HTMLElement && sidebar.contains(event.target)) pending.target = event.target
        else cancel()
      }, { capture: true, signal: pending.controller.signal })
      document.addEventListener("pointerdown", event => {
        if (!(event.target instanceof Node) || !sidebar.contains(event.target)) cancel()
      }, { capture: true, signal: pending.controller.signal })
    }
    closeDrawer()
    mobileMenu.disabled = true
    delete mobileMenu.dataset.drawerReady
  }, { once: true })
})
