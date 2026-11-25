/**
 * habits-card-renderer.ts — Routine card DOM builder, formatters, and stats
 *
 * @domain tasks
 * @kcs Extracted from habits-controller.ts for decomposition.
 *      Pure rendering functions — no side effects, no fetch calls.
 *      Takes routine data array and renders Tabler cards + updates stat elements.
 */

import { pageLifecycle } from "@lib/page-lifecycle"
import { formatCalendarDay } from "@lib/calendar-day"
import { mapEntityEmojiToTabler } from "@lib/tabler-svg"
import { taskDetailPath } from "@lib/task-page-url"
import { cadenceToRRule, describeRule, parseRRule } from "@domains/tasks/recurrence"
import { createSpriteIconElement, type IconName } from "../../generated/icon-registry"

export interface HabitChecklistItem {
  text: string
  done: boolean
}

export interface HabitData {
  areaId?: string | undefined
  projectId?: string | undefined
  id: string
  name: string
  icon: string
  cadence: string
  todayCompleted: boolean
  todayTaskId: string | null
  lastCompletedDate: string | null
  currentStreak: number
  longestStreak: number
  totalCompletions: number
  projectActive: boolean
  description: string
  priority: number
  checklists: HabitChecklistItem[]
}

function formatCadence(cadence: string): string {
  return describeRule(cadence) || "Daily"
}

function streakUnit(cadence: string): string {
  const parsed = parseRRule(cadenceToRRule(cadence) ?? cadence)
  if (parsed?.freq === "WEEKLY") return "week"
  if (parsed?.freq === "MONTHLY") return "month"
  if (parsed?.freq === "YEARLY") return "year"
  return "day"
}

function formatLastCompletedDate(value: string | null): string {
  const i18n = window.mI18n
  if (!value) return i18n?.get("habits.never_completed") ?? "Never completed"
  const date = formatCalendarDay(value, document.documentElement.lang === "ga" ? "ga" : undefined) ?? value
  return (i18n?.get("habits.last_done") ?? "Last done {date}").replace("{date}", () => date)
}

function priorityLabel(priority: number): string {
  switch (priority) {
    case 1: return "P1"
    case 2: return "P2"
    case 4: return "P4"
    case 5: return "P5"
    default: return "P3"
  }
}

function createMetaItem(text: string, className?: string): HTMLSpanElement {
  const item = document.createElement("span")
  item.className = className ? `badge habit-card__meta-item ${className}` : "badge habit-card__meta-item"
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
  button.replaceChildren(createSpriteIconElement(iconName, { size: 16 }))
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
      marker.replaceChildren(createSpriteIconElement("check", { size: 14 }))
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
  card.className = `card habit-card${habit.todayCompleted ? " completed" : ""}`
  card.dataset.habitId = habit.id

  const top = document.createElement("div")
  top.className = "habit-card__top"

  const completeButton = document.createElement("button")
  completeButton.type = "button"
  completeButton.className = "habit-card__check"
  completeButton.disabled =
    document.getElementById("habits-shell")?.dataset.canComplete === "false" ||
    habit.todayCompleted ||
    !habit.projectActive
  completeButton.dataset.action = "complete"
  completeButton.dataset.id = habit.id
  completeButton.setAttribute("aria-pressed", habit.todayCompleted ? "true" : "false")
  completeButton.setAttribute(
    "aria-label",
    habit.todayCompleted ? `${habit.name} completed for this period` : `Complete ${habit.name}`,
  )
  if (habit.todayCompleted) {
    completeButton.replaceChildren(createSpriteIconElement("check", { size: 16 }))
  }

  const icon = document.createElement("span")
  icon.className = "habit-card__icon"
  icon.setAttribute("aria-hidden", "true")
  const mappedIcon = mapEntityEmojiToTabler(habit.icon)
  if (mappedIcon) icon.replaceChildren(createSpriteIconElement(mappedIcon, { size: 18 }))
  else icon.textContent = habit.icon || ""

  const info = document.createElement("div")
  info.className = "habit-card__info"

  const name = document.createElement("div")
  name.className = "habit-card__name"
  name.textContent = habit.name

  const meta = document.createElement("div")
  meta.className = "habit-card__meta"

  const cadenceBadge = document.createElement("span")
  cadenceBadge.className = "badge habit-card__meta-item habit-card__cadence"
  cadenceBadge.replaceChildren(
    createSpriteIconElement("repeat", { size: 12 }),
    document.createTextNode(formatCadence(habit.cadence)),
  )

  meta.append(
    cadenceBadge,
    createMetaItem(priorityLabel(habit.priority)),
    createMetaItem(`${habit.totalCompletions} total`),
    createMetaItem(formatLastCompletedDate(habit.lastCompletedDate)),
  )

  if (habit.currentStreak > 0) {
    const streakItem = document.createElement("span")
    streakItem.className = "badge habit-card__meta-item habit-card__streak"
    streakItem.replaceChildren(
      createSpriteIconElement("flame", { size: 13 }),
      document.createTextNode(`${habit.currentStreak} ${streakUnit(habit.cadence)} streak`),
    )
    meta.prepend(streakItem)
  }

  if (!habit.projectActive) {
    meta.append(createMetaItem("Paused project", "habit-card__inactive"))
  }

  if (habit.todayTaskId) {
    const taskLink = document.createElement("a")
    taskLink.className = "badge habit-card__meta-item habit-card__task-link"
    taskLink.href = taskDetailPath(habit.todayTaskId)
    taskLink.replaceChildren(
      createSpriteIconElement("external-link", { size: 12 }),
      document.createTextNode("View task"),
    )
    meta.append(taskLink)
  }

  if (habit.checklists.length > 0) {
    meta.append(
      createMetaItem(`${habit.checklists.length} checklist item${habit.checklists.length === 1 ? "" : "s"}`),
    )
  }

  info.append(name, meta)

  const actions = document.createElement("div")
  actions.className = "habit-card__actions"
  const edit = createIconButton("edit", habit.id, `Edit ${habit.name}`, "pencil")
  const remove = createIconButton("delete", habit.id, `Delete ${habit.name}`, "trash")
  edit.disabled = document.getElementById("habits-shell")?.dataset.canEdit === "false"
  remove.disabled = document.getElementById("habits-shell")?.dataset.canDelete === "false"
  actions.append(edit, remove)

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
 * Render routines list into the DOM.
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
    title.textContent = "No routines yet"
    const detail = document.createElement("p")
    detail.className = "habits-empty__detail"
    detail.textContent = "Create a routine with any daily, weekly, monthly, or custom schedule and Meitheal will add each occurrence to your task list automatically."
    emptyState.append(title, detail)
    list.append(emptyState)
    return
  }

  habits.forEach((habit) => {
    list.append(createHabitCard(habit))
  })
}

