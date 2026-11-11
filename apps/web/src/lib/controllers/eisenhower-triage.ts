/**
 * Eisenhower Triage Wizard
 *
 * @domain tasks
 * @bounded-context tasks (presentation)
 *
 * Overlay wizard that walks through unclassified tasks,
 * assigning urgency/importance values via sliders to place
 * them into Eisenhower quadrants.
 */

import { taskApi } from "@lib/task-api-client"
import { showToast } from "@lib/toast"
import { normalizeStatus, OPEN_STATUSES } from "@lib/status-config"

// ── Types ─────────────────────────────────────────────────────────────────

interface TriageTask {
  id: string
  title: string
}

// ── State ─────────────────────────────────────────────────────────────────

let triageTasks: TriageTask[] = []
let triageIndex = 0

// ── Public API ────────────────────────────────────────────────────────────

/** Derive quadrant label + emoji from urgency × importance values */
export function quadrantPreview(urgency: number, importance: number): string {
  if (urgency === 0 && importance === 0) return "🔍 Set values to classify"
  const urgent = urgency >= 3
  const important = importance >= 3
  if (urgent && important) return "🔴 Do First"
  if (!urgent && important) return "🔵 Schedule"
  if (urgent && !important) return "🟡 Delegate"
  return "⚪ Not Now"
}

/** Open the triage overlay by fetching unclassified tasks */
export async function startTriage(): Promise<void> {
  try {
    const res = await fetch("/api/tasks?deferred=0")
    if (!res.ok) { showToast("common.failed_update", "error"); return }
    const data = await res.json()
    const raw = Array.isArray(data) ? data : (data.tasks ?? [])
    triageTasks = raw
      .filter((t: Record<string, unknown>) =>
        OPEN_STATUSES.has(normalizeStatus(String(t.status ?? ""))) &&
        (t.urgency === 0 || t.urgency == null) &&
        (t.importance === 0 || t.importance == null)
      )
      .map((t: Record<string, unknown>) => ({ id: String(t.id), title: String(t.title ?? "Untitled") }))

    if (triageTasks.length === 0) {
      showToast("common.empty")
      return
    }

    triageIndex = 0
    showTriageTask()

    const overlay = document.getElementById("triage-overlay")
    if (overlay) overlay.classList.remove("triage-overlay--hidden")
  } catch {
    showToast("common.failed_update", "error")
  }
}

export function closeTriage(): void {
  const overlay = document.getElementById("triage-overlay")
  if (overlay) overlay.classList.add("triage-overlay--hidden")
  triageTasks = []
  triageIndex = 0
}

export function triageNext(): void {
  triageIndex++
  if (triageIndex >= triageTasks.length) {
    closeTriage()
    showToast("common.task_updated")
    window.location.reload()
  } else {
    showTriageTask()
  }
}

export async function triageSave(): Promise<void> {
  const task = triageTasks[triageIndex]
  if (!task) return

  const urgency = Number((document.getElementById("triage-urgency") as HTMLInputElement)?.value ?? 0)
  const importance = Number((document.getElementById("triage-importance") as HTMLInputElement)?.value ?? 0)

  if (urgency === 0 && importance === 0) {
    // Don't save if both are unset — same as skip
    triageNext()
    return
  }

  // Collect extended fields (may be empty — that's fine)
  const payload: Record<string, unknown> = { urgency, importance }

  const effortVal = (document.getElementById("triage-effort") as HTMLSelectElement)?.value
  if (effortVal) payload.effort_minutes = Number(effortVal)

  const effortTypeRadio = document.querySelector<HTMLInputElement>('input[name="triage-effort-type"]:checked')
  if (effortTypeRadio?.value) payload.effort_type = effortTypeRadio.value

  const delayVal = (document.getElementById("triage-delay-impact") as HTMLSelectElement)?.value
  if (delayVal && delayVal !== "none") {
    const existingFP = await getExistingFrameworkPayload(task.id)
    existingFP.delay_impact = delayVal
    payload.framework_payload = JSON.stringify(existingFP)
  }

  const interestRadio = document.querySelector<HTMLInputElement>('input[name="triage-interest"]:checked')
  if (interestRadio?.value) {
    const existingFP = typeof payload.framework_payload === "string"
      ? JSON.parse(payload.framework_payload as string)
      : await getExistingFrameworkPayload(task.id)
    existingFP.interest_tag = interestRadio.value
    payload.framework_payload = JSON.stringify(existingFP)
  }

  try {
    await taskApi.updateTask(task.id, payload)
    triageNext()
  } catch {
    showToast("common.failed_update", "error")
  }
}

