import {
  pinsChanged, pinsInvalidated, readPinPresence, supportsPersonalPins, watchPinLease,
} from "./task-pin-client"

export function bindSidebarPinPresence(sidebar: HTMLElement, signal: AbortSignal): void {
  const item = sidebar.querySelector<HTMLElement>("[data-sidebar-pin-presence]")
  if (!item || !supportsPersonalPins()) return

  const desktop = matchMedia("(min-width: 769px)")
  const foreground = () => !signal.aborted && document.visibilityState !== "hidden" && document.hasFocus()
    && (desktop.matches || sidebar.classList.contains("open"))
  let request: AbortController | undefined
  let stopLease: (() => void) | undefined
  let checked = false
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
    checked = false
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
      checked = true
      if (result.value.hasPins !== true) {
        hide(true)
        return
      }
      item!.hidden = false
      stopLease = watchPinLease(result.lease, signal, () => lastInteraction, () => {}, () => suspend(true))
    } catch {
      if (request === current) {
        suspend(true)
        checked = true
      }
    } finally {
      if (request === current) request = undefined
    }
  }

  function syncVisibility() {
    if (!foreground()) suspend()
    else if (!request && !checked) void refresh()
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
  window.addEventListener("pagehide", () => suspend(), { signal })
  window.addEventListener(pinsChanged, () => void refresh(), { signal })
  window.addEventListener(pinsInvalidated, () => {
    suspend(true)
    checked = true
  }, { signal })
  for (const type of ["pointerdown", "keydown"]) document.addEventListener(type, () => {
    lastInteraction = performance.now()
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
