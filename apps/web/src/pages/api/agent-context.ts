import { boardSessionProof } from "@lib/named-board-request"
import type { APIRoute } from "astro"
import { BoardAccessService, canReadBoardAggregate, getPersistenceClient, validateBoardScope, type BoardScope } from "@domains/tasks"
import { verifiedBoardRequestPrincipal, verifiedBoardIngressPrincipal } from "@lib/board-request-context"
import { apiJson, apiError } from "@lib/api-response"

/** Self metadata for an existing credential. It grants no task or destination authority. */
export const GET: APIRoute = async context => {
  if (!context.locals.agentToken?.scopes.includes("tasks:read")) return apiError("Use a current task-reading integration credential.", 403)
  const principal = await verifiedBoardRequestPrincipal(context)
  if (!principal || principal.kind !== "agent") return apiError("Credential context is unavailable.", 403)
  const { haEventOperationAllowed } = await import("@lib/webhook-dispatcher")
  const human = await verifiedBoardIngressPrincipal(context)
  const db = getPersistenceClient()
  const { rows } = await db.execute({
    sql: `SELECT b.id,b.name,b.visibility FROM task_boards b JOIN board_access_grants g ON g.board_id=b.id
      WHERE g.principal_type='agent' AND g.principal_id=? AND b.state='active' ORDER BY b.created_at,b.id`, args: [principal.id],
  })
  const scopes: BoardScope[] = []
  const boards: { id: string, name: string, sharedEntityDelivery: boolean }[] = []
  for (const row of rows) {
    const result = await new BoardAccessService(db).resolve(principal, String(row.id), { resource: "task", action: "read" })
    if (!result.ok) continue
    if (human) {
      const limited = await new BoardAccessService(db).resolve(human, String(row.id), { resource: "task", action: "read" })
      if (!limited.ok) continue
      scopes.push(limited.scope)
    }
    const { rows: restricted } = await db.execute({ sql: "SELECT 1 FROM organization_access_policies WHERE board_id=? AND audience<>'everyone' LIMIT 1", args: [result.scope.boardId] })
    boards.push({ id: result.scope.boardId, name: String(row.name),
      sharedEntityDelivery: row.visibility === "shared" && !restricted.length && await canReadBoardAggregate(db, result.scope) && await haEventOperationAllowed(result.scope) })
    scopes.push(result.scope)
  }
  for (const scope of scopes) if (!(await validateBoardScope(scope, db, { resource: "task", action: "read" })).ok) return apiError("Credential access changed.", 409)
  const response = apiJson({ boards, enrollmentBoardId: boards.length === 1 ? boards[0]?.id ?? null : null })
  if (human) response.headers.set("X-Meitheal-Board-Session", boardSessionProof(human.id))
  response.headers.set("Cache-Control", "private, no-store")
  return response
}
