import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TaskRepository } from "@domains/tasks/persistence/task-repository"
import { normalizeStatus } from "@lib/status-config"
import { apiProblem } from "../../../lib/api-response"

/**
 * iCal Export — VCALENDAR with VTODO entries
 *
 * GET /api/export/tasks.ics
 *
 * Returns all non-complete tasks as iCal VTODO items.
 * Compatible with Apple Calendar, Google Calendar, Thunderbird, etc.
 *
 * @domain tasks
 * @bounded-context tasks
 *
 * @kcs RFC 5545 VTODO format. Uses PRIORITY mapping:
 * Meitheal P1 (urgent) → iCal 1 (highest)
 * Meitheal P5 (minimal) → iCal 9 (lowest)
 */

export const GET: APIRoute = async ({ locals }) => {
    if (!locals.hassIsAdmin && !locals.agentToken?.scopes.includes("settings:write")) {
        return apiProblem({ status: 403, title: "Admin Required", detail: "Task export requires admin access or settings:write scope" })
    }
  try {
    await ensureSchema()
    const repo = new TaskRepository(getPersistenceClient())

    const { tasks } = await repo.findAll({
      limit: 500,
      sort: "due_date",
      order: "ASC",
    })

    const lines: string[] = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Meitheal//Task Manager//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:Meitheal Tasks",
    ]

    for (const task of tasks) {
      const t = task as Record<string, unknown>
      const id = String(t.id ?? "")
      const title = escapeIcal(String(t.title ?? "Untitled"))
      const description = t.description ? escapeIcal(String(t.description)) : ""
      const status = String(t.status ?? "pending")
      const priority = Number(t.priority ?? 3)
      const createdAt = Number(t.created_at ?? Date.now())
      const updatedAt = Number(t.updated_at ?? Date.now())

      lines.push("BEGIN:VTODO")
      lines.push(`UID:${id}@meitheal`)
      lines.push(`DTSTAMP:${toIcalDate(updatedAt)}`)
      lines.push(`CREATED:${toIcalDate(createdAt)}`)
      lines.push(`LAST-MODIFIED:${toIcalDate(updatedAt)}`)
      lines.push(`SUMMARY:${title}`)

      if (description) {
        lines.push(`DESCRIPTION:${description}`)
      }

      if (t.due_date && typeof t.due_date === "string") {
        lines.push(`DUE;VALUE=DATE:${t.due_date.replace(/-/g, "")}`)
      }

      // iCal priority: 1-4 = high, 5 = medium, 6-9 = low
      const icalPriority = mapPriority(priority)
      lines.push(`PRIORITY:${icalPriority}`)

      // Status mapping — normalize legacy values first, then map to iCal
      const icalStatus = mapStatus(normalizeStatus(status))
      lines.push(`STATUS:${icalStatus}`)

      // Percent complete based on task progress
      const progress = Number(t.progress ?? 0)
      if (progress > 0) {
        lines.push(`PERCENT-COMPLETE:${progress}`)
      }

      // Labels as CATEGORIES
      if (t.labels && typeof t.labels === "string") {
        try {
          const labels = JSON.parse(t.labels)
          if (Array.isArray(labels) && labels.length > 0) {
            lines.push(`CATEGORIES:${labels.join(",")}`)
          }
        } catch { /* invalid labels */ }
      }

      lines.push("END:VTODO")
    }

    lines.push("END:VCALENDAR")

    return new Response(lines.join("\r\n"), {
      status: 200,
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": "attachment; filename=\"meitheal-tasks.ics\"",
        "x-content-type-options": "nosniff",
      },
    })
  } catch {
    return new Response("Failed to generate iCal export", { status: 500 })
  }
}

function escapeIcal(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n")
}

function toIcalDate(timestamp: number): string {
  const d = new Date(timestamp)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  const day = String(d.getUTCDate()).padStart(2, "0")
  const h = String(d.getUTCHours()).padStart(2, "0")
  const min = String(d.getUTCMinutes()).padStart(2, "0")
  const s = String(d.getUTCSeconds()).padStart(2, "0")
  return `${y}${m}${day}T${h}${min}${s}Z`
}

function mapPriority(p: number): number {
  // Meitheal 1-5 → iCal 1-9
  switch (p) {
    case 1: return 1  // Urgent → Highest
    case 2: return 3  // High
    case 3: return 5  // Medium
    case 4: return 7  // Low
    case 5: return 9  // Minimal → Lowest
    default: return 5
  }
}

function mapStatus(s: string): string {
  // Expects canonical statuses (backlog, pending, active, complete)
  // Legacy values are normalized upstream via normalizeStatus()
  switch (s) {
    case "complete":
      return "COMPLETED"
    case "active":
      return "IN-PROCESS"
    case "backlog":
    case "pending":
    default:
      return "NEEDS-ACTION"
  }
}
