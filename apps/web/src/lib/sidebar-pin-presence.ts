import {
  PinAccessError, pinsChanged, pinsInvalidated, readPinPresence, supportsPersonalPins, watchPinLease,
} from "./task-pin-client"

export function bindSidebarPinPresence(sidebar: HTMLElement, signal: AbortSignal, waitForSidebarInteraction: boolean): void {
  const item = sidebar.querySelector<HTMLElement>("[data-sidebar-pin-presence]")
  if (!item || !supportsPersonalPins()) return

  const desktop = matchMedia("(min-width: 769px)")
  let sidebarActivated = !waitForSidebarInteraction
  const foreground = () => sidebarActivated && !signal.aborted && document.visibilityState !== "hidden" && document.hasFocus()
    && (desktop.matches || sidebar.classList.contains("open"))
  let request: AbortController | undefined
  let stopLease: (() => void) | undefined
  let nextCheckAt = 0
  let lastInteraction = performance.now()

  function hide(restoreFocus = false) {
    if (restoreFocus && item!.contains(document.activeElement)) {
      const fallback = desktop.matches
        ? sidebar.querySelector<HTMLElement>(document.documentElement.dataset.appearanceNavigation === "navbar"
          ? ".sidebar-brand" : "#sidebar-edge-toggle")
        : sidebar.querySelector<HTMLElement>("#sidebar-toggle-btn")
      fallback?.focus({ preventScroll: true })
    }
    item!.hidden = true
  }

  function suspend(restoreFocus = false) {
    request?.abort()
    request = undefined
    stopLease?.()
    stopLease = undefined
    nextCheckAt = 0
    hide(restoreFocus)
  }

  async function refresh() {
    if (!foreground()) return
    request?.abort()
    const current = new AbortController()
    request = current
    lastInteraction = performance.now()
    try {
      const result = await readPinPresence(AbortSignal.any([signal, current.signal]))
      if (request !== current || !foreground()) return
      stopLease?.()
      stopLease = undefined
      // Refresh a verified result on the next interaction after a minute.
      nextCheckAt = performance.now() + 60_000
      if (result.value.hasPins !== true) {
        hide(true)
        return
      }
      item!.hidden = false
      stopLease = watchPinLease(result.lease, signal, () => lastInteraction, () => {}, () => suspend(true))
    } catch (error) {
      if (request === current) {
        suspend(true)
        const requiresNewSession = error instanceof PinAccessError && error.kind !== "network"
        nextCheckAt = requiresNewSession ? Infinity : performance.now() + 5_000
      }
    } finally {
      if (request === current) request = undefined
    }
  }

  function syncVisibility() {
    if (!foreground()) suspend()
    else if (!request && performance.now() >= nextCheckAt) void refresh()
  }

  function restart() {
    suspend(true)
    syncVisibility()
  }

  const drawer = new MutationObserver(syncVisibility)
  drawer.observe(sidebar, { attributes: true, attributeFilter: ["class"] })
  desktop.addEventListener("change", syncVisibility, { signal })
  window.addEventListener("focus", syncVisibility, { signal })
  window.addEventListener("blur", syncVisibility, { signal })
  window.addEventListener("pageshow", syncVisibility, { signal })
  window.addEventListener("online", syncVisibility, { signal })
  window.addEventListener("pagehide", () => suspend(), { signal })
  window.addEventListener(pinsChanged, () => void refresh(), { signal })
  window.addEventListener(pinsInvalidated, () => {
    suspend(true)
    nextCheckAt = Infinity
  }, { signal })
  sidebar.addEventListener("focusin", () => {
    if (sidebarActivated) return
    sidebarActivated = true
    syncVisibility()
  }, { signal })
  for (const type of ["pointerdown", "keydown"]) document.addEventListener(type, event => {
    lastInteraction = performance.now()
    if (event.target instanceof Node && sidebar.contains(event.target)) sidebarActivated = true
    syncVisibility()
  }, { signal })
  document.addEventListener("visibilitychange", syncVisibility, { signal })
  navigator.serviceWorker?.addEventListener("controllerchange", restart, { signal })
  signal.addEventListener("abort", () => {
    drawer.disconnect()
    suspend()
  }, { once: true })
  syncVisibility()
}
