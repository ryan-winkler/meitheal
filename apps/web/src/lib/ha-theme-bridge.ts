import { pageLifecycle } from "./page-lifecycle"
import { applyTheme } from "./theme-watcher"

type Appearance = "light" | "dark"

function parentAppearance(parent: Window): Appearance | undefined {
  const style = parent.getComputedStyle(parent.document.documentElement)
  const scheme = style.colorScheme
  if (scheme === "light" || scheme === "dark") return scheme

  const background = style.getPropertyValue("--primary-background-color").trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(background)?.[1]
  const rgb = /^rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/i.exec(background)
  let channels: number[] | undefined
  if (hex) {
    const pairs = hex.length === 3 ? [...hex].map(digit => digit + digit) : hex.match(/../g)
    channels = pairs?.map(channel => Number.parseInt(channel, 16))
  } else if (rgb) {
    channels = rgb.slice(1).map(Number)
  }
  if (!channels || channels.some(channel => channel > 255)) return

  const [red, green, blue] = channels
  if (red === undefined || green === undefined || blue === undefined) return
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue >= 128 ? "light" : "dark"
}

export function initHAThemeBridge(): void {
  const parent = window.parent
  if (!document.body.classList.contains("ha-ingress") || parent === window) return

  let parentRoot: HTMLElement
  try {
    if (parent.location.origin !== window.location.origin) return
    parentRoot = parent.document.documentElement
  } catch {
    return
  }

  const root = document.documentElement
  function syncAppearance(): void {
    let appearance: Appearance | undefined
    try {
      if (parent.location.origin !== window.location.origin) return
      appearance = parentAppearance(parent)
    } catch {
      return
    }

    if (root.dataset.haTheme === appearance) return
    if (appearance) root.dataset.haTheme = appearance
    else delete root.dataset.haTheme
    if (root.dataset.theme === "auto") applyTheme()
  }

  const signal = pageLifecycle.signal
  const observer = new MutationObserver(syncAppearance)
  const disconnect = () => observer.disconnect()
  function observe(): void {
    observer.observe(parentRoot, { attributes: true })
    syncAppearance()
  }

  observe()
  signal.addEventListener("abort", disconnect, { once: true })
  // The Home Assistant parent survives native iframe navigation.
  window.addEventListener("pagehide", disconnect, { signal })
  window.addEventListener("pageshow", event => {
    if (event.persisted) observe()
  }, { signal })
  document.addEventListener("settheme", syncAppearance, { signal })
  window.addEventListener("message", event => {
    if (event.source !== parent || event.origin !== window.location.origin) return
    if (event.data?.type === "theme-changed") syncAppearance()
  }, { signal })
}
