import { createHash } from "node:crypto"
import type { Client, InValue, Row } from "@libsql/client"
import {
  inactivityClockSql, inactivityDayMs, inactivityDaysSql, inactivityPageSize,
  inactivityTaskSql, inactivityUpcomingMs, validInactivityRevisionSql,
} from "./task-inactivity-query"
import { taskTimestampMs } from "./task-timestamp"

export type InactivityFilter = "all" | "ready" | "upcoming"
export type InactivityScope = string | null

function readPolicy(row: Row | undefined, fallback: number) {
  if (!row) return { days: fallback, revision: null }
  const { days, revision } = row
  if (typeof days !== "number" || !Number.isInteger(days) || days < -1 || days > 365 ||
      typeof revision !== "string" || !/^[a-f0-9]{32}$/.test(revision)) {
    throw new Error("Malformed inactivity policy")
  }
  return { days, revision }
}

const areaCatalogSql = `SELECT areas.id, areas.name, areas.inactivity_generation AS generation,
    task_inactivity_policy.revision AS policy_revision
  FROM areas LEFT JOIN task_inactivity_policy ON task_inactivity_policy.area_id = areas.id
  ORDER BY areas.position, areas.id`

function areaCatalogRevision(rows: Row[]) {
  return createHash("sha256").update(JSON.stringify(rows.map(row => [row.id, row.generation, row.policy_revision])))
    .digest("hex")
}

const selectedScope = (areaId: InactivityScope) => areaId === null ? "default" : `area:${areaId}`
const enabledPolicySql = (simulate = false) => `WITH input(area_id, proposed) AS (VALUES (?, ?))
  SELECT 1 FROM areas, input WHERE (input.area_id IS NULL OR areas.id = input.area_id)
    AND (${inactivityDaysSql(simulate, "areas.id")}) > 0 LIMIT 1`
const rowsCte = `WITH input(area_id, proposed, now_ms) AS (VALUES (?, ?, ?)),
  eligible AS MATERIALIZED (
    SELECT tasks.id, tasks.title, tasks.area_id, tasks.ticket_number, tasks.status,
      ${taskTimestampMs("tasks.updated_at")} AS updated_at, tasks.deferral_revision,
      ${inactivityClockSql} AS last_activity, ${inactivityDaysSql(true)} AS days
    FROM tasks CROSS JOIN input
    WHERE ${inactivityTaskSql} AND (input.area_id IS NULL OR tasks.area_id = input.area_id)
  ), dated AS (
    SELECT *, last_activity + days * ${inactivityDayMs} AS deadline
    FROM eligible, input WHERE days BETWEEN 1 AND 365 AND last_activity <= input.now_ms
  )`

function filterSql(filter: InactivityFilter) {
  if (filter === "ready") return "deadline <= now_ms"
  if (filter === "upcoming") return `deadline > now_ms AND deadline <= now_ms + ${inactivityUpcomingMs}`
  return `deadline <= now_ms + ${inactivityUpcomingMs}`
}

export class TaskInactivityRepository {
  constructor(private readonly client: Client) {}

  async preview({ areaId, proposed, page, filter, now }: {
    areaId: InactivityScope
    proposed?: number
    page: number
    filter: InactivityFilter
    now: number
  }) {
    const args = [areaId, proposed ?? null, now]
    const where = filterSql(filter)
    const [policies, areas, result, enabled] = await this.client.batch([
      { sql: `SELECT scope, days, CASE WHEN ${validInactivityRevisionSql} THEN revision END AS revision
          FROM task_inactivity_policy WHERE scope IN ('default', ?)`,
        args: [selectedScope(areaId)] },
      areaCatalogSql,
      { sql: `${rowsCte}, filtered AS MATERIALIZED (SELECT * FROM dated WHERE ${where}),
          bounds AS (SELECT COUNT(*) AS total, MAX(1, MIN(?, (COUNT(*) + 24) / 25)) AS page FROM filtered),
          items AS (
            SELECT id, title, area_id, ticket_number, status, last_activity, deadline
            FROM filtered ORDER BY deadline, id
            LIMIT 25 OFFSET (SELECT (page - 1) * 25 FROM bounds)
          )
          SELECT bounds.total, bounds.page, items.* FROM bounds LEFT JOIN items ON TRUE ORDER BY items.deadline, items.id`,
        args: [...args, page] },
      { sql: enabledPolicySql(true), args: [areaId, proposed ?? null] },
    ], "read")
    const scope = selectedScope(areaId)
    const policy = policies!.rows.find(row => row.scope === scope)
    const defaultPolicy = policies!.rows.find(row => row.scope === "default")
    const selectedArea = areas!.rows.find(row => row.id === areaId)
    return {
      areaCatalogRevision: areaId === null ? areaCatalogRevision(areas!.rows) : null,
      hasEffectivePolicy: Boolean(enabled?.rows.length),
      areaExists: areaId === null || selectedArea !== undefined,
      areaGeneration: typeof selectedArea?.generation === "string" ? selectedArea.generation : null,
      areas: areas!.rows.map(({ id, name }) => ({ id: String(id), name: String(name) })),
      policy: readPolicy(policy, areaId === null ? 0 : -1),
      defaultPolicy: readPolicy(defaultPolicy, 0),
      page: Number(result!.rows[0]?.page ?? 1),
      total: Number(result!.rows[0]?.total ?? 0),
      tasks: result!.rows.filter(row => row.id !== null).map(({ id, title, area_id, ticket_number, status, last_activity, deadline }) =>
        ({
          id: String(id), title: String(title), area_id: String(area_id), status: String(status),
          ticket_number: ticket_number === null ? null : Number(ticket_number),
          last_activity: Number(last_activity), deadline: Number(deadline),
        })),
    }
  }

