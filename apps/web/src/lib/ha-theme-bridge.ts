import { applyPersonalAccent } from "./accent-colors"
import { applyHAThemePalette, HA_THEME_MATCH_KEY, readHAThemePalette } from "./ha-theme-palette"
import { pageLifecycle } from "./page-lifecycle"
import { applyTheme, readAppearanceValue } from "./theme-watcher"

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

function frameParent(): Window | undefined {
  if (!window.__ingress_path && !document.body?.classList.contains("ha-ingress")) return
  try {
    const parent = window.parent
    if (parent !== window && parent.location.origin === window.location.origin && window.frameElement?.isConnected) return parent
  } catch {
    return
  }
}

export function refreshHAThemeMatch(preview?: { matchHaTheme?: boolean; accent?: string | null }): void {
  const root = document.documentElement
  const wasMatched = root.dataset.haMatch === "light" || root.dataset.haMatch === "dark"
  const parent = frameParent()
  const appearance = parent && parentAppearance(parent)
  if (appearance) root.dataset.haTheme = appearance
  else delete root.dataset.haTheme
  const matchEnabled = preview?.matchHaTheme !== undefined
    ? preview.matchHaTheme
    : readAppearanceValue(HA_THEME_MATCH_KEY) === "1"
  const accent = preview && "accent" in preview
    ? (preview.accent ?? null)
    : readAppearanceValue("meitheal-accent-color")
  const match = readHAThemePalette(matchEnabled, Boolean(parent))
  applyHAThemePalette(root, match, accent, applyPersonalAccent)
  if (wasMatched || match.state === "active" || (parent && root.dataset.theme === "auto")) applyTheme()
  document.dispatchEvent(new Event("meitheal:ha-theme-match"))
}

export function initHAThemeBridge(): void {
  let activeSignal: AbortSignal | undefined
  pageLifecycle.onPageLoad(signal => {
    if (signal === activeSignal) return
    activeSignal = signal
    let scheduled: number | undefined
    const schedule = () => {
      if (scheduled !== undefined || signal.aborted) return
      scheduled = requestAnimationFrame(() => {
        scheduled = undefined
        refreshHAThemeMatch()
      })
    }
    const observer = new MutationObserver(schedule)
    const disconnect = () => {
      observer.disconnect()
      if (scheduled !== undefined) cancelAnimationFrame(scheduled)
      scheduled = undefined
    }
    const observe = () => {
      const parent = frameParent()
      const frame = window.frameElement
      if (parent && frame) {
        const options = { attributeFilter: ["style", "class"] }
        observer.observe(parent.document.documentElement, options)
        observer.observe(frame, options)
      }
      refreshHAThemeMatch()
    }

    observe()
    signal.addEventListener("abort", disconnect, { once: true })
    window.addEventListener("pagehide", disconnect, { signal })
    window.addEventListener("pageshow", event => {
      if (event.persisted) observe()
    }, { signal })
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") schedule()
    }, { signal })
    window.addEventListener("storage", event => {
      if (event.key === HA_THEME_MATCH_KEY || event.key === null) schedule()
    }, { signal })
    for (const query of ["(forced-colors: active)", "(prefers-contrast: more)"]) {
      matchMedia(query).addEventListener("change", schedule, { signal })
    }
    document.addEventListener("settheme", schedule, { signal })
    window.addEventListener("message", event => {
      if (event.source !== frameParent() || event.origin !== window.location.origin) return
      if (event.data?.type === "theme-changed") schedule()
    }, { signal })
  })
}
