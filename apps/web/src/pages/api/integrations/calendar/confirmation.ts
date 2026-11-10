import type { APIRoute } from "astro";
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability";
import { ensureSchema, findTaskById, persistManualCalendarConfirmation } from "@domains/tasks/persistence/store";

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["integrations", "audit", "observability"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: true
});

export const POST: APIRoute = async ({ request }) => {
  const body = (await request.json().catch(() => ({}))) as {
    taskId?: string;
    confirmationId?: string;
    providerEventId?: string;
    payload?: unknown;
    requestId?: string;
  };

  if (!body.taskId) {
    return new Response(JSON.stringify({ error: "taskId is required" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }

  const requestId = body.requestId ?? request.headers.get("x-request-id") ?? crypto.randomUUID();
  const confirmationId = body.confirmationId ?? crypto.randomUUID();

  await ensureSchema();
  const task = await findTaskById(body.taskId);
  if (!task) {
    return new Response(JSON.stringify({ error: "Task not found", taskId: body.taskId }), {
      status: 404,
      headers: { "content-type": "application/json" }
    });
  }

  const persisted = await persistManualCalendarConfirmation({
    taskId: body.taskId,
    requestId,
    confirmationId,
    ...(body.providerEventId ? { providerEventId: body.providerEventId } : {}),
    ...(typeof body.payload !== "undefined" ? { payload: body.payload } : {})
  });

  logger.log("info", {
    event: "calendar.confirmation.received",
    domain: "integrations",
    component: "calendar-api",
    request_id: requestId,
    task_id: body.taskId,
    integration: "calendar",
    message: persisted.alreadyExisted
      ? "Calendar confirmation already existed and was replayed"
      : "Calendar confirmation persisted"
  });

  logger.audit({
    event: "audit.integration.calendar",
    domain: "audit",
    component: "calendar-api",
    request_id: requestId,
    task_id: body.taskId,
    integration: "calendar",
    message: persisted.alreadyExisted
      ? "Manual confirmation idempotent replay"
      : "Manual confirmation persisted"
  });

  return new Response(
    JSON.stringify({
      taskId: body.taskId,
      requestId,
      confirmationId: persisted.confirmationId,
      alreadyExisted: persisted.alreadyExisted
    }),
    {
      status: persisted.alreadyExisted ? 200 : 201,
      headers: { "content-type": "application/json" }
    }
  );
};
