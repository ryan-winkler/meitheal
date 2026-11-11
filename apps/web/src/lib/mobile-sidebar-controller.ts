import { pageLifecycle } from "./page-lifecycle"

pageLifecycle.onPageLoad(signal => {
  const mobileMenu = document.querySelector<HTMLButtonElement>("#menu-toggle")
  const sidebar = document.getElementById("sidebar")
  if (!mobileMenu || !sidebar || mobileMenu.dataset.drawerReady === "true") return
  mobileMenu.dataset.drawerReady = "true"
  let drawerScroll = 0
  function closeDrawer(restoreFocus = false) {
    if (!sidebar?.classList.contains("open")) return
    sidebar.classList.remove("open")
    document.body.classList.remove("sidebar-open")
    mobileMenu?.setAttribute("aria-expanded", "false")
    if (restoreFocus) mobileMenu?.focus()
    requestAnimationFrame(() => { if (!signal.aborted) window.scrollTo(0, drawerScroll) })
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
  document.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : null
    if (!target || mobileMenu.contains(target)) return
    const link = target.closest(".nav-link:not(.nav-link--external)")
    if (!sidebar.contains(target) || link) closeDrawer()
  }, { signal })
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && sidebar.classList.contains("open")) {
      event.preventDefault()
      closeDrawer(true)
    }
  }, { signal })
  mobileMenu.disabled = false
  signal.addEventListener("abort", () => {
    closeDrawer()
    mobileMenu.disabled = true
    delete mobileMenu.dataset.drawerReady
  }, { once: true })
})
