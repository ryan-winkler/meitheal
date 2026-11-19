import { createHash } from "node:crypto"
import type { BoardScope } from "@domains/tasks/board-scope"

export type CaptureAttempt = { ok: true, digest?: string } | { ok: false, error: string }
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Private browser receipt key. Neither the UUID nor derived digest is a public task field. */
export function captureAttempt(request: Request, scope: BoardScope, required = false): CaptureAttempt {
  const attempt = request.headers.get("X-Meitheal-Capture-Attempt")
  if (attempt === null && !required) return { ok: true }
  if (!attempt || !uuidV4.test(attempt) || request.headers.has("Idempotency-Key")) {
    return { ok: false, error: "Use a valid capture attempt without an Idempotency-Key." }
  }
  if (request.headers.get("X-Meitheal-Board-Id") !== scope.boardId ||
    !["ha_user", "local_operator"].includes(scope.principal.kind)) {
    return { ok: false, error: "Capture requires its original Board and current browser identity." }
  }
  return { ok: true, digest: createHash("sha256").update(JSON.stringify([
    "capture-v1", scope.principal.kind, scope.principal.id, scope.boardId, attempt,
  ])).digest("hex") }
}
