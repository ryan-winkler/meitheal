import { confirmDialog } from "@lib/confirm-dialog"
import { pageLifecycle } from "@lib/page-lifecycle"
import { showToast } from "@lib/toast"
import { createFocusTrap } from "@lib/focus-trap"
import { safeIngressHref } from "@lib/ingress-navigation"
import { createClientLogger } from "@lib/client-logger"
import { mapEntityEmojiToTabler } from "@lib/tabler-svg"
import { initHabitsShellNav } from "@lib/controllers/habits-shell-nav"
import {
  renderHabits,
  updateStats,
  createChecklistBuilderItem,
  type HabitData,
  type HabitChecklistItem,
} from "@lib/controllers/habits-card-renderer"

const log = createClientLogger("habits-shell")
let habits: HabitData[] = []

// ───── Data Parsing ─────

function normalizeChecklistItems(items: unknown): HabitChecklistItem[] {
  if (!Array.isArray(items)) return []

  return items
    .map((item) => {
      if (!item || typeof item !== "object") return null

      const record = item as Record<string, unknown>
      const text = String(record.text ?? "").trim()
      if (!text) return null

      return {
        text,
        done: Boolean(record.done),
      }
    })
    .filter((item): item is HabitChecklistItem => Boolean(item))
}

function parseTemplatePayload(templateJson: unknown): {
  description: string
  priority: number
  checklists: HabitChecklistItem[]
  areaId?: string | undefined
  projectId?: string | undefined
} {
  if (typeof templateJson !== "string" || !templateJson.trim()) {
    return {
      description: "",
      priority: 3,
      checklists: [],
    }
  }

  try {
    const parsed = JSON.parse(templateJson) as Record<string, unknown>
    return {
      description: String(parsed.description ?? "").trim(),
      priority: Number(parsed.priority ?? 3) || 3,
      checklists: normalizeChecklistItems(parsed.checklists),
      areaId: typeof parsed.area_id === "string" ? parsed.area_id : undefined,
      projectId: typeof parsed.project_id === "string" ? parsed.project_id : undefined,
    }
  } catch {
    return {
      description: "",
      priority: 3,
      checklists: [],
    }
  }
}

function normalizeHabitData(raw: unknown): HabitData | null {
  if (!raw || typeof raw !== "object") return null

  const record = raw as Record<string, unknown>
  const templatePayload = parseTemplatePayload(record.template_json)
  const topLevelChecklists = normalizeChecklistItems(record.checklists)
  const cadenceValue =
    record.cadence === "weekly" || record.frequency === "weekly"
      ? "weekly"
      : "daily"

  return {
    id: String(record.id ?? ""),
    name: String(record.name ?? "Untitled routine").trim() || "Untitled routine",
    icon: String(record.icon ?? "check").trim() || "check",
    cadence: cadenceValue,
    todayCompleted: Boolean(record.todayCompleted),
    todayTaskId:
      record.todayTaskId === null || record.todayTaskId === undefined
        ? null
        : String(record.todayTaskId),
    lastCompletedDate:
      record.lastCompletedDate === null || record.lastCompletedDate === undefined
        ? null
        : String(record.lastCompletedDate),
    currentStreak: Number(record.currentStreak ?? 0) || 0,
    longestStreak: Number(record.longestStreak ?? 0) || 0,
    totalCompletions: Number(record.totalCompletions ?? 0) || 0,
    projectActive: record.projectActive === undefined ? true : Boolean(record.projectActive),
    description: templatePayload.description,
    priority: templatePayload.priority,
    areaId: templatePayload.areaId,
    projectId: templatePayload.projectId,
    checklists: topLevelChecklists.length > 0 ? topLevelChecklists : templatePayload.checklists,
  }
}

function parseBootstrapHabits(): HabitData[] {
  const script = document.getElementById("habits-bootstrap")
  if (!script?.textContent) return []

  try {
    const data = JSON.parse(script.textContent) as { habits?: unknown[] }
    if (!Array.isArray(data.habits)) return []

    return data.habits
      .map(normalizeHabitData)
      .filter((habit): habit is HabitData => Boolean(habit))
  } catch (error) {
    log.error("Failed to parse habits bootstrap payload", error)
    return []
  }
}

// ───── API Operations ─────

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string }
    return data.error || "Request failed"
  } catch {
    return "Request failed"
  }
}

