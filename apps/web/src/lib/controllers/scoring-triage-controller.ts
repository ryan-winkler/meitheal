/**
 * Scoring Triage Modal Controller (Lazy-Loaded)
 *
 * Orchestrates multi-framework triage (Eisenhower, RICE, DRICE, ICE, WSJF,
 * MoSCoW, Story Points) with live Sprint/Epic/Project/Area queue filtering.
 *
 * @domain strategy / planning
 */

import {
  buildTriagePatchPayload,
  computeTriagePreview,
  extractInitialTriageValues,
  extractSprintLabels,
  filterTriageTasks,
  getTriageFrameworkDef,
  parseTaskFrameworkPayload,
  type TriageFrameworkId,
  type TriageTaskRecord,
} from "@lib/scoring-triage"
import { saveVersionedTask, sameTaskApiContext, taskRecordVersion } from "@lib/task-api-client"
import { currentTaskApiContext, type TaskApiContext } from "@lib/task-api"
import { showToast } from "@lib/toast"

export interface OpenScoringTriageOptions {
  framework?: TriageFrameworkId
  unscoredOnly?: boolean
  epicId?: string
  projectId?: string
  areaId?: string
  sprint?: string
  onComplete?: () => void
}

interface CatalogOption {
  id: string
  name: string
}

let allTasks: TriageTaskRecord[] = []
let queueContext: TaskApiContext | null = null
let saveInProgress = false
let queue: TriageTaskRecord[] = []
let currentIndex = 0
let savedCount = 0
let currentFramework: TriageFrameworkId = "eisenhower"
let currentValues: Record<string, number> = {}
let onCompleteCb: (() => void) | undefined
let wiredModal: HTMLElement | null = null
let modalAbort: AbortController | null = null

let epicsMap = new Map<string, string>()
let projectsMap = new Map<string, string>()
let areasMap = new Map<string, string>()

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

function getSelectedRadio(name: string): string {
  const checked = document.querySelector<HTMLInputElement>(`#scoring-triage-modal input[name="${name}"]:checked`)
  return checked?.value ?? ""
}

function setSelectedRadio(name: string, value: string): void {
  document.querySelectorAll<HTMLInputElement>(`#scoring-triage-modal input[name="${name}"]`).forEach((input) => {
    input.checked = input.value === value
  })
}

async function fetchCatalogsAndTasks(): Promise<void> {
  const context = currentTaskApiContext()
  queueContext = null
  const [tasksRes, projectsRes, areasRes] = await Promise.all([
    fetch("/api/tasks?deferred=0"),
    fetch("/api/projects").catch(() => null),
    fetch("/api/areas").catch(() => null),
  ])

  if (!tasksRes.ok) throw new Error("Failed to load tasks for triage")
  const tasksJson = await tasksRes.json()
  if (!sameTaskApiContext(context, currentTaskApiContext())) throw new Error("Open triage again from the current Board.")
  queueContext = context
  allTasks = Array.isArray(tasksJson) ? tasksJson : (tasksJson.tasks ?? [])

  epicsMap = new Map()
  for (const t of allTasks) {
    if (String(t.task_type ?? "").toLowerCase() === "epic") {
      epicsMap.set(String(t.id), String(t.title ?? "Untitled Epic"))
    }
  }

  projectsMap = new Map()
  if (projectsRes?.ok) {
    const pJson = await projectsRes.json().catch(() => null)
    const pList: CatalogOption[] = Array.isArray(pJson) ? pJson : (pJson?.projects ?? pJson?.data ?? [])
    for (const p of pList) {
      if (p?.id) projectsMap.set(String(p.id), String(p.name ?? (p as unknown as { title?: string }).title ?? p.id))
    }
  }

  areasMap = new Map()
  if (areasRes?.ok) {
    const aJson = await areasRes.json().catch(() => null)
    const aList: CatalogOption[] = Array.isArray(aJson) ? aJson : (aJson?.areas ?? aJson?.data ?? [])
    for (const a of aList) {
      if (a?.id) areasMap.set(String(a.id), String(a.name ?? a.id))
    }
  }

  populateFilterSelects()
}

function populateSelect(
  select: HTMLSelectElement | null,
  allLabel: string,
  options: Array<{ value: string; label: string }>,
  includeNoneLabel?: string,
): void {
  if (!select) return
  const prev = select.value
  select.replaceChildren(new Option(allLabel, ""))
  if (includeNoneLabel) select.add(new Option(includeNoneLabel, "__none__"))
  for (const opt of options) {
    select.add(new Option(opt.label, opt.value))
  }
  if (Array.from(select.options).some(o => o.value === prev)) {
    select.value = prev
  }
}

