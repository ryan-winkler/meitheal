/**
 * Custom Confirm Dialog — replaces native browser confirm()
 *
 * Renders a themed, centered modal that matches the app's design system.
 * Returns a Promise<boolean> — true if confirmed, false if cancelled.
 *
 * Bounded context: lib (shared UI utility)
 */

import { mountDialogOverlay } from "./dialog-overlay"
import { copyToClipboard } from "./clipboard"

export interface ConfirmOptions {
  title?: string;
  message: string;
  details?: readonly string[];
  confirmText?: string;
  /** A validated HTTP(S) destination opened by a native link click. */
  confirmUrl?: URL;
  copyPrompt?: { text: string; label: string; success: string; failure: string }
  cancelText?: string;
  variant?: "danger" | "warning" | "default";
  signal?: AbortSignal;
}

let dismissCurrent: (() => void) | undefined

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  if (options.signal?.aborted) return Promise.resolve(false);
  if (options.confirmUrl && !["http:", "https:"].includes(options.confirmUrl.protocol)) return Promise.resolve(false)
  return new Promise((resolve) => {
    dismissCurrent?.()

    const variant = options.variant ?? "default";
    const accentColor =
      variant === "danger"
        ? "var(--danger, #ef4444)"
        : variant === "warning"
          ? "var(--warning, #f59e0b)"
          : "var(--accent, #6366f1)";

    const overlay = document.createElement("div");
    overlay.id = "meitheal-confirm-overlay";
    overlay.setAttribute("role", "alertdialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "confirm-title");
    overlay.setAttribute("aria-describedby", "confirm-message");
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 9999;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(4px);
      animation: confirmFadeIn 0.15s ease-out;
    `;

    const dialog = document.createElement("div");
    dialog.style.cssText = `
      background: var(--bg-card, #1e293b); border: 1px solid var(--border, #334155);
      border-radius: 12px; padding: 24px; max-width: 420px; width: 90%;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      animation: confirmSlideIn 0.15s ease-out;
    `;

    const icon =
      variant === "danger" ? "🗑️" : variant === "warning" ? "⚠️" : "❓";

    dialog.innerHTML = `
      <div data-confirm-icon style="text-align: center; margin-bottom: 16px; font-size: 32px;"></div>
      <h3 id="confirm-title" style="
        margin: 0 0 8px; font-size: 16px; font-weight: 600;
        color: var(--text-primary, #f1f5f9); text-align: center;
      "></h3>
      <p id="confirm-message" style="
        margin: 0 0 24px; font-size: 14px; line-height: 1.5;
        color: var(--text-secondary, #94a3b8); text-align: center; overflow-wrap: anywhere;
      "></p>
      <ul id="confirm-details" hidden style="
        margin: 0 0 24px; padding-inline-start: 20px; max-block-size: 40vh;
        overflow: auto; overflow-wrap: anywhere; color: var(--text-secondary, #94a3b8);
      "></ul>
      <p id="confirm-copy-status" role="status" hidden style="margin: 0 0 12px; color: var(--text-secondary);"></p>
      <div style="display: flex; flex-wrap: wrap; gap: 12px; justify-content: center;">
        <button type="button" id="confirm-cancel" style="
          padding: 8px 20px; border-radius: 8px; font-size: 14px; cursor: pointer;
          background: transparent; border: 1px solid var(--border, #334155);
          color: var(--text-secondary, #94a3b8);
          transition: background 0.15s, border-color 0.15s;
        "></button>
        <button type="button" id="confirm-ok" style="
          padding: 8px 20px; border-radius: 8px; font-size: 14px; cursor: pointer;
          background: var(--accent, #6366f1); border: 1px solid var(--accent, #6366f1);
          color: #fff; font-weight: 500;
          transition: opacity 0.15s;
        "></button>
      </div>
    `;

    // Dialog options are plain text, including values read back from DOM labels.
    dialog.querySelector<HTMLElement>("[data-confirm-icon]")!.textContent = icon
    dialog.querySelector<HTMLElement>("#confirm-title")!.textContent = options.title ?? "Confirm"
    dialog.querySelector<HTMLElement>("#confirm-message")!.textContent = options.message
    const details = dialog.querySelector<HTMLElement>("#confirm-details")!
    for (const text of options.details ?? []) {
      const item = document.createElement("li")
      item.textContent = text
      details.appendChild(item)
    }
    if (details.childElementCount) {
      details.hidden = false
      overlay.setAttribute("aria-describedby", "confirm-message confirm-details")
    }
    const cancelBtn = dialog.querySelector<HTMLButtonElement>("#confirm-cancel")!
    let okBtn: HTMLButtonElement | HTMLAnchorElement = dialog.querySelector<HTMLButtonElement>("#confirm-ok")!
    const copyPrompt = options.copyPrompt
    const copyStatus = dialog.querySelector<HTMLElement>("#confirm-copy-status")!
    const copyBtn = copyPrompt ? document.createElement("button") : undefined
    if (copyBtn && copyPrompt) {
      copyBtn.type = "button"
      copyBtn.style.cssText = cancelBtn.style.cssText
      copyBtn.textContent = copyPrompt.label
      cancelBtn.after(copyBtn)
    }
    if (options.confirmUrl) {
      const link = document.createElement("a")
      link.id = okBtn.id
      link.style.cssText = okBtn.style.cssText
      link.style.textDecoration = "none"
      link.href = options.confirmUrl.href
      link.target = "_blank"
      link.rel = "noopener noreferrer"
      okBtn.replaceWith(link)
      okBtn = link
    }
    cancelBtn.textContent = options.cancelText ?? "Cancel"
    okBtn.textContent = options.confirmText ?? "Confirm"
    okBtn.style.background = accentColor
    okBtn.style.borderColor = accentColor

    overlay.appendChild(dialog);


    // Save previously focused element for restoration
    const previouslyFocused = document.activeElement as HTMLElement | null;
    mountDialogOverlay(overlay)

    // Focus the cancel button by default (safer)
    cancelBtn?.focus();

    let settled = false
    let removeTimer: number | undefined
    const listeners = new AbortController()
    const abort = () => cleanup(false, true)
    const dismiss = () => cleanup(false, true, false)
    dismissCurrent = dismiss
    function cleanup(result: boolean, immediate = false, restoreFocus = true) {
      function remove() {
        window.clearTimeout(removeTimer)
        listeners.abort()
        overlay.remove()
        if (dismissCurrent === dismiss) dismissCurrent = undefined
        if (restoreFocus && !options.signal?.aborted && previouslyFocused?.isConnected) previouslyFocused.focus()
      }
      if (settled) {
        if (immediate) remove()
        return
      }
      settled = true
      overlay.style.opacity = "0"
      overlay.style.pointerEvents = "none"
      if (!result && okBtn instanceof HTMLAnchorElement) okBtn.removeAttribute("href")
      if (immediate) remove()
      else removeTimer = window.setTimeout(remove, 100)
      resolve(result)
    }

    cancelBtn?.addEventListener("click", () => cleanup(false), { signal: listeners.signal })
    okBtn?.addEventListener("click", (event) => {
      if (settled || options.signal?.aborted) {
        event.preventDefault()
        return
      }
      cleanup(true)
    }, { signal: listeners.signal })
    if (copyBtn && copyPrompt) {
      copyBtn.addEventListener("click", async () => {
        if (settled || options.signal?.aborted || copyBtn.getAttribute("aria-busy") === "true") return
        copyBtn.setAttribute("aria-busy", "true")
        const copied = await copyToClipboard(copyPrompt.text)
        if (settled || options.signal?.aborted) return
        copyStatus.hidden = false
        copyStatus.textContent = copied ? copyPrompt.success : copyPrompt.failure
        copyBtn.removeAttribute("aria-busy")
      }, { signal: listeners.signal })
    }
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cleanup(false);
    }, { signal: listeners.signal })
    // Let the buttons handle native activation while keeping app shortcuts outside.
    overlay.addEventListener(
      "keydown",
      (event) => event.stopPropagation(),
      { signal: listeners.signal },
    );

    // Escape cancels and Tab keeps focus in the dialog.
    const focusable = copyBtn ? [cancelBtn, copyBtn, okBtn] : [cancelBtn, okBtn]
    function onKey(e: KeyboardEvent) {
      if (settled) {
        if (e.key === "Escape") {
          e.preventDefault()
          e.stopPropagation()
        }
        return
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cleanup(false);
      } else if (e.key === "Tab" && focusable.length > 0) {
        // Focus trap — cycle between cancel and confirm
        const idx = focusable.indexOf(document.activeElement as HTMLButtonElement | HTMLAnchorElement);
        if (e.shiftKey) {
          e.preventDefault();
          focusable[idx <= 0 ? focusable.length - 1 : idx - 1]?.focus();
        } else {
          e.preventDefault();
          focusable[idx >= focusable.length - 1 ? 0 : idx + 1]?.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey, { capture: true, signal: listeners.signal })
    options.signal?.addEventListener("abort", abort, { once: true, signal: listeners.signal })
  });
}

// Inject keyframe animation styles (once)
if (typeof document !== "undefined" && !document.getElementById("confirm-dialog-styles")) {
  const style = document.createElement("style");
  style.id = "confirm-dialog-styles";
  style.textContent = `
    @keyframes confirmFadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes confirmSlideIn {
      from { opacity: 0; transform: scale(0.95) translateY(-10px); }
      to { opacity: 1; transform: scale(1) translateY(0); }
    }
    @media (prefers-reduced-motion: reduce) {
      @keyframes confirmFadeIn { from { opacity: 1; } to { opacity: 1; } }
      @keyframes confirmSlideIn { from { opacity: 1; } to { opacity: 1; } }
    }
  `;
  document.head.appendChild(style);
}
