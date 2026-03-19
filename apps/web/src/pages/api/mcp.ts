import type { APIRoute } from "astro";
import { apiJson, apiError } from "../../lib/api-response";

/**
 * POST /api/mcp — MCP (Model Context Protocol) Server Endpoint
 *
 * Accepts JSON-RPC 2.0 tool calls per the MCP specification.
 * Routes incoming tool requests to the Meitheal task API.
 *
 * Supports:
 * - "initialize" — handshake
 * - "tools/list" — enumerate available tools
 * - "tools/call" — execute a tool (createTask, searchTasks, completeTask, getCalendarEvents, etc.)
 *
 * The handler uses the same task database as all other Meitheal endpoints.
 * Any MCP-compatible client (Claude, Antigravity, Codex) can connect here.
 *
 * @see https://modelcontextprotocol.io/
 * @see /.well-known/mcp.json for static discovery
 */

// MCP tool definitions — same as mcp_server.py but for the Astro runtime
const MCP_TOOLS = [
  {
    name: "createTask",
    description: "Create a new task with title, description, priority, urgency, importance, labels, and due date",
    inputSchema: {
      type: "object" as const,
      required: ["title"],
      properties: {
        title: { type: "string", description: "Task title" },
        description: { type: "string", description: "Task description" },
        priority: { type: "integer", minimum: 1, maximum: 5, description: "Priority 1-5 (1=urgent)" },
        urgency: { type: "integer", minimum: 0, maximum: 5, description: "Urgency 0-5 (Eisenhower x-axis, 0=unclassified)" },
        importance: { type: "integer", minimum: 0, maximum: 5, description: "Importance 0-5 (Eisenhower y-axis, 0=unclassified)" },
        due_date: { type: "string", format: "date", description: "Due date YYYY-MM-DD" },
        assigned_to: { type: "string", description: "User ID to assign the task to" },
      },
    },
  },
  {
    name: "searchTasks",
    description: "Search tasks by keyword, status, priority, urgency, importance, Eisenhower quadrant, assignee, labels, custom fields, comments, or task IDs",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search keyword" },
        status: { type: "string", enum: ["backlog", "pending", "active", "complete"] },
        priority: { type: "integer", minimum: 1, maximum: 5 },
        urgency: { type: "integer", minimum: 0, maximum: 5, description: "Filter by urgency (Eisenhower)" },
        importance: { type: "integer", minimum: 0, maximum: 5, description: "Filter by importance (Eisenhower)" },
        eisenhower_quadrant: { type: "string", enum: ["do-first", "schedule", "delegate", "not-now"], description: "Filter by Eisenhower quadrant" },
        assigned_to: { type: "string", description: "Filter by assigned user ID" },
        include_completed: { type: "boolean" },
      },
    },
  },
  {
    name: "completeTask",
    description: "Mark a task as done by ID or title",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Task UUID" },
        title: { type: "string", description: "Task title (fuzzy match)" },
      },
    },
  },
  {
    name: "updateTask",
    description: "Update task fields including Eisenhower urgency/importance",
    inputSchema: {
      type: "object" as const,
      required: ["id"],
      properties: {
        id: { type: "string", description: "Task UUID" },
        title: { type: "string" },
        status: { type: "string", enum: ["backlog", "pending", "active", "complete"] },
        priority: { type: "integer", minimum: 1, maximum: 5 },
        urgency: { type: "integer", minimum: 0, maximum: 5, description: "Urgency 0-5 (Eisenhower x-axis)" },
        importance: { type: "integer", minimum: 0, maximum: 5, description: "Importance 0-5 (Eisenhower y-axis)" },
        eisenhower_override: { type: "boolean", description: "Set true if manually placed in quadrant" },
        due_date: { type: "string", format: "date" },
        description: { type: "string" },
      },
    },
  },
  {
    name: "deleteTask",
    description: "Delete a task by ID",
    inputSchema: {
      type: "object" as const,
      required: ["id"],
      properties: {
        id: { type: "string", description: "Task UUID" },
      },
    },
  },
  {
    name: "getTask",
    description: "Get full details of a specific task by ID",
    inputSchema: {
      type: "object" as const,
      required: ["id"],
      properties: {
        id: { type: "string", description: "Task UUID" },
      },
    },
  },
  {
    name: "getCalendarEvents",
    description: "Get events from the user's HA calendar synced into Meitheal",
    inputSchema: {
      type: "object" as const,
      properties: {
        days_ahead: { type: "integer", minimum: 1, maximum: 30, description: "Days ahead to look (default: 7)" },
      },
    },
  },
  {
    name: "getUpcoming",
    description: "Get all upcoming tasks and calendar events combined",
    inputSchema: {
      type: "object" as const,
      properties: {
        days_ahead: { type: "integer", minimum: 1, maximum: 30, description: "Days ahead to look (default: 7)" },
      },
    },
  },
  {
    name: "syncCalendar",
    description: "Trigger a manual calendar sync from Home Assistant",
    inputSchema: {
      type: "object" as const,
      properties: {
        entity_id: { type: "string", description: "Calendar entity ID (optional, uses configured entity if omitted)" },
      },
    },
  },
  {
    name: "getOverdueTasks",
    description: "Get all overdue tasks — tasks past their due date that aren't done",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "getTodaysTasks",
    description: "Get tasks due today plus any overdue tasks",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "getTaskSummary",
    description: "Get summary counts: total, active, overdue, done",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "batchComplete",
    description: "Complete multiple tasks at once by label or priority filter",
    inputSchema: {
      type: "object" as const,
      properties: {
        label: { type: "string", description: "Only affect tasks with this label" },
        max_priority: { type: "integer", description: "Only affect tasks with priority <= this" },
        titles: { type: "array", items: { type: "string" }, description: "Specific task titles to complete" },
      },
    },
  },
  {
    name: "assignTask",
    description: "Assign a task to a user (HA user or custom user) by task ID and user ID",
    inputSchema: {
      type: "object" as const,
      required: ["id"],
      properties: {
        id: { type: "string", description: "Task UUID" },
        assigned_to: { type: "string", description: "User ID to assign to (omit or null to unassign)" },
      },
    },
  },
  {
    name: "listUsers",
    description: "List all available users (Home Assistant auto-discovered + custom users)",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "linkTask",
    description: "Create a Jira-style link between two tasks. Link types: related_to, blocked_by, blocks, duplicates, duplicated_by",
    inputSchema: {
      type: "object" as const,
      required: ["source_task_id", "target_task_id", "link_type"],
      properties: {
        source_task_id: { type: "string", description: "Source task UUID" },
        target_task_id: { type: "string", description: "Target task UUID" },
        link_type: { type: "string", enum: ["related_to", "blocked_by", "blocks", "duplicates", "duplicated_by"], description: "Relationship type" },
      },
    },
  },
  {
    name: "unlinkTask",
    description: "Remove a link between two tasks by link ID",
    inputSchema: {
      type: "object" as const,
      required: ["task_id", "link_id"],
      properties: {
        task_id: { type: "string", description: "Task UUID the link belongs to" },
        link_id: { type: "string", description: "Link UUID to remove" },
      },
    },
  },
  {
    name: "getTaskLinks",
    description: "Get all links for a task (outbound and inbound relationships)",
    inputSchema: {
      type: "object" as const,
      required: ["task_id"],
      properties: {
        task_id: { type: "string", description: "Task UUID" },
      },
    },
  },
];

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json().catch(() => null);

    if (!body || typeof body !== "object") {
      return apiJson(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        400
      );
    }

    const { method, id: reqId = "1", params = {} } = body as {
      method?: string;
      id?: string;
      params?: Record<string, unknown>;
    };

    // Initialize handshake
    if (method === "initialize") {
      return apiJson({
        jsonrpc: "2.0",
        id: reqId,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "meitheal", version: "0.3.0" },
        },
      });
    }

    // List tools
    if (method === "tools/list") {
      return apiJson({
        jsonrpc: "2.0",
        id: reqId,
        result: { tools: MCP_TOOLS },
      });
    }

    // Execute tool
    if (method === "tools/call") {
      const toolName = (params as { name?: string }).name ?? "";
      const args = (params as { arguments?: Record<string, unknown> }).arguments ?? {};

      const result = await executeTool(toolName, args, request);

      return apiJson({
        jsonrpc: "2.0",
        id: reqId,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: false,
        },
      });
    }

    return apiJson(
      { jsonrpc: "2.0", id: reqId, error: { code: -32601, message: `Unknown method: ${method}` } },
      400
    );
  } catch (error) {
    return apiError(
      error instanceof Error ? error.message : "MCP server error",
      500
    );
  }
};