function populateFilterSelects(): void {
  const epicOpts = Array.from(epicsMap.entries())
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([value, label]) => ({ value, label }))
  populateSelect(byId<HTMLSelectElement>("st-filter-epic"), "All epics", epicOpts, "No epic")

  const projOpts = Array.from(projectsMap.entries())
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([value, label]) => ({ value, label }))
  populateSelect(byId<HTMLSelectElement>("st-filter-project"), "All projects", projOpts, "No project")

  const areaOpts = Array.from(areasMap.entries())
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([value, label]) => ({ value, label }))
  populateSelect(byId<HTMLSelectElement>("st-filter-area"), "All areas", areaOpts, "No area")

  const sprintSelect = byId<HTMLSelectElement>("st-filter-sprint")
  if (sprintSelect) {
    const prev = sprintSelect.value
    const baseOptions: Array<[string, string]> = [
      ["", "All sprints & dates"],
      ["due:this-week", "Due this week"],
      ["due:next-2-weeks", "Next 2 weeks"],
      ["due:overdue", "Overdue"],
      ["due:unscheduled", "Unscheduled"],
    ]
    sprintSelect.replaceChildren(...baseOptions.map(([v, l]) => new Option(l, v)))
    const labels = extractSprintLabels(allTasks)
    if (labels.length > 0) {
      const group = document.createElement("optgroup")
      group.label = "Sprint / Cycle Labels"
      for (const lbl of labels) {
        group.appendChild(new Option(`#${lbl}`, `label:${lbl}`))
      }
      sprintSelect.appendChild(group)
    }
    if (Array.from(sprintSelect.options).some(o => o.value === prev)) {
      sprintSelect.value = prev
    }
  }
}

function rebuildQueue(resetIndex = true): void {
  const unscoredOnly = byId<HTMLInputElement>("st-unscored-only")?.checked ?? true
  const epicId = byId<HTMLSelectElement>("st-filter-epic")?.value || undefined
  const projectId = byId<HTMLSelectElement>("st-filter-project")?.value || undefined
  const areaId = byId<HTMLSelectElement>("st-filter-area")?.value || undefined
  const sprint = byId<HTMLSelectElement>("st-filter-sprint")?.value || undefined

  queue = filterTriageTasks(allTasks, {
    framework: currentFramework,
    unscoredOnly,
    epicId,
    projectId,
    areaId,
    sprint,
  })
  if (resetIndex) currentIndex = 0
  else if (currentIndex >= queue.length) currentIndex = Math.max(0, queue.length - 1)
  renderCurrentTask()
}

function updatePreviewUI(): void {
  const preview = computeTriagePreview(currentFramework, currentValues)
  const box = byId("st-preview")
  const badge = byId("st-preview-badge")
  const detail = byId("st-preview-detail")
  const saveBtn = byId<HTMLButtonElement>("st-save-btn")

  if (box) box.dataset.tone = preview.tone
  if (badge) badge.textContent = preview.badgeText
  if (detail) detail.textContent = preview.detailText
  if (saveBtn) saveBtn.disabled = saveInProgress || !preview.canSave
}

