/**
 * Today Supplemental Modules — G27, G29, G35, G40-G42
 *
 * @domain tasks
 * @bounded-context tasks (presentation)
 *
 * Contains smaller Today page features:
 * - Migration prompt (G27) — morning triage banner for carried-forward tasks
 * - Context grouping (G29) — @-prefix label grouping
 * - Effort indicators (G35) — visual effort chips
 * - Recurrence management (G40-G42) — post-complete and cancel actions
 */

import type { ListenerManager } from "../managed-listeners"
import { showToast } from "../toast"
import { confirmDialog } from "../confirm-dialog"

// ── G27: Daily Migration Prompt ───────────────────────────────────────────

export function setupMigrationPrompt(container: HTMLElement): void {
  const promptEl = container.querySelector<HTMLElement>("#migration-prompt")
  if (!promptEl) return

  const hour = new Date().getHours()
  // Show only in morning (before noon) when there are carried-forward tasks
  if (hour >= 12) return

  // Check if already dismissed today
  const MIGRATION_PROMPT_KEY = "meitheal-migration-dismissed"
  const dismissed = localStorage.getItem(MIGRATION_PROMPT_KEY)
  const todayStr = new Date().toISOString().split("T")[0]!
  if (dismissed === todayStr) return

  const carriedSection = container.querySelector("#section-carried")
  if (!carriedSection) return

  const carriedCount = carriedSection.querySelectorAll(".tli").length
  if (carriedCount === 0) return

  promptEl.style.display = ""
  promptEl.innerHTML = `
    <div class="migration-banner">
      <span class="migration-banner__text">
        ☀️ Good morning! You have <strong>${carriedCount}</strong> carried forward task${carriedCount === 1 ? "" : "s"}.
        Triage them to keep your day focused.
      </span>
      <button type="button" class="btn btn-sm btn-primary migration-banner__action" id="migration-triage-btn">
        Triage Now
      </button>
      <button type="button" class="btn btn-sm migration-banner__action" id="migration-dismiss-btn">
        Dismiss
      </button>
    </div>
  `

  promptEl.querySelector("#migration-dismiss-btn")?.addEventListener("click", () => {
    localStorage.setItem(MIGRATION_PROMPT_KEY, todayStr)
    promptEl.style.display = "none"
  })

  promptEl.querySelector("#migration-triage-btn")?.addEventListener("click", () => {
    localStorage.setItem(MIGRATION_PROMPT_KEY, todayStr)
    promptEl.style.display = "none"
    if (carriedSection.classList.contains("today-section--collapsed")) {
      const toggle = carriedSection.querySelector(".today-section__toggle") as HTMLElement | null
      toggle?.click()
    }
    carriedSection.scrollIntoView({ behavior: "smooth", block: "start" })
  })
}

// ── G29: Context Grouping ─────────────────────────────────────────────────

export function setupContextGrouping(container: HTMLElement): void {
  const todaySection = container.querySelector("#section-today .today-section__list")
  if (!todaySection) return

  const tasks = todaySection.querySelectorAll<HTMLElement>(".tli")
  if (tasks.length === 0) return

  // Group tasks by @-prefix labels
  const groups = new Map<string, HTMLElement[]>()
  const ungrouped: HTMLElement[] = []

  tasks.forEach(task => {
    const labels = task.dataset.labels ?? ""
    const contextMatch = labels.match(/@(\w+)/)
    if (contextMatch) {
      const ctx = contextMatch[1]!
      if (!groups.has(ctx)) groups.set(ctx, [])
      groups.get(ctx)!.push(task)
    } else {
      ungrouped.push(task)
    }
  })

  // Only apply grouping if there are at least 2 different contexts
  if (groups.size < 2) return

  const contextIcons: Record<string, string> = {
    home: "🏠",
    work: "💼",
    errands: "🏃",
    personal: "👤",
    health: "💪",
  }

  // Rebuild the list with context headers
  todaySection.replaceChildren()

  for (const [ctx, ctxTasks] of groups) {
    const icon = contextIcons[ctx.toLowerCase()] ?? "📌"
    const header = document.createElement("div")
    header.className = "context-group-header"
    header.textContent = `${icon} @${ctx} (${ctxTasks.length})`
    todaySection.appendChild(header)
    ctxTasks.forEach(t => todaySection.appendChild(t))
  }

  if (ungrouped.length > 0) {
    const header = document.createElement("div")
    header.className = "context-group-header"
    header.textContent = `📌 Other (${ungrouped.length})`
    todaySection.appendChild(header)
    ungrouped.forEach(t => todaySection.appendChild(t))
  }
}

// ── G35: Effort Indicators ────────────────────────────────────────────────

export function renderEffortIndicators(container: HTMLElement): void {
  container.querySelectorAll<HTMLElement>(".tli").forEach(el => {
    const priority = parseInt(el.dataset.priority ?? "3", 10)
    const existing = el.querySelector(".tli__effort")
    if (existing) return

    let label: string
    let emoji: string
    let color: string

    if (priority <= 2) {
      label = "Deep"
      emoji = "🔴"
      color = "rgba(239, 68, 68, 0.15)"
    } else if (priority === 3) {
      label = "Regular"
      emoji = "🟡"
      color = "rgba(245, 158, 11, 0.15)"
    } else {
      label = "Quick"
      emoji = "🟢"
      color = "rgba(34, 197, 94, 0.15)"
    }

    const chip = document.createElement("span")
    chip.className = "tli__effort"
    chip.title = `Effort: ${label}`
    chip.style.cssText = `
      font-size: 10px; padding: 1px 6px; border-radius: 8px;
      background: ${color}; color: var(--text-secondary); display: inline-flex; align-items: center;
      gap: 2px; white-space: nowrap; margin-left: 4px;
    `
    chip.textContent = `${emoji} ${label}`

    const metaRow = el.querySelector(".tli__meta")
    if (metaRow) {
      metaRow.appendChild(chip)
    }
  })
}

// ── G40-G42: Recurrence Management ────────────────────────────────────────

export async function handleRecurrencePostComplete(
  taskId: string,
  lm: ListenerManager,
): Promise<void> {
  try {
    const res = await fetch(`/api/tasks/${taskId}`, { signal: lm.signal })
    if (!res.ok) return
    const data = await res.json() as { task?: { recurrence_rule?: string; title?: string } }
    const task = data.task
    if (!task?.recurrence_rule) return

    showToast(`Recurring task completed — next occurrence created`, "success")
  } catch { /* non-critical */ }
}

export async function cancelRecurrence(
  taskId: string,
  lm: ListenerManager,
): Promise<void> {
  const confirmed = await confirmDialog({
    title: "Cancel Recurrence",
    message: "This will cancel all future occurrences of this recurring task. Continue?",
  })
  if (!confirmed) return

  try {
    const res = await fetch(`/api/tasks/${taskId}`, { signal: lm.signal,
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recurrence_rule: null }),
    })
    if (!res.ok) throw new Error("Failed")

    showToast("Recurrence cancelled — future occurrences removed", "success")
  } catch {
    showToast("Failed to cancel recurrence", "error")
  }
}
