import { createClientLogger } from "@lib/client-logger"

const log = createClientLogger("ui", "async-button")

/**
 * withAsyncButton — Prevent double-clicks on async actions
 *
 * Wraps a button handler so that:
 * 1. The button is disabled for the duration of the async operation
 * 2. Optional loading text is shown during the operation
 * 3. The button is restored on success or failure
 * 4. Errors are caught and optionally reported
 *
 * @domain ui
 * @phase 25 — Client-Side Resilience
 *
 * @example
 * ```ts
 * import { withAsyncButton } from "@lib/async-button"
 *
 * submitBtn.addEventListener("click", withAsyncButton(submitBtn, async () => {
 *   await fetch("/api/tasks", { method: "POST", ... })
 * }, { loadingText: "Creating…" }))
 * ```
 */

export interface AsyncButtonOptions {
  /** Text to show while the operation is in progress */
  loadingText?: string
  /** Class to add while the operation is in progress */
  loadingClass?: string
  /** Callback for errors (defaults to structured log.warn) */
  onError?: (error: unknown) => void
}

/**
 * Wraps an async handler to prevent double-clicks and show loading state.
 *
 * Returns an event handler function suitable for addEventListener.
 */
export function withAsyncButton(
  button: HTMLButtonElement,
  handler: (e: Event) => Promise<void>,
  options: AsyncButtonOptions = {},
): (e: Event) => void {
  const { loadingText, loadingClass, onError } = options

  return async (e: Event) => {
    if (button.disabled) return

    const originalText = button.textContent
    const originalAriaLabel = button.getAttribute("aria-label")

    button.disabled = true
    if (loadingText) button.textContent = loadingText
    if (loadingClass) button.classList.add(loadingClass)
    button.setAttribute("aria-busy", "true")

    try {
      await handler(e)
    } catch (err) {
      if (onError) onError(err)
      else log.warn("handler error", err)
    } finally {
      button.disabled = false
      if (loadingText && originalText) button.textContent = originalText
      if (loadingClass) button.classList.remove(loadingClass)
      button.removeAttribute("aria-busy")
      if (originalAriaLabel) button.setAttribute("aria-label", originalAriaLabel)
    }
  }
}