function renderFrameworkControls(): void {
  const container = byId("st-controls")
  if (!container) return
  const def = getTriageFrameworkDef(currentFramework)
  const desc = byId("st-framework-desc")
  if (desc) desc.textContent = def.description

  const quickSpGroup = byId("st-quick-sp-group")
  if (quickSpGroup) quickSpGroup.hidden = currentFramework === "story-points"

  container.replaceChildren(
    ...def.fields.map((field) => {
      const card = document.createElement("div")
      card.className = field.control === "selectgroup" ? "st-control-card st-control-card--full" : "st-control-card"

      const val = currentValues[field.key] ?? field.defaultValue

      if (field.control === "selectgroup" && field.choices) {
        const label = document.createElement("span")
        label.className = "st-control-label"
        label.textContent = field.label

        const group = document.createElement("div")
        group.className = "form-selectgroup st-selectgroup"
        group.setAttribute("role", "radiogroup")
        group.setAttribute("aria-label", field.label)

        for (const choice of field.choices) {
          const item = document.createElement("label")
          item.className = "form-selectgroup-item st-sg-item"
          if (choice.hint) item.title = choice.hint

          const input = document.createElement("input")
          input.type = "radio"
          input.name = `st-field-${field.key}`
          input.value = String(choice.value)
          input.className = "form-selectgroup-input"
          input.checked = val === choice.value
          input.addEventListener("change", () => {
            currentValues[field.key] = choice.value
            updatePreviewUI()
          })

          const pill = document.createElement("span")
          pill.className = "form-selectgroup-label st-sg-label"
          pill.textContent = choice.hint && currentFramework === "story-points"
            ? `${choice.label} · ${choice.hint}`
            : choice.label

          item.append(input, pill)
          group.appendChild(item)
        }

        const hint = document.createElement("p")
        hint.className = "st-control-hint"
        hint.textContent = field.hint
        card.append(label, group, hint)
        return card
      }

      // Paired Tabler range + editable number input
      const head = document.createElement("div")
      head.className = "st-control-head"

      const label = document.createElement("label")
      label.className = "st-control-label"
      label.htmlFor = `st-num-${field.key}`
      label.textContent = field.label

      const numWrap = document.createElement("div")
      numWrap.className = "st-control-num-wrap"

      const numInput = document.createElement("input")
      numInput.type = "number"
      numInput.id = `st-num-${field.key}`
      numInput.className = "form-control st-control-num"
      numInput.min = String(field.min)
      numInput.max = String(field.max)
      numInput.step = String(field.step)
      numInput.value = String(val)
      numInput.setAttribute("aria-label", `${field.label} value`)

      numWrap.appendChild(numInput)
      if (field.suffix) {
        const suffix = document.createElement("span")
        suffix.className = "st-control-suffix"
        suffix.textContent = field.suffix
        numWrap.appendChild(suffix)
      }
      head.append(label, numWrap)

      const rangeInput = document.createElement("input")
      rangeInput.type = "range"
      rangeInput.id = `st-range-${field.key}`
      rangeInput.className = "form-range st-control-range"
      rangeInput.min = String(field.min)
      rangeInput.max = String(field.max)
      rangeInput.step = String(field.step)
      rangeInput.value = String(val)
      rangeInput.setAttribute("aria-label", `${field.label} slider`)

      rangeInput.addEventListener("input", () => {
        const n = Number(rangeInput.value)
        currentValues[field.key] = n
        numInput.value = String(n)
        updatePreviewUI()
      })

      numInput.addEventListener("input", () => {
        const parsed = Number(numInput.value)
        if (!Number.isFinite(parsed)) return
        const clamped = Math.max(field.min, Math.min(field.max, parsed))
        currentValues[field.key] = clamped
        rangeInput.value = String(clamped)
        updatePreviewUI()
      })

      const ticks = document.createElement("div")
      ticks.className = "st-control-ticks"
      const minSpan = document.createElement("span")
      minSpan.textContent = field.minLabel ?? String(field.min)
      const maxSpan = document.createElement("span")
      maxSpan.textContent = field.maxLabel ?? String(field.max)
      ticks.append(minSpan, maxSpan)

      const hint = document.createElement("p")
      hint.className = "st-control-hint"
      hint.textContent = field.hint

      card.append(head, rangeInput, ticks, hint)
      return card
    }),
  )
}

