/**
 * modal-labels-subtasks.ts — Labels chips + inline subtask creation
 *
 * @domain tasks
 * @kcs Extracted from task-modal-controller.ts for decomposition.
 *      Labels: chip rendering + Enter-to-add with dedup.
 *      Subtasks: inline form with type inference from parent.
 */

export interface LabelsSubtasksDeps {
  saveTD: (field: string, value: unknown) => Promise<void>
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

  // Phase 1 (REC-04): Recurrence select → save on change
  document
    .getElementById("td-recurrence")
    ?.addEventListener("change", (e) => {
      const val = (e.target as HTMLSelectElement).value || null
      saveTD("recurrence_rule", val)
      const descEl = document.getElementById("td-recurrence-desc")
      if (descEl) {
        descEl.textContent = val ? `🔁 ${(e.target as HTMLSelectElement).selectedOptions[0]?.textContent ?? ""}` : ""
      }
    }, opts)

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
      addSubInput.disabled = true
      const currentTaskId = getCurrentTaskId()
      try {
        const parentAreaEl = document.getElementById("td-area") as HTMLSelectElement | null
        const parentTypeEl = document.getElementById("td-task-type") as HTMLSelectElement | null
        const parentType = parentTypeEl?.value ?? "task"
        const childType = parentType === "epic" ? "story" : "task"
        const res = await fetch(`${window.__ingress_path || ""}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            parent_id: currentTaskId,
            area_id: parentAreaEl?.value ?? "default",
            task_type: childType,
            status: "pending",
          }),
        })
        if (res.ok) {
          addSubInput.value = ""
          addSubForm.classList.add("hidden")
          addSubBtn.classList.remove("hidden")
          openTaskDetail(String(currentTaskId))
          const { showToast } = await import("@lib/toast")
          showToast(`Subtask "${title}" created`)
        } else {
          const err = await res.json().catch(() => ({ error: "Failed to create subtask" }))
          const { showToast } = await import("@lib/toast")
          showToast(err.error ?? "Failed to create subtask", "error")
        }
      } catch {
        const { showToast } = await import("@lib/toast")
        showToast("Network error creating subtask", "error")
      } finally {
        addSubInput.disabled = false
      }
    }
    addSubSubmit.addEventListener("click", submitSubtask, opts)
    addSubInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitSubtask()
      if (e.key === "Escape") {
        addSubForm.classList.add("hidden")
        addSubBtn.classList.remove("hidden")
      }
    }, opts)
  }

  return {
    addLabelChip,
    getCurrentLabels: () => currentLabels,
    setCurrentLabels: (labels: string[]) => { currentLabels = labels },
  }
}
