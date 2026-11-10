import { isDeferralTerminalStatus } from "@domains/tasks/persistence/task-deferral-status"
import {
  allowsDeferral, DEFERRAL_RECONCILED, notifyTaskCountsChanged, readFreshDeferral, writeDeferral, type DeferralState,
} from "@lib/deferral-client"

interface CurrentTask {
  id: string
  projectId: string | null
  signal: AbortSignal
  state?: DeferralState
  deferred: boolean
  nativeWrites: number
  dataOnly: boolean
}

export function initModalDeferral(overlay: HTMLElement, signal: AbortSignal) {
  const action = overlay.querySelector<HTMLButtonElement>("#td-deferral-action")
  const badge = overlay.querySelector<HTMLElement>("#td-deferred-badge")
  const status = overlay.querySelector<HTMLElement>("#td-deferral-status")
  const retry = overlay.querySelector<HTMLButtonElement>("#td-deferral-refresh")
  let task: CurrentTask | undefined
  let originId: string | undefined
  let changed = new Set<string>()
  let generation = 0
  let writing = false
  let queued: (() => void) | undefined

  const message = (key: string, fallback: string) => window.mI18n?.get(`deferral.${key}`) ?? fallback
  const relevant = (selected: CurrentTask) => task === selected && !selected.signal.aborted && !signal.aborted
  function showStatus(text: string, refresh = false) {
    if (status) { status.textContent = text; status.hidden = !text }
    if (retry) retry.hidden = !refresh
  }
  function invalidate() {
    generation++
    if (task) delete task.state
    if (action) action.hidden = true
    if (retry) retry.hidden = true
  }
  function reconcile(taskId: string | undefined, changedIds: string[], dataOnly: boolean) {
    if (signal.aborted) return
    if (document.querySelector("#kanban-board, [data-deferred-root]")) {
      window.dispatchEvent(new CustomEvent(DEFERRAL_RECONCILED, { detail: { taskId, changedIds, dataOnly } }))
    } else {
      document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "deferral", dataOnly } }))
    }
  }
  function render(selected: CurrentTask, state: DeferralState) {
    selected.state = state
    selected.deferred = state.deferred_at !== null
    if (badge) badge.hidden = !selected.deferred
    if (action) {
      action.hidden = isDeferralTerminalStatus(state.status)
      action.disabled = false
      action.textContent = selected.deferred ? action.dataset.resumeLabel ?? "Resume" : action.dataset.deferLabel ?? "Defer"
    }
  }
  async function refresh(selected = task, checkMembership = false, requested = false) {
    invalidate()
    if (!selected || !relevant(selected) || selected.nativeWrites || writing) return
    const request = generation
    try {
      const state = await readFreshDeferral(selected.id, selected.signal)
      if (!relevant(selected) || request !== generation) return
      if (checkMembership && selected.deferred !== (state.deferred_at !== null)) {
        changed.add(selected.id)
        notifyTaskCountsChanged(selected.projectId)
      }
      render(selected, state)
      showStatus("")
      if (requested) {
        const focus = action && !action.hidden ? action : overlay.querySelector<HTMLElement>("#td-close")
        focus?.focus()
      }
    } catch {
      if (requested && relevant(selected) && request === generation) {
        showStatus(message("network_required", "This action needs a connection."), true)
      }
    }
  }

  action?.addEventListener("click", async () => {
    const selected = task
    const guard = selected?.state
    if (!selected || !guard || writing || selected.nativeWrites || isDeferralTerminalStatus(guard.status)) return
    const defer = !selected.deferred
    const request = generation
    let refreshAfterSave = false
    writing = true
    action.disabled = true
    showStatus(message("saving", "Saving…"))
    try {
      if (!await allowsDeferral() || !relevant(selected)) {
        if (relevant(selected)) {
          invalidate()
          showStatus(message("worker_update", "Reload to activate the update."))
        }
        return
      }
      const result = await writeDeferral(selected.id, defer, {
        updated_at: guard.updated_at, deferral_revision: guard.deferral_revision,
      }, selected.dataOnly ? signal : selected.signal)
      if (!relevant(selected)) {
        if (selected.dataOnly && (result.kind === "saved" || result.kind === "uncertain")) {
          notifyTaskCountsChanged(selected.projectId)
          reconcile(selected.id, [selected.id], true)
        }
        return
      }
      if (result.kind === "saved") {
        changed.add(selected.id)
        notifyTaskCountsChanged(selected.projectId)
        refreshAfterSave = selected.nativeWrites > 0 || generation !== request
        if (refreshAfterSave) {
          selected.deferred = result.task.deferred_at !== null
          invalidate()
        } else render(selected, result.task)
        showStatus(defer ? message("deferred", "Task deferred.") : message("resumed", "Task resumed."))
      } else if (result.kind === "blocked") {
        const text = message("blocked", "This task is still blocked.")
        showStatus(result.blockers.length ? `${text} ${result.blockers.join(", ")}` : text)
      } else if (result.kind === "changed" || result.kind === "uncertain") {
        if (result.kind === "uncertain") changed.add(selected.id)
        invalidate()
        showStatus(message("verify", "Reload to check the task before trying again."), true)
        retry?.focus()
      } else {
        showStatus(message("failed", "Couldn’t save the change."))
      }
    } finally {
      writing = false
      if (relevant(selected)) action.disabled = false
      const next = queued
      queued = undefined
      if (!signal.aborted) {
        if (next) next()
        else if (refreshAfterSave && relevant(selected)) void refresh(selected, true)
      }
    }
  }, { signal })
  retry?.addEventListener("click", () => void refresh(task, true, true), { signal })
  navigator.serviceWorker?.addEventListener("controllerchange", () => { void refresh() }, { signal })
  window.addEventListener("pagehide", invalidate, { signal })
  window.addEventListener("pageshow", event => { if (event.persisted) void refresh() }, { signal })

  return {
    waitForWrite(action: () => void): boolean {
      if (!writing) return false
      queued = action
      return true
    },
    opening(newSession: boolean) {
      invalidate()
      task = undefined
      if (badge) badge.hidden = true
      showStatus("")
      if (newSession) { originId = undefined; changed = new Set() }
    },
    loaded(id: string, projectId: string | null, initialMarker: boolean, modalSignal: AbortSignal, dataOnly = false) {
      originId ??= id
      task = { id, projectId, signal: modalSignal, deferred: initialMarker, nativeWrites: 0, dataOnly }
      void refresh()
    },
    nativeWrite(field: string, value: unknown) {
      const selected = task
      if (!selected) return (_saved: boolean) => {}
      selected.nativeWrites++
      invalidate()
      return (saved: boolean) => {
        if (!relevant(selected)) return
        selected.nativeWrites--
        if (saved && field === "status") {
          notifyTaskCountsChanged(selected.projectId)
          if (selected.deferred && typeof value === "string" && isDeferralTerminalStatus(value)) {
            selected.deferred = false
            if (badge) badge.hidden = true
            changed.add(selected.id)
          }
        } else if (saved && field === "project_id") {
          const oldProject = selected.projectId
          selected.projectId = typeof value === "string" ? value : null
          notifyTaskCountsChanged(oldProject, selected.projectId)
        }
        if (selected.nativeWrites === 0) void refresh(selected, true)
      }
    },
    removing(id: string): boolean {
      if (task?.id !== id || (!task.deferred && !document.querySelector("[data-deferred-root]"))) return false
      changed.add(id)
      notifyTaskCountsChanged(task.projectId)
      return true
    },
    reconcileSearch() {
      reconcile(undefined, [], true)
    },
    closed(suppressGlobal = false, dataOnly = false): boolean {
      const changedIds = [...changed]
      const taskId = originId
      originId = undefined
      changed.clear()
      if (!changedIds.length || signal.aborted) return false
      if (suppressGlobal) return true
      reconcile(taskId, changedIds, dataOnly)
      return true
    },
  }
}
