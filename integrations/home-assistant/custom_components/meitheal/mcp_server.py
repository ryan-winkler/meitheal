"""Meitheal MCP (Model Context Protocol) server endpoint.

Exposes Meitheal's task management as a live MCP server, allowing
any MCP-compatible agent (Claude, Antigravity, Codex, etc.) to
create, search, complete, and manage tasks programmatically.

Endpoint: POST /api/meitheal/mcp on Home Assistant's HTTP server, for a
Home Assistant administrator. The Meitheal App serves its own endpoint at
/api/mcp for agent tokens; this one lets a client that already signs in to
Home Assistant reach the same household without a second credential.

The MCP spec is tool-based: client sends a tool call, server executes
and returns the result. This module processes incoming tool calls and
routes them to the coordinator.

Tools (16 — separate from the HA LLM API surface):
  - createTask, searchTasks, completeTask, updateTask, deleteTask, getTask
  - getOverdueTasks, getTodaysTasks, getTaskSummary, dailyBriefing
  - getCalendarEvents, getUpcoming, batchComplete
  - linkTask, unlinkTask, getTaskLinks

@see https://modelcontextprotocol.io/
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

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
    request_body: dict[str, Any],
) -> dict[str, Any]:
    """Process an MCP tool call request.

    Expected request format:
    {
        "jsonrpc": "2.0",
        "id": "req-1",
        "method": "tools/call",
        "params": {
            "name": "createTask",
            "arguments": { "title": "Buy groceries" }
        }
    }

    Also supports:
    - "tools/list" — list available tools
    - "initialize" — handshake
    """
    method = request_body.get("method", "")
    req_id = request_body.get("id", "1")
    params = request_body.get("params", {})

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
        arguments = params.get("arguments", {})

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
        await coordinator.async_create_task(
            title=args["title"],
            description=args.get("description"),
            priority=args.get("priority"),
            due_date=args.get("due_date"),
            assigned_to=args.get("assigned_to"),
        )
        return {"status": "created", "title": args["title"]}

    elif tool_name == "completeTask":
        await coordinator.async_complete_task(
            task_id=args.get("id"),
            title=args.get("title"),
        )
        return {"status": "completed"}

    elif tool_name == "deleteTask":
        await coordinator.async_delete_task(task_id=args["id"])
        return {"status": "deleted"}

    elif tool_name == "updateTask":
        task_id = args["id"]
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
        today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
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
        now = datetime.now(timezone.utc)
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
        now = datetime.now(timezone.utc)
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
        now = datetime.now(timezone.utc)
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
            except Exception:
                pass
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
    from homeassistant.components.http import HomeAssistantView
except ImportError:
    HomeAssistantView = object
    web = None

MCP_VIEW_URL = "/api/meitheal/mcp"
# Largest request body the view reads; a tool call is a few hundred bytes.
_MAX_BODY_BYTES = 256 * 1024


def _rpc_error(req_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


async def async_handle_mcp_http(
    hass: Any, user: Any, body: Any
) -> tuple[int, dict[str, Any] | None]:
    """Answer one MCP message sent through Home Assistant's HTTP server.

    Home Assistant has already authenticated the caller. These tools can change
    and delete any task, so they are limited to administrators, the same rule as
    the Meitheal LLM APIs. The coordinator is looked up on each call so a
    reloaded or removed entry is never served from a stale object.
    """
    if user is None or not getattr(user, "is_active", False) or not getattr(user, "is_admin", False):
        return 403, _rpc_error(None, -32001, "Meitheal tools need a Home Assistant administrator")
    if not isinstance(body, dict) or not isinstance(body.get("method"), str):
        return 400, _rpc_error(None, -32600, "Invalid request")
    if "id" not in body:
        # A notification such as notifications/initialized expects no reply.
        return 202, None
    if body["method"] == "ping":
        return 200, {"jsonrpc": "2.0", "id": body["id"], "result": {}}
    params = body.get("params", {})
    if not isinstance(params, dict) or not isinstance(params.get("arguments", {}), dict):
        return 400, _rpc_error(body["id"], -32602, "Invalid params")

    from .const import DOMAIN

    coordinator = next(
        (
            entry.runtime_data
            for entry in hass.config_entries.async_loaded_entries(DOMAIN)
            if isinstance(getattr(entry, "runtime_data", None), MeithealCoordinator)
        ),
        None,
    )
    if coordinator is None:
        return 503, _rpc_error(body["id"], -32002, "Meitheal is not loaded")
    return 200, await handle_mcp_request(coordinator, {**body, "params": params})


class MeithealMcpView(HomeAssistantView):
    """Meitheal's MCP tools on Home Assistant's own HTTP server.

    An MCP client that is signed in to Home Assistant (a long-lived access token
    or Home Assistant's OAuth) reaches Meitheal here, with no second address or
    credential. Registered once and kept across config entry reloads.
    """

    url = MCP_VIEW_URL
    name = "api:meitheal:mcp"
    requires_auth = True

    def __init__(self, hass: Any) -> None:
        self.hass = hass

    async def post(self, request: web.Request) -> web.Response:
        """Handle one MCP JSON-RPC message."""
        if (request.content_length or 0) > _MAX_BODY_BYTES:
            return web.json_response(_rpc_error(None, -32600, "Request too large"), status=413)
        try:
            raw = await request.content.read(_MAX_BODY_BYTES + 1)
            if len(raw) > _MAX_BODY_BYTES:
                return web.json_response(_rpc_error(None, -32600, "Request too large"), status=413)
            body = json.loads(raw)
        except ValueError:
            return web.json_response(_rpc_error(None, -32700, "Parse error: invalid JSON"), status=400)

        status, response = await async_handle_mcp_http(self.hass, request.get("hass_user"), body)
        if response is None:
            return web.Response(status=status)
        return web.json_response(response, status=status)


def async_register_mcp_view(hass: Any) -> None:
    """Register the view once per Home Assistant run; views cannot be removed."""
    from .const import DOMAIN

    flag = f"{DOMAIN}_mcp_view"
    if hass.data.get(flag):
        return
    hass.http.register_view(MeithealMcpView(hass))
    hass.data[flag] = True
