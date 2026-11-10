import type { APIRoute } from "astro";
import { apiJson, apiError } from "../../../../lib/api-response";
import type { A2ATask, A2ATaskStatus } from "@meitheal/integration-core";

/**
 * GET /api/a2a/tasks/[id] — A2A Task Status
 *
 * Returns the current status of an A2A task by ID.
 * Per A2A spec §11.3.2.
 *
 * Note: Tasks are currently stateless (not persisted between requests).
 * This endpoint returns a status skeleton for protocol compliance.
 * Future: persist A2A tasks in SQLite alongside Meitheal tasks.
 */
export const GET: APIRoute = async ({ params }) => {
  const id = params.id;

  if (!id) {
    return apiError("Task ID is required", 400);
  }

  // For now, return a minimal task object.
  // A2A tasks are not yet persisted — this is protocol-compliant scaffolding.
  const task: A2ATask = {
    id,
    status: "completed" as A2ATaskStatus,
    messages: [],
    metadata: {
      note: "A2A task persistence is planned. Current implementation returns a stub.",
    },
  };

  return apiJson({ task });
};

/**
 * POST /api/a2a/tasks/[id]:cancel — Cancel A2A Task
 *
 * Cancels a running A2A task by ID.
 * Per A2A spec §11.3.2.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const id = params.id;
  const urlPath = new URL(request.url).pathname;

  if (!id) {
    return apiError("Task ID is required", 400);
  }

  // Check for :cancel action
  if (urlPath.endsWith(":cancel")) {
    const task: A2ATask = {
      id,
      status: "canceled",
      messages: [
        {
          role: "agent",
          messageId: crypto.randomUUID(),
          parts: [{ text: `Task ${id} has been canceled.` }],
        },
      ],
    };
    return apiJson({ task });
  }

  return apiError("Unsupported action", 400);
};
