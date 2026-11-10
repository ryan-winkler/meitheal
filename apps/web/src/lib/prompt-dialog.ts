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

import { mountDialogOverlay } from "./dialog-overlay"

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
    // Remove any existing prompt dialog
    document.getElementById("meitheal-prompt-overlay")?.remove()

    const overlay = document.createElement("div")
    overlay.id = "meitheal-prompt-overlay"
    overlay.setAttribute("role", "dialog")
    overlay.setAttribute("aria-modal", "true")
    overlay.setAttribute("aria-labelledby", "prompt-title")
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 9999;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(4px);
      animation: confirmFadeIn 0.15s ease-out;
    `

    const dialog = document.createElement("div")
    dialog.style.cssText = `
      background: var(--bg-card, #1e293b); border: 1px solid var(--border, #334155);
      border-radius: 12px; padding: 24px; max-width: 420px; width: 90%;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      animation: confirmSlideIn 0.15s ease-out;
    `

    dialog.innerHTML = `
      <h3 id="prompt-title" style="
        margin: 0 0 12px; font-size: 16px; font-weight: 600;
        color: var(--text-primary, #f1f5f9); text-align: center;
      "></h3>
      <p id="prompt-message" style="
        margin: 0 0 16px; font-size: 14px; line-height: 1.5;
        color: var(--text-secondary, #94a3b8); text-align: center;
      "></p>
      <input
        type="text"
        id="prompt-input"
        autocomplete="off"
        maxlength="200"
        placeholder=""
        value=""
        style="
          width: 100%; box-sizing: border-box;
          padding: 10px 14px; font-size: 14px;
          background: var(--bg-primary, #0f172a);
          border: 1px solid var(--border, #334155);
          border-radius: 8px; color: var(--text-primary, #f1f5f9);
          outline: none; margin-bottom: 8px;
          transition: border-color 0.15s;
        "
      />
      <div id="prompt-error" style="
        font-size: 12px; color: var(--danger, #ef4444);
        min-height: 18px; margin-bottom: 8px; text-align: center;
      "></div>
      <div style="display: flex; gap: 12px; justify-content: center;">
        <button type="button" id="prompt-cancel" style="
          padding: 8px 20px; border-radius: 8px; font-size: 14px; cursor: pointer;
          background: transparent; border: 1px solid var(--border, #334155);
          color: var(--text-secondary, #94a3b8);
          transition: background 0.15s, border-color 0.15s;
        "></button>
        <button type="button" id="prompt-ok" style="
          padding: 8px 20px; border-radius: 8px; font-size: 14px; cursor: pointer;
          background: var(--accent, #6366f1); border: 1px solid var(--accent, #6366f1);
          color: #fff; font-weight: 500;
          transition: opacity 0.15s;
        "></button>
      </div>
    `

    // Assign text and input properties without parsing option values as HTML.
    dialog.querySelector<HTMLElement>("#prompt-title")!.textContent = options.title ?? "Input"
    const message = dialog.querySelector<HTMLElement>("#prompt-message")!
    if (options.message) message.textContent = options.message
    else message.remove()
    const input = dialog.querySelector<HTMLInputElement>("#prompt-input")!
    const errorDiv = dialog.querySelector<HTMLElement>("#prompt-error")!
    const cancelBtn = dialog.querySelector<HTMLButtonElement>("#prompt-cancel")!
    const okBtn = dialog.querySelector<HTMLButtonElement>("#prompt-ok")!
    input.placeholder = options.placeholder ?? ""
    input.value = options.defaultValue ?? ""
    input.defaultValue = input.value
    cancelBtn.textContent = options.cancelText ?? "Cancel"
    okBtn.textContent = options.confirmText ?? "OK"

    overlay.appendChild(dialog)
    const previouslyFocused = document.activeElement as HTMLElement | null
    mountDialogOverlay(overlay)

    // Focus and select input text
    requestAnimationFrame(() => {
      if (!input.isConnected || options.signal?.aborted) return
      input.focus()
      input.select()
    })

    let settled = false
    const abort = () => cleanup(null, true)
    function cleanup(result: string | null, immediate = false) {
      function remove() {
        document.removeEventListener("keydown", onKey, true)
        options.signal?.removeEventListener("abort", abort)
        overlay.remove()
        if (!options.signal?.aborted && previouslyFocused?.isConnected) previouslyFocused.focus()
      }
      if (settled) {
        if (immediate) remove()
        return
      }
      settled = true
      overlay.style.opacity = "0"
      if (immediate) remove()
      else setTimeout(remove, 100)
      resolve(result)
    }

    function trySubmit() {
      const value = input.value.trim()
      if (options.required && !value) {
        errorDiv.textContent = "This field is required"
        input.focus()
        return
      }
      if (options.validate) {
        const err = options.validate(value)
        if (err) {
          errorDiv.textContent = err
          input.focus()
          return
        }
      }
      cleanup(value || null)
    }

    cancelBtn.addEventListener("click", () => cleanup(null))
    okBtn.addEventListener("click", trySubmit)
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cleanup(null)
    })

    // Clear error on input
    input.addEventListener("input", () => {
      errorDiv.textContent = ""
    })

    // Focus border effect
    input.addEventListener("focus", () => {
      input.style.borderColor = "var(--accent, #6366f1)"
    })
    input.addEventListener("blur", () => {
      input.style.borderColor = "var(--border, #334155)"
    })

    function onKey(e: KeyboardEvent) {
      if (settled) {
        if (e.key === "Escape") {
          e.preventDefault()
          e.stopPropagation()
        }
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        cleanup(null)
      } else if (e.key === "Enter" && (document.activeElement === input || document.activeElement === okBtn)) {
        e.preventDefault()
        trySubmit()
      } else if (e.key === "Tab") {
        // Focus trap
        const focusable = [input, cancelBtn, okBtn].filter(Boolean)
        const idx = focusable.indexOf(document.activeElement as any)
        if (e.shiftKey) {
          e.preventDefault()
          focusable[idx <= 0 ? focusable.length - 1 : idx - 1]?.focus()
        } else {
          e.preventDefault()
          focusable[idx >= focusable.length - 1 ? 0 : idx + 1]?.focus()
        }
      }
    }
    document.addEventListener("keydown", onKey, true)
    options.signal?.addEventListener("abort", abort, { once: true })
  })
}

// Register on window for use in define:vars scripts
if (typeof window !== "undefined") {
  ;(window as any).promptDialog = promptDialog
}
