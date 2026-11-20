import { boardOperationClient, ensureSchema, getPersistenceClient, type BoardScope } from "@domains/tasks"
import { stripHtml } from "../../lib/strip-html"
import { LabelMutationRepository } from "./label-mutation"
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

export async function listLabels(scope: BoardScope): Promise<Label[]> {
  await ensureSchema()
  const rows = await boardOperationClient(getPersistenceClient(), scope, { resource: "label", action: "read" }).execute(
    { sql: "SELECT id, title, hex_color FROM vikunja_labels WHERE board_id = ? ORDER BY id", args: [scope.boardId] },
  )
  return rows.rows.map(readLabel)
}

export function normalizeLabelTitle(title: string): string {
  const normalized = stripHtml(title).trim().slice(0, 100)
  return isWellFormedLabelName(normalized) ? normalized : ""
}

/** Return an existing label when the title differs only by case. */
export async function createLabel(scope: BoardScope, title: string, hexColor?: string): Promise<Label> {
  const sanitized = normalizeLabelTitle(title)
  if (!sanitized) {
    throw new Error("Label title is required")
  }

  const color = hexColor && /^#?[0-9a-fA-F]{6}$/.test(hexColor)
    ? hexColor.replace(/^#/, "")
    : "6b7280"

  await ensureSchema()
  const [, result] = await boardOperationClient(getPersistenceClient(), scope, { resource: "label", action: "create" }).batch([
    { sql: "INSERT INTO vikunja_labels (board_id, title, hex_color) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM vikunja_labels WHERE board_id = ? AND lower(title) = lower(?))", args: [scope.boardId, sanitized, color, scope.boardId, sanitized] },
    { sql: "SELECT id, title, hex_color FROM vikunja_labels WHERE board_id = ? AND lower(title) = lower(?) ORDER BY id LIMIT 1", args: [scope.boardId, sanitized] },
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
  scope: BoardScope,
  id: number,
  updates: { title?: string; hexColor?: string }
): Promise<Label | null> {
  await ensureSchema()
  if (!Number.isSafeInteger(id) || id < 1) return null
  const title = updates.title === undefined ? undefined : normalizeLabelTitle(updates.title)
  if (title !== undefined && !title) return null
  if (updates.hexColor !== undefined && !/^#?[0-9a-fA-F]{6}$/.test(updates.hexColor)) return null
  const row = await new LabelMutationRepository(getPersistenceClient(), scope).update(id, {
    ...(title === undefined ? {} : { title }),
    ...(updates.hexColor === undefined ? {} : { hexColor: updates.hexColor.replace(/^#/, "") }),
  })
  return row ? readLabel(row) : null
}

/**
 * Delete a label by ID.
 * Removes persisted task, draft, template and junction references atomically.
 * Equivalent surviving definitions retain their shared name references.
 * Returns true if label existed and was deleted.
 */
export async function deleteLabel(scope: BoardScope, id: number): Promise<boolean> {
  await ensureSchema()
  if (!Number.isSafeInteger(id) || id < 1) return false
  const deleted = await new LabelMutationRepository(getPersistenceClient(), scope).delete(id)
  return deleted
}

/**
 * Get the label color map: label title (lowercase) → hex color.
 * Used by label-color-resolver for rendering.
 */
export async function getLabelColorMap(scope: BoardScope): Promise<Map<string, string>> {
  const labels = await listLabels(scope)
  const map = new Map<string, string>()
  for (const label of labels) {
    map.set(labelNameKey(label.title), label.hexColor)
  }
  return map
}
