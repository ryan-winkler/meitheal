import {
  BoardOperationError,
  isVerifiedPrincipalCurrent,
  currentBoardGrantRevision,
  requireBoardScope,
  validateBoardScope
} from "@domains/tasks"
import { boardScopeErrorResponse } from "./board-http"
import {
  scopeBoardAccess,
  type BoardScope,
  type VerifiedPrincipal,
  type WorkOperation
} from "@domains/tasks/board-scope"
import { createHash } from "node:crypto"
import { BoardIntakeRepository } from "@domains/tasks/persistence/board-intake-repository"
import {
  NamedBoardRepository,
  type BoardActor
} from "@domains/tasks/persistence/named-board-repository"
import { NamedBoardTaskRepository } from "@domains/tasks/persistence/named-board-task-repository"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import type { HomeAssistantAreaFilter } from "./home-assistant-area-access"
import type { BoardWorkspaceSelection } from "./board-workspace"
import { ORGANIZATION_FEATURES, type OrganizationFeature } from "./organization-availability"
import { isOrganizationFeatureAvailable } from "./organization-request-context"
import { apiJson } from "./api-response"

export function boardViewKey(value: unknown, actorId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([actorId, value]))
    .digest("hex")
}

/** Bind private DOM to current authority independently of ordinary task-content freshness. */
export function boardAuthorityKey(
  view: NonNullable<Awaited<ReturnType<NamedBoardTaskRepository["view"]>>>,
  actorId: string
): string {
  const board = view.board
  return boardViewKey(
    {
      epoch: view.authorityRevision,
      board: {
        id: board.id,
        role: board.role,
        state: board.state,
        revision: board.revision,
        denyCompletion: board.denyCompletion,
        denyDeletion: board.denyDeletion,
        policy: board.policy
      },
      area: view.context?.area?.id,
      project: view.context?.project && {
        id: view.context.project.id,
        status: view.context.project.status
      },
      features: (Object.keys(ORGANIZATION_FEATURES) as OrganizationFeature[]).filter(
        isOrganizationFeatureAvailable
      )
    },
    actorId
  )
}

export function boardViewResponse(value: unknown, actorId: string, payload = value): Response {
  const response = apiJson(payload)
  response.headers.set("x-meitheal-board-view", boardViewKey(value, actorId))
  return response
}

type DirectoryAdmission = { actor: VerifiedPrincipal; revision: string }
const directoryAdmissions = new WeakMap<object, DirectoryAdmission>()
type ScopeAdmission = { scope: BoardScope; operation: WorkOperation }
type ResponseAdmissions = { directories: DirectoryAdmission[]; scopes: ScopeAdmission[] }
const requestAdmissions = new WeakMap<Request, ResponseAdmissions>()

function responseAdmissions(request: Request): ResponseAdmissions {
  let admissions = requestAdmissions.get(request)
  if (!admissions) {
    admissions = { directories: [], scopes: [] }
    requestAdmissions.set(request, admissions)
  }
  return admissions
}

/** Append original server-admitted authority; a later scope never replaces it. */
export function retainBoardResponseScope(
  request: Request,
  scope: BoardScope,
  operation: WorkOperation = { resource: "task", action: "read" }
) {
  requireBoardScope(scope)
  const admissions = responseAdmissions(request)
  if (
    !admissions.scopes.some(
      (current) =>
        current.scope === scope &&
        current.operation.resource === operation.resource &&
        current.operation.action === operation.action
    )
  ) {
    admissions.scopes.push({ scope, operation: { ...operation } })
  }
}

async function assertDirectoryAdmission(admission: DirectoryAdmission) {
  if (!isVerifiedPrincipalCurrent(admission.actor)) throw new BoardOperationError("stale")
  if ((await currentBoardGrantRevision(getPersistenceClient())) !== admission.revision)
    throw new BoardOperationError("stale")
  if (!isVerifiedPrincipalCurrent(admission.actor)) throw new BoardOperationError("stale")
}

