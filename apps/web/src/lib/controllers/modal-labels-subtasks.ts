/**
 * modal-labels-subtasks.ts — Labels chips + inline subtask creation
 *
 * @domain tasks
 * @kcs Extracted from task-modal-controller.ts for decomposition.
 *      Labels: chip rendering + Enter-to-add with dedup.
 *      Subtasks: inline form with type inference from parent.
 */

import { currentTaskApiContext, taskApiHeaders } from "@lib/task-api"
import { defaultChildTaskType, normalizeEditableTaskType } from "@lib/task-editor-fields"
import { CUSTOM_RECURRENCE_SENTINEL, enhanceRecurrenceSelect } from "@lib/recurrence-picker"
import { describeRule } from "@domains/tasks/recurrence"
import { shouldShowManualCalendarPush } from "@lib/calendar-push-policy"
import { showToast } from "@lib/toast"

export interface LabelsSubtasksDeps {
  saveTD: (field: string, value: unknown) => Promise<unknown>
  getCurrentTaskId: () => string | null
  openTaskDetail: (id: string) => void
  signal?: AbortSignal
}

/**
 * Initialise labels chip bar + inline subtask creation form.
 */
export function initLabelsAndSubtasks({ saveTD, getCurrentTaskId, openTaskDetail, signal }: LabelsSubtasksDeps): {
  addLabelChip: (label: string) => void
  getCurrentLabels: () => string[]
  setCurrentLabels: (labels: string[]) => void
} {
  let currentLabels: string[] = []
  const opts = signal ? { signal } : {}

  function addLabelChip(label: string) {
    const labelsDiv = document.getElementById("td-labels") as HTMLElement
    const chip = document.createElement("span")
    chip.className = "label-chip"
    chip.style.cssText =
      "cursor:pointer;display:inline-flex;align-items:center;gap:4px;"
    // Use textContent to prevent XSS from user-provided label values
    const labelText = document.createTextNode(label)
    chip.appendChild(labelText)
    const removeBtn = document.createElement("span")
    removeBtn.className = "td-label-remove"
    removeBtn.style.cssText = "font-size:14px;line-height:1;opacity:0.6;"
    removeBtn.textContent = "×"
    removeBtn.addEventListener("click", () => {
        currentLabels = currentLabels.filter((l) => l !== label)
        chip.remove()
        saveTD("labels", JSON.stringify(currentLabels))
      }, opts)
    chip.appendChild(removeBtn)
    labelsDiv.appendChild(chip)
  }

  document
    .getElementById("td-label-input")
    ?.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return
      e.preventDefault()
      const input = e.target as HTMLInputElement
      const val = input.value.trim()
      if (!val || currentLabels.includes(val)) {
        input.value = ""
        return
      }
      currentLabels.push(val)
      addLabelChip(val)
      input.value = ""
      saveTD("labels", JSON.stringify(currentLabels))
    }, opts)

  // Google Calendar recurrence picker + save on change
  const tdRecurrenceSelect = document.getElementById("td-recurrence") as HTMLSelectElement | null
  if (tdRecurrenceSelect) {
    enhanceRecurrenceSelect(tdRecurrenceSelect, {
      allowNone: true,
      noneLabel: "Does not repeat",
      getAnchorDate: () =>
        (document.getElementById("td-due-date") as HTMLInputElement | null)?.value ||
        (document.getElementById("td-start-date") as HTMLInputElement | null)?.value ||
        new Date(),
      signal,
    })
    tdRecurrenceSelect.addEventListener("change", (e) => {
      const val = (e.target as HTMLSelectElement).value || null
      if (val === CUSTOM_RECURRENCE_SENTINEL) return
      saveTD("recurrence_rule", val)
      const descEl = document.getElementById("td-recurrence-desc")
      if (descEl) {
        descEl.textContent = val ? describeRule(val) : ""
      }
    }, opts)
  }

  // Manual "Push to Calendar" action + smart policy visibility
  const pushCalendarBtn = document.getElementById("td-push-calendar-btn") as HTMLButtonElement | null
  const pushCalendarRow = pushCalendarBtn?.closest<HTMLElement>('[data-layout-item="calendar-push"]') ?? null
  const syncTdPushVisibility = () => {
    const visible = shouldShowManualCalendarPush(window.mSettings)
    if (pushCalendarRow) pushCalendarRow.hidden = !visible
  }
  syncTdPushVisibility()
  window.addEventListener("meitheal:calendar-push-policy-changed", syncTdPushVisibility, opts)
  if (pushCalendarBtn) {
    pushCalendarBtn.addEventListener("click", async () => {
      const currentTaskId = getCurrentTaskId()
      if (!currentTaskId) return
      pushCalendarBtn.disabled = true
      const labelEl = pushCalendarBtn.querySelector("span")
      const prevLabel = labelEl?.textContent ?? "Push to Calendar"
      if (labelEl) labelEl.textContent = "Pushing…"
      try {
        const ctx = currentTaskApiContext()
        const res = await fetch("/api/integrations/calendar/push", {
          method: "POST",
          headers: ctx
            ? taskApiHeaders(ctx, { "content-type": "application/json" })
            : { "content-type": "application/json" },
          signal,
          body: JSON.stringify({ task_id: currentTaskId }),
        })
        const data = await res.json().catch(() => ({}))
        if (res.ok) {
          const count = Number(data.pushed ?? 1)
          showToast(
            count > 1 ? `Pushed to ${count} calendars` : "Pushed to calendar",
            "success",
          )
        } else {
          showToast(String(data.error || "Could not push task to calendar"), "error")
        }
      } catch {
        if (!signal?.aborted) {
          showToast("Network error pushing task to calendar", "error")
        }
      } finally {
        if (!signal?.aborted) {
          pushCalendarBtn.disabled = false
          if (labelEl) labelEl.textContent = prevLabel
        }
      }
    }, opts)
  }

  // Phase 1 (SUB-02): Add subtask inline form
  const addSubBtn = document.getElementById("td-add-subtask-btn")
  const addSubForm = document.getElementById("td-add-subtask-form")
  const addSubInput = document.getElementById("td-add-subtask-input") as HTMLInputElement | null
  const addSubSubmit = document.getElementById("td-add-subtask-submit")
  const addSubCancel = document.getElementById("td-add-subtask-cancel")

  if (addSubBtn && addSubForm && addSubInput && addSubSubmit && addSubCancel) {
    addSubBtn.addEventListener("click", () => {
      addSubForm.classList.remove("hidden")
      addSubForm.classList.add("flex")
      addSubBtn.classList.add("hidden")
      addSubInput.value = ""
      addSubInput.focus()
    }, opts)
    addSubCancel.addEventListener("click", () => {
      addSubForm.classList.add("hidden")
      addSubForm.classList.remove("flex")
      addSubBtn.classList.remove("hidden")
    }, opts)
    const submitSubtask = async () => {
      const title = addSubInput.value.trim()
      if (!title) return
      const currentTaskId = getCurrentTaskId()
      if (!currentTaskId) return
      addSubInput.disabled = true
      try {
        const parentAreaEl = document.getElementById("td-area") as HTMLSelectElement | null
        const parentProjectEl = document.getElementById("td-project") as HTMLSelectElement | null
        const parentTypeEl = document.getElementById("td-task-type") as HTMLSelectElement | null
        const childType = defaultChildTaskType(parentTypeEl?.value)
        const ctx = currentTaskApiContext()
        const areaId = parentAreaEl?.value || null
        const projectId = parentProjectEl?.value || null
        const res = await fetch("/api/tasks", {
          method: "POST",
          headers: ctx ? taskApiHeaders(ctx, { "content-type": "application/json" }) : { "content-type": "application/json" },
          signal,
          body: JSON.stringify({
            title,
            parent_id: currentTaskId,
            ...(areaId ? { area_id: areaId } : {}),
            ...(projectId ? { project_id: projectId } : {}),
            task_type: childType,
            status: "pending",
          }),
        })
        if (res.ok) {
          addSubInput.value = ""
          addSubForm.classList.add("hidden")
          addSubForm.classList.remove("flex")
          addSubBtn.classList.remove("hidden")
          openTaskDetail(String(currentTaskId))
          document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "child-created" } }))
          showToast(`Child item "${title}" created`)
        } else {
          const err = await res.json().catch(() => ({ error: "Failed to create child item" }))
          showToast(err.error ?? err.detail ?? "Failed to create child item", "error")
        }
      } catch {
        showToast("Network error creating child item", "error")
      } finally {
        addSubInput.disabled = false
      }
    }
    addSubSubmit.addEventListener("click", submitSubtask, opts)
    document.getElementById("td-add-subtask-full-btn")?.addEventListener("click", () => {
      const currentTaskId = getCurrentTaskId()
      if (!currentTaskId || !window.openNewTaskModal) return
      const titleInput = document.getElementById("td-title") as HTMLTextAreaElement | null
      const idEl = document.getElementById("td-id")
      const parentTypeEl = document.getElementById("td-task-type") as HTMLSelectElement | null
      const parentAreaEl = document.getElementById("td-area") as HTMLSelectElement | null
      const parentProjectEl = document.getElementById("td-project") as HTMLSelectElement | null
      const ticketText = idEl?.textContent?.trim() ?? ""
      window.openNewTaskModal("standard_action", {
        parent: {
          parentId: currentTaskId,
          parentTitle: titleInput?.value.trim() || "Parent item",
          parentTicketKey: ticketText.startsWith("#") ? null : ticketText || null,
          parentType: normalizeEditableTaskType(parentTypeEl?.value),
          areaId: parentAreaEl?.value || null,
          projectId: parentProjectEl?.value || null,
        },
        resumeOriginTaskId: currentTaskId,
      })
    }, opts)
    addSubInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitSubtask()
    }, opts)
    addSubForm.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !addSubForm.classList.contains("hidden")) {
        e.preventDefault()
        addSubForm.classList.add("hidden")
        addSubForm.classList.remove("flex")
        addSubBtn.classList.remove("hidden")
        addSubBtn.focus()
      }
    }, opts)
  }

  return {
    addLabelChip,
    getCurrentLabels: () => currentLabels,
    setCurrentLabels: (labels: string[]) => { currentLabels = labels },
  }
}
