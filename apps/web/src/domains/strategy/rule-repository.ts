/**
 * Rule Repository — CRUD operations for Task Context Rules
 *
 * Stores rules in SQLite. Rules define which strategic lenses,
 * AI scopes, and constraints apply to tasks based on type and tags.
 */

import { getPersistenceClient } from "../tasks/persistence/store"
import type { AIScope, TaskRule, TaskType } from "@meitheal/domain-strategy"
import { DEFAULT_AI_SCOPE } from "@meitheal/domain-strategy"
import { parseRuleInput } from "./rule-input"

/**
 * Safely parse a JSON string, returning fallback on failure.
 */
function safeParseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/**
 * Map a database row to a TaskRule.
 */
function toTaskRule(row: Record<string, unknown>): TaskRule {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ""),
    ruleType: String(row.rule_type) as TaskRule["ruleType"],
    taskTypes: safeParseJson<TaskType[]>(row.task_types, []),
    tags: safeParseJson<string[]>(row.tags, []),
    lensIds: safeParseJson<string[]>(row.lens_ids, []),
    aiScope: safeParseJson<AIScope>(row.ai_scope, { ...DEFAULT_AI_SCOPE }),
    constraints: String(row.constraints ?? ""),
    priority: Number(row.priority ?? 100),
    enabled: Number(row.enabled) === 1,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  }
}

/** Get all rules, optionally filtered by task type or tag */
export async function findAllRules(filters?: {
  taskType?: TaskType
  tag?: string
}): Promise<TaskRule[]> {
  const client = getPersistenceClient()
  const result = await client.execute("SELECT * FROM rules ORDER BY priority ASC, name ASC")
  let rules = result.rows.map((row) => toTaskRule(row as Record<string, unknown>))

  if (filters?.taskType) {
    rules = rules.filter(
      (r) => r.taskTypes.length === 0 || r.taskTypes.includes(filters.taskType as TaskType),
    )
  }

  if (filters?.tag) {
    rules = rules.filter(
      (r) => r.tags.length === 0 || r.tags.includes(filters.tag as string),
    )
  }

  return rules
}

/** Find a single rule by ID */
export async function findRuleById(id: string): Promise<TaskRule | null> {
  const client = getPersistenceClient()
  const result = await client.execute({
    sql: "SELECT * FROM rules WHERE id = ? LIMIT 1",
    args: [id],
  })
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  return toTaskRule(row)
}

function ruleInsert(rule: TaskRule, now: string) {
  return {
    sql: `INSERT INTO rules (id, name, description, rule_type, task_types, tags, lens_ids, ai_scope, constraints, priority, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      rule.id,
      rule.name,
      rule.description,
      rule.ruleType,
      JSON.stringify(rule.taskTypes),
      JSON.stringify(rule.tags),
      JSON.stringify(rule.lensIds),
      JSON.stringify(rule.aiScope),
      rule.constraints,
      rule.priority,
      rule.enabled ? 1 : 0,
      now,
      now,
    ],
  }
}

/** Replace rules atomically; failed inserts preserve the previous configuration. */
export async function replaceRules(rules: TaskRule[], replaceIds?: string[], resetFrameworks = false): Promise<TaskRule[]> {
  const now = new Date().toISOString()
  const client = getPersistenceClient()
  const deletion = replaceIds === undefined
    ? { sql: "DELETE FROM rules", args: [] }
    : { sql: `DELETE FROM rules WHERE id IN (${replaceIds.map(() => "?").join(",") || "NULL"})`, args: replaceIds }
  await client.batch([
    deletion,
    ...rules.map((rule) => ruleInsert(rule, now)),
    ...(resetFrameworks ? [{ sql: "DELETE FROM framework_configs", args: [] }] : []),
  ], "write")
  return rules.map((rule) => ({ ...rule, createdAt: now, updatedAt: now }))
}

/** Create a new rule */
export async function createRule(rule: TaskRule): Promise<TaskRule> {
  const client = getPersistenceClient()
  const now = new Date().toISOString()
  await client.execute(ruleInsert(rule, now))
  return { ...rule, createdAt: now, updatedAt: now }
}

/** Update an existing rule */
export async function updateRule(
  id: string,
  updates: Partial<Omit<TaskRule, "id" | "createdAt" | "updatedAt">>,
): Promise<TaskRule | null> {
  const existing = await findRuleById(id)
  if (!existing) return null

  const merged: TaskRule = {
    ...existing,
    ...parseRuleInput({ ...existing, ...updates }),
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  }

  const client = getPersistenceClient()
  await client.execute({
    sql: `UPDATE rules SET name = ?, description = ?, rule_type = ?, task_types = ?, tags = ?, lens_ids = ?, ai_scope = ?, constraints = ?, priority = ?, enabled = ?, updated_at = ?
          WHERE id = ?`,
    args: [
      merged.name,
      merged.description,
      merged.ruleType,
      JSON.stringify(merged.taskTypes),
      JSON.stringify(merged.tags),
      JSON.stringify(merged.lensIds),
      JSON.stringify(merged.aiScope),
      merged.constraints,
      merged.priority,
      merged.enabled ? 1 : 0,
      merged.updatedAt,
      id,
    ],
  })

  return merged
}

/** Delete a rule by ID */
export async function deleteRule(id: string): Promise<boolean> {
  const client = getPersistenceClient()
  const result = await client.execute({
    sql: "DELETE FROM rules WHERE id = ?",
    args: [id],
  })
  return (result.rowsAffected ?? 0) > 0
}

/** Count total rules */
export async function countRules(): Promise<number> {
  const client = getPersistenceClient()
  const result = await client.execute("SELECT COUNT(*) as cnt FROM rules")
  return Number((result.rows[0] as Record<string, unknown>)?.cnt ?? 0)
}

/** Delete all rules (used for preset resets) */
export async function deleteAllRules(): Promise<void> {
  const client = getPersistenceClient()
  await client.execute("DELETE FROM rules")
}
