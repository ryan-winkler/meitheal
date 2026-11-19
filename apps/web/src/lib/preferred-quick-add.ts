import { quickAddPayload } from "./quick-add"
import { taskApi, TaskApiError } from "./task-api-client"
import { closeTablerModal, openTablerModal } from "./tabler-modal"
import { showToast } from "./toast"

export async function openQuickAdd(trigger: HTMLElement | undefined, signal: AbortSignal): Promise<void> {
  const template = document.querySelector<HTMLTemplateElement>("#preferred-quick-add-template")
  const clone = template?.content.firstElementChild?.cloneNode(true)
  if (!(clone instanceof HTMLElement) || signal.aborted || document.getElementById("workspace-quick-add")) return
  const modal = clone.querySelector<HTMLElement>("#workspace-quick-add")!
  const form = clone.querySelector<HTMLFormElement>("form")!
  const input = clone.querySelector<HTMLInputElement>("input")!
  const error = clone.querySelector<HTMLElement>("[data-quick-add-error]")!
  const status = clone.querySelector<HTMLElement>("[data-quick-add-saving]")!
  const submit = clone.querySelector<HTMLButtonElement>('button[type="submit"]')!
  const full = clone.querySelector<HTMLButtonElement>("[data-quick-add-full]")!
  const controller = new AbortController()
  const active = AbortSignal.any([signal, controller.signal])
  const areaId = window.__activeArea
  const remove = () => {
    controller.abort()
    clone.remove()
    signal.removeEventListener("abort", teardown)
  }
  const teardown = () => {
    closeTablerModal(modal)
    remove()
  }
  signal.addEventListener("abort", teardown, { once: true })
  modal.addEventListener("hide.bs.modal", event => {
    if (!status.hidden && !signal.aborted) event.preventDefault()
  }, { signal: active })
  modal.addEventListener("hidden.bs.modal", () => queueMicrotask(remove), { once: true })
  form.addEventListener("submit", async event => {
    event.preventDefault()
    const text = input.value.trim()
    if (!text || submit.disabled) return
    submit.disabled = full.disabled = true
    input.readOnly = true
    error.hidden = true
    status.hidden = false
    const { payload } = quickAddPayload(text)
    try {
      await taskApi.createTask({ ...payload, area_id: !areaId || areaId === "all" ? "default" : areaId },
        AbortSignal.any([active, AbortSignal.timeout(10_000)]))
      if (signal.aborted) return
      status.hidden = true
      document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "quick-add" } }))
      showToast("common.task_created")
      closeTablerModal(modal)
    } catch (cause) {
      if (active.aborted) return
      status.hidden = true
      const rejected = cause instanceof TaskApiError && [400, 403, 404, 422, 429].includes(cause.status)
      error.textContent = (rejected ? error.dataset.rejected : error.dataset.uncertain) ?? ""
      error.hidden = false
      input.readOnly = false
      if (rejected) submit.disabled = full.disabled = false
    }
  }, { signal: active })
  full.addEventListener("click", () => {
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
