import type { APIRoute } from "astro";
import { apiJson, apiError } from "../../lib/api-response";
import { getMcpTools, getToolByName, getToolCount } from "@meitheal/integration-core";

/**
 * POST /api/mcp — MCP (Model Context Protocol) Server Endpoint
 *
 * Accepts JSON-RPC 2.0 tool calls per the MCP specification.
 * Routes incoming tool requests to the Meitheal task API.
 *
 * Tool definitions come from the shared tool-registry in integration-core.
 * This endpoint is a thin JSON-RPC adapter — all business logic delegates
 * to internal REST API routes.
 *
 * Supports:
 * - "initialize" — handshake
 * - "tools/list" — enumerate available tools (from shared registry)
 * - "tools/call" — execute a tool
 *
 * @see https://modelcontextprotocol.io/
 * @see /.well-known/mcp.json for static discovery
 * @domain integration-core (tool definitions)
 */

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
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "meitheal", version: "0.3.0", toolCount: getToolCount() },
        },
      });
    }

    // List tools
    if (method === "tools/list") {
      return apiJson({
        jsonrpc: "2.0",
        id: reqId,
        result: { tools: getMcpTools() },
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

    // ─── Hierarchy (Areas, Goals, Projects) ───

    case "listAreas": {
      const res = await fetch(`${baseUrl}/api/areas`);
      return await res.json().catch(() => ({ areas: [] }));
    }

    case "listGoals": {
      const params = new URLSearchParams();
      if (args.area_id) params.set("area_id", String(args.area_id));
      const res = await fetch(`${baseUrl}/api/goals?${params}`);
      return await res.json().catch(() => ({ goals: [] }));
    }

    case "moveTask": {
      const taskId = String(args.task_id ?? "");
      const payload: Record<string, unknown> = {};
      if (args.project_id) payload.project_id = args.project_id;
      if (args.area_id) payload.area_id = args.area_id;
      const res = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { status: "moved", ...(await res.json().catch(() => ({}))) };
    }

    case "setGoalProgress": {
      const goalId = String(args.goal_id ?? "");
      const res = await fetch(`${baseUrl}/api/goals/${goalId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ progress: args.progress }),
      });
      return { status: "updated", ...(await res.json().catch(() => ({}))) };
    }

    // ─── Habits ───

    case "getHabits": {
      const res = await fetch(`${baseUrl}/api/habits`);
      return await res.json().catch(() => ({ habits: [] }));
    }

    case "completeHabit": {
      const res = await fetch(`${baseUrl}/api/habits`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ templateId: args.templateId, action: "complete" }),
      });
      return { status: "completed", ...(await res.json().catch(() => ({}))) };
    }

    // ─── Reviews ───

    case "getWeeklyReview": {
      const res = await fetch(`${baseUrl}/api/review/weekly`);
      return await res.json().catch(() => ({ completed_last_week: [], upcoming: [] }));
    }

    // ─── Scoring/Frameworks ───

    case "scoreTask": {
      const taskId = String(args.task_id ?? "");
      const res = await fetch(`${baseUrl}/api/tasks/${taskId}/score`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          framework: args.framework,
          reach: args.reach,
          impact: args.impact,
          confidence: args.confidence,
          effort: args.effort,
        }),
      });
      return await res.json().catch(() => ({ error: "Scoring failed" }));
    }

    // ─── Export ───

    case "exportTasks": {
      const params = new URLSearchParams();
      if (args.format) params.set("format", String(args.format));
      if (args.status) params.set("status", String(args.status));
      const res = await fetch(`${baseUrl}/api/export/tasks?${params}`);
      return await res.json().catch(() => ({ error: "Export failed" }));
    }

    // ─── Labels ───

    case "listLabels": {
      const res = await fetch(`${baseUrl}/api/labels`);
      return await res.json().catch(() => ({ labels: [] }));
    }

    // ─── Daily Briefing ───

    case "dailyBriefing": {
      // Compose a briefing from today's tasks + overdue + calendar
      const [tasksRes, calendarRes] = await Promise.all([
        fetch(`${baseUrl}/api/tasks`),
        fetch(`${baseUrl}/api/tasks?calendar_synced=true`),
      ]);
      const taskData = (await tasksRes.json().catch(() => ({ tasks: [] }))) as {
        tasks: Array<{ title: string; status: string; due_date: string; priority: number }>
      };
      const calData = (await calendarRes.json().catch(() => ({ tasks: [] }))) as {
        tasks: Array<{ title: string; due_date: string; calendar_sync_state: string }>
      };
      const today = new Date().toISOString().slice(0, 10);
      const todayTasks = (taskData.tasks ?? []).filter(
        (t) => t.status !== "complete" && t.due_date && t.due_date.slice(0, 10) <= today
      );
      const calEvents = (calData.tasks ?? []).filter(
        (t) => t.calendar_sync_state === "synced" && t.due_date && t.due_date.slice(0, 10) === today
      );
      return {
        date: today,
        tasks_today: todayTasks.length,
        overdue: todayTasks.filter((t) => t.due_date.slice(0, 10) < today).length,
        calendar_events: calEvents.length,
        tasks: todayTasks.map((t) => ({ title: t.title, due: t.due_date, priority: t.priority })),
        events: calEvents.map((t) => ({ title: t.title, time: t.due_date })),
      };
    }

    // ─── HA Entity State ───

    case "getEntityState": {
      const entityId = String(args.entity_id ?? "");
      const res = await fetch(`${baseUrl}/api/ha/entity?entity_id=${encodeURIComponent(entityId)}`);
      return await res.json().catch(() => ({ error: `Entity ${entityId} not found` }));
    }

    default: {
      // Check if tool exists in registry but has no handler yet
      const registryTool = getToolByName(toolName);
      if (registryTool) {
        return { error: `Tool '${toolName}' is registered but handler not yet implemented`, tool: registryTool.name };
      }
      return { error: `Unknown tool: ${toolName}` };
    }
  }
}
