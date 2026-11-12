import type { InStatement } from "@libsql/client"
import { ensureSchema, getPersistenceClient } from "@domains/tasks"
import { stripHtml } from "../../lib/strip-html"
import { LabelMutationRepository } from "./label-mutation"
import { resetColorCache } from "./label-color-resolver"
import { isWellFormedLabelName, labelNameKey } from "./label-name"

export interface Label {
  id: number
  title: string
  hexColor: string
}

function readLabel(row: Record<string, unknown>): Label {
  const color = String(row.hex_color).replace(/^#/, "")
  return {
    id: Number(row.id),
    title: String(row.title),
    hexColor: /^[a-f0-9]{6}$/i.test(color) ? `#${color}` : "#6b7280",
  }
}

export async function listLabels(): Promise<Label[]> {
  await ensureSchema()
  const rows = await getPersistenceClient().execute(
    "SELECT id, title, hex_color FROM vikunja_labels ORDER BY id",
  )
  return rows.rows.map(readLabel)
}

export function normalizeLabelTitle(title: string): string {
  const normalized = stripHtml(title).trim().slice(0, 100)
  return isWellFormedLabelName(normalized) ? normalized : ""
}

/** Add an explicitly created label only if the task write in this batch won. */
export function taskLabelInsert(title: string, taskId: string, requestId: string): InStatement {
  return {
    sql: `INSERT INTO vikunja_labels (title, hex_color)
          SELECT ?, '6b7280'
          WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ? AND request_id = ?)
            AND NOT EXISTS (SELECT 1 FROM vikunja_labels WHERE lower(title) = lower(?))`,
    args: [title, taskId, requestId, title],
  }
}

/** Return an existing label when the title differs only by case. */
export async function createLabel(title: string, hexColor?: string): Promise<Label> {
  const sanitized = normalizeLabelTitle(title)
  if (!sanitized) {
    throw new Error("Label title is required")
  }

  const color = hexColor && /^#?[0-9a-fA-F]{6}$/.test(hexColor)
    ? hexColor.replace(/^#/, "")
    : "6b7280"

  await ensureSchema()
  const [, result] = await getPersistenceClient().batch([
    {
      sql: `INSERT INTO vikunja_labels (title, hex_color)
            SELECT ?, ? WHERE NOT EXISTS (
              SELECT 1 FROM vikunja_labels WHERE lower(title) = lower(?)
            )`,
      args: [sanitized, color, sanitized],
    },
    {
      sql: "SELECT id, title, hex_color FROM vikunja_labels WHERE lower(title) = lower(?) ORDER BY id LIMIT 1",
      args: [sanitized],
    },
  ], "write")
  const row = result?.rows[0]
  if (!row) {
    throw new Error("Label write did not return a row")
  }
  resetColorCache()
  return readLabel(row)
}

/**
 * Update a label's title and/or color.
 * Title is sanitized and length-capped at 100 characters.
 */
export async function updateLabel(
  id: number,
  updates: { title?: string; hexColor?: string }
): Promise<Label | null> {
  await ensureSchema()
  if (!Number.isSafeInteger(id) || id < 1) return null
  const title = updates.title === undefined ? undefined : normalizeLabelTitle(updates.title)
  if (title !== undefined && !title) return null
  if (updates.hexColor !== undefined && !/^#?[0-9a-fA-F]{6}$/.test(updates.hexColor)) return null
  const row = await new LabelMutationRepository(getPersistenceClient()).update(id, {
    ...(title === undefined ? {} : { title }),
    ...(updates.hexColor === undefined ? {} : { hexColor: updates.hexColor.replace(/^#/, "") }),
  })
  if (row) resetColorCache()
  return row ? readLabel(row) : null
}

/**
 * Delete a label by ID.
 * Removes persisted task, draft, template and junction references atomically.
 * Equivalent surviving definitions retain their shared name references.
 * Returns true if label existed and was deleted.
 */
export async function deleteLabel(id: number): Promise<boolean> {
  await ensureSchema()
  if (!Number.isSafeInteger(id) || id < 1) return false
  const deleted = await new LabelMutationRepository(getPersistenceClient()).delete(id)
  if (deleted) resetColorCache()
  return deleted
}

/**
 * Get the label color map: label title (lowercase) → hex color.
 * Used by label-color-resolver for rendering.
 */
export async function getLabelColorMap(): Promise<Map<string, string>> {
  const labels = await listLabels()
  const map = new Map<string, string>()
  for (const label of labels) {
    map.set(labelNameKey(label.title), label.hexColor)
  }
  return map
}