function renderCurrentTask(): void {
  const emptyEl = byId("st-empty-state")
  const workEl = byId("st-task-workspace")
  const badge = byId("st-progress-badge")
  const fill = byId("st-progress-fill")
  const prevBtn = byId<HTMLButtonElement>("st-prev-btn")
  const skipBtn = byId<HTMLButtonElement>("st-skip-btn")
  const saveBtn = byId<HTMLButtonElement>("st-save-btn")

  if (queue.length === 0) {
    if (emptyEl) emptyEl.hidden = false
    if (workEl) workEl.hidden = true
    if (badge) badge.textContent = "0 / 0"
    if (fill) fill.style.width = "0%"
    if (prevBtn) prevBtn.disabled = true
    if (skipBtn) skipBtn.disabled = true
    if (saveBtn) saveBtn.disabled = true
    return
  }

  if (emptyEl) emptyEl.hidden = true
  if (workEl) workEl.hidden = false

  const task = queue[currentIndex]
  if (!task) return

  if (badge) badge.textContent = `${currentIndex + 1} / ${queue.length}`
  if (fill) fill.style.width = `${Math.round(((currentIndex + 1) / queue.length) * 100)}%`
  if (prevBtn) prevBtn.disabled = currentIndex === 0
  if (skipBtn) skipBtn.disabled = false

  const titleEl = byId("st-task-title")
  if (titleEl) titleEl.textContent = task.title

  const metaEl = byId("st-task-meta")
  if (metaEl) {
    const chips: HTMLElement[] = []
    const addChip = (text: string, extraClass = "") => {
      const chip = document.createElement("span")
      chip.className = `st-meta-chip ${extraClass}`.trim()
      chip.textContent = text
      chips.push(chip)
    }
    if (task.ticket_key) addChip(task.ticket_key, "st-meta-chip--key")
    if (task.status) addChip(task.status)
    const epicId = task.epic_id ?? task.parent_id
    if (epicId && epicsMap.has(epicId)) addChip(`Epic: ${epicsMap.get(epicId)}`)
    if (task.project_id && projectsMap.has(task.project_id)) addChip(`Project: ${projectsMap.get(task.project_id)}`)
    if (task.area_id && areasMap.has(task.area_id)) addChip(areasMap.get(task.area_id)!)
    const fp = parseTaskFrameworkPayload(task.framework_payload)
    if (typeof fp.story_points === "number" && fp.story_points > 0) addChip(`${fp.story_points} pts`)
    metaEl.replaceChildren(...chips)
  }

  currentValues = extractInitialTriageValues(task, currentFramework)
  renderFrameworkControls()
  updatePreviewUI()

  // Populate extended planning details from task
  const fp = parseTaskFrameworkPayload(task.framework_payload)
  setSelectedRadio("st-quick-sp", fp.story_points ? String(fp.story_points) : "")
  const effortSelect = byId<HTMLSelectElement>("st-detail-effort")
  if (effortSelect) effortSelect.value = task.effort_minutes ? String(task.effort_minutes) : ""
  const delaySelect = byId<HTMLSelectElement>("st-detail-delay")
  if (delaySelect) delaySelect.value = typeof fp.delay_impact === "string" ? fp.delay_impact : "none"
  setSelectedRadio("st-effort-type", task.effort_type ?? "")
  setSelectedRadio("st-interest", typeof fp.interest_tag === "string" ? fp.interest_tag : "")

  const details = byId<HTMLDetailsElement>("st-details")
  if (details) details.open = false
}

async function saveCurrentTask(): Promise<void> {
  const task = queue[currentIndex]
  if (!task || !queueContext || saveInProgress) return

  const preview = computeTriagePreview(currentFramework, currentValues)
  if (!preview.canSave) return

  const saveBtn = byId<HTMLButtonElement>("st-save-btn")
  if (saveBtn) saveBtn.disabled = true
  saveInProgress = true

  try {
    const existingFp = parseTaskFrameworkPayload(task.framework_payload)
    const quickSpRaw = getSelectedRadio("st-quick-sp")
    const effortRaw = byId<HTMLSelectElement>("st-detail-effort")?.value ?? ""
    const delayRaw = byId<HTMLSelectElement>("st-detail-delay")?.value ?? "none"
    const effortType = getSelectedRadio("st-effort-type")
    const interestTag = getSelectedRadio("st-interest")

    const patch = buildTriagePatchPayload(currentFramework, currentValues, existingFp, {
      storyPoints: quickSpRaw ? Number(quickSpRaw) : null,
      effortMinutes: effortRaw ? Number(effortRaw) : null,
      effortType: effortType || undefined,
      delayImpact: delayRaw,
      interestTag: interestTag || undefined,
    })

    const saved = await saveVersionedTask(task.id, patch, taskRecordVersion({ ...task }), queueContext, modalAbort?.signal)
    if (!saved.ok) {
      showToast(saved.errorCode === "conflict" ? "This task changed. Reopen triage to review the latest score." : "common.failed_update", "error")
      return
    }
    task.task_version = saved.version
    savedCount++

    // Keep local cache in sync so switching frameworks reflects saved scores immediately
    if (typeof patch.urgency === "number") task.urgency = patch.urgency
    if (typeof patch.importance === "number") task.importance = patch.importance
    if (typeof patch.effort_minutes === "number") task.effort_minutes = patch.effort_minutes
    if (typeof patch.effort_type === "string") task.effort_type = patch.effort_type
    if (typeof patch.framework_payload === "string") task.framework_payload = patch.framework_payload

    if (queue[currentIndex] === task) advanceQueue()
  } catch {
    showToast("common.failed_update", "error")
  } finally {
    saveInProgress = false
    updatePreviewUI()
  }
}

