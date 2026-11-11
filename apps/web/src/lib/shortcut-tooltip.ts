/**
 * shortcutTooltip — Attach keyboard shortcut hints to interactive elements
 *
 * Adds a small badge showing the keyboard shortcut on hover,
 * respecting OS-specific modifier keys (⌘ vs Ctrl).
 *
 * @domain ui
 * @phase 25 — Client-Side Resilience
 *
 * @example
 * ```ts
 * import { attachShortcutTooltips } from "@lib/shortcut-tooltip"
 *
 * // Declarative: elements with data-shortcut="n" get tooltip badges
 * attachShortcutTooltips(document.body)
 *
 * // Or in HTML:
 * // <button data-shortcut="n" data-shortcut-label="New Task">+ New</button>
 * ```
 */

import { singleKeyShortcutsEnabled } from "@lib/single-key-shortcuts"

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "")

/** Map modifier names to OS-appropriate symbols */
function formatKey(key: string): string {
  const modMap: Record<string, string> = isMac
    ? { ctrl: "⌘", alt: "⌥", shift: "⇧", meta: "⌘" }
    : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Win" }

  // Handle combo keys like "ctrl+k"
  const parts = key.toLowerCase().split("+")
  return parts
    .map((p) => modMap[p] || p.toUpperCase())
    .join(isMac ? "" : "+")
}

/** Create tooltip badge element */
function createBadge(key: string): HTMLSpanElement {
  const badge = document.createElement("span")
  badge.className = "shortcut-badge"
  badge.textContent = formatKey(key)
  badge.setAttribute("aria-hidden", "true")
  return badge
}

/**
 * Scan a container for elements with `data-shortcut` and attach
 * tooltip badges that appear on hover.
 *
 * Safe to call multiple times to update existing shortcut hints.
 */
export function attachShortcutTooltips(container: HTMLElement): void {
  const singleKeysEnabled = singleKeyShortcutsEnabled()
  for (const el of container.querySelectorAll<HTMLElement>("[data-shortcut]")) {
    const key = el.dataset.shortcut
    if (!key) continue

    const enabled = key.length !== 1 || singleKeysEnabled
    let badge = el.querySelector(".shortcut-badge")
    if (enabled && !badge) {
      if (getComputedStyle(el).position === "static") el.style.position = "relative"
      badge = createBadge(key)
      el.appendChild(badge)
    }
    badge?.toggleAttribute("hidden", !enabled)

    const label = el.dataset.shortcutLabel || el.getAttribute("aria-label")
    if (label) {
      const title = `${label} (${formatKey(key)})`
      if (enabled) el.setAttribute("title", title)
      else if (el.getAttribute("title") === title) el.setAttribute("title", label)
    }
  }

  for (const launcher of container.querySelectorAll(".unified-bar__search-launcher, #settings-bar-search-launcher")) {
    if (singleKeysEnabled) launcher.setAttribute("aria-keyshortcuts", "/")
    else launcher.removeAttribute("aria-keyshortcuts")
    launcher.querySelector("kbd")?.toggleAttribute("hidden", !singleKeysEnabled)
  }
}

/**
 * Inject the shortcut badge styles into the document.
 * Safe to call multiple times — uses a dedup marker.
 */
export function injectShortcutStyles(): void {
  if (document.getElementById("shortcut-badge-styles")) return

  const style = document.createElement("style")
  style.id = "shortcut-badge-styles"
  style.textContent = `
    .shortcut-badge {
      position: absolute;
      top: -6px;
      right: -6px;
      display: none;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 4px;
      font-size: 10px;
      font-weight: 700;
      font-family: system-ui, -apple-system, sans-serif;
      line-height: 1;
      color: var(--text-muted, #888);
      background: var(--bg-surface, #1e1e2e);
      border: 1px solid var(--border, #334155);
      border-radius: 4px;
      pointer-events: none;
      white-space: nowrap;
      z-index: 10;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
    }

    .unified-bar__search-launcher kbd[hidden] {
      display: none;
    }

    *:hover > .shortcut-badge:not([hidden]),
    *:focus-visible > .shortcut-badge:not([hidden]) {
      display: inline-flex;
    }

    @media (prefers-reduced-motion: reduce) {
      .shortcut-badge { transition: none; }
    }

    /* Hide on touch devices — keyboard shortcuts aren't relevant */
    @media (hover: none) {
      .shortcut-badge { display: none !important; }
    }
  `
  document.head.appendChild(style)
}
