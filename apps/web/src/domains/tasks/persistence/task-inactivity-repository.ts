import { requireBoardScope, type BoardScope } from "../board-scope"
import { boardOperationClient } from "./board-operation-client"
import { scopedTaskRead } from "./board-work-query"
import { sql, sourceSql, type SqlFragment } from "./sql-fragment"
import { createHash } from "node:crypto"
import type { Client, InValue, Row } from "@libsql/client"
import {
  inactivityClockSql,
  inactivityDayMs,
  inactivityDaysSql,
  inactivityPageSize,
  inactivityOpenTaskSql,
  inactivityProtectionSql,
  inactivitySpikeSql,
  inactivityStallSinceSql,
  inactivityTaskSql,
  inactivityUpcomingMs,
  validInactivityRevisionSql
} from "./task-inactivity-query"
import { taskTimestampMs } from "./task-timestamp"

export type InactivityFilter = "all" | "ready" | "upcoming" | "stalled"
export type InactivityScope = string | null

function readPolicy(row: Row | undefined, fallback: number) {
  if (!row) return { days: fallback, revision: null }
  const { days, revision } = row
  if (
    typeof days !== "number" ||
    !Number.isInteger(days) ||
    days < -1 ||
    days > 365 ||
    typeof revision !== "string" ||
    !/^[a-f0-9]{32}$/.test(revision)
  ) {
    throw new Error("Malformed inactivity policy")
  }
  return { days, revision }
}

const areaCatalogSql = `SELECT areas.id, areas.name, areas.inactivity_generation AS generation,
    task_inactivity_policy.revision AS policy_revision
  FROM scoped_areas AS areas LEFT JOIN scoped_policy AS task_inactivity_policy ON task_inactivity_policy.area_id = areas.id
  WHERE areas.retired_at IS NULL
  ORDER BY areas.position, areas.id`

function areaCatalogRevision(rows: Row[]) {
  return createHash("sha256")
    .update(JSON.stringify(rows.map((row) => [row.id, row.generation, row.policy_revision])))
    .digest("hex")
}

const selectedScope = (areaId: InactivityScope) => (areaId === null ? "default" : `area:${areaId}`)
const enabledPolicySql = (simulate = false) => `input(area_id, proposed) AS (VALUES (?, ?))
  SELECT 1 FROM input WHERE (input.area_id IS NULL AND (${inactivityDaysSql(simulate, "NULL")}) > 0)
    OR EXISTS(SELECT 1 FROM scoped_areas AS areas WHERE areas.retired_at IS NULL
      AND (input.area_id IS NULL OR areas.id = input.area_id)
      AND (${inactivityDaysSql(simulate, "areas.id")}) > 0) LIMIT 1`
const deadline = `CASE WHEN can_defer THEN last_activity + days * ${inactivityDayMs} END`

function rowsCte(preview = false, stalledOnly = false) {
  return `input(area_id, proposed, now_ms) AS (VALUES (?, ?, ?)),
    eligible AS MATERIALIZED (
      SELECT tasks.id, tasks.title, tasks.area_id, tasks.ticket_number, tasks.status,
        ${taskTimestampMs("tasks.updated_at")} AS updated_at, tasks.deferral_revision,
        ${inactivityClockSql} AS last_activity, ${inactivityDaysSql(true)} AS days,
        ${stalledOnly ? `(${inactivityProtectionSql})` : "1"} AS can_defer
        ${preview ? `, ${inactivitySpikeSql} AS spike_at` : ""}
      FROM scoped_tasks AS tasks CROSS JOIN input
      WHERE ${stalledOnly ? inactivityOpenTaskSql : inactivityTaskSql}
        AND (input.area_id IS NULL OR tasks.area_id = input.area_id)
    ), dated AS (
      SELECT eligible.*, input.now_ms, ${deadline} AS deadline
        ${preview ? `, ${inactivityStallSinceSql("input.now_ms")} AS stall_since` : ""}
      FROM eligible, input WHERE days BETWEEN 1 AND 365 AND last_activity <= input.now_ms
    )`
}

