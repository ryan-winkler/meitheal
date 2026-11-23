import type Modal from "@tabler/core/js/src/bootstrap/modal"
import { notifyOverlayChange } from "./dialog-overlay"
import { pageLifecycle } from "./page-lifecycle"
import { ensureTablerStyles } from "./tabler-styles"

const openModals = new WeakMap<HTMLElement, Modal>()
const FOCUS_SEL = ".modal-body :is(input:not([type=hidden]),textarea,select,button):not([disabled])"

export async function openTablerModal(dialog: HTMLElement, trigger?: HTMLElement): Promise<void> {
  const signal = pageLifecycle.signal
  const [{ default: TablerModal }] = await Promise.all([
    import("@tabler/core/js/src/bootstrap/modal"),
    ensureTablerStyles(),
  ])
  if (signal.aborted || !dialog.isConnected || openModals.has(dialog) ||
    document.querySelector("[data-meitheal-tabler-modal].show")) return

  const surface = dialog.closest<HTMLElement>(".tabler-surface") ?? dialog
  if (surface.parentElement !== document.body && surface.closest(".layout-navigation, #sidebar")) {
    document.body.appendChild(surface)
  }

  const modal = new TablerModal(dialog)
  openModals.set(dialog, modal)
  const ac = new AbortController()
  const focusInitial = () => {
    if (!signal.aborted && dialog.classList.contains("show")) {
      const target = dialog.querySelector<HTMLElement>("[data-tabler-initial-focus]:not([disabled])")
        ?? dialog.querySelector<HTMLElement>(FOCUS_SEL)
        ?? dialog
      target.focus({ preventScroll: true })
    }
  }
  const cleanup = () => {
    ac.abort()
    modal.dispose()
    openModals.delete(dialog)
    signal.removeEventListener("abort", close)
    notifyOverlayChange("closed")
    if (trigger?.isConnected) trigger.focus({ preventScroll: true })
  }
  const close = () => {
    modal.hide()
    if (openModals.has(dialog)) cleanup()
  }
  signal.addEventListener("abort", close, { once: true })
  dialog.addEventListener("hidden.bs.modal", cleanup, { once: true })
  dialog.addEventListener("shown.bs.modal", focusInitial, { once: true, signal: ac.signal })
  dialog.addEventListener("click", (event) => {
    if ((event.target as Element | null)?.closest("[data-tabler-modal-close]")) {
      event.preventDefault()
      closeTablerModal(dialog)
    }
  }, { signal: ac.signal })
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && dialog.classList.contains("show")) {
      event.preventDefault()
      closeTablerModal(dialog)
    }
  }, { signal: ac.signal })
  modal.show(trigger)
  if (!dialog.classList.contains("show")) {
    dialog.removeEventListener("hidden.bs.modal", cleanup)
    cleanup()
  } else {
    notifyOverlayChange("opened")
    focusInitial()
    queueMicrotask(focusInitial)
    requestAnimationFrame(focusInitial)
  }
}

export function closeTablerModal(dialog: HTMLElement): void {
  openModals.get(dialog)?.hide()
}
