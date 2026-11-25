import { scopeBoardAccess, scopePermits, type BoardScope } from "@domains/tasks/board-scope"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { TemplateRepository } from "@domains/tasks/persistence/template-repository"
import { isValidTimezone } from "./date"
import { readStoredHouseholdTimezone } from "./task-queries"

export async function readRoutineWorkspace(
  scope: BoardScope,
  selection: { areaId?: string | undefined; projectId?: string | undefined; timezone?: string | undefined },
) {
  await ensureSchema()
  const rawTimezone = selection.timezone?.trim() ?? ""
  const timezone = isValidTimezone(rawTimezone) ? rawTimezone : await readStoredHouseholdTimezone()
  const repository = new TemplateRepository(getPersistenceClient(), scope)
  if (scopeBoardAccess(scope).state === "active" && scopePermits(scope, { resource: "task", action: "create" })) {
    await repository.ensureDueRoutineTasks(timezone).catch(() => 0)
  }
  return repository.getRoutinesWithStats(selection.areaId, selection.projectId, timezone)
}
