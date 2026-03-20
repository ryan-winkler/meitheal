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

/** Check if a helper has been dismissed */
export function isHelperDismissed(helperId: string): boolean {
  return getDismissed().has(helperId)
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

/**
 * Initialize all helpers on the page.
 * Hides previously dismissed helpers and wires up dismiss buttons.
 */
export function initHelperSystem(): void {
  const helpers = document.querySelectorAll<HTMLElement>("[data-helper-id]")

  for (const el of helpers) {
    const helperId = el.dataset.helperId
    if (!helperId) continue

    // Hide if previously dismissed
    if (isHelperDismissed(helperId)) {
      el.style.display = "none"
      continue
    }

    // Wire collapse toggle
    const toggle = el.querySelector<HTMLButtonElement>("[data-helper-toggle]")
    if (toggle) {
      toggle.addEventListener("click", () => {
        el.classList.toggle("inline-helper--collapsed")
      })
    }

    // Wire dismiss button
    const dismiss = el.querySelector<HTMLButtonElement>("[data-helper-dismiss]")
    if (dismiss) {
      dismiss.addEventListener("click", () => {
        dismissHelper(helperId)
        el.style.display = "none"
        el.dispatchEvent(new CustomEvent("helper:dismissed", { bubbles: true, detail: { helperId } }))
      })
    }
  }

  // Global keyboard shortcut: ? to restore all helpers
  document.addEventListener("keydown", (e) => {
    // Only trigger if not in an input/textarea/contenteditable
    const target = e.target as HTMLElement
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return

    if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const count = dismissedCount()
      if (count === 0) return

      restoreAllHelpers()
      // Show all helpers on current page
      const allHelpers = document.querySelectorAll<HTMLElement>("[data-helper-id]")
      for (const h of allHelpers) {
        h.style.display = ""
        h.classList.remove("inline-helper--collapsed")
      }

      // Brief flash notification
      const flash = document.createElement("div")
      flash.className = "helper-restore-flash"
      flash.textContent = `${count} helper${count > 1 ? "s" : ""} restored — press ? again to dismiss`
      document.body.appendChild(flash)
      setTimeout(() => flash.remove(), 2500)
    }
  })
}