/** Setup triage slider input listeners */
export function setupTriageListeners(signal: AbortSignal): void {
  const urgencySlider = document.getElementById("triage-urgency")
  const importanceSlider = document.getElementById("triage-importance")
  const urgencyVal = document.getElementById("triage-urgency-val")
  const importanceVal = document.getElementById("triage-importance-val")

  urgencySlider?.addEventListener("input", () => {
    if (urgencyVal) urgencyVal.textContent = (urgencySlider as HTMLInputElement).value
    updateTriagePreview()
  }, { signal })

  importanceSlider?.addEventListener("input", () => {
    if (importanceVal) importanceVal.textContent = (importanceSlider as HTMLInputElement).value
    updateTriagePreview()
  }, { signal })

  // Close on overlay backdrop click
  document.getElementById("triage-overlay")?.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).classList.contains("triage-overlay")) {
      closeTriage()
    }
  }, { signal })

  // Close on Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("triage-overlay")?.classList.contains("triage-overlay--hidden")) {
      closeTriage()
    }
  }, { signal })
}

// ── Internal helpers ──────────────────────────────────────────────────────

function showTriageTask(): void {
  const task = triageTasks[triageIndex]
  if (!task) { closeTriage(); return }

  const nameEl = document.getElementById("triage-task-name")
  if (nameEl) nameEl.textContent = task.title

  const progressEl = document.getElementById("triage-progress")
  if (progressEl) progressEl.textContent = `${triageIndex + 1} / ${triageTasks.length}`

  // Reset urgency/importance sliders
  const urgencySlider = document.getElementById("triage-urgency") as HTMLInputElement | null
  const importanceSlider = document.getElementById("triage-importance") as HTMLInputElement | null
  if (urgencySlider) urgencySlider.value = "0"
  if (importanceSlider) importanceSlider.value = "0"

  const urgencyValEl = document.getElementById("triage-urgency-val")
  const importanceValEl = document.getElementById("triage-importance-val")
  if (urgencyValEl) urgencyValEl.textContent = "0"
  if (importanceValEl) importanceValEl.textContent = "0"

  // Reset extended fields
  const effortSelect = document.getElementById("triage-effort") as HTMLSelectElement | null
  if (effortSelect) effortSelect.value = ""
  const delaySelect = document.getElementById("triage-delay-impact") as HTMLSelectElement | null
  if (delaySelect) delaySelect.value = "none"
  document.querySelectorAll<HTMLInputElement>('input[name="triage-effort-type"]').forEach(r => r.checked = r.value === "")
  document.querySelectorAll<HTMLInputElement>('input[name="triage-interest"]').forEach(r => r.checked = r.value === "")

  // Collapse extended details between tasks
  const details = document.querySelector<HTMLDetailsElement>('.triage-card__details')
  if (details) details.removeAttribute('open')

  updateTriagePreview()
}

function updateTriagePreview(): void {
  const u = Number((document.getElementById("triage-urgency") as HTMLInputElement)?.value ?? 0)
  const i = Number((document.getElementById("triage-importance") as HTMLInputElement)?.value ?? 0)
  const preview = document.getElementById("triage-quadrant-preview")
  if (preview) preview.textContent = quadrantPreview(u, i)
}

/** Helper: fetch existing framework_payload for a task to merge into */
export async function getExistingFrameworkPayload(taskId: string): Promise<Record<string, unknown>> {
  try {
    const res = await fetch((window.__ingress_path || "") + `/api/tasks/${taskId}`)
    if (!res.ok) return {}
    const data = await res.json()
    const fp = data.framework_payload
    if (typeof fp === "string") return JSON.parse(fp)
    if (typeof fp === "object" && fp !== null) return fp
    return {}
  } catch {
    return {}
  }
}
