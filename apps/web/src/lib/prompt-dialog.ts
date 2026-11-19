/**
 * Custom Prompt Dialog — replaces native browser prompt()
 *
 * Renders a themed, centered modal with a text input that matches
 * the app's design system. Returns a Promise<string | null> —
 * the entered string if confirmed, null if cancelled.
 *
 * @domain lib (shared UI utility)
 * @bounded-context ui-dialogs
 * @kcs Companion to confirmDialog — handles text input collection
 *      without native browser dialogs.
 */

import { dialogText, openManagedDialog } from "./dialog-overlay"

export interface PromptOptions {
  title?: string
  message?: string
  placeholder?: string
  defaultValue?: string
  confirmText?: string
  cancelText?: string
  /** Input validation — return error message or empty string if valid */
  validate?: (value: string) => string
  /** Set to true to require non-empty input */
  required?: boolean
  signal?: AbortSignal
}

export function promptDialog(options: PromptOptions): Promise<string | null> {
  if (options.signal?.aborted) return Promise.resolve(null)
  return new Promise((resolve) => {
    const dialog = document.createElement("div")
    dialog.className = "m-dialog-card"

    dialog.innerHTML = `
      <h3 id="prompt-title" class="m-dialog-title"></h3>
      <p id="prompt-message" class="m-dialog-message"></p>
      <input
        type="text"
        id="prompt-input"
        aria-labelledby="prompt-title"
        autocomplete="off"
        maxlength="200"
        placeholder=""
        value=""
      />
      <div id="prompt-error" role="alert" aria-live="assertive"></div>
      <div class="m-dialog-actions">
        <button type="button" id="prompt-cancel" class="m-dialog-btn m-dialog-btn--secondary"></button>
        <button type="button" id="prompt-ok" class="m-dialog-btn m-dialog-btn--primary"></button>
      </div>
    `

    // Assign text and input properties without parsing option values as HTML.
    dialog.querySelector<HTMLElement>("#prompt-title")!.textContent = options.title ?? dialogText("common.input", "Input")
    const message = dialog.querySelector<HTMLElement>("#prompt-message")!
    if (options.message) message.textContent = options.message
    else message.remove()
    const input = dialog.querySelector<HTMLInputElement>("#prompt-input")!
    const errorDiv = dialog.querySelector<HTMLElement>("#prompt-error")!
    const cancelBtn = dialog.querySelector<HTMLButtonElement>("#prompt-cancel")!
    const okBtn = dialog.querySelector<HTMLButtonElement>("#prompt-ok")!
    if (options.message) input.setAttribute("aria-describedby", "prompt-message")
    input.placeholder = options.placeholder ?? ""
    input.value = options.defaultValue ?? ""
    input.defaultValue = input.value
    cancelBtn.textContent = options.cancelText ?? dialogText("common.cancel", "Cancel")
    okBtn.textContent = options.confirmText ?? dialogText("common.ok", "OK")

    const showValidationError = (msg: string) => {
      errorDiv.textContent = msg
      input.setAttribute("aria-invalid", "true")
      input.setAttribute("aria-describedby", options.message ? "prompt-message prompt-error" : "prompt-error")
      input.focus()
    }

    const trySubmit = () => {
      const value = input.value.trim()
      if (options.required && !value) {
        showValidationError(dialogText("common.required_field", "This field is required"))
        return
      }
      if (options.validate) {
        const err = options.validate(value)
        if (err) {
          showValidationError(err)
          return
        }
      }
      close(value || null)
    }

    const { signal, close } = openManagedDialog<string | null>({
      id: "meitheal-prompt-overlay",
      role: "dialog",
      labelledBy: "prompt-title",
      dialog,
      cancelValue: null,
      signal: options.signal,
      resolve,
      onEnter: (e) => {
        if (document.activeElement === input || document.activeElement === okBtn) {
          e.preventDefault()
          trySubmit()
        }
      },
    })

    // Focus immediately (so Escape works on frame 0 over toasts) and re-ensure on next frame.
    input.focus()
    input.select()
    requestAnimationFrame(() => {
      if (!input.isConnected || options.signal?.aborted || document.activeElement === input) return
      input.focus()
      input.select()
    })

    cancelBtn.addEventListener("click", () => close(null), { signal })
    okBtn.addEventListener("click", trySubmit, { signal })
    input.addEventListener("input", () => {
      errorDiv.textContent = ""
      input.removeAttribute("aria-invalid")
      if (options.message) input.setAttribute("aria-describedby", "prompt-message")
      else input.removeAttribute("aria-describedby")
    }, { signal })
  })
}

// Register on window for use in define:vars scripts
if (typeof window !== "undefined") {
  ;(window as any).promptDialog = promptDialog
}
