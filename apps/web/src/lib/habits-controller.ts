import { pageLifecycle } from "@lib/page-lifecycle"
import { showToast } from "@lib/toast"
import { createClientLogger } from "@lib/client-logger"
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
    name: String(record.name ?? "Untitled habit").trim() || "Untitled habit",
    icon: String(record.icon ?? "✅").trim() || "✅",
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
    description: templatePayload.description,
    priority: templatePayload.priority,
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
  const response = await fetch("/api/habits", {
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
  const card = document.querySelector<HTMLElement>(`.habit-card[data-habit-id="${habitId}"]`)
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

    showToast("Habit completed")
    await refreshHabits()
  } catch (error) {
    log.error("Failed to complete habit", error)
    showToast((error as Error).message || "Failed to complete habit", "error")
  } finally {
    card?.classList.remove("just-completed")
  }
}

async function deleteHabit(habitId: string): Promise<void> {
  if (!window.confirm("Delete this habit? Associated tasks stay in your task history.")) {
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

    showToast("Habit deleted")
    await refreshHabits()
  } catch (error) {
    log.error("Failed to delete habit", error)
    showToast((error as Error).message || "Failed to delete habit", "error")
  }
}

// ───── CRUD Modal ─────

function initHabitsCrud(): void {
  const overlay = document.getElementById("habit-modal-overlay")
  const form = document.getElementById("habit-form") as HTMLFormElement | null
  const editIdInput = document.getElementById("habit-edit-id") as HTMLInputElement | null
  const nameInput = document.getElementById("habit-name") as HTMLInputElement | null
  const iconInput = document.getElementById("habit-icon") as HTMLInputElement | null
  const cadenceSelect = document.getElementById("habit-cadence") as HTMLSelectElement | null
  const prioritySelect = document.getElementById("habit-priority") as HTMLSelectElement | null
  const descInput = document.getElementById("habit-description") as HTMLTextAreaElement | null
  const checklistContainer = document.getElementById("checklist-items")
  const modalTitle = document.getElementById("habit-modal-title")
  const modalClose = document.getElementById("habit-modal-close")
  const modalCancel = document.getElementById("habit-cancel")
  const addChecklistItemButton = document.getElementById("add-checklist-item")
  const list = document.getElementById("habits-list")

  if (
    !overlay ||
    !form ||
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

  function openCreateModal(): void {
    editIdInput!.value = ""
    modalTitle!.textContent = "New Habit"
    nameInput!.value = ""
    iconInput!.value = "✅"
    cadenceSelect!.value = "daily"
    prioritySelect!.value = "3"
    descInput!.value = ""
    resetChecklistBuilder()
    overlay!.classList.remove("hidden")
    nameInput!.focus()
  }

  function openEditModal(habitId: string): void {
    const habit = habits.find((candidate) => candidate.id === habitId)
    if (!habit) return

    editIdInput!.value = habit.id
    modalTitle!.textContent = "Edit Habit"
    nameInput!.value = habit.name
    iconInput!.value = habit.icon
    cadenceSelect!.value = habit.cadence
    prioritySelect!.value = String(habit.priority)
    descInput!.value = habit.description

    resetChecklistBuilder()
    habit.checklists.forEach((item) => addChecklistItem(item.text))

    overlay!.classList.remove("hidden")
    nameInput!.focus()
  }

  function closeModal(): void {
    overlay!.classList.add("hidden")
  }

  pageLifecycle.on(document, "click", (event) => {
    const target = event.target as HTMLElement
    const openButton = target.closest<HTMLElement>("[data-open-habit-modal]")
    if (!openButton) return

    event.preventDefault()
    openCreateModal()
  })

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

    try {
      if (editId) {
        const templateJson: Record<string, unknown> = {
          title: name,
          description: descInput!.value.trim(),
          priority: Number(prioritySelect!.value),
          labels: ["routine"],
          task_type: "task",
        }

        if (checklists.length > 0) {
          templateJson.checklists = checklists
        }

        const response = await fetch("/api/habits", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "update",
            templateId: editId,
            name,
            icon: iconInput!.value.trim() || "✅",
            cadence: cadenceSelect!.value,
            templateJson,
          }),
          signal: pageLifecycle.signal,
        })

        if (!response.ok) {
          throw new Error(await readErrorMessage(response))
        }

        showToast("Habit updated")
      } else {
        const response = await fetch("/api/habits", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "create",
            name,
            icon: iconInput!.value.trim() || "✅",
            cadence: cadenceSelect!.value,
            priority: Number(prioritySelect!.value),
            description: descInput!.value.trim(),
            checklists: checklists.length > 0 ? checklists : undefined,
          }),
          signal: pageLifecycle.signal,
        })

        if (!response.ok) {
          throw new Error(await readErrorMessage(response))
        }

        showToast("Habit created")
      }

      closeModal()
      await refreshHabits()
    } catch (error) {
      log.error("Failed to save habit", error)
      showToast((error as Error).message || "Failed to save habit", "error")
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
  initHabitsCrud()
  updateStats(habits)
}

bootHabitsPage()

pageLifecycle.onPageLoad(() => {
  bootHabitsPage()
})
