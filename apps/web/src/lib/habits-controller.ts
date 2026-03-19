import { HABITS_SECTIONS, type HabitsSectionId } from "@lib/habits-registry"
import { pageLifecycle } from "@lib/page-lifecycle"
import { showToast } from "@lib/toast"
import {
  initUnifiedBarSearchLauncher,
  initUnifiedBarTabOverflow,
  initUnifiedBarTitleSwitcher,
  setUnifiedBarSwitcherActiveState,
} from "@lib/unified-bar-controller"
import { createClientLogger } from "@lib/client-logger"

interface HabitChecklistItem {
  text: string
  done: boolean
}

interface HabitData {
  id: string
  name: string
  icon: string
  cadence: "daily" | "weekly"
  todayCompleted: boolean
  todayTaskId: string | null
  lastCompletedDate: string | null
  currentStreak: number
  longestStreak: number
  totalCompletions: number
  description: string
  priority: number
  checklists: HabitChecklistItem[]
}

const HABITS_BAR_ID = "habits-bar"
const HABITS_SECTION_IDS = new Set(HABITS_SECTIONS.map((section) => section.id))
const log = createClientLogger("habits-shell")
let habits: HabitData[] = []

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

function resolveHabitsSectionId(anchorId: string): HabitsSectionId | null {
  const target = document.getElementById(anchorId)
  if (!target) return null

  const maybeSectionId =
    target.closest<HTMLElement>("[data-habits-section]")?.id ||
    target.id ||
    null

  if (!maybeSectionId || !HABITS_SECTION_IDS.has(maybeSectionId as HabitsSectionId)) {
    return null
  }

  return maybeSectionId as HabitsSectionId
}

function updateActiveSectionState(sectionId: HabitsSectionId): void {
  document
    .querySelectorAll<HTMLElement>("[data-unified-bar-section]")
    .forEach((link) => {
      const active = link.dataset.unifiedBarSection === sectionId
      link.classList.toggle("is-active", active)
      link.setAttribute("aria-current", active ? "location" : "false")
      link.setAttribute("aria-selected", active ? "true" : "false")
      link.setAttribute("tabindex", active ? "0" : "-1")
    })

  setUnifiedBarSwitcherActiveState(HABITS_BAR_ID, sectionId)
}

function scrollToHabitsAnchor(
  anchorId: string,
  behavior: ScrollBehavior = "smooth",
): void {
  const target = document.getElementById(anchorId)
  if (!target) return

  target.scrollIntoView({ behavior, block: "start" })
  history.replaceState(null, "", `#${anchorId}`)

  const sectionId = resolveHabitsSectionId(anchorId)
  if (sectionId) {
    updateActiveSectionState(sectionId)
  }

  target.classList.add("habits-shell__section--flash")
  setTimeout(() => target.classList.remove("habits-shell__section--flash"), 1000)
}

function syncHabitsSectionFromHash(): void {
  const hash = window.location.hash.replace("#", "")
  const sectionId = hash ? resolveHabitsSectionId(hash) : null
  updateActiveSectionState(sectionId ?? "habits-overview")
}

function initSectionLinks(): void {
  document
    .querySelectorAll<HTMLElement>("[data-unified-bar-section-link], [data-habits-section-link]")
    .forEach((link) => {
      pageLifecycle.on(link, "click", (event) => {
        event.preventDefault()
        const targetId = link.getAttribute("href")?.replace("#", "")
        if (!targetId) return

        scrollToHabitsAnchor(targetId)
      })
    })
}

function initIntersectionTracking(): void {
  const sections = document.querySelectorAll<HTMLElement>("[data-habits-section]")
  if (!sections.length) return

  const observer = new IntersectionObserver(
    (entries) => {
      const active = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0]

      if (!active?.target.id) return

      const sectionId = resolveHabitsSectionId(active.target.id)
      if (sectionId) {
        updateActiveSectionState(sectionId)
      }
    },
    {
      rootMargin: "-25% 0px -45% 0px",
      threshold: [0.2, 0.45, 0.7],
    },
  )

  sections.forEach((section) => observer.observe(section))
  pageLifecycle.signal.addEventListener("abort", () => observer.disconnect(), {
    once: true,
  })
}