function advanceQueue(): void {
  if (currentIndex + 1 >= queue.length) {
    closeScoringTriage(true)
    return
  }
  currentIndex++
  renderCurrentTask()
}

export function closeScoringTriage(completed = false): void {
  const modal = byId("scoring-triage-modal")
  if (modal) modal.hidden = true
  document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "scoring-triage" } }))
  if (savedCount > 0) {
    showToast(completed ? `Triage complete — ${savedCount} task${savedCount === 1 ? "" : "s"} scored` : `Saved ${savedCount} scored task${savedCount === 1 ? "" : "s"}`, "success")
    const cb = onCompleteCb
    onCompleteCb = undefined
    savedCount = 0
    if (cb) cb()
  }
}

function ensureModalWired(): HTMLElement | null {
  const modal = byId("scoring-triage-modal")
  if (!modal) return null
  if (wiredModal === modal) return modal

  modalAbort?.abort()
  modalAbort = new AbortController()
  const { signal } = modalAbort
  wiredModal = modal

  byId("st-close-btn")?.addEventListener("click", () => closeScoringTriage(false), { signal })
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeScoringTriage(false)
  }, { signal })

  document.addEventListener("keydown", (e) => {
    if (modal.hidden) return
    if (e.key === "Escape") {
      e.preventDefault()
      closeScoringTriage(false)
    } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault()
      void saveCurrentTask()
    }
  }, { signal })

  byId<HTMLSelectElement>("st-framework-select")?.addEventListener("change", (e) => {
    currentFramework = ((e.target as HTMLSelectElement).value || "eisenhower") as TriageFrameworkId
    rebuildQueue(true)
  }, { signal })

  for (const id of ["st-unscored-only", "st-filter-sprint", "st-filter-epic", "st-filter-project", "st-filter-area"]) {
    byId(id)?.addEventListener("change", () => rebuildQueue(true), { signal })
  }

  byId("st-show-all-btn")?.addEventListener("click", () => {
    const cb = byId<HTMLInputElement>("st-unscored-only")
    if (cb) cb.checked = false
    rebuildQueue(true)
  }, { signal })

  byId("st-reset-filters-btn")?.addEventListener("click", () => {
    for (const id of ["st-filter-sprint", "st-filter-epic", "st-filter-project", "st-filter-area"]) {
      const sel = byId<HTMLSelectElement>(id)
      if (sel) sel.value = ""
    }
    const cb = byId<HTMLInputElement>("st-unscored-only")
    if (cb) cb.checked = false
    rebuildQueue(true)
  }, { signal })

  byId("st-prev-btn")?.addEventListener("click", () => {
    if (currentIndex > 0) {
      currentIndex--
      renderCurrentTask()
    }
  }, { signal })

  byId("st-skip-btn")?.addEventListener("click", () => advanceQueue(), { signal })
  byId("st-save-btn")?.addEventListener("click", () => { void saveCurrentTask() }, { signal })

  return modal
}

export async function openScoringTriage(options: OpenScoringTriageOptions = {}): Promise<void> {
  const modal = ensureModalWired()
  if (!modal) return

  savedCount = 0
  onCompleteCb = options.onComplete
  currentFramework = options.framework ?? (modal.dataset.defaultFramework as TriageFrameworkId) ?? "eisenhower"

  const fwSelect = byId<HTMLSelectElement>("st-framework-select")
  if (fwSelect) fwSelect.value = currentFramework

  const unscoredCb = byId<HTMLInputElement>("st-unscored-only")
  if (unscoredCb) unscoredCb.checked = options.unscoredOnly ?? true

  modal.hidden = false
  const titleEl = byId("st-task-title")
  if (titleEl) titleEl.textContent = "Loading open tasks…"

  try {
    await fetchCatalogsAndTasks()
    if (options.epicId) {
      const el = byId<HTMLSelectElement>("st-filter-epic")
      if (el) el.value = options.epicId
    }
    if (options.projectId) {
      const el = byId<HTMLSelectElement>("st-filter-project")
      if (el) el.value = options.projectId
    }
    if (options.areaId) {
      const el = byId<HTMLSelectElement>("st-filter-area")
      if (el) el.value = options.areaId
    }
    if (options.sprint) {
      const el = byId<HTMLSelectElement>("st-filter-sprint")
      if (el) el.value = options.sprint
    }
    rebuildQueue(true)
  } catch {
    showToast("common.failed_update", "error")
    modal.hidden = true
  }
}