  async savePolicy({ areaId, days, expectedRevision, expectedDefaultRevision, areaGeneration, expectedAreaCatalogRevision }: {
    areaId: InactivityScope
    days: number
    expectedRevision: string | null
    expectedDefaultRevision: string | null
    areaGeneration: string | null
    expectedAreaCatalogRevision: string | null
  }) {
    const scope = selectedScope(areaId)
    const mutation = {
      sql: `INSERT INTO task_inactivity_policy (scope, area_id, days, revision)
        SELECT ?, ?, ?, lower(hex(randomblob(16)))
        WHERE (SELECT revision FROM task_inactivity_policy WHERE scope = ?) IS ?
          AND (? IS NULL OR (EXISTS (SELECT 1 FROM areas WHERE id = ? AND inactivity_generation IS ?)
            AND (SELECT revision FROM task_inactivity_policy WHERE scope = 'default') IS ?))
        ON CONFLICT(scope) DO UPDATE SET days = excluded.days, revision = excluded.revision
        RETURNING days, revision`,
      args: [scope, areaId, days, scope, expectedRevision, areaId, areaId, areaGeneration, expectedDefaultRevision],
    }
    if (areaId === null) {
      const tx = await this.client.transaction("write")
      try {
        const current = await tx.execute(areaCatalogSql)
        if (areaCatalogRevision(current.rows) !== expectedAreaCatalogRevision) return { status: "stale" } as const
        const result = await tx.execute(mutation)
        const saved = result.rows[0]
        if (!saved) return { status: "stale" } as const
        const policy = readPolicy(saved, days)
        await tx.commit()
        return { status: "saved", policy } as const
      } finally {
        tx.close()
      }
    }
    const [saved, area] = await this.client.batch([
      mutation,
      { sql: "SELECT 1 FROM areas WHERE id = ?", args: [areaId] },
    ], "write")
    if (saved!.rows[0]) return { status: "saved", policy: readPolicy(saved!.rows[0], days) } as const
    return { status: !area!.rows.length ? "missing" : "stale" } as const
  }

  async hasEnabledPolicy(areaId?: InactivityScope) {
    const { rows } = await this.client.execute(areaId === undefined
      ? `SELECT 1 FROM task_inactivity_policy WHERE days > 0 AND ${validInactivityRevisionSql} LIMIT 1`
      : { sql: enabledPolicySql(), args: [areaId, null] })
    return rows.length > 0
  }

  async candidates(now: number) {
    const { rows } = await this.client.execute({
      sql: `${rowsCte} SELECT id, updated_at, deferral_revision
        FROM dated WHERE deadline <= now_ms ORDER BY deadline, id LIMIT ?`,
      args: [null, null, now, inactivityPageSize],
    })
    return rows.map(row => ({
      id: String(row.id),
      updatedAt: Number(row.updated_at),
      revision: typeof row.deferral_revision === "string" ? row.deferral_revision : null,
    }))
  }

  async boardCues(ids: string[], now: number) {
    if (!ids.length || !await this.hasEnabledPolicy()) return new Map<string, number>()
    const args: InValue[] = [JSON.stringify(ids), now, now + inactivityUpcomingMs]
    const days = inactivityDaysSql()
    const { rows } = await this.client.execute({
      sql: `WITH visible AS MATERIALIZED (
        SELECT tasks.id, ${inactivityClockSql} AS last_activity, (${days}) AS days
        FROM tasks JOIN json_each(?) card ON tasks.id = card.value WHERE ${inactivityTaskSql}
      )
      SELECT id, last_activity + days * ${inactivityDayMs} AS deadline
      FROM visible WHERE days BETWEEN 1 AND 365 AND last_activity <= ? AND deadline <= ?`,
      args,
    })
    return new Map(rows.map(row => [String(row.id), Number(row.deadline)]))
  }
}
