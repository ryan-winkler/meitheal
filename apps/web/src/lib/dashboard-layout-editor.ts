import { DASHBOARD_LAYOUT_PREFIX, workspaceStorageKey } from "./workspace-preferences"
import { applyDashboardOrder, normalizeDashboardLayout, readDashboardLayout, type DashboardWidgetPreference } from "./dashboard-layout"
import { closeTablerModal, openTablerModal } from "./tabler-modal"
import { showToast } from "./toast"

const S_ROW = "[data-dashboard-editor-widget]"
const S_VIS = "[data-dashboard-visible]"
const S_WID = "[data-dashboard-width]"
const S_STA = "[data-dashboard-state]"
const MV_UP = '[data-dashboard-move="up"]'
const MV_DN = '[data-dashboard-move="down"]'

export function bindDashboardLayoutEditor(
  key: string, launcher: HTMLButtonElement, signal: AbortSignal,
  onSave: (draft: DashboardWidgetPreference[]) => void,
): ((control: HTMLElement) => void) | undefined {
  const dialog = document.getElementById("dashboard-layout-editor")
  const list = dialog?.querySelector<HTMLElement>("[data-dashboard-editor-list]")
  if (!dialog || !list) return undefined
  const dialogEl: HTMLElement = dialog
  const listEl: HTMLElement = list

  const rows = () => Array.from(listEl.querySelectorAll<HTMLElement>(S_ROW))
  const byId = new Map(rows().map(r => [r.dataset.dashboardEditorWidget ?? "", r]))
  const q = <T extends Element>(s: string, p: ParentNode = dialogEl) => p.querySelector<T>(s)
  const msg = q<HTMLElement>("[data-dashboard-editor-message]")
  const countEl = q<HTMLElement>("[data-dashboard-visible-count]")
  const dirtyEl = q<HTMLElement>("[data-dashboard-dirty]")
  const showAll = q<HTMLButtonElement>("[data-dashboard-show-all]")
  let openedLayout = ""
  let trigger: HTMLElement = launcher
  let opening = false
  let dragging = false
  let dragStarted = false

  const feedback = (t = "") => { if (msg) { msg.textContent = t; msg.hidden = !t } }

  function readDraft(): DashboardWidgetPreference[] {
    return normalizeDashboardLayout(rows().map(r => ({
      id: r.dataset.dashboardEditorWidget,
      visible: q<HTMLInputElement>(S_VIS, r)?.checked,
      width: q<HTMLSelectElement>(S_WID, r)?.value,
      collapsed: q<HTMLSelectElement>(S_STA, r)?.value === "collapsed",
    })))
  }

  function syncUi(): void {
    const all = rows()
    let n = 0
    all.forEach((r, i) => {
      const on = q<HTMLInputElement>(S_VIS, r)?.checked ?? true
      if (on) n++
      r.classList.toggle("is-hidden-widget", !on)
      const w = q<HTMLSelectElement>(S_WID, r)
      const s = q<HTMLSelectElement>(S_STA, r)
      if (w) w.disabled = !on
      if (s) s.disabled = !on
      q(MV_UP, r)?.setAttribute("aria-disabled", String(!i))
      q(MV_DN, r)?.setAttribute("aria-disabled", String(i === all.length - 1))
    })
    if (countEl) countEl.textContent = `${n} of ${all.length} widgets visible`
    if (showAll) showAll.hidden = n === all.length
    if (dirtyEl && openedLayout) dirtyEl.hidden = JSON.stringify(readDraft()) === openedLayout
  }

  function renderDraft(draft: DashboardWidgetPreference[]): void {
    applyDashboardOrder(listEl, byId, draft)
    for (const { id, visible, width, collapsed } of draft) {
      const r = byId.get(id)
      if (!r) continue
      const v = q<HTMLInputElement>(S_VIS, r)
      const w = q<HTMLSelectElement>(S_WID, r)
      const s = q<HTMLSelectElement>(S_STA, r)
      if (v) v.checked = visible
      if (w) w.value = width
      if (s) s.value = collapsed ? "collapsed" : "expanded"
    }
    syncUi()
  }

  function startDrag(): void {
    if (dragStarted) return
    dragStarted = true
    void import("./list-drag-reorder").then(({ attachVerticalListDragReorder }) => {
      if (signal.aborted) return
      attachVerticalListDragReorder(listEl, {
        handle: "[data-dashboard-drag]", item: S_ROW, ghostClass: "dashboard-widget-drag-ghost",
        signal, onStart: () => { dragging = true }, onEnd: () => { dragging = false; syncUi() },
      })
      listEl.dataset.dashboardDragReady = ""
    }).catch(() => {
      dragStarted = false
      if (!signal.aborted) feedback("Drag unavailable; use arrows.")
    })
  }

  function open(control: HTMLElement): void {
    if (workspaceStorageKey(DASHBOARD_LAYOUT_PREFIX) !== key || dialogEl.classList.contains("show") || opening) return
    opening = true
    trigger = control
    const saved = readDashboardLayout(key)
    openedLayout = JSON.stringify(saved)
    renderDraft(saved)
    feedback()
    void openTablerModal(dialogEl, control)
      .then(() => { if (dialogEl.classList.contains("show")) startDrag() })
      .catch(() => { if (!signal.aborted) showToast("Couldn’t open editor.", "error") })
      .finally(() => { opening = false })
  }

  function save(): void {
    if (workspaceStorageKey(DASHBOARD_LAYOUT_PREFIX) !== key) return feedback("Session changed. Reload.")
    const draft = readDraft()
    try {
      if (JSON.stringify(readDashboardLayout(key)) !== openedLayout) return feedback("Changed in another tab. Reopen.")
      localStorage.setItem(key, JSON.stringify(draft))
    } catch { return feedback("Storage error. Couldn’t save.") }
    onSave(draft)
    closeTablerModal(dialogEl)
    showToast("Dashboard layout saved", "success")
  }

  dialogEl.addEventListener("change", syncUi, { signal })
  dialogEl.addEventListener("click", event => {
    const t = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null
    if (!t || dragging) return
    const h = (a: string) => t.hasAttribute(a)
    if (h("data-dashboard-save")) return save()
    if (h("data-dashboard-cancel")) return closeTablerModal(dialogEl)
    if (h("data-dashboard-reset")) { renderDraft(normalizeDashboardLayout(null)); return feedback("Defaults loaded — save to apply.") }
    if (h("data-dashboard-show-all")) {
      rows().forEach(r => { const cb = q<HTMLInputElement>(S_VIS, r); if (cb) cb.checked = true })
      return syncUi()
    }
    const dir = t.dataset.dashboardMove
    if (!dir || t.getAttribute("aria-disabled") === "true") return
    const item = t.closest<HTMLElement>(S_ROW)
    const up = dir === "up"
    const nb = up ? item?.previousElementSibling : item?.nextElementSibling
    if (!item || !nb) return
    const before = up ? nb : nb.nextElementSibling
    if (typeof list.moveBefore === "function") list.moveBefore(item, before)
    else list.insertBefore(item, before)
    syncUi()
    t.focus({ preventScroll: true })
    t.scrollIntoView({ block: "nearest" })
  }, { signal })

  dialog.addEventListener("hidden.bs.modal", () => {
    if (!signal.aborted) (trigger.isConnected && !trigger.closest("[hidden]") ? trigger : launcher).focus({ preventScroll: true })
  }, { signal })

  return open
}
