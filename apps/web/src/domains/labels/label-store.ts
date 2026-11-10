import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { stripHtml } from "../../lib/strip-html"

export interface Label {
  id: number
  title: string
  hexColor: string
}

function readLabel(row: Record<string, unknown>): Label {
  const color = String(row.hex_color)
  return {
    id: Number(row.id),
    title: String(row.title),
    hexColor: color.startsWith("#") ? color : `#${color}`,
  }
}

export async function listLabels(): Promise<Label[]> {
  await ensureSchema()
  const rows = await getPersistenceClient().execute(
    "SELECT id, title, hex_color FROM vikunja_labels ORDER BY id",
  )
  return rows.rows.map(readLabel)
}

/** Return an existing label when the title differs only by case. */
export async function createLabel(title: string, hexColor?: string): Promise<Label> {
  const sanitized = stripHtml(title.trim()).slice(0, 100)
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
  const client = getPersistenceClient()

  const existing = await client.execute({
    sql: "SELECT id, title, hex_color FROM vikunja_labels WHERE id = ? LIMIT 1",
    args: [id],
  })

  if (existing.rows.length === 0) return null

  const row = existing.rows[0] as Record<string, unknown>
  const newTitle = updates.title
    ? stripHtml(updates.title.trim()).slice(0, 100)
    : String(row.title)
  const newColor = updates.hexColor
    ? updates.hexColor.replace(/^#/, "")
    : String(row.hex_color)

  if (!newTitle) return null

  await client.execute({
    sql: "UPDATE vikunja_labels SET title = ?, hex_color = ? WHERE id = ?",
    args: [newTitle, newColor, id],
  })

  return {
    id: Number(row.id),
    title: newTitle,
    hexColor: newColor.startsWith("#") ? newColor : `#${newColor}`,
  }
}

/**
 * Delete a label by ID.
 * Also removes it from the vikunja_task_labels junction table.
 * Returns true if label existed and was deleted.
 */
export async function deleteLabel(id: number): Promise<boolean> {
  await ensureSchema()
  const client = getPersistenceClient()

  const existing = await client.execute({
    sql: "SELECT id, title FROM vikunja_labels WHERE id = ? LIMIT 1",
    args: [id],
  })

  if (existing.rows.length === 0) return false

  // Remove from junction table
  await client.execute({
    sql: "DELETE FROM vikunja_task_labels WHERE label_id = ?",
    args: [id],
  })

  // Remove the label itself
  await client.execute({
    sql: "DELETE FROM vikunja_labels WHERE id = ?",
    args: [id],
  })

  return true
}

/**
 * Get the label color map: label title (lowercase) → hex color.
 * Used by label-color-resolver for rendering.
 */
export async function getLabelColorMap(): Promise<Map<string, string>> {
  const labels = await listLabels()
  const map = new Map<string, string>()
  for (const label of labels) {
    map.set(label.title.toLowerCase(), label.hexColor)
  }
  return map
}