/** The entire aggregate retains one independently verified actor and live epoch. */
export async function readBoardDirectory(actor: VerifiedPrincipal, request?: Request) {
  await ensureSchema()
  const client = getPersistenceClient()
  if (!isVerifiedPrincipalCurrent(actor)) throw new BoardOperationError("stale")
  const revision = await currentBoardGrantRevision(client)
  if (!revision) throw new BoardOperationError("continuity_locked")
  const admission = { actor, revision }
  if (request) responseAdmissions(request).directories.push(admission)
  const repository = new NamedBoardRepository(client)
  const [boards, destinations, deletedBoards] = await Promise.all([
    repository.findDirectory(actor),
    new BoardIntakeRepository(client, actor).findDestinations(actor),
    repository.findDeleted(actor)
  ])
  await assertDirectoryAdmission(admission)
  const directory = { boards, destinations, deletedBoards, authorityRevision: revision }
  directoryAdmissions.set(directory, admission)
  return directory
}

export async function assertBoardDirectoryCurrent(directory: object) {
  const admission = directoryAdmissions.get(directory)
  if (!admission) throw new BoardOperationError("stale")
  await assertDirectoryAdmission(admission)
}

/** Final HTTP boundary: finish governed asynchronous SSR before admitting any private bytes. */
export async function admitBoardResponse(
  request: Request,
  response: Response,
  governedHtml = false
) {
  const retain = governedHtml || requestAdmissions.has(request)
  if (!retain) return response
  let chunks: Uint8Array[] | undefined
  if (response.body) {
    const reader = response.body.getReader()
    const collected: Uint8Array[] = []
    const abort = () => {
      void reader.cancel(request.signal.reason ?? new DOMException("Request aborted", "AbortError")).catch(() => {})
    }
    request.signal.addEventListener("abort", abort, { once: true })
    try {
      if (request.signal.aborted) {
        abort()
        request.signal.throwIfAborted()
      }
      for (;;) {
        const chunk = await reader.read()
        request.signal.throwIfAborted()
        if (chunk.done) break
        collected.push(chunk.value)
      }
      chunks = collected
    } finally {
      request.signal.removeEventListener("abort", abort)
      reader.releaseLock()
    }
  }
  const admissions = requestAdmissions.get(request)
  if (admissions) {
    try {
      for (const admission of admissions.directories) await assertDirectoryAdmission(admission)
      for (const { scope, operation } of admissions.scopes) {
        const current = await validateBoardScope(scope, getPersistenceClient(), operation)
        if (!current.ok) throw new BoardOperationError(current.errorCode)
      }
      // Keep every original proof current through later sibling revalidation.
      const originals = [
        ...admissions.directories,
        ...admissions.scopes.map(({ scope }) => ({
          actor: scope.principal,
          revision: scope.authorityRevision
        }))
      ]
      const revision = await currentBoardGrantRevision(getPersistenceClient())
      if (
        originals.some(
          (original) =>
            original.revision !== revision || !isVerifiedPrincipalCurrent(original.actor)
        )
      )
        throw new BoardOperationError("stale")
    } catch (error) {
      const failure = boardScopeErrorResponse(error)
      if (failure) return failure
      throw error
    }
  }
  if (chunks !== undefined) {
    const body: BodyInit = chunks.length === 0
      ? new Uint8Array(0)
      : new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < chunks.length; i++) {
              const chunk = chunks[i]
              if (chunk && chunk.byteLength > 0) controller.enqueue(chunk)
            }
            controller.close()
          },
        })
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
  return response
}

export async function readBoardView(
  scope: BoardScope,
  actor: BoardActor,
  id: string,
  offset: number,
  selection?: BoardWorkspaceSelection,
  location?: HomeAssistantAreaFilter,
  kanban?: { params: URLSearchParams; timezone?: string }
) {
  await ensureSchema()
  return new NamedBoardTaskRepository(getPersistenceClient(), scope).view(
    actor,
    id,
    offset,
    selection,
    location,
    kanban
  )
}

export function boardScopeAuthorityKey(scope: BoardScope): string {
  return boardViewKey(
    {
      epoch: scope.authorityRevision,
      board: scopeBoardAccess(scope),
      capabilities: scope.capabilities
    },
    scope.principal.id
  )
}
