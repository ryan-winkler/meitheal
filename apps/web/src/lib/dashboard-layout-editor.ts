import "../styles/dashboard-layout-editor.css"
import { applyDashboardOrder, dashboardLayoutStorageKey, normalizeDashboardLayout, readDashboardLayout, type DashboardWidgetPreference } from "./dashboard-layout"
import { closeTablerModal, openTablerModal } from "./tabler-modal"
import { showToast } from "./toast"

export function bindDashboardLayoutEditor(
  key: string, launcher: HTMLButtonElement, signal: AbortSignal,
  onSave: (draft: DashboardWidgetPreference[]) => void,
): ((control: HTMLElement) => void) | undefined {
  const modalElement = document.getElementById("dashboard-layout-editor")
  const listElement = modalElement?.querySelector<HTMLElement>("[data-dashboard-editor-list]")
  if (!modalElement || !listElement) return undefined

  const dialog = modalElement
  const list = listElement
  const editorRows = () => Array.from(list.querySelectorAll<HTMLElement>("[data-dashboard-editor-widget]"))
  const byId = new Map(editorRows().map(row => [row.dataset.dashboardEditorWidget ?? "", row]))
  const message = dialog.querySelector<HTMLElement>("[data-dashboard-editor-message]")
  let openedLayout = ""
  let trigger: HTMLElement = launcher
  let opening = false
  let dragging = false
  let dragStarted = false

  function feedback(text = ""): void {
    if (!message) return
    message.textContent = text
    message.hidden = !text
  }

  function refreshArrows(): void {
    const rows = editorRows()
    rows.forEach((row, index) => {
      row.querySelector('[data-dashboard-move="up"]')?.setAttribute("aria-disabled", String(index === 0))
      row.querySelector('[data-dashboard-move="down"]')?.setAttribute("aria-disabled", String(index === rows.length - 1))
    })
  }

  function readDraft(): DashboardWidgetPreference[] {
    return normalizeDashboardLayout(editorRows().map(row => ({
      id: row.dataset.dashboardEditorWidget,
      visible: row.querySelector<HTMLInputElement>("[data-dashboard-visible]")?.checked,
      width: row.querySelector<HTMLSelectElement>("[data-dashboard-width]")?.value,
      collapsed: row.querySelector<HTMLSelectElement>("[data-dashboard-state]")?.value === "collapsed",
    })))
  }

  function renderDraft(draft: DashboardWidgetPreference[]): void {
    applyDashboardOrder(list, byId, draft)
    for (const { id, visible, width, collapsed } of draft) {
      const row = byId.get(id)
      const visibleControl = row?.querySelector<HTMLInputElement>("[data-dashboard-visible]")
      const widthControl = row?.querySelector<HTMLSelectElement>("[data-dashboard-width]")
      const stateControl = row?.querySelector<HTMLSelectElement>("[data-dashboard-state]")
      if (visibleControl) visibleControl.checked = visible
      if (widthControl) widthControl.value = width
      if (stateControl) stateControl.value = collapsed ? "collapsed" : "expanded"
    }
    refreshArrows()
  }

  function startDrag(): void {
    if (dragStarted) return
    dragStarted = true
    void import("sortablejs").then(({ default: Sortable }) => {
      if (signal.aborted) return
      const motion = window.matchMedia("(prefers-reduced-motion: reduce)")
      const sorter = Sortable.create(list, {
        animation: motion.matches ? 0 : 150,
        easing: "cubic-bezier(0.23, 1, 0.32, 1)",
        handle: "[data-dashboard-drag]",
        draggable: "[data-dashboard-editor-widget]",
        ghostClass: "dashboard-widget-drag-ghost",
        direction: "vertical",
        forceFallback: true,
        fallbackTolerance: 4,
        onStart: () => { dragging = true },
        onEnd: () => {
          dragging = false
          refreshArrows()
        },
      })
      list.dataset.dashboardDragReady = ""
      motion.addEventListener("change", () => sorter.option("animation", motion.matches ? 0 : 150), { signal })
      signal.addEventListener("abort", () => sorter.destroy(), { once: true })
    }).catch(() => {
      dragStarted = false
      if (!signal.aborted) feedback("Dragging couldn’t load. Use the arrow buttons to move widgets.")
    })
  }

  function open(control: HTMLElement): void {
    if (dashboardLayoutStorageKey() !== key || dialog.classList.contains("show") || opening) return
    opening = true
    trigger = control
    const saved = readDashboardLayout(key)
    openedLayout = JSON.stringify(saved)
    renderDraft(saved)
    feedback()
    void openTablerModal(dialog, control)
      .then(() => { if (dialog.classList.contains("show")) startDrag() })
      .catch(() => { if (!signal.aborted) showToast("Dashboard editor couldn’t open. Try again.", "error") })
      .finally(() => { opening = false })
  }

  function save(): void {
    if (dashboardLayoutStorageKey() !== key) {
      feedback("Your session changed. Reload the dashboard to edit your layout.")
      return
    }
    const draft = readDraft()
    try {
      if (JSON.stringify(readDashboardLayout(key)) !== openedLayout) {
        feedback("The layout changed in another tab. Close and reopen the editor to load it.")
        return
      }
      localStorage.setItem(key, JSON.stringify(draft))
    } catch {
      feedback("Couldn’t save this layout. Allow site storage and try again.")
      return
    }
    onSave(draft)
    closeTablerModal(dialog)
  }

  dialog.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null
    if (!target || dragging) return
    if (target.hasAttribute("data-dashboard-save")) save()
    if (target.hasAttribute("data-dashboard-cancel")) closeTablerModal(dialog)
    if (target.hasAttribute("data-dashboard-reset")) renderDraft(normalizeDashboardLayout(null))
    if (!target.dataset.dashboardMove || target.getAttribute("aria-disabled") === "true") return
    const item = target.closest<HTMLElement>("[data-dashboard-editor-widget]")
    const neighbor = target.dataset.dashboardMove === "up" ? item?.previousElementSibling : item?.nextElementSibling
    if (!item || !neighbor) return
    const preceding = target.dataset.dashboardMove === "up" ? neighbor : neighbor.nextElementSibling
    if (typeof list.moveBefore === "function") list.moveBefore(item, preceding)
    else list.insertBefore(item, preceding)
    refreshArrows()
    target.focus({ preventScroll: true })
    target.scrollIntoView({ block: "nearest" })
  }, { signal })

  dialog.addEventListener("hidden.bs.modal", () => {
    if (signal.aborted) return
    const destination = trigger.isConnected && !trigger.closest("[hidden]") ? trigger : launcher
    destination.focus({ preventScroll: true })
  }, { signal })

  return open
}
