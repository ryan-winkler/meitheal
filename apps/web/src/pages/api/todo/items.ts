/**
 * Todo Items API — CRUD Operations
 *
 * Proxies CRUD operations to HA todo entities:
 *   GET    /api/todo/items?entity_id=todo.xyz&status=needs_action — list items
 *   POST   /api/todo/items — add item
 *   PUT    /api/todo/items — update item
 *   DELETE /api/todo/items — remove item(s)
 *
 * @domain todo
 * @bounded-context integration
 */
import type { APIRoute } from "astro";
import {
  getTodoItems,
  addTodoItem,
  updateTodoItem,
  removeTodoItem,
  removeTodoCompletedItems,
} from "@domains/ha";
import { logApiError } from "../../../lib/api-logger";

/**
 * GET /api/todo/items?entity_id=todo.xyz&status=needs_action,completed
 */
export const GET: APIRoute = async ({ url }) => {
  const entityId = url.searchParams.get("entity_id");
  if (!entityId) {
    return new Response(JSON.stringify({ ok: false, error: "entity_id required" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  const statusParam = url.searchParams.get("status");
  const statusFilter = statusParam
    ? statusParam.split(",").filter((s): s is "needs_action" | "completed" => ["needs_action", "completed"].includes(s))
    : undefined;

  try {
    const items = await getTodoItems(entityId, statusFilter);
    return new Response(JSON.stringify({ ok: true, items }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    logApiError("todo-items", "GET failed", err);
    return new Response(JSON.stringify({ ok: false, error: "Internal server error" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
};

/**
 * POST /api/todo/items
 * Body: { entity_id, summary, due?, description? }
 */
export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json() as {
      entity_id?: string;
      summary?: string;
      due?: string;
      description?: string;
    };

    if (!body.entity_id || !body.summary) {
      return new Response(JSON.stringify({ ok: false, error: "entity_id and summary required" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }

    const success = await addTodoItem(body.entity_id, {
      summary: body.summary,
      due: body.due,
      description: body.description,
    });

    return new Response(JSON.stringify({ ok: success }), {
      status: success ? 201 : 502,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    logApiError("todo-items", "POST failed", err);
    return new Response(JSON.stringify({ ok: false, error: "Internal server error" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
};

/**
 * PUT /api/todo/items
 * Body: { entity_id, item (uid or summary), rename?, status?, due_date?, due_datetime?, description? }
 */
export const PUT: APIRoute = async ({ request }) => {
  try {
    const body = await request.json() as {
      entity_id?: string;
      item?: string;
      rename?: string;
      status?: "needs_action" | "completed";
      due_date?: string;
      due_datetime?: string;
      description?: string;
    };

    if (!body.entity_id || !body.item) {
      return new Response(JSON.stringify({ ok: false, error: "entity_id and item required" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }

    const success = await updateTodoItem(body.entity_id, body.item, {
      summary: body.rename,
      status: body.status,
      due_date: body.due_date,
      due_datetime: body.due_datetime,
      description: body.description,
    });

    return new Response(JSON.stringify({ ok: success }), {
      status: success ? 200 : 502,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    logApiError("todo-items", "PUT failed", err);
    return new Response(JSON.stringify({ ok: false, error: "Internal server error" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
};

/**
 * DELETE /api/todo/items
 * Body: { entity_id, items: string[] } OR { entity_id, clear_completed: true }
 */
export const DELETE: APIRoute = async ({ request }) => {
  try {
    const body = await request.json() as {
      entity_id?: string;
      items?: string[];
      clear_completed?: boolean;
    };

    if (!body.entity_id) {
      return new Response(JSON.stringify({ ok: false, error: "entity_id required" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }

    let success: boolean;
    if (body.clear_completed) {
      success = await removeTodoCompletedItems(body.entity_id);
    } else if (body.items?.length) {
      success = await removeTodoItem(body.entity_id, body.items);
    } else {
      return new Response(JSON.stringify({ ok: false, error: "items or clear_completed required" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: success }), {
      status: success ? 200 : 502,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    logApiError("todo-items", "DELETE failed", err);
    return new Response(JSON.stringify({ ok: false, error: "Internal server error" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
};
