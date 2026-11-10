/**
 * Toast notification system — shared across all pages.
 * Domain: UI Infrastructure
 *
 * Accessibility:
 *   - role="alert" for all toasts
 *   - aria-live="assertive" for errors, "polite" for success
 *   - Dismiss button with aria-label for keyboard/screen reader users
 *   - Max 5 visible toasts — oldest removed to prevent stack overflow
 */

const MAX_VISIBLE_TOASTS = 5;

/** Show a toast notification */
export function showToast(
    message: string,
    type: "success" | "error" | "warning" = "success",
): void {
    let container = document.getElementById("toast-container");
    if (!container) {
        container = document.createElement("div");
        container.id = "toast-container";
        container.className = "toast-container";
        document.body.appendChild(container);
    }

    let displayMessage = message;
    // Attempt local i18n resolution mapped via Layout.astro <script is:inline>
    if (typeof window !== "undefined" && window.mI18n) {
        const translated = window.mI18n.get(message);
        if (translated && translated !== message) {
            displayMessage = translated;
        }
    }

    // Enforce max visible toasts — remove oldest first
    while (container.children.length >= MAX_VISIBLE_TOASTS) {
        container.firstElementChild?.remove();
    }

    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.setAttribute("role", "alert");
    toast.setAttribute("aria-live", type === "error" ? "assertive" : "polite");

    // Add visual icon based on type
    const iconSpan = document.createElement("span");
    iconSpan.style.marginRight = "8px";
    iconSpan.style.display = "flex";
    if (type === "success") {
        iconSpan.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    } else if (type === "error") {
        iconSpan.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
    } else if (type === "warning") {
        iconSpan.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
    }
    toast.appendChild(iconSpan);

    const text = document.createElement("span");
    text.textContent = displayMessage;
    toast.appendChild(text);

    // Dismiss button for keyboard/assistive tech users
    const dismiss = document.createElement("button");
    dismiss.className = "toast-dismiss";
    dismiss.setAttribute("aria-label", "Dismiss notification");
    dismiss.textContent = "×";
    dismiss.addEventListener("click", () => removeToast(toast));
    toast.appendChild(dismiss);

    container.appendChild(toast);

    // Auto-dismiss after 3s (5s for errors — more time to read)
    const duration = type === "error" ? 5000 : 3000;
    setTimeout(() => removeToast(toast), duration);
}

function removeToast(toast: HTMLElement): void {
    if (!toast.parentElement) return; // already removed
    toast.style.opacity = "0";
    toast.style.transform = "translateX(100%)";
    setTimeout(() => toast.remove(), 300);
}

/**
 * UX-01: Show an undo toast for destructive actions.
 * If the user clicks "Undo" within `timeout` ms, `onUndo` is called.
 * Otherwise, the action is committed via `onCommit` (if provided).
 *
 * @param message - User-facing message (e.g. "Task deleted")
 * @param onUndo - Called when user clicks Undo
 * @param onCommit - Called when timeout expires without undo
 * @param timeout - Undo window in ms (default: 5000)
 */
export function showUndoToast(
    message: string,
    onUndo: () => void,
    onCommit?: () => void,
    timeout = 5000,
): void {
    let container = document.getElementById("toast-container");
    if (!container) {
        container = document.createElement("div");
        container.id = "toast-container";
        container.className = "toast-container";
        document.body.appendChild(container);
    }

    while (container.children.length >= MAX_VISIBLE_TOASTS) {
        container.firstElementChild?.remove();
    }

    let undone = false;
    const toast = document.createElement("div");
    toast.className = "toast success";
    toast.setAttribute("role", "alert");
    toast.setAttribute("aria-live", "polite");

    const text = document.createElement("span");
    text.textContent = message;
    toast.appendChild(text);

    const undoBtn = document.createElement("button");
    undoBtn.className = "toast-undo";
    undoBtn.textContent = "Undo";
    undoBtn.setAttribute("aria-label", "Undo action");
    undoBtn.addEventListener("click", () => {
        undone = true;
        onUndo();
        removeToast(toast);
    });
    toast.appendChild(undoBtn);

    container.appendChild(toast);

    setTimeout(() => {
        if (!undone) {
            onCommit?.();
            removeToast(toast);
        }
    }, timeout);
}

/**
 * UX-02: Show an error toast with a retry button.
 *
 * @param message - Error message
 * @param onRetry - Called when user clicks Retry
 */