/**
 * Update the stats panel with current routine data.
 */
export function updateStats(habits: HabitData[]): void {
  const activeCount = habits.length
  const completedToday = habits.filter((habit) => habit.todayCompleted).length
  const bestStreak = Math.max(0, ...habits.map((habit) => habit.longestStreak))
  const totalCompletions = habits.reduce(
    (sum, habit) => sum + habit.totalCompletions,
    0,
  )

  let daily = 0
  let weekly = 0
  let monthly = 0
  let yearly = 0
  for (const habit of habits) {
    const parsed = parseRRule(cadenceToRRule(habit.cadence) ?? habit.cadence)
    switch (parsed?.freq) {
      case "WEEKLY": weekly++; break
      case "MONTHLY": monthly++; break
      case "YEARLY": yearly++; break
      default: daily++; break
    }
  }
  const parts: string[] = []
  if (daily > 0) parts.push(`${daily} daily`)
  if (weekly > 0) parts.push(`${weekly} weekly`)
  if (monthly > 0) parts.push(`${monthly} monthly`)
  if (yearly > 0) parts.push(`${yearly} yearly`)

  const statActive = document.getElementById("stat-active")
  const statCompletedToday = document.getElementById("stat-completed-today")
  const statLongestStreak = document.getElementById("stat-longest-streak")
  const statTotal = document.getElementById("stat-total")
  const cadenceSummary = document.getElementById("habits-cadence-summary")
  const libraryCount = document.getElementById("habits-library-count")

  if (statActive) statActive.textContent = String(activeCount)
  if (statCompletedToday) statCompletedToday.textContent = String(completedToday)
  if (statLongestStreak) statLongestStreak.textContent = String(bestStreak)
  if (statTotal) statTotal.textContent = String(totalCompletions)

  if (cadenceSummary) {
    cadenceSummary.textContent =
      activeCount === 0
        ? "Create your first routine to automatically schedule repeating tasks."
        : `${parts.join(" · ")} routine${activeCount === 1 ? "" : "s"}`
  }

  if (libraryCount) {
    libraryCount.hidden = activeCount === 0
    libraryCount.textContent = `${activeCount} active routine${activeCount === 1 ? "" : "s"}`
  }
}

/**
 * Create a checklist builder item for the routine modal form.
 */
export function createChecklistBuilderItem(text = ""): HTMLDivElement {
  const row = document.createElement("div")
  row.className = "checklist-builder__item"

  const input = document.createElement("input")
  input.type = "text"
  input.className = "form-control checklist-text"
  input.placeholder = "Checklist item"
  input.value = text

  const removeButton = document.createElement("button")
  removeButton.type = "button"
  removeButton.className = "btn-remove"
  removeButton.setAttribute("aria-label", "Remove item")
  removeButton.replaceChildren(createSpriteIconElement("x", { size: 14 }))

  pageLifecycle.on(removeButton, "click", () => {
    row.remove()
  })

  row.append(input, removeButton)
  return row
}