/**
 * Route MCP tool calls to internal API endpoints.
 * This keeps the MCP server thin — it delegates to the existing
 * REST API rather than reimplementing business logic.
 */
async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  request: Request
): Promise<Record<string, unknown>> {
  const baseUrl = new URL(request.url).origin;

  switch (toolName) {
    case "createTask": {
      const res = await fetch(`${baseUrl}/api/tasks/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: args.title,
          frameworkPayload: args.description ? { description: args.description } : undefined,
          priority: args.priority,
          urgency: args.urgency,
          importance: args.importance,
          dueDate: args.due_date,
          assigned_to: args.assigned_to,
        }),
      });
      return { status: "created", ...(await res.json().catch(() => ({}))) };
    }

    case "searchTasks": {
      const params = new URLSearchParams();
      if (args.query) params.set("q", String(args.query));
      if (args.status) params.set("status", String(args.status));
      if (args.priority) params.set("priority", String(args.priority));
      if (args.assigned_to) params.set("assigned_to", String(args.assigned_to));
      if (args.include_completed) params.set("include_completed", "1");
      params.set("scope", "tasks");
      const res = await fetch(`${baseUrl}/api/search?${params}`);
      const data = (await res.json().catch(() => ({ sections: [] }))) as {
        sections?: Array<{ id?: string; items?: Array<Record<string, unknown>> }>
      };
      const taskSection = data.sections?.find((section) => section.id === "tasks");
      return {
        tasks: (taskSection?.items ?? []).map((item) => ({
          id: item.taskId ?? item.id,
          title: item.title,
          description: item.description,
          status: (item.meta as Record<string, unknown> | undefined)?.status,
          priority: (item.meta as Record<string, unknown> | undefined)?.priority,
          matched_fields: (item.meta as Record<string, unknown> | undefined)?.matched_fields ?? [],
        })),
        count: taskSection?.items?.length ?? 0,
      };
    }

    case "completeTask": {
      if (args.id) {
        const res = await fetch(`${baseUrl}/api/tasks/${args.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "complete" }),
        });
        return { status: "completed", ...(await res.json().catch(() => ({}))) };
      }
      // Title-based completion — search then update
      if (args.title) {
        const searchRes = await fetch(`${baseUrl}/api/tasks?q=${encodeURIComponent(String(args.title))}`);
        const data = (await searchRes.json().catch(() => ({ tasks: [] }))) as { tasks: Array<{ id: string; title: string }> };
        const match = data.tasks?.find(
          (t: { title: string }) => t.title.toLowerCase() === String(args.title).toLowerCase()
        );
        if (match) {
          await fetch(`${baseUrl}/api/tasks/${match.id}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "complete" }),
          });
          return { status: "completed", id: match.id, title: match.title };
        }
        return { status: "not_found", title: args.title };
      }
      return { status: "error", message: "Provide id or title" };
    }

    case "updateTask": {
      const { id, ...updates } = args;
      const res = await fetch(`${baseUrl}/api/tasks/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(updates),
      });
      return { status: "updated", ...(await res.json().catch(() => ({}))) };
    }

    case "deleteTask": {
      await fetch(`${baseUrl}/api/tasks/${args.id}`, { method: "DELETE" });
      return { status: "deleted", id: args.id };
    }

    case "getTask": {
      const res = await fetch(`${baseUrl}/api/tasks/${args.id}`);
      return await res.json().catch(() => ({ error: "Task not found" }));
    }

    case "getCalendarEvents": {
      // Fetch tasks that were synced from HA calendar
      const res = await fetch(`${baseUrl}/api/tasks?calendar_synced=true`);
      const data = (await res.json().catch(() => ({ tasks: [] }))) as {
        tasks: Array<{ title: string; due_date: string; calendar_sync_state: string; description: string }>
      };
      const daysAhead = typeof args.days_ahead === "number" ? args.days_ahead : 7;
      const now = new Date();
      const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
      const today = now.toISOString().slice(0, 10);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      const events = (data.tasks ?? []).filter(
        (t) =>
          t.calendar_sync_state === "synced" &&
          t.due_date &&
          t.due_date.slice(0, 10) >= today &&
          t.due_date.slice(0, 10) <= cutoffStr
      ).map((t) => ({
        title: t.title,
        date: t.due_date,
        description: t.description || "",
        source: "ha_calendar",
      }));
      return { events, count: events.length };
    }

    case "getUpcoming": {
      const res = await fetch(`${baseUrl}/api/tasks`);
      const data = (await res.json().catch(() => ({ tasks: [] }))) as {
        tasks: Array<{ title: string; status: string; due_date: string; priority: number; calendar_sync_state: string }>
      };
      const daysAhead = typeof args.days_ahead === "number" ? args.days_ahead : 7;
      const now = new Date();
      const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
      const today = now.toISOString().slice(0, 10);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      const items = (data.tasks ?? []).filter(
        (t) =>
          t.status !== "complete" &&
          t.due_date &&
          t.due_date.slice(0, 10) >= today &&
          t.due_date.slice(0, 10) <= cutoffStr
      ).map((t) => ({
        title: t.title,
        date: t.due_date,
        type: t.calendar_sync_state === "synced" ? "calendar_event" : "task",
        priority: t.priority,
      }));
      return {
        items,
        count: items.length,
        calendar_events: items.filter((i) => i.type === "calendar_event").length,
        tasks: items.filter((i) => i.type === "task").length,
      };
    }

    case "syncCalendar": {
      const res = await fetch(`${baseUrl}/api/integrations/calendar/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "sync",
          entity_id: args.entity_id,
        }),
      });
      return await res.json().catch(() => ({ error: "Calendar sync failed" }));
    }

    case "getOverdueTasks": {
      const res = await fetch(`${baseUrl}/api/tasks`);
      const data = (await res.json().catch(() => ({ tasks: [] }))) as {
        tasks: Array<{ id: string; title: string; status: string; due_date: string; priority: number }>
      };
      const now = new Date().toISOString().slice(0, 10);
      const overdue = (data.tasks ?? []).filter(
        (t) => t.status !== "complete" && t.due_date && t.due_date.slice(0, 10) < now
      ).map((t) => ({ id: t.id, title: t.title, due_date: t.due_date, priority: t.priority }));
      return { tasks: overdue, count: overdue.length };
    }

    case "getTodaysTasks": {
      const res = await fetch(`${baseUrl}/api/tasks`);
      const data = (await res.json().catch(() => ({ tasks: [] }))) as {
        tasks: Array<{ id: string; title: string; status: string; due_date: string; priority: number }>
      };
      const today = new Date().toISOString().slice(0, 10);
      const tasks = (data.tasks ?? []).filter(
        (t) => t.status !== "complete" && t.due_date && (
          t.due_date.slice(0, 10) === today || t.due_date.slice(0, 10) < today
        )
      ).map((t) => ({
        id: t.id, title: t.title, due_date: t.due_date,
        priority: t.priority, is_overdue: t.due_date.slice(0, 10) < today,
      }));
      return { tasks, count: tasks.length };
    }

    case "getTaskSummary": {
      const res = await fetch(`${baseUrl}/api/tasks`);
      const data = (await res.json().catch(() => ({ tasks: [] }))) as {
        tasks: Array<{ status: string; due_date: string }>
      };
      const all = data.tasks ?? [];
      const now = new Date().toISOString().slice(0, 10);
      const done = all.filter((t) => t.status === "complete").length;
      const overdue = all.filter((t) => t.status !== "complete" && t.due_date && t.due_date.slice(0, 10) < now).length;
      return { total: all.length, active: all.length - done, overdue, completed: done };
    }

    case "batchComplete": {
      const res = await fetch(`${baseUrl}/api/tasks`);
      const data = (await res.json().catch(() => ({ tasks: [] }))) as {
        tasks: Array<{ id: string; title: string; status: string; priority: number; labels: string[] }>
      };
      const label = args.label ? String(args.label).toLowerCase() : null;
      const maxPri = typeof args.max_priority === "number" ? args.max_priority : null;
      const titles = Array.isArray(args.titles) ? args.titles.map((t: unknown) => String(t).toLowerCase()) : null;

      const targets = (data.tasks ?? []).filter((t) => {
        if (t.status === "complete") return false;
        if (titles && !titles.includes(t.title.toLowerCase())) return false;
        if (label && !(t.labels ?? []).some((l) => l.toLowerCase() === label)) return false;
        if (maxPri !== null && t.priority > maxPri) return false;
        if (!titles && !label && maxPri === null) return false; // Safety
        return true;
      });

      const completed: string[] = [];
      for (const t of targets) {
        try {
          await fetch(`${baseUrl}/api/tasks/${t.id}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "complete" }),
          });
          completed.push(t.title);
        } catch { /* skip */ }
      }
      return { completed, count: completed.length };
    }

    case "assignTask": {
      const taskId = String(args.id ?? "");
      if (!taskId || !/^[a-zA-Z0-9_-]+$/.test(taskId)) {
        return { error: "id must be a non-empty alphanumeric string" };
      }
      const assignedTo = args.assigned_to != null ? String(args.assigned_to) : null;
      if (assignedTo && !/^(ha_|custom_)/.test(assignedTo)) {
        return { error: "assigned_to must start with 'ha_' or 'custom_'" };
      }
      if (assignedTo && assignedTo.length > 255) {
        return { error: "assigned_to exceeds max length (255)" };
      }
      const res = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assigned_to: assignedTo }),
      });
      return { status: "assigned", ...(await res.json().catch(() => ({}))) };
    }

    case "listUsers": {
      const res = await fetch(`${baseUrl}/api/users`);
      return await res.json().catch(() => ({ users: [] }));
    }

    case "linkTask": {
      const res = await fetch(`${baseUrl}/api/tasks/${args.source_task_id}/links`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_task_id: args.target_task_id, link_type: args.link_type }),
      });
      return await res.json().catch(() => ({ error: "Failed to create link" }));
    }

    case "unlinkTask": {
      const res = await fetch(
        `${baseUrl}/api/tasks/${args.task_id}/links?link_id=${encodeURIComponent(String(args.link_id))}`,
        { method: "DELETE" },
      );
      return await res.json().catch(() => ({ error: "Failed to delete link" }));
    }

    case "getTaskLinks": {
      const res = await fetch(`${baseUrl}/api/tasks/${args.task_id}/links`);
      return await res.json().catch(() => ({ outbound: [], inbound: [] }));
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