export function showRetryToast(
    message: string,
    onRetry: () => void,
): void {
    let container = document.getElementById("toast-container");
    if (!container) {
        container = document.createElement("div");
        container.id = "toast-container";
        container.className = "toast-container";
        document.body.appendChild(container);
    }

    while (container.children.length >= MAX_VISIBLE_TOASTS) {
        container.firstElementChild?.remove();
    }

    const toast = document.createElement("div");
    toast.className = "toast error";
    toast.setAttribute("role", "alert");
    toast.setAttribute("aria-live", "assertive");

    const text = document.createElement("span");
    text.textContent = message;
    toast.appendChild(text);

    const retryBtn = document.createElement("button");
    retryBtn.className = "toast-undo"; // reuses undo styling
    retryBtn.textContent = "Retry";
    retryBtn.setAttribute("aria-label", "Retry action");
    retryBtn.addEventListener("click", () => {
        removeToast(toast);
        onRetry();
    });
    toast.appendChild(retryBtn);

    const dismiss = document.createElement("button");
    dismiss.className = "toast-dismiss";
    dismiss.setAttribute("aria-label", "Dismiss notification");
    dismiss.textContent = "×";
    dismiss.addEventListener("click", () => removeToast(toast));
    toast.appendChild(dismiss);

    container.appendChild(toast);

    // Retry toasts stay for 8s — user needs time to read + decide
    setTimeout(() => removeToast(toast), 8000);
}

/**
 * UX-03: Show a task-created toast with ticket key and clickable link.
 * Subtle, dismissable, auto-fades in 4s.
 *
 * @param ticketKey - Human task key, e.g. "MTH-57"
 * @param taskId - Task UUID for opening detail modal
 * @param title - Task title (truncated in display)
 */
export function showTaskCreatedToast(
    ticketKey: string | null,
    taskId: string,
    title: string,
): void {
    let container = document.getElementById("toast-container");
    if (!container) {
        container = document.createElement("div");
        container.id = "toast-container";
        container.className = "toast-container";
        document.body.appendChild(container);
    }

    while (container.children.length >= MAX_VISIBLE_TOASTS) {
        container.firstElementChild?.remove();
    }

    const toast = document.createElement("div");
    toast.className = "toast success";
    toast.setAttribute("role", "alert");
    toast.setAttribute("aria-live", "polite");

    // Checkmark icon
    const iconSpan = document.createElement("span");
    iconSpan.style.marginRight = "8px";
    iconSpan.style.display = "flex";
    iconSpan.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    toast.appendChild(iconSpan);

    // Message with clickable ticket key
    const msgSpan = document.createElement("span");
    msgSpan.style.cssText = "display:flex;align-items:center;gap:6px;flex:1;min-width:0;";

    if (ticketKey) {
        const link = document.createElement("button");
        link.type = "button";
        link.textContent = ticketKey;
        link.title = `Open ${ticketKey}: ${title}`;
        link.setAttribute("aria-label", `Open task ${ticketKey}`);
        link.style.cssText = "background:none;border:none;color:var(--accent-text,var(--text-primary));font-weight:600;cursor:pointer;padding:0;text-decoration:underline;text-underline-offset:2px;font-size:inherit;white-space:nowrap;";
        link.addEventListener("click", () => {
            removeToast(toast);
            if (typeof (window as any).openTaskDetail === "function") {
                (window as any).openTaskDetail(taskId);
            }
        });
        msgSpan.appendChild(link);
    }

    const titleSpan = document.createElement("span");
    titleSpan.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    const displayTitle = title.length > 40 ? title.slice(0, 37) + "…" : title;
    titleSpan.textContent = ticketKey ? `— ${displayTitle}` : `Created: ${displayTitle}`;
    msgSpan.appendChild(titleSpan);

    toast.appendChild(msgSpan);

    // Dismiss button
    const dismiss = document.createElement("button");
    dismiss.className = "toast-dismiss";
    dismiss.setAttribute("aria-label", "Dismiss notification");
    dismiss.textContent = "×";
    dismiss.addEventListener("click", () => removeToast(toast));
    toast.appendChild(dismiss);

    container.appendChild(toast);

    // Auto-dismiss after 4s — longer than standard to give time to click
    setTimeout(() => removeToast(toast), 4000);
}
