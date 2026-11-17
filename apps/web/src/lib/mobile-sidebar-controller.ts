import { pageLifecycle } from "./page-lifecycle"
import { hasPriorityOverlay } from "./layout-shortcuts-controller"
import { containTabFocus } from "./focus-trap"

pageLifecycle.onPageLoad(signal => {
  const mobileMenu = document.querySelector<HTMLButtonElement>("#menu-toggle")
  const sidebar = document.getElementById("sidebar")
  if (!mobileMenu || !sidebar || mobileMenu.dataset.drawerReady === "true") return
  mobileMenu.dataset.drawerReady = "true"
  let drawerScroll = 0
  function closeDrawer(restoreFocus = false, restoreScroll = true) {
    if (!sidebar?.classList.contains("open")) return
    sidebar.classList.remove("open")
    document.body.classList.remove("sidebar-open")
    mobileMenu?.setAttribute("aria-expanded", "false")
    if (restoreFocus) mobileMenu?.focus()
    if (restoreScroll) requestAnimationFrame(() => { if (!signal.aborted) window.scrollTo(0, drawerScroll) })
  }
  mobileMenu.addEventListener("click", () => {
    if (sidebar.classList.contains("open")) { closeDrawer(true); return }
    drawerScroll = window.scrollY
    sidebar.classList.add("open")
    document.body.classList.add("sidebar-open")
    mobileMenu.setAttribute("aria-expanded", "true")
    const activeLink = sidebar.querySelector<HTMLElement>('.nav-link[aria-current="page"]')
    const focusTarget = activeLink ?? sidebar.querySelector<HTMLElement>(".nav-link")
    focusTarget?.focus()
  }, { signal })
  sidebar.querySelector("#sidebar-toggle-btn")?.addEventListener("click", () => closeDrawer(true), { signal })
  matchMedia("(min-width: 769px)").addEventListener("change", event => {
    if (event.matches) closeDrawer()
  }, { signal })
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
    } else containTabFocus(sidebar, event)
  }, { signal })
  mobileMenu.disabled = false
  signal.addEventListener("abort", () => {
    closeDrawer()
    mobileMenu.disabled = true
    delete mobileMenu.dataset.drawerReady
  }, { once: true })
})
