/**
 * Helper System Controller — manages collapsible/dismissible inline helpers
 *
 * Persists dismissal state in localStorage so dismissed helpers stay gone
 * across page loads. Users can restore all helpers via keyboard shortcut (?)
 * or a "Show helpers" toggle in settings.
 *
 * @domain navigation (UX support)
 * @phase 15 — Hierarchy Architecture Overhaul
 * @kcs Helpers are explainer callouts that teach the hierarchy model.
 *      They can be dismissed individually or restored globally.
 */

import { singleKeyShortcutsEnabled } from "@lib/single-key-shortcuts"

const STORAGE_KEY = "meitheal-dismissed-helpers"

/** Get set of dismissed helper IDs */
function getDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    return new Set(JSON.parse(raw) as string[])
  } catch {
    return new Set()
  }
}

/** Persist dismissed set */
function saveDismissed(dismissed: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...dismissed]))
  } catch { /* storage unavailable */ }
}

/** Dismiss a specific helper */
export function dismissHelper(helperId: string): void {
  const dismissed = getDismissed()
  dismissed.add(helperId)
  saveDismissed(dismissed)
}

/** Restore all helpers (clear all dismissals) */
export function restoreAllHelpers(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch { /* storage unavailable */ }
}

/** Count of currently dismissed helpers */
export function dismissedCount(): number {
  return getDismissed().size
}

function handleHelperClick(event: MouseEvent): void {
  if (!(event.target instanceof Element)) return
  const control = event.target.closest<HTMLButtonElement>("[data-helper-toggle], [data-helper-dismiss]")
  const helper = control?.closest<HTMLElement>("[data-helper-id]")
  const helperId = helper?.dataset.helperId
  if (!control || !helper || !helperId) return

  if (control.hasAttribute("data-helper-toggle")) {
    const collapsed = helper.classList.toggle("inline-helper--collapsed")
    control.setAttribute("aria-expanded", String(!collapsed))
  } else {
    dismissHelper(helperId)
    helper.style.display = "none"
    helper.dispatchEvent(new CustomEvent("helper:dismissed", { bubbles: true, detail: { helperId } }))
  }
}

function handleHelperRestore(event: KeyboardEvent): void {
  if (event.key !== "?" || event.ctrlKey || event.metaKey || event.altKey || !singleKeyShortcutsEnabled()) return
  const target = event.target
  if (target instanceof HTMLElement && (target.matches("input, textarea") || target.isContentEditable)) return
  const count = dismissedCount()
  if (count === 0) return

  restoreAllHelpers()
  for (const helper of document.querySelectorAll<HTMLElement>("[data-helper-id]")) {
    helper.style.display = ""
    helper.classList.remove("inline-helper--collapsed")
    helper.querySelector("[data-helper-toggle]")?.setAttribute("aria-expanded", "true")
  }

  const flash = document.createElement("div")
  flash.className = "helper-restore-flash"
  flash.textContent = `${count} helper${count > 1 ? "s" : ""} restored`
  document.body.appendChild(flash)
  setTimeout(() => flash.remove(), 2500)
}

export function initHelperSystem(signal: AbortSignal): void {
  const dismissed = getDismissed()
  for (const helper of document.querySelectorAll<HTMLElement>("[data-helper-id]")) {
    if (helper.dataset.helperId && dismissed.has(helper.dataset.helperId)) helper.style.display = "none"
  }

  document.addEventListener("click", handleHelperClick, { signal })
  document.addEventListener("keydown", handleHelperRestore, { signal })
}
