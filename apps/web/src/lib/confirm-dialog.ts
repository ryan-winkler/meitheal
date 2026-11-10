/**
 * Custom Confirm Dialog — replaces native browser confirm()
 *
 * Renders a themed, centered modal that matches the app's design system.
 * Returns a Promise<boolean> — true if confirmed, false if cancelled.
 *
 * Bounded context: lib (shared UI utility)
 */

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "danger" | "warning" | "default";
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    // Remove any existing confirm dialog
    document.getElementById("meitheal-confirm-overlay")?.remove();

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
      <div style="text-align: center; margin-bottom: 16px; font-size: 32px;">${icon}</div>
      <h3 id="confirm-title" style="
        margin: 0 0 8px; font-size: 16px; font-weight: 600;
        color: var(--text-primary, #f1f5f9); text-align: center;
      ">${options.title ?? "Confirm"}</h3>
      <p id="confirm-message" style="
        margin: 0 0 24px; font-size: 14px; line-height: 1.5;
        color: var(--text-secondary, #94a3b8); text-align: center;
      ">${options.message}</p>
      <div style="display: flex; gap: 12px; justify-content: center;">
        <button type="button" id="confirm-cancel" style="
          padding: 8px 20px; border-radius: 8px; font-size: 14px; cursor: pointer;
          background: transparent; border: 1px solid var(--border, #334155);
          color: var(--text-secondary, #94a3b8);
          transition: background 0.15s, border-color 0.15s;
        ">${options.cancelText ?? "Cancel"}</button>
        <button type="button" id="confirm-ok" style="
          padding: 8px 20px; border-radius: 8px; font-size: 14px; cursor: pointer;
          background: ${accentColor}; border: 1px solid ${accentColor};
          color: #fff; font-weight: 500;
          transition: opacity 0.15s;
        ">${options.confirmText ?? "Confirm"}</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Save previously focused element for restoration
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Focus the cancel button by default (safer)
    const cancelBtn = dialog.querySelector("#confirm-cancel") as HTMLButtonElement;
    const okBtn = dialog.querySelector("#confirm-ok") as HTMLButtonElement;
    cancelBtn?.focus();

    function cleanup(result: boolean) {
      overlay.style.opacity = "0";
      document.removeEventListener("keydown", onKey, true);
      setTimeout(() => {
        overlay.remove();
        // Restore focus to the element that was focused before the dialog
        previouslyFocused?.focus();
      }, 100);
      resolve(result);
    }

    cancelBtn?.addEventListener("click", () => cleanup(false));
    okBtn?.addEventListener("click", () => cleanup(true));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cleanup(false);
    });

    // Keyboard: Enter confirms, Escape cancels, Tab traps focus
    const focusable = [cancelBtn, okBtn].filter(Boolean);
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cleanup(false);
      } else if (e.key === "Enter" && document.activeElement === okBtn) {
        e.preventDefault();
        cleanup(true);
      } else if (e.key === "Tab" && focusable.length > 0) {
        // Focus trap — cycle between cancel and confirm
        const idx = focusable.indexOf(document.activeElement as HTMLButtonElement);
        if (e.shiftKey) {
          e.preventDefault();
          focusable[idx <= 0 ? focusable.length - 1 : idx - 1]?.focus();
        } else {
          e.preventDefault();
          focusable[idx >= focusable.length - 1 ? 0 : idx + 1]?.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey, true);
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
