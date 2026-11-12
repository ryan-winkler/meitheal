"""Meitheal MCP (Model Context Protocol) server endpoint.

Exposes Meitheal's task management as a live MCP server, allowing
any MCP-compatible agent (Claude, Antigravity, Codex, etc.) to
create, search, complete, and manage tasks programmatically.

Endpoint: POST /api/meitheal/mcp (via Home Assistant HTTP view)
Discovery: GET /.well-known/mcp.json (webapp discovery endpoint)

The MCP spec is tool-based: client sends a tool call, server executes
and returns the result. This module processes incoming tool calls and
routes them to the coordinator.

Tools (16 — separate from the HA LLM API surface):
  - createTask, searchTasks, completeTask, updateTask, deleteTask, getTask
  - getOverdueTasks, getTodaysTasks, getTaskSummary, dailyBriefing
  - getCalendarEvents, getUpcoming, batchComplete
  - linkTask, unlinkTask, getTaskLinks

See: https://modelcontextprotocol.io/
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from .const import DOMAIN
from .coordinator import MeithealCoordinator

_LOGGER = logging.getLogger(__name__)

# MCP tool definitions with full JSON Schema inputSchemas
MCP_TOOLS = [
    {
        "name": "createTask",
        "description": "Create a new task with title, description, priority, labels, and due date",
        "inputSchema": {
            "type": "object",
            "required": ["title"],
            "properties": {
                "title": {"type": "string", "description": "Task title"},
                "description": {"type": "string", "description": "Task description"},
                "priority": {"type": "integer", "minimum": 1, "maximum": 5, "description": "Priority 1-5 (1=urgent)"},
                "due_date": {"type": "string", "format": "date", "description": "Due date YYYY-MM-DD"},
                "assigned_to": {"type": "string", "description": "Assignee identifier (user ID or agent ID)"},
            },
        },
    },
    {
        "name": "searchTasks",
        "description": "Search tasks by keyword, status, priority, labels, custom fields, comments, or task IDs",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search keyword"},
                "status": {"type": "string", "enum": ["backlog", "todo", "in_progress", "done", "cancelled"]},
                "priority": {"type": "integer", "minimum": 1, "maximum": 5},
                "include_completed": {"type": "boolean"},
            },
        },
    },
    {
        "name": "completeTask",
        "description": "Mark a task as done by ID or title",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Task UUID"},
                "title": {"type": "string", "description": "Task title (fuzzy match)"},
            },
        },
    },
    {
        "name": "updateTask",
        "description": "Update task fields (title, status, priority, due_date, description)",
        "inputSchema": {
            "type": "object",
            "required": ["id"],
            "properties": {
                "id": {"type": "string", "description": "Task UUID"},
                "title": {"type": "string"},
                "status": {"type": "string", "enum": ["backlog", "todo", "in_progress", "done", "cancelled"]},
                "priority": {"type": "integer", "minimum": 1, "maximum": 5},
                "due_date": {"type": "string", "format": "date"},
                "description": {"type": "string"},
            },
        },
    },
    {
        "name": "deleteTask",
        "description": "Delete a task by ID",
        "inputSchema": {
            "type": "object",
            "required": ["id"],
            "properties": {
                "id": {"type": "string", "description": "Task UUID"},
            },
        },
    },
    {
        "name": "getTask",
        "description": "Get full details of a specific task by ID",
        "inputSchema": {
            "type": "object",
            "required": ["id"],
            "properties": {
                "id": {"type": "string", "description": "Task UUID"},
            },
        },
    },
    {
        "name": "getOverdueTasks",
        "description": "Get all overdue tasks — tasks past their due date that aren't done",
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "getTodaysTasks",
        "description": "Get tasks due today plus any overdue tasks",
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "getTaskSummary",
        "description": "Get summary counts: total, active, overdue, done",
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "dailyBriefing",
        "description": "Get a comprehensive daily briefing with tasks, calendar, weather, and who's home",
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "getCalendarEvents",
        "description": "Get events from HA calendar synced into Meitheal",
        "inputSchema": {
            "type": "object",
            "properties": {
                "days_ahead": {"type": "integer", "minimum": 1, "maximum": 30, "description": "Days ahead (default: 7)"},
            },
        },
    },
    {
        "name": "getUpcoming",
        "description": "Get all upcoming tasks and calendar events combined",
        "inputSchema": {
            "type": "object",
            "properties": {
                "days_ahead": {"type": "integer", "minimum": 1, "maximum": 30, "description": "Days ahead (default: 7)"},
            },
        },
    },
    {
        "name": "batchComplete",
        "description": "Complete multiple tasks at once by label or priority filter",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["complete", "list_completed"], "description": "'complete' or 'list_completed'"},
                "label": {"type": "string", "description": "Only affect tasks with this label"},
                "max_priority": {"type": "integer", "description": "Only affect tasks with priority <= this"},
                "titles": {"type": "array", "items": {"type": "string"}, "description": "Specific task titles to complete"},
            },
        },
    },
    {
        "name": "linkTask",
        "description": "Create a Jira-style link between two tasks. Link types: related_to, blocked_by, blocks, duplicates, duplicated_by",
        "inputSchema": {
            "type": "object",
            "required": ["source_task_id", "target_task_id", "link_type"],
            "properties": {
                "source_task_id": {"type": "string", "description": "Source task UUID"},
                "target_task_id": {"type": "string", "description": "Target task UUID"},
                "link_type": {"type": "string", "enum": ["related_to", "blocked_by", "blocks", "duplicates", "duplicated_by"], "description": "Relationship type"},
            },
        },
    },
    {
        "name": "unlinkTask",
        "description": "Remove a link between two tasks by link ID",
        "inputSchema": {
            "type": "object",
            "required": ["task_id", "link_id"],
            "properties": {
                "task_id": {"type": "string", "description": "Task UUID the link belongs to"},
                "link_id": {"type": "string", "description": "Link UUID to remove"},
            },
        },
    },
    {
        "name": "getTaskLinks",
        "description": "Get all outbound and inbound links for a task",
        "inputSchema": {
            "type": "object",
            "required": ["task_id"],
            "properties": {
                "task_id": {"type": "string", "description": "Task UUID"},
            },
        },
    },
]


async def handle_mcp_request(
    coordinator: MeithealCoordinator,
    request_body: Any,
) -> dict[str, Any] | None:
    """Process an MCP tool call request.

    Returns a JSON-RPC response dict, or None for notifications that must not
    receive a response per the JSON-RPC 2.0 / MCP lifecycle specification.
    """
    if not isinstance(request_body, dict):
        return {
            "jsonrpc": "2.0",
            "id": None,
            "error": {"code": -32600, "message": "Invalid Request: expected JSON object"},
        }

    method = request_body.get("method")
    if not isinstance(method, str) or not method:
        return {
            "jsonrpc": "2.0",
            "id": request_body.get("id"),
            "error": {"code": -32600, "message": "Invalid Request: method must be a string"},
        }

    if "id" not in request_body or method.startswith("notifications/"):
        if "id" not in request_body:
            return None

    req_id = request_body.get("id", "1")
    raw_params = request_body.get("params")
    if raw_params is None:
        params: dict[str, Any] = {}
    elif isinstance(raw_params, dict):
        params = raw_params
    else:
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32602, "message": "Invalid params: expected object"},
        }

    # Handshake
    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {
                    "name": "meitheal",
                    "version": "0.3.0",
                },
            },
        }

    if method == "ping":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {},
        }

    # List tools
    if method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"tools": MCP_TOOLS},
        }

    # Execute tool
    if method == "tools/call":
        tool_name = params.get("name", "")
        raw_arguments = params.get("arguments")
        if raw_arguments is None:
            arguments: dict[str, Any] = {}
        elif isinstance(raw_arguments, dict):
            arguments = raw_arguments
        else:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32602, "message": "Invalid params: arguments must be an object"},
            }
        if not isinstance(tool_name, str) or not tool_name:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32602, "message": "Invalid params: tool name is required"},
            }

        try:
            result = await _execute_tool(coordinator, tool_name, arguments)
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": json.dumps(result)}],
                    "isError": False,
                },
            }
        except Exception as err:
            _LOGGER.error("MCP tool %s failed: %s", tool_name, err)
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": str(err)}],
                    "isError": True,
                },
            }

    # Unknown method
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": -32601, "message": f"Unknown method: {method}"},
    }


async def _execute_tool(
    coordinator: MeithealCoordinator,
    tool_name: str,
    args: dict[str, Any],
) -> Any:
    """Execute an MCP tool and return the result."""

    if tool_name == "createTask":
        title = args.get("title")
        if not isinstance(title, str) or not title.strip():
            raise ValueError("createTask requires a non-empty string title")
        await coordinator.async_create_task(
            title=title,
            description=args.get("description"),
            priority=args.get("priority"),
            due_date=args.get("due_date"),
            assigned_to=args.get("assigned_to"),
        )
        return {"status": "created", "title": title}

    elif tool_name == "completeTask":
        await coordinator.async_complete_task(
            task_id=args.get("id"),
            title=args.get("title"),
        )
        return {"status": "completed"}

    elif tool_name == "deleteTask":
        task_id = args.get("id")
        if not isinstance(task_id, str) or not task_id.strip():
            raise ValueError("deleteTask requires a non-empty string id")
        await coordinator.async_delete_task(task_id=task_id)
        return {"status": "deleted"}

    elif tool_name == "updateTask":
        task_id = args.get("id")
        if not isinstance(task_id, str) or not task_id.strip():
            raise ValueError("updateTask requires a non-empty string id")
        updates = {k: v for k, v in args.items() if k != "id"}
        await coordinator.async_update_task(task_id, updates)
        return {"status": "updated", "id": task_id}

    elif tool_name == "searchTasks":
        if not coordinator:
            return {"tasks": []}
        return await coordinator.async_search_tasks(
            query=args.get("query", ""),
            status=args.get("status"),
            priority=args.get("priority"),
            include_completed=args.get("include_completed", False),
        )

    elif tool_name == "getTask":
        if not coordinator.data:
            raise ValueError("No task data available")
        for t in coordinator.data.tasks:
            if t.id == args["id"]:
                return {
                    "id": t.id, "title": t.title, "status": t.status,
                    "priority": t.priority, "due_date": t.due_date,
                    "description": t.description, "labels": t.labels,
                    "created_at": t.created_at, "updated_at": t.updated_at,
                    "is_overdue": t.is_overdue,
                }
        raise ValueError(f"Task {args['id']} not found")

    elif tool_name == "getOverdueTasks":
        if not coordinator.data:
            return {"tasks": [], "count": 0}
        overdue = [
            {"id": t.id, "title": t.title, "due_date": t.due_date, "priority": t.priority}
            for t in coordinator.data.tasks if t.is_overdue
        ]
        return {"tasks": overdue, "count": len(overdue)}

    elif tool_name == "getTodaysTasks":
        if not coordinator.data:
            return {"tasks": [], "count": 0}
        today_str = datetime.now().astimezone().strftime("%Y-%m-%d")
        results = []
        for t in coordinator.data.tasks:
            if t.status == "done":
                continue
            if t.is_overdue or (t.due_date and t.due_date.startswith(today_str)):
                results.append({
                    "id": t.id, "title": t.title, "due_date": t.due_date,
                    "priority": t.priority, "is_overdue": t.is_overdue,
                })
        return {"tasks": results, "count": len(results)}

    elif tool_name == "getTaskSummary":
        if not coordinator.data:
            return {"total": 0, "active": 0, "overdue": 0, "done": 0}
        data = coordinator.data
        done = sum(1 for t in data.tasks if t.status == "done")
        return {
            "total": data.total_count, "active": data.active_count,
            "overdue": data.overdue_count, "done": done,
        }

    elif tool_name == "dailyBriefing":
        if not coordinator.data:
            return {"greeting": "Hello", "tasks": {"active": 0, "overdue": 0, "total": 0}}
        now = datetime.now().astimezone()
        today_str = now.strftime("%Y-%m-%d")
        hour = now.hour
        greeting = "Good morning" if hour < 12 else ("Good afternoon" if hour < 17 else "Good evening")
        data = coordinator.data
        today_tasks = [
            {"title": t.title, "priority": t.priority}
            for t in data.tasks
            if t.status != "done" and t.due_date and t.due_date.startswith(today_str)
        ][:5]
        overdue = [
            {"title": t.title, "due_date": t.due_date}
            for t in data.tasks if t.is_overdue
        ][:5]
        urgent = [
            {"title": t.title, "priority": t.priority}
            for t in data.tasks if t.status != "done" and t.priority <= 2
        ][:3]
        return {
            "greeting": greeting,
            "date": now.strftime("%A, %B %d"),
            "tasks": {"active": data.active_count, "overdue": data.overdue_count, "total": data.total_count},
            "today_tasks": today_tasks,
            "overdue_tasks": overdue,
            "urgent_items": urgent,
        }

    elif tool_name == "getCalendarEvents":
        if not coordinator.data:
            return {"events": [], "count": 0}
        days_ahead = args.get("days_ahead", 7)
        now = datetime.now(UTC)
        cutoff = now + timedelta(days=days_ahead)
        today_str = now.strftime("%Y-%m-%d")
        cutoff_str = cutoff.strftime("%Y-%m-%d")
        events = []
        for t in coordinator.data.tasks:
            sync_state = getattr(t, "calendar_sync_state", None)
            if sync_state not in ("synced", "confirmed"):
                continue
            if t.due_date and today_str <= t.due_date[:10] <= cutoff_str:
                events.append({
                    "title": t.title, "date": t.due_date,
                    "description": t.description or "", "source": "ha_calendar",
                })
        events.sort(key=lambda e: e["date"])
        return {"events": events, "count": len(events)}

    elif tool_name == "getUpcoming":
        if not coordinator.data:
            return {"items": [], "count": 0}
        days_ahead = args.get("days_ahead", 7)
        now = datetime.now(UTC)
        cutoff = now + timedelta(days=days_ahead)
        today_str = now.strftime("%Y-%m-%d")
        cutoff_str = cutoff.strftime("%Y-%m-%d")
        items = []
        for t in coordinator.data.tasks:
            if t.status == "done" or not t.due_date:
                continue
            due_str = t.due_date[:10]
            if due_str < today_str or due_str > cutoff_str:
                continue
            sync_state = getattr(t, "calendar_sync_state", None)
            items.append({
                "title": t.title, "date": t.due_date,
                "type": "calendar_event" if sync_state in ("synced", "confirmed") else "task",
                "priority": t.priority, "is_overdue": t.is_overdue,
            })
        items.sort(key=lambda e: e["date"])
        return {
            "items": items, "count": len(items),
            "calendar_events": sum(1 for i in items if i["type"] == "calendar_event"),
            "tasks": sum(1 for i in items if i["type"] == "task"),
        }

    elif tool_name == "batchComplete":
        if not coordinator.data:
            return {"error": "No task data available"}
        action = args.get("action", "complete")
        label = args.get("label")
        max_priority = args.get("max_priority")
        titles = args.get("titles", [])

        if action == "list_completed":
            done = [
                {"title": t.title, "updated": t.updated_at}
                for t in coordinator.data.tasks if t.status == "done"
            ]
            return {"completed_tasks": done[:10], "total_done": len(done)}

        targets = []
        for t in coordinator.data.tasks:
            if t.status == "done":
                continue
            if titles and t.title.lower() not in [x.lower() for x in titles]:
                continue
            if label and label.lower() not in [lb.lower() for lb in t.labels]:
                continue
            if max_priority and t.priority > max_priority:
                continue
            if not titles and not label and not max_priority:
                continue  # Safety: require at least one filter
            targets.append(t)

        completed = []
        for t in targets:
            try:
                await coordinator.async_complete_task(task_id=t.id)
                completed.append(t.title)
            except Exception as err:
                _LOGGER.debug("batchComplete failed for task %s: %s", t.id, err)
        return {"completed": completed, "count": len(completed)}

    elif tool_name == "linkTask":
        result = await coordinator.async_link_task(
            source_task_id=args["source_task_id"],
            target_task_id=args["target_task_id"],
            link_type=args["link_type"],
        )
        return result

    elif tool_name == "unlinkTask":
        result = await coordinator.async_unlink_task(
            task_id=args["task_id"],
            link_id=args["link_id"],
        )
        return result

    elif tool_name == "getTaskLinks":
        result = await coordinator.async_get_task_links(task_id=args["task_id"])
        return result

    else:
        raise ValueError(f"Unknown tool: {tool_name}")


try:
    from aiohttp import web
    from homeassistant.components.http import (
        KEY_HASS,
        HomeAssistantView,
        require_admin,
    )
    from homeassistant.config_entries import ConfigEntryState
except ImportError:
    HomeAssistantView = object
    KEY_HASS = "hass"
    ConfigEntryState = None
    web = None

    def require_admin(func: Callable[..., Any]) -> Callable[..., Any]:  # type: ignore[no-redef]
        """No-op fallback when Home Assistant HTTP helpers are unavailable."""
        return func


def _resolve_loaded_coordinator(hass: Any) -> MeithealCoordinator | None:
    """Resolve the active Meitheal coordinator from ConfigEntry.runtime_data."""
    if hass is None:
        return None
    for entry in hass.config_entries.async_entries(DOMAIN):
        is_loaded = (
            ConfigEntryState is None or entry.state is ConfigEntryState.LOADED
        )
        coordinator = getattr(entry, "runtime_data", None)
        if is_loaded and coordinator is not None:
            return coordinator
    return None


class MeithealMcpView(HomeAssistantView):
    """Administrator-only view for MCP JSON-RPC requests over Home Assistant HTTP."""

    url = "/api/meitheal/mcp"
    name = "api:meitheal:mcp"
    requires_auth = True

    @require_admin
    async def post(self, request: web.Request) -> web.Response:
        """Handle incoming MCP JSON-RPC call."""
        try:
            body = await request.json()
        except Exception:
            return web.json_response(
                {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {"code": -32700, "message": "Parse error: invalid JSON"},
                },
                status=400,
            )

        if not isinstance(body, dict):
            return web.json_response(
                {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {
                        "code": -32600,
                        "message": "Invalid Request: expected JSON object",
                    },
                },
                status=400,
            )

        coordinator = _resolve_loaded_coordinator(request.app.get(KEY_HASS))
        if coordinator is None:
            return web.json_response(
                {
                    "jsonrpc": "2.0",
                    "id": body.get("id"),
                    "error": {
                        "code": -32000,
                        "message": "Meitheal integration is not loaded",
                    },
                },
                status=503,
            )

        response = await handle_mcp_request(coordinator, body)
        if response is None:
            return web.Response(status=202)
        return web.json_response(response)
