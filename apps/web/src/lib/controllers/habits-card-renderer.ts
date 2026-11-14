/**
 * habits-card-renderer.ts — Habit card DOM builder, formatters, and stats
 *
 * @domain tasks
 * @kcs Extracted from habits-controller.ts for decomposition.
 *      Pure rendering functions — no side effects, no fetch calls.
 *      Takes habit data array and renders cards + updates stat elements.
 */

import { pageLifecycle } from "@lib/page-lifecycle"
import { formatCalendarDay } from "@lib/calendar-day"
import { renderSpriteIconSvg, type IconName } from "../../generated/icon-registry"

export interface HabitChecklistItem {
  text: string
  done: boolean
}

export interface HabitData {
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

function formatCadence(cadence: HabitData["cadence"]): string {
  return cadence === "weekly" ? "Weekly" : "Daily"
}

function formatLastCompletedDate(value: string | null): string {
  const i18n = window.mI18n
  if (!value) return i18n?.get("habits.never_completed") ?? "Never completed"
  const date = formatCalendarDay(value, document.documentElement.lang === "ga" ? "ga" : undefined) ?? value
  return (i18n?.get("habits.last_done") ?? "Last done {date}").replace("{date}", () => date)
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
  iconName: IconName,
): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "btn-icon"
  button.dataset.action = action
  button.dataset.id = habitId
  button.setAttribute("aria-label", label)
  button.title = label
  button.innerHTML = renderSpriteIconSvg(iconName, { size: 16 })
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
    if (item.done) {
      marker.innerHTML = renderSpriteIconSvg("check", { size: 14 })
    } else {
      marker.textContent = "•"
    }

    const text = document.createElement("span")
    text.textContent = item.text

    entry.append(marker, text)
    list.append(entry)
  })

  return list
}

function createHabitCard(habit: HabitData): HTMLElement {
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
  if (habit.todayCompleted) {
    completeButton.innerHTML = renderSpriteIconSvg("check", { size: 16 })
  }

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
    const streakItem = document.createElement("span")
    streakItem.className = "habit-card__meta-item habit-card__streak"
    streakItem.style.display = "inline-flex"
    streakItem.style.alignItems = "center"
    streakItem.style.gap = "4px"
    streakItem.innerHTML = renderSpriteIconSvg("flame", { size: 14 })
    streakItem.append(document.createTextNode(`${habit.currentStreak} day streak`))
    meta.prepend(streakItem)
  }

  if (habit.checklists.length > 0) {
    meta.append(createMetaItem(`${habit.checklists.length} checklist items`))
  }

  info.append(name, meta)

  const actions = document.createElement("div")
  actions.className = "habit-card__actions"
  actions.append(
    createIconButton("edit", habit.id, `Edit ${habit.name}`, "pencil"),
    createIconButton("delete", habit.id, `Delete ${habit.name}`, "trash"),
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

/**
 * Render habits list into the DOM.
 */
export function renderHabits(habits: HabitData[]): void {
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

/**
 * Update the stats panel with current habit data.
 */
export function updateStats(habits: HabitData[]): void {
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

/**
 * Create a checklist builder item for the habit modal form.
 */
export function createChecklistBuilderItem(text = ""): HTMLDivElement {
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
  removeButton.innerHTML = renderSpriteIconSvg("x", { size: 14 })

  pageLifecycle.on(removeButton, "click", () => {
    row.remove()
  })

  row.append(input, removeButton)
  return row
}
