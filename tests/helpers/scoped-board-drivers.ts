import type { getPersistenceClient } from "./persistence-fixture"
import { fixturePrincipal } from "./current-board-scope"
import { BoardAccessService } from "../../apps/web/src/domains/tasks/board-access-service"
import { principalProof, registerVerifiedPrincipal, type VerifiedPrincipal, type WorkOperation } from "../../apps/web/src/domains/tasks/board-scope"
import { NamedBoardTaskRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-task-repository"
import { NamedBoardPlanningRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-planning-repository"
import { BoardIntakeRepository } from "../../apps/web/src/domains/tasks/persistence/board-intake-repository"
import type { BoardActor } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { readBoardGrantRevision } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"

type Client = ReturnType<typeof getPersistenceClient>
const unavailable = { ok: false, errorCode: "unavailable" } as const
function verified(actor: BoardActor): actor is VerifiedPrincipal { return Boolean(principalProof(actor as VerifiedPrincipal)) }
export function fixtureAgent(id: string) {
  return registerVerifiedPrincipal({ kind: "agent", id, tokenId: id }, { administrator: false, expiresAt: Date.now() + 60_000,
    tokenScopes: ["tasks:read", "tasks:write", "tasks:write:assigned", "tasks:delete", "tasks:propose", "tasks:assign"] })
}

/** Domain tests model separate admitted requests. Every method resolves current
 * production authority; no driver supplies a scope or work SQL of its own. */
export class ScopedBoardTasks {
  constructor(private db: Client) {}
  private async repository(actor: BoardActor, boardId: string, operation: WorkOperation) {
    if (!verified(actor)) return null
    const result = await new BoardAccessService(this.db).resolve(actor, boardId, operation)
    return result.ok ? new NamedBoardTaskRepository(this.db, result.scope) : result.errorCode === "denied" ? "denied" : null
  }
  async view(...args: Parameters<NamedBoardTaskRepository["view"]>) {
    const repo = await this.repository(args[0], args[1], { resource: "task", action: "read" })
    return repo && repo !== "denied" ? repo.view(...args) : null
  }
  async groups(...args: Parameters<NamedBoardTaskRepository["groups"]>) {
    const repo = await this.repository(args[0], args[1], { resource: "task", action: "read" })
    return repo && repo !== "denied" ? repo.groups(...args) : null
  }
  async projects(...args: Parameters<NamedBoardTaskRepository["projects"]>) {
    const repo = await this.repository(args[0], args[1], { resource: "task", action: "read" })
    return repo && repo !== "denied" ? repo.projects(...args) : null
  }
  async homeAssistantArea(...args: Parameters<NamedBoardTaskRepository["homeAssistantArea"]>) {
    const repo = await this.repository(args[0], args[1], { resource: "task", action: "read" })
    return repo && repo !== "denied" ? repo.homeAssistantArea(...args) : null
  }
  async create(...args: Parameters<NamedBoardTaskRepository["create"]>) {
    const repo = await this.repository(args[0], args[1], { resource: "task", action: "create" })
    return repo && repo !== "denied" ? repo.create(...args) : { ...unavailable, errorCode: repo === "denied" ? "denied" : "unavailable" }
  }
  async edit(...args: Parameters<NamedBoardTaskRepository["edit"]>) {
    const repo = await this.repository(args[0], args[1], { resource: "task", action: "edit" })
    return repo && repo !== "denied" ? repo.edit(...args) : { ...unavailable, errorCode: repo === "denied" ? "denied" : "unavailable" }
  }
  async move(...args: Parameters<NamedBoardTaskRepository["move"]>) {
    const repo = await this.repository(args[0], args[1], { resource: "task", action: "move" })
    return repo && repo !== "denied" ? repo.move(...args) : { ...unavailable, errorCode: repo === "denied" ? "denied" : "unavailable" }
  }
  async delete(...args: Parameters<NamedBoardTaskRepository["delete"]>) {
    const repo = await this.repository(args[0], args[1], { resource: "task", action: "delete" })
    return repo && repo !== "denied" ? repo.delete(...args) : { ...unavailable, errorCode: repo === "denied" ? "denied" : "unavailable" }
  }
  async file(...args: Parameters<NamedBoardTaskRepository["file"]>) {
    const repo = await this.repository(args[0], args[1], { resource: "task", action: "move" })
    return repo && repo !== "denied" ? repo.file(...args) : { ...unavailable, errorCode: repo === "denied" ? "denied" : "unavailable" }
  }
  async changeHomeAssistantArea(...args: Parameters<NamedBoardTaskRepository["changeHomeAssistantArea"]>) {
    const repo = await this.repository(args[0], args[1], { resource: "task", action: "edit" })
    return repo && repo !== "denied" ? repo.changeHomeAssistantArea(...args) : { ...unavailable, errorCode: repo === "denied" ? "denied" : "unavailable" }
  }
  async completeRoutine(...args: Parameters<NamedBoardTaskRepository["completeRoutine"]>) {
    const repo = await this.repository(args[0], args[1], { resource: "task", action: "create" })
    return repo && repo !== "denied" ? repo.completeRoutine(...args) : { ...unavailable, errorCode: repo === "denied" ? "denied" : "unavailable" }
  }
  async routineLibrary(actor: BoardActor, boardId: string) {
    const repo = await this.repository(actor, boardId, { resource: "task", action: "read" })
    return repo && repo !== "denied" ? repo.routineLibrary(actor) : []
  }
  async dueWork(actor: BoardActor, boardId: string, day: string) {
    const repo = await this.repository(actor, boardId, { resource: "task", action: "read" })
    return repo && repo !== "denied" ? repo.dueWork(actor, day) : []
  }
}
export class ScopedBoardPlanning {
  constructor(private db: Client, private marker?: string) {}
  async saveVisibility(...args: Parameters<NamedBoardPlanningRepository["saveVisibility"]>) {
    const result = await new BoardAccessService(this.db).resolve(fixturePrincipal(args[0]), args[1], { resource: "task", action: "read" })
    if (!result.ok) return { status: "unchanged", result: "unavailable" } as const
    return new NamedBoardPlanningRepository(this.db, result.scope).saveVisibility(...args)
  }
  async save(...args: Parameters<NamedBoardPlanningRepository["save"]>) {
    if (this.marker && !await readBoardGrantRevision(this.marker)) return false
    const result = await new BoardAccessService(this.db).resolve(fixturePrincipal(args[0]), args[1], { resource: "task", action: "read" })
    if (!result.ok) return false
    try { return await new NamedBoardPlanningRepository(this.db, result.scope).save(...args) }
    catch (error) { if (error instanceof Error && error.name === "BoardOperationError") return false; throw error }
  }
}
export class ScopedBoardIntake {
  constructor(private db: Client) {}
  private repo(actor: BoardActor) {
    if (!verified(actor)) throw new Error("Synthetic intake request must have a verified fixture identity")
    return new BoardIntakeRepository(this.db, actor)
  }
  create(...args: Parameters<BoardIntakeRepository["create"]>) { return this.repo(fixturePrincipal(args[0])).create(...args) }
  setEnabled(...args: Parameters<BoardIntakeRepository["setEnabled"]>) { return this.repo(fixturePrincipal(args[0])).setEnabled(...args) }
  findDestinations(...args: Parameters<BoardIntakeRepository["findDestinations"]>) { return this.repo(args[0]).findDestinations(...args) }
  findSubmissions(...args: Parameters<BoardIntakeRepository["findSubmissions"]>) { return this.repo(args[0]).findSubmissions(...args) }
  private issuePermit(actor: BoardActor, id: string, now?: number) { return this.repo(actor).issue(actor, id, now) }
  private issuePending(actor: BoardActor, id: string, now: number, pending: { resumeId: string, title: string, description: string, assignToRecipient: boolean }) { return this.repo(actor).issue(actor, id, now, pending) }
  issue(actor: BoardActor, id: string, now?: number): ReturnType<ScopedBoardIntake["issuePermit"]>
  issue(actor: BoardActor, id: string, now: number, pending: { resumeId: string, title: string, description: string, assignToRecipient: boolean }): ReturnType<ScopedBoardIntake["issuePending"]>
  issue(actor: BoardActor, id: string, now?: number, pending?: { resumeId: string, title: string, description: string, assignToRecipient: boolean }) {
    return pending ? this.issuePending(actor, id, now ?? Date.now(), pending) : this.issuePermit(actor, id, now)
  }
  submit(...args: Parameters<BoardIntakeRepository["submit"]>) { return this.repo(args[0]).submit(...args) }
  retry(...args: Parameters<BoardIntakeRepository["retry"]>) { return this.repo(args[0]).retry(...args) }
}
