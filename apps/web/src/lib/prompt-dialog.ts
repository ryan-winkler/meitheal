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

import { dialogText, isTopManagedDialog, openManagedDialog } from "./dialog-overlay"

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

    const titleEl = document.createElement("h3")
    titleEl.id = "prompt-title"
    titleEl.className = "m-dialog-title"
    titleEl.textContent = options.title ?? dialogText("common.input", "Input")

    const input = document.createElement("input")
    input.type = "text"
    input.id = "prompt-input"
    input.setAttribute("aria-labelledby", "prompt-title")
    input.autocomplete = "off"
    input.maxLength = 200
    input.placeholder = options.placeholder ?? ""
    input.value = options.defaultValue ?? ""
    input.defaultValue = input.value

    const errorDiv = document.createElement("div")
    errorDiv.id = "prompt-error"
    errorDiv.setAttribute("role", "alert")
    errorDiv.setAttribute("aria-live", "assertive")

    const actions = document.createElement("div")
    actions.className = "m-dialog-actions"
    const cancelBtn = document.createElement("button")
    cancelBtn.type = "button"
    cancelBtn.id = "prompt-cancel"
    cancelBtn.className = "m-dialog-btn m-dialog-btn--secondary"
    cancelBtn.textContent = options.cancelText ?? dialogText("common.cancel", "Cancel")

    const okBtn = document.createElement("button")
    okBtn.type = "button"
    okBtn.id = "prompt-ok"
    okBtn.className = "m-dialog-btn m-dialog-btn--primary"
    okBtn.textContent = options.confirmText ?? dialogText("common.ok", "OK")

    actions.append(cancelBtn, okBtn)
    dialog.appendChild(titleEl)
    if (options.message) {
      const message = document.createElement("p")
      message.id = "prompt-message"
      message.className = "m-dialog-message"
      message.textContent = options.message
      input.setAttribute("aria-describedby", "prompt-message")
      dialog.appendChild(message)
    }
    dialog.append(input, errorDiv, actions)

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
      if (
        !input.isConnected ||
        options.signal?.aborted ||
        !isTopManagedDialog("meitheal-prompt-overlay") ||
        document.activeElement === input
      ) {
        return
      }
      const active = document.activeElement
      if (active && active !== document.body) return
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
