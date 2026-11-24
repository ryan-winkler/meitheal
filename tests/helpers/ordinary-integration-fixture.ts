type APIRoute = typeof import("../../apps/web/src/pages/api/grocy/auto-key").POST
import { randomUUID } from "node:crypto"
import { currentBoardScope } from "./current-board-scope"
import { getPersistenceClient } from "./persistence-fixture"
import {
  readWorkDestinations,
  type WorkBinding
} from "../../apps/web/src/domains/tasks/integration-destinations"
import { saveWorkBinding } from "../../apps/web/src/domains/tasks/work-binding-manager"
import { resolveIntegrationScope } from "../../apps/web/src/domains/tasks/board-automation"
import { boardSessionProof } from "../../apps/web/src/lib/named-board-request"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"

/** Explicit synthetic Board owner approval; append a real binding without replacing other authority. */
export async function integrationFixture(input: {
  integration: string
  sourceId: string
  purpose: string
  boardId?: string
}) {
  const db = getPersistenceClient()
  const boardId = input.boardId ?? "household"
  const owner = await currentBoardScope(db, boardId)
  const configuration = await readWorkDestinations(db)
  if (!configuration) throw new Error("Current integration configuration required")
  const existing = configuration.bindings.find(
    (binding) =>
      !binding.retired &&
      binding.enabled &&
      binding.integration === input.integration &&
      binding.sourceId === input.sourceId &&
      binding.purpose === input.purpose &&
      binding.destination.boardId === boardId
  )
  const admitted = existing
    ? { ok: true as const, binding: existing }
    : await saveWorkBinding(db, owner.principal, configuration.revision, {
        id: randomUUID(),
        generation: 1,
        enabled: true,
        integration: input.integration,
        sourceId: input.sourceId,
        purpose: input.purpose,
        destination: { boardId },
        allowedOperations: (input.purpose === "webhook.delivery"
          ? (["read"] as const)
          : (["read", "create", "edit", "complete", "reopen", "delete"] as const)
        ).map((action) => ({ resource: "task", action }))
      })
  if (!admitted.ok) throw new Error("Fixture binding approval failed")
  const scope = await currentBoardScope(db, boardId)
  const service = await resolveIntegrationScope(
    db,
    admitted.binding.id,
    admitted.binding.generation,
    { resource: "task", action: "read" }
  )
  if (!service.ok) throw new Error("Fixture binding service unavailable")
  return { binding: admitted.binding, scope, context: service.value }
}
export function calendarFixtureConfig(binding: WorkBinding, interval = 0) {
  return {
    bindingId: binding.id,
    generation: binding.generation,
    entityId: binding.sourceId,
    syncEnabled: true,
    syncMode: "import" as const,
    writeBack: false,
    syncIntervalMs: interval
  }
}
/** Exercise the actual standalone transport/session proof path; no raw header can mint a user. */
export async function integrationRoute(
  route: APIRoute,
  path: string,
  body?: unknown,
  method = "POST",
  locals: Partial<App.Locals> = {}
) {
  const {
    rows: [operator]
  } = await getPersistenceClient().execute(
    "SELECT value FROM app_settings WHERE key='local_operator_identity'"
  )
  if (typeof operator?.value !== "string") throw new Error("Current standalone operator required")
  const url = new URL(path, "http://localhost")
  const request = new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-meitheal-board-session": boardSessionProof(operator.value)
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  return runWithIngressTransport(
    {
      peer: "127.0.0.1",
      fromSupervisor: false,
      identityHeadersSafe: true,
      configuredPath: undefined
    },
    () =>
      route({
        request,
        url,
        params: {},
        locals: { hassIsAdmin: true, ...locals }
      } as Parameters<APIRoute>[0])
  )
}