function initGoToTop(): void {
  const button = document.getElementById("habits-go-top")
  const shell = document.getElementById("habits-shell")
  if (!button || !shell) return

  shell.style.position = "relative"

  const sentinel = document.createElement("div")
  sentinel.setAttribute("aria-hidden", "true")
  sentinel.style.cssText =
    "position:absolute;top:420px;width:1px;height:1px;pointer-events:none;"
  shell.appendChild(sentinel)

  const observer = new IntersectionObserver(
    (entries) => {
      const isAboveFold = entries[0]?.isIntersecting ?? true
      button.classList.toggle("is-visible", !isAboveFold)
      button.toggleAttribute("hidden", isAboveFold)
    },
    { threshold: 0 },
  )

  observer.observe(sentinel)
  pageLifecycle.signal.addEventListener("abort", () => observer.disconnect(), {
    once: true,
  })

  pageLifecycle.on(button, "click", () => {
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`)
    window.scrollTo({ top: 0, behavior: "smooth" })
    updateActiveSectionState("habits-overview")
  })
}

function initTabsKeyboard(): void {
  const tabContainer = document.getElementById(`${HABITS_BAR_ID}-tabs`)
  if (!tabContainer) return

  pageLifecycle.on(tabContainer, "keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent
    if (keyboardEvent.key !== "ArrowLeft" && keyboardEvent.key !== "ArrowRight") {
      return
    }

    const visibleTabs = Array.from(
      tabContainer.querySelectorAll<HTMLElement>(
        "[data-unified-bar-tab]:not([data-overflow-hidden])",
      ),
    )
    const currentIndex = visibleTabs.findIndex((tab) => tab === document.activeElement)
    if (currentIndex === -1) return

    keyboardEvent.preventDefault()
    const direction = keyboardEvent.key === "ArrowRight" ? 1 : -1
    const nextIndex = (currentIndex + direction + visibleTabs.length) % visibleTabs.length
    const nextTab = visibleTabs[nextIndex]
    if (!nextTab) return

    nextTab.focus()
    nextTab.click()
  })
}

function formatCadence(cadence: HabitData["cadence"]): string {
  return cadence === "weekly" ? "Weekly" : "Daily"
}

function formatLastCompletedDate(value: string | null): string {
  if (!value) return "Never completed"

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return `Last done ${value}`

  return `Last done ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date)}`
}

function priorityLabel(priority: number): string {
  switch (priority) {
    case 1:
      return "P1"
    case 2:
      return "P2"
    case 4:
      return "P4"
    case 5:
      return "P5"
    default:
      return "P3"
  }
}

function updateStats(): void {
  const activeCount = habits.length
  const completedToday = habits.filter((habit) => habit.todayCompleted).length
  const bestStreak = Math.max(0, ...habits.map((habit) => habit.longestStreak))
  const totalCompletions = habits.reduce(
    (sum, habit) => sum + habit.totalCompletions,
    0,
  )
  const dailyCount = habits.filter((habit) => habit.cadence === "daily").length
  const weeklyCount = habits.filter((habit) => habit.cadence === "weekly").length

  const statActive = document.getElementById("stat-active")
  const statCompletedToday = document.getElementById("stat-completed-today")
  const statLongestStreak = document.getElementById("stat-longest-streak")
  const statTotal = document.getElementById("stat-total")
  const signalSummary = document.getElementById("habits-signal-summary")
  const cadenceSummary = document.getElementById("habits-cadence-summary")
  const libraryCount = document.getElementById("habits-library-count")

  if (statActive) statActive.textContent = String(activeCount)
  if (statCompletedToday) statCompletedToday.textContent = String(completedToday)
  if (statLongestStreak) statLongestStreak.textContent = String(bestStreak)
  if (statTotal) statTotal.textContent = String(totalCompletions)

  if (signalSummary) {
    signalSummary.textContent =
      activeCount === 0
        ? "No active habits yet"
        : `${completedToday} completed today across ${activeCount} active habit${activeCount === 1 ? "" : "s"}`
  }

  if (cadenceSummary) {
    cadenceSummary.textContent =
      activeCount === 0
        ? "Create your first habit to start a routine cadence."
        : `${dailyCount} daily · ${weeklyCount} weekly routines`
  }

  if (libraryCount) {
    libraryCount.textContent =
      activeCount === 0 ? "No active habits yet" : `${activeCount} active habit${activeCount === 1 ? "" : "s"}`
  }
}

function createMetaItem(text: string, className?: string): HTMLSpanElement {
  const item = document.createElement("span")
  item.className = className ? `habit-card__meta-item ${className}` : "habit-card__meta-item"
  item.textContent = text
  return item
}

function createIconButton(
  action: "edit" | "delete",
  habitId: string,
  label: string,
  icon: string,
): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "btn-icon"
  button.dataset.action = action
  button.dataset.id = habitId
  button.setAttribute("aria-label", label)
  button.title = label
  button.textContent = icon
  return button
}

function createChecklistList(habit: HabitData): HTMLUListElement {
  const list = document.createElement("ul")
  list.className = "habit-card__checklist"
  list.setAttribute("aria-label", `${habit.name} template checklist`)

  habit.checklists.forEach((item) => {
    const entry = document.createElement("li")
    entry.className = "habit-card__checklist-item"

    const marker = document.createElement("span")
    marker.className = "habit-card__checklist-marker"
    marker.setAttribute("aria-hidden", "true")
    marker.textContent = item.done ? "✓" : "•"

    const text = document.createElement("span")
    text.textContent = item.text

    entry.append(marker, text)
    list.append(entry)
  })

  return list
}

function createHabitCard(habit: HabitData): HTMLArticleElement {
  const card = document.createElement("article")
  card.className = `habit-card${habit.todayCompleted ? " completed" : ""}`
  card.dataset.habitId = habit.id

  const top = document.createElement("div")
  top.className = "habit-card__top"

  const completeButton = document.createElement("button")
  completeButton.type = "button"
  completeButton.className = "habit-card__check"
  completeButton.dataset.action = "complete"
  completeButton.dataset.id = habit.id
  completeButton.setAttribute("aria-label", `Complete ${habit.name} today`)
  completeButton.textContent = habit.todayCompleted ? "✓" : ""

  const icon = document.createElement("span")
  icon.className = "habit-card__icon"
  icon.setAttribute("aria-hidden", "true")
  icon.textContent = habit.icon

  const info = document.createElement("div")
  info.className = "habit-card__info"

  const name = document.createElement("div")
  name.className = "habit-card__name"
  name.textContent = habit.name

  const meta = document.createElement("div")
  meta.className = "habit-card__meta"
  meta.append(
    createMetaItem(formatCadence(habit.cadence)),
    createMetaItem(priorityLabel(habit.priority)),
    createMetaItem(`${habit.totalCompletions} total`),
    createMetaItem(formatLastCompletedDate(habit.lastCompletedDate)),
  )

  if (habit.currentStreak > 0) {
    meta.prepend(createMetaItem(`🔥 ${habit.currentStreak} day streak`, "habit-card__streak"))
  }

  if (habit.checklists.length > 0) {
    meta.append(createMetaItem(`${habit.checklists.length} checklist items`))
  }

  info.append(name, meta)

  const actions = document.createElement("div")
  actions.className = "habit-card__actions"
  actions.append(
    createIconButton("edit", habit.id, `Edit ${habit.name}`, "✏️"),
    createIconButton("delete", habit.id, `Delete ${habit.name}`, "🗑️"),
  )

  top.append(completeButton, icon, info, actions)
  card.append(top)

  if (habit.description) {
    const description = document.createElement("p")
    description.className = "habit-card__description"
    description.textContent = habit.description
    card.append(description)
  }

  if (habit.checklists.length > 0) {
    card.append(createChecklistList(habit))
  }

  return card
}

function renderHabits(): void {
  const list = document.getElementById("habits-list")
  if (!list) return

  list.replaceChildren()

  if (habits.length === 0) {
    const emptyState = document.createElement("div")
    emptyState.className = "habits-empty"

    const title = document.createElement("p")
    title.className = "habits-empty__title"
    title.textContent = "No habits yet. Create your first daily routine."

    const detail = document.createElement("p")
    detail.className = "habits-empty__detail"
    detail.textContent =
      "Habits create real tasks that surface in Today, Kanban, Table, and Upcoming."

    const button = document.createElement("button")
    button.type = "button"
    button.className = "btn btn-primary"
    button.dataset.openHabitModal = "true"
    button.textContent = "Create Habit"

    emptyState.append(title, detail, button)
    list.append(emptyState)
    return
  }

  habits.forEach((habit) => {
    list.append(createHabitCard(habit))
  })
}

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

  renderHabits()
  updateStats()
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

function createChecklistBuilderItem(text = ""): HTMLDivElement {
  const row = document.createElement("div")
  row.className = "checklist-builder__item"

  const input = document.createElement("input")
  input.type = "text"
  input.className = "checklist-text"
  input.placeholder = "Checklist item"
  input.value = text

  const removeButton = document.createElement("button")
  removeButton.type = "button"
  removeButton.className = "btn-remove"
  removeButton.setAttribute("aria-label", "Remove item")
  removeButton.textContent = "×"

  pageLifecycle.on(removeButton, "click", () => {
    row.remove()
  })

  row.append(input, removeButton)
  return row
}

function initHabitsShell(): void {
  initSectionLinks()
  initIntersectionTracking()
  initGoToTop()
  initTabsKeyboard()
  initUnifiedBarTitleSwitcher({
    barId: HABITS_BAR_ID,
    onSelect: (sectionId) => {
      scrollToHabitsAnchor(sectionId)
    },
  })
  initUnifiedBarSearchLauncher(HABITS_BAR_ID)
  initUnifiedBarTabOverflow(HABITS_BAR_ID)

  pageLifecycle.on(window, "hashchange", () => {
    syncHabitsSectionFromHash()
  })

  syncHabitsSectionFromHash()

  const hash = window.location.hash.replace("#", "")
  if (!hash) return

  requestAnimationFrame(() => {
    scrollToHabitsAnchor(hash, "auto")
  })
}

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
    checklistContainer.replaceChildren()
  }

  function addChecklistItem(text = ""): void {
    const row = createChecklistBuilderItem(text)
    checklistContainer.append(row)

    if (!text) {
      const input = row.querySelector<HTMLInputElement>(".checklist-text")
      input?.focus()
    }
  }

  function openCreateModal(): void {
    editIdInput.value = ""
    modalTitle.textContent = "New Habit"
    nameInput.value = ""
    iconInput.value = "✅"
    cadenceSelect.value = "daily"
    prioritySelect.value = "3"
    descInput.value = ""
    resetChecklistBuilder()
    overlay.classList.remove("hidden")
    nameInput.focus()
  }

  function openEditModal(habitId: string): void {
    const habit = habits.find((candidate) => candidate.id === habitId)
    if (!habit) return

    editIdInput.value = habit.id
    modalTitle.textContent = "Edit Habit"
    nameInput.value = habit.name
    iconInput.value = habit.icon
    cadenceSelect.value = habit.cadence
    prioritySelect.value = String(habit.priority)
    descInput.value = habit.description

    resetChecklistBuilder()
    habit.checklists.forEach((item) => addChecklistItem(item.text))

    overlay.classList.remove("hidden")
    nameInput.focus()
  }

  function closeModal(): void {
    overlay.classList.add("hidden")
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
    if (keyboardEvent.key === "Escape" && !overlay.classList.contains("hidden")) {
      keyboardEvent.preventDefault()
      closeModal()
    }
  })

  pageLifecycle.on(form, "submit", async (event) => {
    event.preventDefault()

    const name = nameInput.value.trim()
    if (!name) {
      showToast("Habit name is required", "warning")
      return
    }

    const checklists = Array.from(
      checklistContainer.querySelectorAll<HTMLInputElement>(".checklist-text"),
    )
      .map((input) => input.value.trim())
      .filter(Boolean)
      .map((text) => ({ text, done: false }))

    const editId = editIdInput.value

    try {
      if (editId) {
        const templateJson: Record<string, unknown> = {
          title: name,
          description: descInput.value.trim(),
          priority: Number(prioritySelect.value),
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
            icon: iconInput.value.trim() || "✅",
            cadence: cadenceSelect.value,
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
            icon: iconInput.value.trim() || "✅",
            cadence: cadenceSelect.value,
            priority: Number(prioritySelect.value),
            description: descInput.value.trim(),
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

function bootHabitsPage(): void {
  const shell = document.getElementById("habits-shell")
  if (!shell || shell.dataset.habitsBooted === "true") return

  shell.dataset.habitsBooted = "true"
  habits = parseBootstrapHabits()

  initHabitsShell()
  initHabitsCrud()
  updateStats()
}

bootHabitsPage()

pageLifecycle.onPageLoad(() => {
  bootHabitsPage()
})
