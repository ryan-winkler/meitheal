import { pageLifecycle } from "./page-lifecycle"
import { hasPriorityOverlay } from "./layout-shortcuts-controller"
import { containTabFocus } from "./focus-trap"

export const SIDEBAR_FOCUS_REVEAL_EVENT = "meitheal:sidebar-focus-reveal"

pageLifecycle.onPageLoad(signal => {
  const mobileMenu = document.querySelector<HTMLButtonElement>("#menu-toggle")
  const sidebar = document.getElementById("sidebar")
  if (!mobileMenu || !sidebar || mobileMenu.dataset.drawerReady === "true") return
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
    const link = target.closest(".nav-link:not(.nav-link--external), .task-creation__settings")
    // The mobile drawer backdrop is rendered by body::before.
    if (target === document.body) closeDrawer(true)
    else if (link && sidebar.contains(target)) closeDrawer(false, !link.matches(".task-creation__settings"))
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
  signal.addEventListener("abort", () => {
    closeDrawer()
    mobileMenu.disabled = true
    delete mobileMenu.dataset.drawerReady
  }, { once: true })
})