function filterSql(filter: InactivityFilter) {
  if (filter === "stalled") return "stall_since IS NOT NULL"
  if (filter === "ready") return "deadline <= now_ms"
  if (filter === "upcoming")
    return `deadline > now_ms AND deadline <= now_ms + ${inactivityUpcomingMs}`
  return `deadline <= now_ms + ${inactivityUpcomingMs}`
}

export class TaskInactivityRepository {
  constructor(
    private readonly sourceClient: Client,
    private readonly scope: BoardScope
  ) {
    requireBoardScope(scope)
  }
  private reader() {
    return boardOperationClient(this.sourceClient, this.scope, { resource: "task", action: "read" })
  }
  private writer() {
    return boardOperationClient(this.sourceClient, this.scope, {
      resource: "board",
      action: "manage"
    })
  }
  private query(text: string, args: InValue[] = [], continuation = false): SqlFragment {
    return scopedTaskRead(
      this.scope,
      sql`scoped_policy AS (SELECT * FROM task_inactivity_policy WHERE board_id=${this.scope.boardId})${sourceSql(continuation ? "," : "")} ${sourceSql(text, args)}`,
      "with"
    )
  }

  async preview({
    areaId,
    proposed,
    page,
    filter,
    now
  }: {
    areaId: InactivityScope
    proposed?: number
    page: number
    filter: InactivityFilter
    now: number
  }) {
    const args = [areaId, proposed ?? null, now]
    const where = filterSql(filter)
    const sort = filter === "stalled" ? "stall_since" : "deadline"
    const [policies, areas, result, enabled] = await this.reader().batch(
      [
        this.query(
          `SELECT scope, days, CASE WHEN ${validInactivityRevisionSql} THEN revision END AS revision
          FROM scoped_policy AS policy WHERE scope IN ('default', ?)
          AND (area_id IS NULL OR EXISTS (SELECT 1 FROM scoped_areas AS areas WHERE id = policy.area_id AND retired_at IS NULL))`,
          [selectedScope(areaId)]
        ),
        this.query(areaCatalogSql),
        this.query(
          `${rowsCte(true, filter === "stalled")}, filtered AS MATERIALIZED (SELECT * FROM dated WHERE ${where}),
          bounds AS (SELECT COUNT(*) AS total, MAX(1, MIN(?, (COUNT(*) + 24) / 25)) AS page FROM filtered),
          items AS (
            SELECT id, title, area_id, ticket_number, status, last_activity, deadline, stall_since
            FROM filtered ORDER BY ${sort}, id
            LIMIT 25 OFFSET (SELECT (page - 1) * 25 FROM bounds)
          )
          SELECT bounds.total, bounds.page, items.* FROM bounds LEFT JOIN items ON TRUE ORDER BY items.${sort}, items.id`,
          [...args, page],
          true
        ),
        this.query(enabledPolicySql(true), [areaId, proposed ?? null], true)
      ],
      "read"
    )
    const scope = selectedScope(areaId)
    const policy = policies!.rows.find((row) => row.scope === scope)
    const defaultPolicy = policies!.rows.find((row) => row.scope === "default")
    const selectedArea = areas!.rows.find((row) => row.id === areaId)
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
      tasks: result!.rows
        .filter((row) => row.id !== null)
        .map(
          ({
            id,
            title,
            area_id,
            ticket_number,
            status,
            last_activity,
            deadline,
            stall_since
          }) => ({
            id: String(id),
            title: String(title),
            area_id: area_id === null ? null : String(area_id),
            status: String(status),
            ticket_number: ticket_number === null ? null : Number(ticket_number),
            last_activity: Number(last_activity),
            deadline: deadline === null ? null : Number(deadline),
            stall_since: stall_since === null ? null : Number(stall_since)
          })
        )
    }
  }

  async savePolicy({
    areaId,
    days,
    expectedRevision,
    expectedDefaultRevision,
    areaGeneration,
    expectedAreaCatalogRevision
  }: {
    areaId: InactivityScope
    days: number
    expectedRevision: string | null
    expectedDefaultRevision: string | null
    areaGeneration: string | null
    expectedAreaCatalogRevision: string | null
  }) {
    try {
      const scope = selectedScope(areaId)
      const mutation = this.query(
        `INSERT INTO task_inactivity_policy (scope, area_id, days, revision,board_id)
          SELECT ?, ?, ?, lower(hex(randomblob(16))), ?
          WHERE (SELECT revision FROM scoped_policy WHERE scope = ?) IS ?
            AND (? IS NULL OR (EXISTS (SELECT 1 FROM scoped_areas AS areas WHERE id = ? AND retired_at IS NULL AND inactivity_generation IS ?)
              AND (SELECT revision FROM scoped_policy WHERE scope = 'default') IS ?))
          ON CONFLICT(board_id,scope) DO UPDATE SET days = excluded.days, revision = excluded.revision
          RETURNING days, revision`,
        [
          scope,
          areaId,
          days,
          this.scope.boardId,
          scope,
          expectedRevision,
          areaId,
          areaId,
          areaGeneration,
          expectedDefaultRevision
        ]
      )
      if (areaId === null) {
        const tx = await this.writer().transaction("write")
        try {
          const current = await tx.execute(this.query(areaCatalogSql))
          if (areaCatalogRevision(current.rows) !== expectedAreaCatalogRevision)
            return { status: "stale" } as const
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
      const [saved, area] = await this.writer().batch(
        [
          mutation,
          this.query("SELECT 1 FROM scoped_areas AS areas WHERE id=? AND retired_at IS NULL", [
            areaId
          ])
        ],
        "write"
      )
      if (saved!.rows[0])
        return { status: "saved", policy: readPolicy(saved!.rows[0], days) } as const
      return { status: !area!.rows.length ? "missing" : "stale" } as const
    } catch (error) {
      throw error
    }
  }

  async hasEnabledPolicy(areaId?: InactivityScope) {
    const statement =
      areaId === undefined
        ? this
            .query(`SELECT 1 FROM scoped_policy AS policy WHERE days>0 AND ${validInactivityRevisionSql}
      AND (area_id IS NULL OR EXISTS(SELECT 1 FROM scoped_areas AS areas WHERE areas.id=policy.area_id AND retired_at IS NULL)) LIMIT 1`)
        : this.query(enabledPolicySql(), [areaId, null], true)
    return (await this.reader().execute(statement)).rows.length > 0
  }

  async candidates(now: number) {
    const { rows } = await this.reader().execute(
      this.query(
        `${rowsCte()} SELECT id, updated_at, deferral_revision
        FROM dated WHERE deadline <= now_ms ORDER BY deadline, id LIMIT ?`,
        [null, null, now, inactivityPageSize],
        true
      )
    )
    return rows.map((row) => ({
      id: String(row.id),
      updatedAt: Number(row.updated_at),
      revision: typeof row.deferral_revision === "string" ? row.deferral_revision : null
    }))
  }

  async boardCues(ids: string[], now: number) {
    const cues = new Map<string, number>()
    const stalled = new Map<string, number>()
    if (!ids.length || !(await this.hasEnabledPolicy())) return { cues, stalled }

    const args: InValue[] = [now, JSON.stringify(ids)]
    const days = inactivityDaysSql()
    const { rows } = await this.reader().execute(
      this.query(
        `input(now_ms, ids) AS (VALUES (?, ?)), visible AS MATERIALIZED (
        SELECT tasks.id, ${inactivityClockSql} AS last_activity, (${days}) AS days,
          ${inactivitySpikeSql} AS spike_at, (${inactivityProtectionSql}) AS can_defer
        FROM input JOIN json_each(input.ids) card JOIN scoped_tasks AS tasks ON tasks.id = card.value
        WHERE ${inactivityOpenTaskSql}
      ), dated AS (
        SELECT id, input.now_ms, ${deadline} AS deadline, ${inactivityStallSinceSql("input.now_ms")} AS stall_since
        FROM visible, input WHERE days BETWEEN 1 AND 365 AND last_activity <= input.now_ms
      )
      SELECT id, CASE WHEN deadline <= now_ms + ${inactivityUpcomingMs} THEN deadline END AS deadline, stall_since
      FROM dated WHERE deadline <= now_ms + ${inactivityUpcomingMs} OR stall_since IS NOT NULL`,
        args,
        true
      )
    )
    for (const row of rows) {
      if (typeof row.deadline === "number") cues.set(String(row.id), row.deadline)
      if (typeof row.stall_since === "number") stalled.set(String(row.id), row.stall_since)
    }
    return { cues, stalled }
  }
}