async function refreshHabits(): Promise<void> {
  const shell = document.getElementById("habits-shell")
  const query = new URLSearchParams()
  if (shell?.dataset.boardId) query.set("board_id", shell.dataset.boardId)
  if (shell?.dataset.areaId) query.set("area_id", shell.dataset.areaId)
  if (shell?.dataset.projectId) query.set("project_id", shell.dataset.projectId)
  const response = await fetch("/api/habits?" + query, {
    signal: pageLifecycle.signal,
  })
  if (!response.ok) {
    throw new Error(await readErrorMessage(response))
  }

  const data = (await response.json()) as { habits?: unknown[] }
  habits = Array.isArray(data.habits)
    ? data.habits
        .map(normalizeHabitData)
        .filter((habit): habit is HabitData => Boolean(habit))
    : []

  renderHabits(habits)
  updateStats(habits)
}

async function completeHabit(habitId: string): Promise<void> {
  const card = document.querySelector<HTMLElement>(`.habit-card[data-habit-id="${CSS.escape(habitId)}"]`)
  try {
    card?.classList.add("just-completed")

    const response = await fetch("/api/habits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "complete", templateId: habitId }),
      signal: pageLifecycle.signal,
    })

    if (!response.ok) {
      throw new Error(await readErrorMessage(response))
    }

    try {
      const { onTaskCompleted } = await import("@lib/gamification-hook")
      onTaskCompleted()
    } catch {
      // Gamification is optional.
    }

    showToast("Routine completed")
    await refreshHabits()
  } catch (error) {
    log.error("Failed to complete routine", error)
    showToast((error as Error).message || "Failed to complete routine", "error")
  } finally {
    card?.classList.remove("just-completed")
  }
}

async function deleteHabit(habitId: string): Promise<void> {
  const confirmed = await confirmDialog({ message: "Delete this routine? Associated tasks stay in your task history.", variant: "danger", confirmText: "Delete" })
  if (!confirmed) {
    return
  }

  try {
    const response = await fetch("/api/habits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", templateId: habitId }),
      signal: pageLifecycle.signal,
    })

    if (!response.ok) {
      throw new Error(await readErrorMessage(response))
    }

    showToast("Routine deleted")
    await refreshHabits()
  } catch (error) {
    log.error("Failed to delete routine", error)
    showToast((error as Error).message || "Failed to delete routine", "error")
  }
}

// ───── CRUD Modal ─────

