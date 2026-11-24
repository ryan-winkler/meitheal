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
import { createSpriteIconElement } from "../generated/icon-registry"

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
    const iconName = variant === "danger" ? "trash" : variant === "warning" ? "alert-triangle" : "info-circle"

    const iconWrap = document.createElement("div")
    iconWrap.dataset.confirmIcon = ""
    iconWrap.setAttribute("aria-hidden", "true")
    iconWrap.style.cssText = "display:flex;justify-content:center;margin-bottom:14px;color:var(--accent);"
    if (variant === "danger") iconWrap.style.color = "var(--danger, #dc2626)"
    else if (variant === "warning") iconWrap.style.color = "var(--warning, #d97706)"
    iconWrap.appendChild(createSpriteIconElement(iconName, { size: 28 }))

    const titleEl = document.createElement("h3")
    titleEl.id = "confirm-title"
    titleEl.className = "m-dialog-title"
    titleEl.textContent = options.title ?? dialogText("common.confirm", "Confirm")

    const messageEl = document.createElement("p")
    messageEl.id = "confirm-message"
    messageEl.className = "m-dialog-message"
    messageEl.textContent = options.message

    const details = document.createElement("ul")
    details.id = "confirm-details"
    details.hidden = true
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

    const copyStatus = document.createElement("p")
    copyStatus.id = "confirm-copy-status"
    copyStatus.setAttribute("role", "status")
    copyStatus.hidden = true

    const actions = document.createElement("div")
    actions.className = "m-dialog-actions"
    const cancelBtn = document.createElement("button")
    cancelBtn.type = "button"
    cancelBtn.id = "confirm-cancel"
    cancelBtn.className = "m-dialog-btn m-dialog-btn--secondary"

    let okBtn: HTMLButtonElement | HTMLAnchorElement = document.createElement("button")
    okBtn.type = "button"
    okBtn.id = "confirm-ok"
    okBtn.className = "m-dialog-btn m-dialog-btn--primary"

    actions.append(cancelBtn, okBtn)
    dialog.append(iconWrap, titleEl, messageEl, details, copyStatus, actions)

    const copyPrompt = options.copyPrompt
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
