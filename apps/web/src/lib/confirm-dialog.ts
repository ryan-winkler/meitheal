/**
 * Custom Confirm Dialog — replaces native browser confirm()
 *
 * Renders a themed, centered modal that matches the app's design system.
 * Returns a Promise<boolean> — true if confirmed, false if cancelled.
 *
 * Bounded context: lib (shared UI utility)
 */

import { dialogText, openManagedDialog } from "./dialog-overlay"
import { copyToClipboard } from "./clipboard"

export interface ConfirmOptions {
  title?: string
  message: string
  details?: readonly string[]
  confirmText?: string
  /** A validated HTTP(S) destination opened by a native link click. */
  confirmUrl?: URL
  copyPrompt?: { text: string; label: string; success: string; failure: string }
  cancelText?: string
  variant?: "danger" | "warning" | "default"
  signal?: AbortSignal
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  if (options.signal?.aborted) return Promise.resolve(false)
  if (options.confirmUrl && !["http:", "https:"].includes(options.confirmUrl.protocol)) return Promise.resolve(false)
  return new Promise((resolve) => {
    const variant = options.variant ?? "default"
    const dialog = document.createElement("div")
    dialog.className = "m-dialog-card"
    dialog.dataset.variant = variant
    const icon = variant === "danger" ? "🗑️" : variant === "warning" ? "⚠️" : "❓"

    dialog.innerHTML = `
      <div data-confirm-icon aria-hidden="true" style="font-size: 32px; text-align: center; margin-bottom: 16px;"></div>
      <h3 id="confirm-title" class="m-dialog-title"></h3>
      <p id="confirm-message" class="m-dialog-message"></p>
      <ul id="confirm-details" hidden></ul>
      <p id="confirm-copy-status" role="status" hidden></p>
      <div class="m-dialog-actions">
        <button type="button" id="confirm-cancel" class="m-dialog-btn m-dialog-btn--secondary"></button>
        <button type="button" id="confirm-ok" class="m-dialog-btn m-dialog-btn--primary"></button>
      </div>
    `

    // Dialog options are plain text, including values read back from DOM labels.
    dialog.querySelector<HTMLElement>("[data-confirm-icon]")!.textContent = icon
    dialog.querySelector<HTMLElement>("#confirm-title")!.textContent = options.title ?? dialogText("common.confirm", "Confirm")
    dialog.querySelector<HTMLElement>("#confirm-message")!.textContent = options.message
    const details = dialog.querySelector<HTMLElement>("#confirm-details")!
    for (const text of options.details ?? []) {
      const item = document.createElement("li")
      item.textContent = text
      details.appendChild(item)
    }
    let describedBy = "confirm-message"
    if (details.childElementCount) {
      details.hidden = false
      describedBy = "confirm-message confirm-details"
    }

    const cancelBtn = dialog.querySelector<HTMLButtonElement>("#confirm-cancel")!
    let okBtn: HTMLButtonElement | HTMLAnchorElement = dialog.querySelector<HTMLButtonElement>("#confirm-ok")!
    const copyPrompt = options.copyPrompt
    const copyStatus = dialog.querySelector<HTMLElement>("#confirm-copy-status")!
    const copyBtn = copyPrompt ? document.createElement("button") : undefined
    if (copyBtn && copyPrompt) {
      copyBtn.type = "button"
      copyBtn.className = "m-dialog-btn m-dialog-btn--secondary"
      copyBtn.textContent = copyPrompt.label
      cancelBtn.after(copyBtn)
    }
    if (options.confirmUrl) {
      const link = document.createElement("a")
      link.id = okBtn.id
      link.className = "m-dialog-btn m-dialog-btn--primary"
      link.href = options.confirmUrl.href
      link.target = "_blank"
      link.rel = "noopener noreferrer"
      okBtn.replaceWith(link)
      okBtn = link
    }
    cancelBtn.textContent = options.cancelText ?? dialogText("common.cancel", "Cancel")
    okBtn.textContent = options.confirmText ?? dialogText("common.confirm", "Confirm")

    const { signal, isSettled, close } = openManagedDialog<boolean>({
      id: "meitheal-confirm-overlay",
      role: "alertdialog",
      labelledBy: "confirm-title",
      describedBy,
      dialog,
      cancelValue: false,
      signal: options.signal,
      resolve,
      onBeforeClose: (result) => {
        if (!result && okBtn instanceof HTMLAnchorElement) okBtn.removeAttribute("href")
      },
    })

    // Focus the cancel button by default (safer)
    cancelBtn.focus()

    cancelBtn.addEventListener("click", () => close(false), { signal })
    okBtn.addEventListener("click", (event) => {
      if (isSettled() || options.signal?.aborted) {
        event.preventDefault()
        return
      }
      // Keep external target="_blank" anchor mounted briefly so the browser initiates navigation before removal.
      close(true, !(okBtn instanceof HTMLAnchorElement))
    }, { signal })
    if (copyBtn && copyPrompt) {
      copyBtn.addEventListener("click", async () => {
        if (isSettled() || options.signal?.aborted || copyBtn.getAttribute("aria-busy") === "true") return
        copyBtn.setAttribute("aria-busy", "true")
        const copied = await copyToClipboard(copyPrompt.text)
        if (isSettled() || options.signal?.aborted) return
        copyStatus.textContent = ""
        copyStatus.hidden = false
        requestAnimationFrame(() => {
          if (!isSettled() && !options.signal?.aborted && copyStatus.isConnected) {
            copyStatus.textContent = copied ? copyPrompt.success : copyPrompt.failure
          }
        })
        copyBtn.removeAttribute("aria-busy")
      }, { signal })
    }
  })
}
