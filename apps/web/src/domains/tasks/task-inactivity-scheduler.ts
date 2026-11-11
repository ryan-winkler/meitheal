import type { Client } from "@libsql/client"
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"
import { ensureSchema, getPersistenceClient } from "./persistence/store"
import { inactivityRuleActor } from "./persistence/task-inactivity-query"
import { TaskInactivityRepository } from "./persistence/task-inactivity-repository"
import { TaskRepository } from "./persistence/task-repository"

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "warn",
  enabledCategories: ["tasks"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: false,
})

const intervalMs = 5 * 60 * 1000
let timer: ReturnType<typeof setInterval> | undefined
let sweeping = false

export async function sweepInactiveTasks(client: Client, now: number): Promise<number> {
  const inactivity = new TaskInactivityRepository(client)
  if (!await inactivity.hasEnabledPolicy()) return 0
  const candidates = await inactivity.candidates(now)
  const tasks = new TaskRepository(client)
  const actor = { id: inactivityRuleActor, type: "system", requestId: crypto.randomUUID() } as const
  let moved = 0
  for (const candidate of candidates) {
    const result = await tasks.setDeferral(candidate.id, true, { ...candidate, inactivityNow: now }, actor)
    if (result.ok && result.task.deferred_at === now) moved++
  }
  return moved
}

export function startInactivityScheduler() {
  if (timer) return
  timer = setInterval(async () => {
    if (sweeping) return
    sweeping = true
    try {
      await ensureSchema()
      await sweepInactiveTasks(getPersistenceClient(), Date.now())
    } catch {
      logger.log("warn", {
        event: "tasks.inactivity.sweep_failed",
        domain: "tasks",
        component: "task-inactivity-scheduler",
        request_id: "inactivity-sweep",
        message: "The inactivity sweep failed. The next scheduled sweep will retry.",
      })
    } finally {
      sweeping = false
    }
  }, intervalMs)
  timer.unref?.()
}
