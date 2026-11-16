import { createHash } from "node:crypto"
import { BoardIntakeRepository } from "@domains/tasks/persistence/board-intake-repository"
import { NamedBoardRepository, type BoardActor } from "@domains/tasks/persistence/named-board-repository"
import { NamedBoardTaskRepository } from "@domains/tasks/persistence/named-board-task-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { apiJson } from "./api-response"

export function boardViewKey(value: unknown, actorId: string): string {
  return createHash("sha256").update(JSON.stringify([actorId, value])).digest("hex")
}

export function boardViewResponse(value: unknown, actorId: string, payload = value): Response {
  const response = apiJson(payload)
  response.headers.set("x-meitheal-board-view", boardViewKey(value, actorId))
  return response
}

export async function readBoardDirectory(actor: BoardActor) {
  await ensureSchema()
  const client = getPersistenceClient()
  const [boards, destinations] = await Promise.all([
    new NamedBoardRepository(client).findDirectory(actor),
    new BoardIntakeRepository(client).findDestinations(actor),
  ])
  return { boards, destinations }
}

export async function readBoardView(actor: BoardActor, id: string, offset: number) {
  await ensureSchema()
  return new NamedBoardTaskRepository(getPersistenceClient()).view(actor, id, offset)
}
