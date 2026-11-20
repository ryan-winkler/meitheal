import type Modal from "@tabler/core/js/src/bootstrap/modal"
import { notifyOverlayChange } from "./dialog-overlay"
import { pageLifecycle } from "./page-lifecycle"
import { ensureTablerStyles } from "./tabler-styles"

const openModals = new WeakMap<HTMLElement, Modal>()

export async function openTablerModal(dialog: HTMLElement, trigger?: HTMLElement): Promise<void> {
  const signal = pageLifecycle.signal
  const [{ default: TablerModal }] = await Promise.all([
    import("@tabler/core/js/src/bootstrap/modal"),
    ensureTablerStyles(),
  ])
  if (signal.aborted || !dialog.isConnected || openModals.has(dialog) ||
    document.querySelector("[data-meitheal-tabler-modal].show")) return

  const modal = new TablerModal(dialog)
  openModals.set(dialog, modal)
  const cleanup = () => {
    modal.dispose()
    openModals.delete(dialog)
    signal.removeEventListener("abort", close)
    notifyOverlayChange("closed")
  }
  const close = () => {
    modal.hide()
    if (openModals.has(dialog)) cleanup()
  }
  signal.addEventListener("abort", close, { once: true })
  dialog.addEventListener("hidden.bs.modal", cleanup, { once: true })
  modal.show(trigger)
  if (!dialog.classList.contains("show")) {
    dialog.removeEventListener("hidden.bs.modal", cleanup)
    cleanup()
  } else {
    notifyOverlayChange("opened")
    dialog.querySelector<HTMLElement>("[data-tabler-initial-focus]")?.focus({ preventScroll: true })
  }
}

export function closeTablerModal(dialog: HTMLElement): void {
  openModals.get(dialog)?.hide()
}
