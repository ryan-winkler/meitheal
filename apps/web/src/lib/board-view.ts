import { createHash } from "node:crypto"
import { BoardIntakeRepository } from "@domains/tasks/persistence/board-intake-repository"
import { NamedBoardRepository, readHouseholdBoardState, type BoardActor } from "@domains/tasks/persistence/named-board-repository"
import { NamedBoardTaskRepository } from "@domains/tasks/persistence/named-board-task-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import type { HomeAssistantAreaFilter } from "./home-assistant-area-access"
import type { BoardWorkspaceSelection } from "./board-workspace"
import { apiJson } from "./api-response"

export function boardViewKey(value: unknown, actorId: string): string {
  return createHash("sha256").update(JSON.stringify([actorId, value])).digest("hex")
}

export function boardViewResponse(value: unknown, actorId: string, payload = value): Response {
  const response = apiJson(payload)
  response.headers.set("x-meitheal-board-view", boardViewKey(value, actorId))
  return response
}

export async function readBoardDirectory(actor: BoardActor, householdAdmin = false) {
  await ensureSchema()
  const client = getPersistenceClient()
  const repository = new NamedBoardRepository(client)
  const [boards, destinations, deletedBoards, householdState] = await Promise.all([
    repository.findDirectory(actor),
    new BoardIntakeRepository(client).findDestinations(actor),
    repository.findDeleted(actor),
    readHouseholdBoardState(client),
  ])
  const { rows: [household] } = await client.execute("SELECT revision FROM task_boards WHERE id = 'household'")
  return { boards, destinations, household: { state: householdState, revision: Number(household?.revision) },
    deletedBoards: [...(householdAdmin && householdState === "retired" ? [{ id: "household", name: "Household", revision: Number(household?.revision) }] : []), ...deletedBoards] }
}

export async function readBoardView(actor: BoardActor, id: string, offset: number, selection?: BoardWorkspaceSelection, location?: HomeAssistantAreaFilter, kanban?: { params: URLSearchParams; timezone?: string }) {
  await ensureSchema()
  return new NamedBoardTaskRepository(getPersistenceClient()).view(actor, id, offset, selection, location, kanban)
}