function initHabitsCrud(): void {
  const overlay = document.getElementById("habit-modal-overlay")
  const dialog = overlay?.querySelector<HTMLElement>("[role=dialog]")
  const form = document.getElementById("habit-form") as HTMLFormElement | null
  const editIdInput = document.getElementById("habit-edit-id") as HTMLInputElement | null
  const nameInput = document.getElementById("habit-name") as HTMLInputElement | null
  const iconInput = document.getElementById("habit-icon") as HTMLInputElement | null
  const cadenceSelect = document.getElementById("habit-cadence") as HTMLSelectElement | null
  const prioritySelect = document.getElementById("habit-priority") as HTMLSelectElement | null
  const areaSelect = document.querySelector<HTMLSelectElement>("#habit-area")
  const projectSelect = document.querySelector<HTMLSelectElement>("#habit-project")
  const shell = document.getElementById("habits-shell")
  const descInput = document.getElementById("habit-description") as HTMLTextAreaElement | null
  const checklistContainer = document.getElementById("checklist-items")
  const modalTitle = document.getElementById("habit-modal-title")
  const modalClose = document.getElementById("habit-modal-close")
  const modalCancel = document.getElementById("habit-cancel")
  const addChecklistItemButton = document.getElementById("add-checklist-item")
  const list = document.getElementById("habits-list")
  const save = form?.querySelector<HTMLButtonElement>("button[type=submit]")

  if (
    !overlay ||
    !dialog ||
    !save ||
    !form ||
    !areaSelect ||
    !projectSelect ||
    !editIdInput ||
    !nameInput ||
    !iconInput ||
    !cadenceSelect ||
    !prioritySelect ||
    !descInput ||
    !checklistContainer ||
    !modalTitle ||
    !list
  ) {
    return
  }
  const trap = createFocusTrap(dialog)
  pageLifecycle.signal.addEventListener("abort", () => trap.deactivate(false), { once: true })
  let initialArea = ""
  let initialProject = ""
  const initialScope = shell?.dataset.areaId
  const returnQuery = new URLSearchParams({ board_id: shell?.dataset.boardId ?? "" })
  if (initialScope) returnQuery.set("area_id", initialScope)
  if (shell?.dataset.projectId) returnQuery.set("project_id", shell.dataset.projectId)
  const returnPath = shell?.dataset.openNew ? "/progress?" + returnQuery + "#routines" : undefined

  function resetChecklistBuilder(): void {
    checklistContainer!.replaceChildren()
  }

  function addChecklistItem(text = ""): void {
    const row = createChecklistBuilderItem(text)
    checklistContainer!.append(row)

    if (!text) {
      const input = row.querySelector<HTMLInputElement>(".checklist-text")
      input?.focus()
    }
  }

  function syncIconPicker(rawIcon: string): void {
    const normalized = mapEntityEmojiToTabler(rawIcon) ?? (rawIcon.trim() || "check")
    iconInput!.value = normalized
    const picker = document.getElementById("habit-icon-picker")
    if (!picker) return
    for (const optionBtn of picker.querySelectorAll<HTMLButtonElement>("[data-habit-icon-option]")) {
      const selected = optionBtn.dataset.habitIconOption === normalized
      optionBtn.classList.toggle("is-selected", selected)
      optionBtn.setAttribute("aria-pressed", String(selected))
    }
  }

  function filterProjectsByArea(areaId: string): void {
    for (const option of projectSelect!.options) {
      if (!option.value) {
        option.hidden = false
        option.disabled = false
        continue
      }
      const optionArea = option.dataset.areaId ?? ""
      const matches = !areaId || !optionArea || optionArea === areaId
      option.hidden = !matches
      option.disabled = !matches
    }
    const selectedOption = projectSelect!.selectedOptions[0]
    if (selectedOption && selectedOption.disabled) {
      projectSelect!.value = ""
    }
  }

  function openCreateModal(): void {
    editIdInput!.value = ""
    modalTitle!.textContent = modalTitle!.dataset.createTitle ?? "New Routine"
    nameInput!.value = ""
    syncIconPicker("check")
    cadenceSelect!.value = "daily"
    prioritySelect!.value = "3"
    areaSelect!.value = shell?.dataset.areaId ?? ""
    filterProjectsByArea(areaSelect!.value)
    projectSelect!.value = shell?.dataset.projectId ?? ""
    projectSelect!.disabled = Boolean(shell?.dataset.projectId)
    areaSelect!.disabled = Boolean(shell?.dataset.areaId)
    descInput!.value = ""
    resetChecklistBuilder()
    overlay!.classList.remove("hidden")
    trap.activate()
    nameInput!.focus()
  }

  function openEditModal(habitId: string): void {
    const habit = habits.find((candidate) => candidate.id === habitId)
    if (!habit) return

    editIdInput!.value = habit.id
    modalTitle!.textContent = modalTitle!.dataset.editTitle ?? "Edit Routine"
    nameInput!.value = habit.name
    syncIconPicker(habit.icon)
    cadenceSelect!.value = habit.cadence
    prioritySelect!.value = String(habit.priority)
    areaSelect!.value = habit.areaId ?? ""
    initialArea = habit.areaId ?? ""
    filterProjectsByArea(areaSelect!.value)
    projectSelect!.value = habit.projectId ?? ""
    initialProject = habit.projectId ?? ""
    projectSelect!.disabled = false
    areaSelect!.disabled = false
    descInput!.value = habit.description

    resetChecklistBuilder()
    habit.checklists.forEach((item) => addChecklistItem(item.text))

    overlay!.classList.remove("hidden")
    trap.activate()
    nameInput!.focus()
  }

  const iconPicker = document.getElementById("habit-icon-picker")
  if (iconPicker) {
    pageLifecycle.on(iconPicker, "click", (event) => {
      const btn = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-habit-icon-option]")
      const selected = btn?.dataset.habitIconOption
      if (!selected) return
      syncIconPicker(selected)
    })
  }

  pageLifecycle.on(areaSelect, "change", () => {
    filterProjectsByArea(areaSelect!.value)
  })

  function closeModal(): void {
    if (save?.disabled) return
    overlay!.classList.add("hidden")
    trap.deactivate()
    if (returnPath) window.location.assign(safeIngressHref(returnPath))
  }

  pageLifecycle.on(document, "click", (event) => {
    const target = event.target as HTMLElement
    const openButton = target.closest<HTMLElement>("[data-open-habit-modal]")
    if (!openButton || !areaSelect.options.length) return

    event.preventDefault()
    if (save.disabled) return
    openCreateModal()
  })
  if (shell?.dataset.openNew) {
    const url = new URL(window.location.href)
    url.searchParams.delete("new")
    history.replaceState(history.state, "", url)
    openCreateModal()
  }

  if (modalClose) {
    pageLifecycle.on(modalClose, "click", closeModal)
  }

  if (modalCancel) {
    pageLifecycle.on(modalCancel, "click", closeModal)
  }

  if (addChecklistItemButton) {
    pageLifecycle.on(addChecklistItemButton, "click", () => addChecklistItem())
  }

  pageLifecycle.on(overlay, "click", (event) => {
    if (event.target === overlay) {
      closeModal()
    }
  })

  pageLifecycle.on(document, "keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent
    if (keyboardEvent.key === "Escape" && !overlay!.classList.contains("hidden")) {
      keyboardEvent.preventDefault()
      closeModal()
    }
  })

  pageLifecycle.on(form, "submit", async (event) => {
    event.preventDefault()
    if (save.disabled) return

    const name = nameInput!.value.trim()
    if (!name) {
      showToast("Habit name is required", "warning")
      return
    }

    const checklists = Array.from(
      checklistContainer!.querySelectorAll<HTMLInputElement>(".checklist-text"),
    )
      .map((input) => input.value.trim())
      .filter(Boolean)
      .map((text) => ({ text, done: false }))

    const editId = editIdInput!.value
    save.disabled = true

    try {
      if (editId) {
        const templateJson: Record<string, unknown> = {
          title: name,
          description: descInput!.value.trim(),
          priority: Number(prioritySelect!.value),
          ...(areaSelect.value !== initialArea ? { area_id: areaSelect.value || null } : {}),
          ...(projectSelect.value !== initialProject ? { project_id: projectSelect.value || null } : {}),
          checklists,
        }

        const response = await fetch("/api/habits", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "update",
            templateId: editId,
            name,
            icon: iconInput!.value.trim() || "check",
            cadence: cadenceSelect!.value,
            templateJson,
          }),
          signal: pageLifecycle.signal,
        })

        if (!response.ok) {
          throw new Error(await readErrorMessage(response))
        }

        showToast("Routine updated")
      } else {
        const response = await fetch("/api/habits", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "create",
            name,
            icon: iconInput!.value.trim() || "check",
            cadence: cadenceSelect!.value,
            priority: Number(prioritySelect!.value),
            description: descInput!.value.trim(),
            area_id: areaSelect.value || null,
            project_id: projectSelect.value || null,
            checklists: checklists.length > 0 ? checklists : undefined,
          }),
          signal: pageLifecycle.signal,
        })

        if (!response.ok) {
          throw new Error(await readErrorMessage(response))
        }

        showToast("Routine created")
      }

      save.disabled = false
      closeModal()
      if (!returnPath) await refreshHabits()
    } catch (error) {
      log.error("Failed to save routine", error)
      showToast((error as Error).message || "Failed to save routine", "error")
    } finally {
      save.disabled = false
    }
  })

  pageLifecycle.on(list, "click", (event) => {
    const target = event.target as HTMLElement
    const button = target.closest<HTMLElement>("[data-action]")
    if (!button) return

    event.preventDefault()

    const action = button.dataset.action
    const habitId = button.dataset.id
    if (!habitId) return

    if (action === "complete") {
      void completeHabit(habitId)
      return
    }

    if (action === "edit") {
      openEditModal(habitId)
      return
    }

    if (action === "delete") {
      void deleteHabit(habitId)
    }
  })
}

// ───── Boot ─────

function bootHabitsPage(): void {
  const shell = document.getElementById("habits-shell")
  if (!shell || shell.dataset.habitsBooted === "true") return

  shell.dataset.habitsBooted = "true"
  habits = parseBootstrapHabits()

  initHabitsShellNav()
  if (shell.dataset.boardActive === "false" || shell.dataset.householdActive === "false") return
  initHabitsCrud()
  updateStats(habits)
}

bootHabitsPage()

pageLifecycle.onPageLoad(() => {
  try { bootHabitsPage() } catch (e) { console.error("[Meitheal][habits] Boot failed", e) }
})
