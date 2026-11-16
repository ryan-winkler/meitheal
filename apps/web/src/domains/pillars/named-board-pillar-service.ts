import { randomUUID } from "node:crypto"
import type { Transaction } from "@libsql/client"

export type BoardPillarChange =
  | { action: "pillar"; title: string; description: string; id?: string }
  | { action: "pillar-principle"; pillarId: string; title: string; nonNegotiable: boolean; id?: string }
  | { action: "pillar-link"; pillarId: string; entityType: "goal" | "routine" | "task"; id: string; enabled: boolean }

export async function readBoardPillars(tx: Transaction, boardId: string) {
  const [pillars, principles, links] = await tx.batch([
    {
      sql: "SELECT id, name, manifesto FROM pillars WHERE owner_board_id = ? AND is_active = 1 ORDER BY position, id",
      args: [boardId],
    },
    {
      sql: `SELECT principle.id, principle.pillar_id, principle.statement, principle.is_non_negotiable
          FROM principles AS principle JOIN pillars AS pillar ON pillar.id = principle.pillar_id
          WHERE pillar.owner_board_id = ? AND pillar.is_active = 1 ORDER BY principle.position, principle.id`,
      args: [boardId],
    },
    {
      sql: `SELECT link.pillar_id, link.entity_type, link.entity_id,
          CASE link.entity_type
            WHEN 'goal' THEN (SELECT title FROM goals WHERE id = link.entity_id AND owner_board_id = pillar.owner_board_id AND retired_at IS NULL)
            WHEN 'routine' THEN (SELECT name FROM task_templates WHERE id = link.entity_id AND owner_board_id = pillar.owner_board_id
              AND is_routine = 1 AND retired_at IS NULL)
            WHEN 'task' THEN (SELECT title FROM tasks WHERE id = link.entity_id AND task_board_id = pillar.owner_board_id)
          END AS label
        FROM pillar_associations AS link JOIN pillars AS pillar ON pillar.id = link.pillar_id
        WHERE pillar.owner_board_id = ? AND pillar.is_active = 1 ORDER BY link.entity_type, link.entity_id`,
      args: [boardId],
    },
  ])
  return pillars!.rows.map(pillar => ({
    id: String(pillar.id), name: String(pillar.name), manifesto: String(pillar.manifesto ?? ""),
    principles: principles!.rows.filter(principle => principle.pillar_id === pillar.id).map(principle => ({
      id: String(principle.id), statement: String(principle.statement), nonNegotiable: principle.is_non_negotiable === 1,
    })),
    links: links!.rows.flatMap(link => link.pillar_id === pillar.id && typeof link.label === "string" ? [{
      id: String(link.entity_id), type: String(link.entity_type), label: link.label,
    }] : []),
  }))
}

/** The caller holds the Board owner's authorization in the same write transaction. */
export async function saveBoardPillarChange(tx: Transaction, boardId: string, input: BoardPillarChange) {
  const id = randomUUID()
  const now = Date.now()
  if (input.action === "pillar") {
    const result = input.id ? await tx.execute({
      sql: "UPDATE pillars SET name = ?, manifesto = ?, updated_at = ? WHERE id = ? AND owner_board_id = ? AND is_active = 1",
      args: [input.title, input.description, now, input.id, boardId],
    }) : await tx.execute({
      sql: "INSERT INTO pillars (id, slug, owner_board_id, name, manifesto, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [id, "~" + id, boardId, input.title, input.description, now, now],
    })
    return result.rowsAffected > 0
  }
  const { rows: [pillar] } = await tx.execute({
    sql: "SELECT 1 FROM pillars WHERE id = ? AND owner_board_id = ? AND is_active = 1",
    args: [input.pillarId, boardId],
  })
  if (!pillar) return false
  if (input.action === "pillar-principle") {
    const result = input.id ? await tx.execute({
      sql: "UPDATE principles SET statement = ?, is_non_negotiable = ? WHERE id = ? AND pillar_id = ?",
      args: [input.title, input.nonNegotiable, input.id, input.pillarId],
    }) : await tx.execute({
      sql: `INSERT INTO principles (id, pillar_id, statement, is_non_negotiable, position, created_at)
        VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM principles WHERE pillar_id = ?), ?)`,
      args: [id, input.pillarId, input.title, input.nonNegotiable, input.pillarId, now],
    })
    return result.rowsAffected > 0
  }
  if (!input.enabled) {
    await tx.execute({
      sql: "DELETE FROM pillar_associations WHERE pillar_id = ? AND entity_type = ? AND entity_id = ?",
      args: [input.pillarId, input.entityType, input.id],
    })
    return true
  }
  const ownedEntity = {
    goal: "SELECT 1 FROM goals WHERE id = ? AND owner_board_id = ? AND retired_at IS NULL",
    routine: "SELECT 1 FROM task_templates WHERE id = ? AND owner_board_id = ? AND is_routine = 1 AND retired_at IS NULL",
    task: "SELECT 1 FROM tasks WHERE id = ? AND task_board_id = ?",
  }[input.entityType]
  const { rows: [entity] } = await tx.execute({ sql: ownedEntity, args: [input.id, boardId] })
  if (!entity) return false
  await tx.execute({
    sql: "INSERT OR IGNORE INTO pillar_associations (id, pillar_id, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?, ?)",
    args: [id, input.pillarId, input.entityType, input.id, now],
  })
  return true
}
