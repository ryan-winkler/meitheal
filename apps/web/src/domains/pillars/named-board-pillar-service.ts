import type { Client } from "@libsql/client"
import {
  type BoardScope,
  validateBoardFeature,
  HierarchyRepository,
  TaskRepository,
  TemplateRepository
} from "@domains/tasks"
import { createPillar, getPillars, updatePillar } from "./pillar-service"
import {
  createPrinciple,
  getAllPrinciples,
  updatePrinciple,
  type Principle
} from "./principle-service"
import { getAssociationsForPillar, linkEntity, unlinkEntity } from "./pillar-association-service"

export type BoardPillarChange =
  | { action: "pillar"; title: string; description: string; id?: string }
  | {
      action: "pillar-principle"
      pillarId: string
      title: string
      nonNegotiable: boolean
      id?: string
    }
  | {
      action: "pillar-link"
      pillarId: string
      entityType: "goal" | "routine" | "task"
      id: string
      enabled: boolean
    }

/** Compatibility projection over the common owner-scoped Pillar engine. */
export async function readBoardPillars(client: Client, scope: BoardScope) {
  const pillars = await getPillars(scope, undefined, client)
  const principles = (await validateBoardFeature(scope, client, "principles"))
    ? await getAllPrinciples(scope, client)
    : new Map<string, Principle[]>()
  const hierarchy = new HierarchyRepository(client, scope)
  const tasks = new TaskRepository(client, scope)
  const templates = new TemplateRepository(client, scope)
  const result = []
  for (const pillar of pillars) {
    const links = []
    for (const link of await getAssociationsForPillar(scope, pillar.id, undefined, client)) {
      const record =
        link.entityType === "goal"
          ? await hierarchy.findGoalById(link.entityId)
          : link.entityType === "routine"
            ? await templates.findById(link.entityId)
            : await tasks.findById(link.entityId)
      const label =
        record &&
        (link.entityType === "routine" && "name" in record
          ? record.name
          : "title" in record
            ? record.title
            : null)
      if (typeof label === "string") links.push({ id: link.entityId, type: link.entityType, label })
    }
    result.push({
      id: pillar.id,
      name: pillar.name,
      manifesto: pillar.manifesto ?? "",
      principles: (principles.get(pillar.id) ?? []).map((principle) => ({
        id: principle.id,
        statement: principle.statement,
        nonNegotiable: principle.isNonNegotiable
      })),
      links
    })
  }
  return result
}
export async function saveBoardPillarChange(
  client: Client,
  scope: BoardScope,
  input: BoardPillarChange
): Promise<boolean> {
  if (input.action === "pillar") {
    if (input.id)
      return updatePillar(
        scope,
        input.id,
        { name: input.title, manifesto: input.description },
        client
      )
    return Boolean(
      await createPillar(scope, { name: input.title, manifesto: input.description }, client)
    )
  }
  if (input.action === "pillar-principle") {
    if (input.id)
      return updatePrinciple(
        scope,
        input.id,
        { statement: input.title, isNonNegotiable: input.nonNegotiable },
        input.pillarId,
        client
      )
    return Boolean(
      await createPrinciple(
        scope,
        { pillarId: input.pillarId, statement: input.title, isNonNegotiable: input.nonNegotiable },
        client
      )
    )
  }
  return input.enabled
    ? Boolean(
        await linkEntity(scope, input.pillarId, input.entityType, input.id, undefined, client)
      )
    : unlinkEntity(scope, input.pillarId, input.entityType, input.id, undefined, client)
}
