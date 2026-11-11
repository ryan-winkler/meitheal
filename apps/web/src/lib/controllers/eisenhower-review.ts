/**
 * Eisenhower Weekly Review Flow
 *
 * @domain tasks
 * @bounded-context tasks (presentation)
 *
 * Overlay wizard that reviews tasks in Q4→Q3→Q2 order,
 * allowing promote/archive/delete actions on each.
 */

import { STATUS } from "@lib/status-config"
import { taskApi } from "@lib/task-api-client"
import { showToast } from "@lib/toast"
import { getExistingFrameworkPayload } from "./eisenhower-triage"

// ── Types ─────────────────────────────────────────────────────────────────

interface QuadrantUpdate {
  urgency: number
  importance: number
  eisenhower_override: boolean
}

interface ReviewTask {
  id: string
  title: string
  source: string // quadrant name: "not-now" | "delegate" | "schedule"
  sourceLabel: string // human-readable: "Not Now" | "Delegate" | "Schedule"
}

// ── Constants ─────────────────────────────────────────────────────────────

const QUADRANT_MAP: Record<string, QuadrantUpdate> = {
  "do-first": { urgency: 5, importance: 5, eisenhower_override: true },
  schedule:   { urgency: 1, importance: 5, eisenhower_override: true },
  delegate:   { urgency: 5, importance: 1, eisenhower_override: true },
  "not-now":  { urgency: 1, importance: 1, eisenhower_override: true },
}

const REVIEW_QUADRANT_ORDER = ["not-now", "delegate", "schedule"]
const QUADRANT_LABELS: Record<string, string> = {
  "not-now": "📦 Not Now (Q4)",
  delegate: "👥 Delegate (Q3)",
  schedule: "📅 Schedule (Q2)",
}

// ── State ─────────────────────────────────────────────────────────────────

let reviewTasks: ReviewTask[] = []
let reviewIndex = 0
let reviewStats = { promoted: 0, archived: 0, deleted: 0, skipped: 0 }

// ── Public API ────────────────────────────────────────────────────────────

export async function startReview(): Promise<void> {
  const page = document.getElementById("eisenhower-shell")
  if (!page) return

  reviewTasks = []
  reviewIndex = 0
  reviewStats = { promoted: 0, archived: 0, deleted: 0, skipped: 0 }

  // Collect tasks in quadrant order: Q4 → Q3 → Q2
  for (const qId of REVIEW_QUADRANT_ORDER) {
    const zone = page.querySelector<HTMLElement>(`[data-drop-zone="${qId}"]`)
    if (!zone) continue

    const items = zone.querySelectorAll<HTMLElement>(".tli")
    for (const item of items) {
      const id = item.dataset.id ?? item.querySelector<HTMLElement>("[data-id]")?.dataset.id
      const title = item.querySelector(".tli__title")?.textContent?.trim() ?? "Untitled"
      if (id) {
        reviewTasks.push({ id, title, source: qId, sourceLabel: QUADRANT_LABELS[qId] ?? qId })
      }
    }
  }

  if (reviewTasks.length === 0) {
    showToast("No tasks to review", "success")
    return
  }

  const overlay = document.getElementById("review-overlay")
  overlay?.classList.remove("triage-overlay--hidden")
  showReviewTask()
}

export function closeReview(): void {
  const overlay = document.getElementById("review-overlay")
  overlay?.classList.add("triage-overlay--hidden")
}

export function reviewNext(): void {
  reviewStats.skipped++
  reviewAdvance()
}

export async function reviewAction(action: "promote" | "archive" | "delete"): Promise<void> {
  const task = reviewTasks[reviewIndex]
  if (!task) return

  try {
    switch (action) {
      case "promote": {
        const promotionMap: Record<string, QuadrantUpdate | undefined> = {
          "not-now": QUADRANT_MAP["delegate"],
          delegate: QUADRANT_MAP["schedule"],
          schedule: QUADRANT_MAP["do-first"],
        }
        const update = promotionMap[task.source]
        if (update) {
          await taskApi.updateTask(task.id, { ...update })
        }
        reviewStats.promoted++
        break
      }
      case "archive": {
        await taskApi.updateTask(task.id, { status: STATUS.COMPLETE })
        reviewStats.archived++
        break
      }
      case "delete": {
        await taskApi.deleteTask(task.id)
        reviewStats.deleted++
        break
      }
    }

    // Track last_reviewed in framework_payload
    const existingFP = await getExistingFrameworkPayload(task.id)
    existingFP.last_reviewed = new Date().toISOString()
    try {
      await taskApi.updateTask(task.id, { framework_payload: JSON.stringify(existingFP) })
    } catch {
      // Non-critical — don't block on metadata save failure
    }

    reviewAdvance()
  } catch {
    showToast("common.failed_update", "error")
  }
}

export function setupReviewListeners(signal: AbortSignal): void {
  // Close on overlay backdrop click
  document.getElementById("review-overlay")?.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).classList.contains("review-overlay")) {
      closeReview()
    }
  }, { signal })

  // Close on Escape key (when review is open)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("review-overlay")?.classList.contains("triage-overlay--hidden")) {
      closeReview()
    }
  }, { signal })
}

// ── Internal helpers ──────────────────────────────────────────────────────

function reviewAdvance(): void {
  reviewIndex++
  showReviewTask()
}

function showReviewTask(): void {
  const task = reviewTasks[reviewIndex]
  if (!task) {
    finishReview()
    return
  }

  const nameEl = document.getElementById("review-task-name")
  if (nameEl) nameEl.textContent = task.title

  const sourceEl = document.getElementById("review-source")
  if (sourceEl) {
    sourceEl.textContent = ""
    const badge = document.createElement("span")
    badge.className = "review-source__badge"
    badge.textContent = task.sourceLabel
    sourceEl.appendChild(badge)
  }

  const progressEl = document.getElementById("review-progress")
  if (progressEl) progressEl.textContent = `${reviewIndex + 1} / ${reviewTasks.length}`
}

function finishReview(): void {
  closeReview()
  const parts: string[] = []
  if (reviewStats.promoted > 0) parts.push(`⬆️ ${reviewStats.promoted} promoted`)
  if (reviewStats.archived > 0) parts.push(`📥 ${reviewStats.archived} archived`)
  if (reviewStats.deleted > 0) parts.push(`🗑️ ${reviewStats.deleted} deleted`)
  if (reviewStats.skipped > 0) parts.push(`→ ${reviewStats.skipped} skipped`)
  const summary = parts.length > 0 ? parts.join(", ") : "No changes made"
  showToast(`Review complete: ${summary}`, "success")
  // Reload to show updated state
  setTimeout(() => window.location.reload(), 1200)
}
