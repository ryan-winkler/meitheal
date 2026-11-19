import {
  BoardOperationError,
  isVerifiedPrincipalCurrent,
  currentBoardGrantRevision
} from "@domains/tasks"
import { boardScopeErrorResponse } from "./board-http"
import {
  scopeBoardAccess,
  type BoardScope,
  type VerifiedPrincipal
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
const requestDirectoryAdmissions = new WeakMap<Request, DirectoryAdmission>()

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
  if (request) requestDirectoryAdmissions.set(request, admission)
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

/** Final HTTP boundary: finish asynchronous directory SSR before admitting any bytes. */
export async function admitBoardDirectoryResponse(
  request: Request,
  response: Response,
  directoryPage = false
) {
  const retain = directoryPage || requestDirectoryAdmissions.has(request)
  if (!retain) return response
  let buffered: ArrayBuffer | undefined
  if (response.body) {
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let rejectAbort!: (reason: unknown) => void
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject
    })
    const abort = () => {
      rejectAbort(request.signal.reason ?? new DOMException("Request aborted", "AbortError"))
      void reader.cancel().catch(() => {})
    }
    request.signal.addEventListener("abort", abort, { once: true })
    try {
      if (request.signal.aborted) abort()
      for (;;) {
        const chunk = await Promise.race([reader.read(), aborted])
        request.signal.throwIfAborted()
        if (chunk.done) break
        chunks.push(chunk.value)
      }
      buffered = new Uint8Array(Buffer.concat(chunks)).buffer
    } finally {
      request.signal.removeEventListener("abort", abort)
      reader.releaseLock()
    }
  }
  const admission = requestDirectoryAdmissions.get(request)
  if (admission) {
    try {
      await assertDirectoryAdmission(admission)
    } catch (error) {
      const failure = boardScopeErrorResponse(error)
      if (failure) return failure
      throw error
    }
  }
  return buffered
    ? new Response(buffered, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      })
    : response
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
