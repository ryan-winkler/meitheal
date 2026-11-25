import { currentTaskApiContext, type TaskApiContext } from "./task-api"
import { taskCapturePlacement } from "./task-capture-placement"
import { fetchQuickAddUsers, formatQuickAddPreviewText, quickAddPayload, type QuickAddUserCandidate } from "./quick-add"
import { taskApi, TaskApiError, sameTaskApiContext } from "./task-api-client"
import { closeTablerModal, openTablerModal } from "./tabler-modal"
import { openTaskDetailHandoff } from "./task-detail-handoff"
import { showToast } from "./toast"
import { readWorkspacePreferences } from "./workspace-preferences"

export async function openQuickAdd(trigger: HTMLElement | undefined, signal: AbortSignal,
  capture: { context: TaskApiContext | null; placement: ReturnType<typeof taskCapturePlacement> } = { context: currentTaskApiContext(), placement: taskCapturePlacement() }): Promise<void> {
  if (!sameTaskApiContext(capture.context, currentTaskApiContext())) return
  const template = document.querySelector<HTMLTemplateElement>("#preferred-quick-add-template")
  const clone = template?.content.firstElementChild?.cloneNode(true)
  if (!(clone instanceof HTMLElement) || signal.aborted || document.getElementById("workspace-quick-add")) return
  const q = <T extends Element>(s: string) => clone.querySelector<T>(s)!
  const modal = q<HTMLElement>("#workspace-quick-add")
  const form = q<HTMLFormElement>("form")
  const input = q<HTMLInputElement>("input")
  const error = q<HTMLElement>("[data-quick-add-error]")
  const status = q<HTMLElement>("[data-quick-add-saving]")
  const preview = clone.querySelector<HTMLElement>("[data-quick-add-preview]")
  const submit = q<HTMLButtonElement>('button[type="submit"]')
  const full = q<HTMLButtonElement>("[data-quick-add-full]")
  const cancel = clone.querySelector<HTMLButtonElement>("[data-quick-add-cancel]")
  const controller = new AbortController()
  const active = AbortSignal.any([signal, controller.signal])
  let availableUsers: QuickAddUserCandidate[] = []
  void fetchQuickAddUsers(active).then(users => {
    availableUsers = users
    if (input.value.trim()) input.dispatchEvent(new Event("input"))
  })
  const remove = () => {
    controller.abort()
    clone.remove()
    signal.removeEventListener("abort", teardown)
  }
  const teardown = () => {
    closeTablerModal(modal)
    remove()
  }
  const setBusy = (busy: boolean, keepDisabled = false) => {
    submit.disabled = full.disabled = busy || keepDisabled
    if (cancel) cancel.disabled = busy || keepDisabled
    submit.classList.toggle("btn-loading", busy)
    submit.setAttribute("aria-busy", String(busy))
    input.readOnly = busy
    status.hidden = !busy
  }
  signal.addEventListener("abort", teardown, { once: true })
  modal.addEventListener("hide.bs.modal", event => {
    if (!status.hidden && !signal.aborted) event.preventDefault()
  }, { signal: active })
  modal.addEventListener("hidden.bs.modal", () => queueMicrotask(remove), { once: true })
  cancel?.addEventListener("click", () => closeTablerModal(modal), { signal: active })
  input.addEventListener("input", () => {
    if (!preview) return
    const text = input.value.trim()
    const summary = text ? formatQuickAddPreviewText(text, availableUsers) : ""
    preview.textContent = summary
    preview.hidden = !summary
  }, { signal: active })
  form.addEventListener("submit", async event => {
    event.preventDefault()
    const text = input.value.trim()
    if (!text || submit.disabled) return
    error.hidden = true
    setBusy(true)
    const users = availableUsers.length ? availableUsers : await fetchQuickAddUsers(active)
    availableUsers = users
    const { payload } = quickAddPayload(text, null, { users })
    try {
      const created = await taskApi.createTask({ ...payload, area_id: capture.placement?.areaId ?? null, project_id: capture.placement?.projectId ?? null },
        AbortSignal.any([active, AbortSignal.timeout(10_000)]), capture.context!)
      if (signal.aborted) return
      setBusy(false)
      document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "quick-add" } }))
      showToast("common.task_created")
      closeTablerModal(modal)
      if (typeof created?.id === "string" && created.id && readWorkspacePreferences().afterTaskCreate === "open") {
        openTaskDetailHandoff(created.id)
      }
    } catch (cause) {
      if (active.aborted) return
      const rejected = cause instanceof TaskApiError && [400, 403, 404, 422, 429].includes(cause.status)
      setBusy(false, !rejected)
      error.textContent = (rejected ? error.dataset.rejected : error.dataset.uncertain) ?? ""
      error.hidden = false
    }
  }, { signal: active })
  full.addEventListener("click", () => {
    if (!sameTaskApiContext(capture.context, currentTaskApiContext())) {
      error.textContent = error.dataset.uncertain ?? ""
      error.hidden = false
      return
    }
    const draft = input.value
    closeTablerModal(modal)
    window.openNewTaskModal?.()
    const field = document.querySelector<HTMLTextAreaElement>("#new-task-title-input")
    if (field && draft) {
      field.value = draft
      field.dispatchEvent(new Event("input", { bubbles: true }))
    }
  }, { signal: active })
  document.body.append(clone)
  try {
    await openTablerModal(modal, trigger)
    if (!modal.classList.contains("show")) remove()
  } catch (cause) {
    remove()
    throw cause
  }
}
