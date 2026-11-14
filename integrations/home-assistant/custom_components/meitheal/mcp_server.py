"""Meitheal MCP (Model Context Protocol) server endpoint.

Exposes Meitheal's task management as a live MCP server, allowing
any MCP-compatible agent (Claude, Antigravity, Codex, etc.) to
create, search, complete, and manage tasks programmatically.

Endpoint: POST /api/meitheal/mcp (Home Assistant Core admin HTTP view)
App MCP: Separate bearer-authenticated endpoint discovered at GET /.well-known/mcp.json

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
import math
from datetime import UTC, datetime, timedelta
from typing import Any

from aiohttp import web
from homeassistant.components.http import (
    KEY_HASS,
    HomeAssistantView,
    require_admin,
)
from homeassistant.config_entries import ConfigEntryState

from .const import DOMAIN
from .coordinator import MeithealCoordinator

_LOGGER = logging.getLogger(__name__)

_DEFAULT_PROTOCOL_VERSION = "2025-03-26"
_SUPPORTED_PROTOCOL_VERSIONS = (
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
)

_VALID_STATUSES = [
    "backlog",
    "pending",
    "active",
    "complete",
    "todo",
    "in_progress",
    "done",
]
_VALID_LINK_TYPES = [
    "related_to",
    "blocked_by",
    "blocks",
    "duplicates",
    "duplicated_by",
]
_UPDATE_TASK_FIELDS = frozenset({"title", "status", "priority", "due_date", "description"})

# MCP tool definitions with full JSON Schema inputSchemas
MCP_TOOLS = [
    {
        "name": "createTask",
        "description": "Create a new task with title, description, priority, due date, and assignee",
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
                "q": {"type": "string", "description": "Search keyword (alias for query)"},
                "status": {"type": "string", "enum": _VALID_STATUSES},
                "priority": {"type": "integer", "minimum": 1, "maximum": 5},
                "include_completed": {"type": "boolean"},
            },
        },
    },
    {
        "name": "completeTask",
        "description": "Mark a task as done by ID or exact title",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Task UUID"},
                "title": {"type": "string", "description": "Exact task title (case-insensitive)"},
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
                "status": {"type": "string", "enum": _VALID_STATUSES},
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
        "description": "Get a daily briefing with active, due-today, overdue, and urgent tasks",
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
                "max_priority": {"type": "integer", "minimum": 1, "maximum": 5, "description": "Only affect tasks with priority <= this"},
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
                "link_type": {"type": "string", "enum": _VALID_LINK_TYPES, "description": "Relationship type"},
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

_TOOL_ALLOWED_FIELDS: dict[str, frozenset[str]] = {
    tool["name"]: frozenset(tool["inputSchema"].get("properties", {}).keys())
    for tool in MCP_TOOLS
}


def _is_valid_jsonrpc_id(raw_id: Any) -> bool:
    """Return True when raw_id is a valid JSON-RPC 2.0 id (string, finite number, or null)."""
    return raw_id is None or (
        not isinstance(raw_id, bool)
        and isinstance(raw_id, (str, int, float))
        and (not isinstance(raw_id, float) or math.isfinite(raw_id))
    )


async def handle_mcp_request(
    coordinator: MeithealCoordinator,
    request_body: Any,
    *,
    origin_kind: str | None = None,
    origin_name: str | None = None,
    origin_target: str | None = None,
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

    raw_id = request_body.get("id")
    valid_id = _is_valid_jsonrpc_id(raw_id)
    if request_body.get("jsonrpc") != "2.0" or ("id" in request_body and not valid_id):
        return {
            "jsonrpc": "2.0",
            "id": raw_id if valid_id else None,
            "error": {"code": -32600, "message": "Invalid Request: expected JSON-RPC 2.0 envelope"},
        }

    method = request_body.get("method")
    if not isinstance(method, str) or not method:
        return {
            "jsonrpc": "2.0",
            "id": raw_id,
            "error": {"code": -32600, "message": "Invalid Request: method must be a string"},
        }

    if "id" not in request_body:
        return None

    req_id = raw_id
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
        requested = params.get("protocolVersion")
        negotiated = (
            requested
            if isinstance(requested, str) and requested in _SUPPORTED_PROTOCOL_VERSIONS
            else _DEFAULT_PROTOCOL_VERSION
        )
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": negotiated,
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

        meta = params.get("_meta")
        meta_dict = meta if isinstance(meta, dict) else {}
        # An MCP caller can name its client, but cannot claim to be an HA automation,
        # script or voice agent: those kinds are set only by the integration itself.
        effective_kind = origin_kind or "mcp"
        effective_name = (
            meta_dict.get("origin_name") if isinstance(meta_dict.get("origin_name"), str) else None
        ) or origin_name or "Home Assistant MCP"
        effective_target = (
            meta_dict.get("origin_target") if isinstance(meta_dict.get("origin_target"), str) else None
        ) or origin_target

        try:
            result = await _execute_tool(
                coordinator,
                tool_name,
                arguments,
                origin_kind=effective_kind,
                origin_name=effective_name,
                origin_target=effective_target,
            )
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": json.dumps(result)}],
                    "isError": False,
                },
            }
        except ValueError as err:
            _LOGGER.debug("MCP tool %s rejected invalid arguments: %s", tool_name, err)
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": str(err)}],
                    "isError": True,
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


def _require_str(args: dict[str, Any], key: str, tool_name: str) -> str:
    """Validate and return a required non-empty string argument."""
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{tool_name} requires a non-empty string {key}")
    return value.strip()


def _optional_str(
    args: dict[str, Any], key: str, tool_name: str, *, non_empty: bool = False
) -> str | None:
    """Validate an optional string argument, rejecting non-strings and empty values when requested."""
    if key not in args or args[key] is None:
        return None
    value = args[key]
    if not isinstance(value, str) or (non_empty and not value.strip()):
        qualifier = "non-empty string" if non_empty else "string"
        raise ValueError(f"{tool_name} {key} must be a {qualifier}")
    return value.strip() if non_empty else value


def _parse_days_ahead(args: dict[str, Any], tool_name: str) -> int:
    """Validate bounded day lookahead for calendar and upcoming queries."""
    days = args.get("days_ahead", 7)
    if type(days) is not int or not 1 <= days <= 30:
        raise ValueError(f"{tool_name} days_ahead must be an integer between 1 and 30")
    return days


def _parse_optional_priority(args: dict[str, Any], tool_name: str) -> int | None:
    """Validate optional priority argument against the 1-5 integer contract."""
    priority = args.get("priority")
    if priority is None:
        return None
    if type(priority) is not int or not 1 <= priority <= 5:
        raise ValueError(f"{tool_name} priority must be an integer between 1 and 5")
    return priority


async def _execute_tool(
    coordinator: MeithealCoordinator,
    tool_name: str,
    args: dict[str, Any],
    *,
    origin_kind: str = "mcp",
    origin_name: str = "Home Assistant MCP",
    origin_target: str | None = None,
) -> Any:
    """Execute an MCP tool and return the result."""
    # Provenance comes from the call context, never from tool arguments.
    origin_kwargs = {
        "origin_kind": origin_kind,
        "origin_name": origin_name,
        "origin_target": origin_target,
    }
    allowed_fields = _TOOL_ALLOWED_FIELDS.get(tool_name)
    if allowed_fields is not None:
        unknown_fields = sorted(set(args) - allowed_fields)
        if unknown_fields:
            raise ValueError(f"{tool_name} received unsupported fields: {', '.join(unknown_fields)}")

    if tool_name == "createTask":
        title = _require_str(args, "title", "createTask")
        description = _optional_str(args, "description", "createTask")
        priority = _parse_optional_priority(args, "createTask")
        due_date = _optional_str(args, "due_date", "createTask", non_empty=True)
        assigned_to = _optional_str(args, "assigned_to", "createTask", non_empty=True)
        await coordinator.async_create_task(
            title=title,
            description=description,
            priority=priority,
            due_date=due_date,
            assigned_to=assigned_to,
            **origin_kwargs,
        )
        return {"status": "created", "title": title}

    elif tool_name == "completeTask":
        task_id = _optional_str(args, "id", "completeTask", non_empty=True)
        title = _optional_str(args, "title", "completeTask", non_empty=True)
        if not task_id and not title:
            raise ValueError("completeTask requires id or title")
        await coordinator.async_complete_task(
            task_id=task_id,
            title=title,
            **origin_kwargs,
        )
        return {"status": "completed"}

    elif tool_name == "deleteTask":
        task_id = _require_str(args, "id", "deleteTask")
        await coordinator.async_delete_task(task_id=task_id, **origin_kwargs)
        return {"status": "deleted"}

    elif tool_name == "updateTask":
        task_id = _require_str(args, "id", "updateTask")
        for field_name in _UPDATE_TASK_FIELDS:
            if field_name in args and args[field_name] is None:
                raise ValueError(f"updateTask {field_name} cannot be null")
        title = _optional_str(args, "title", "updateTask", non_empty=True)
        due_date = _optional_str(args, "due_date", "updateTask", non_empty=True)
        description = _optional_str(args, "description", "updateTask")
        status = args.get("status")
        if status is not None and (not isinstance(status, str) or status not in _VALID_STATUSES):
            raise ValueError(f"updateTask status must be one of: {', '.join(_VALID_STATUSES)}")
        priority = _parse_optional_priority(args, "updateTask")
        updates: dict[str, Any] = {}
        if title is not None:
            updates["title"] = title
        if status is not None:
            updates["status"] = status
        if priority is not None:
            updates["priority"] = priority
        if due_date is not None:
            updates["due_date"] = due_date
        if description is not None:
            updates["description"] = description
        if not updates:
            raise ValueError("updateTask requires at least one updatable field")
        await coordinator.async_update_task(task_id, updates, **origin_kwargs)
        return {"status": "updated", "id": task_id}

    elif tool_name == "searchTasks":
        if not coordinator:
            return {"tasks": []}
        query_val = _optional_str(args, "query", "searchTasks")
        q_val = _optional_str(args, "q", "searchTasks")
        query = q_val if q_val is not None else (query_val if query_val is not None else "")
        status = args.get("status")
        if status is not None and (not isinstance(status, str) or status not in _VALID_STATUSES):
            raise ValueError(f"searchTasks status must be one of: {', '.join(_VALID_STATUSES)}")
        priority = _parse_optional_priority(args, "searchTasks")
        include_completed = args.get("include_completed")
        if include_completed is not None and type(include_completed) is not bool:
            raise ValueError("searchTasks include_completed must be a boolean")
        return await coordinator.async_search_tasks(
            query=query,
            status=status,
            priority=priority,
            include_completed=include_completed,
        )

    elif tool_name == "getTask":
        task_id = _require_str(args, "id", "getTask")
        if not coordinator.data:
            raise ValueError("No task data available")
        for t in coordinator.data.tasks:
            if t.id == task_id:
                return {
                    "id": t.id, "title": t.title, "status": t.status,
                    "priority": t.priority, "due_date": t.due_date,
                    "description": t.description, "labels": t.labels,
                    "created_at": t.created_at, "updated_at": t.updated_at,
                    "is_overdue": t.is_overdue,
                }
        raise ValueError(f"Task {task_id} not found")

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
        days_ahead = _parse_days_ahead(args, "getCalendarEvents")
        if not coordinator.data:
            return {"events": [], "count": 0}
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
        days_ahead = _parse_days_ahead(args, "getUpcoming")
        if not coordinator.data:
            return {"items": [], "count": 0}
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
        action = args.get("action", "complete")
        if action not in ("complete", "list_completed"):
            raise ValueError("batchComplete action must be 'complete' or 'list_completed'")
        label = args.get("label")
        if label is not None and not isinstance(label, str):
            raise ValueError("batchComplete label must be a string")
        max_priority = args.get("max_priority")
        if max_priority is not None and (type(max_priority) is not int or not 1 <= max_priority <= 5):
            raise ValueError("batchComplete max_priority must be an integer between 1 and 5")
        titles = args.get("titles", [])
        if not isinstance(titles, list) or not all(isinstance(x, str) for x in titles):
            raise ValueError("batchComplete titles must be a list of strings")
        if not coordinator.data:
            raise ValueError("No task data available")

        if action == "list_completed":
            done = [
                {"title": t.title, "updated": t.updated_at}
                for t in coordinator.data.tasks if t.status == "done"
            ]
            return {"completed_tasks": done[:10], "total_done": len(done)}

        title_set = {x.lower() for x in titles}
        targets = []
        for t in coordinator.data.tasks:
            if t.status == "done":
                continue
            if title_set and t.title.lower() not in title_set:
                continue
            if label and label.lower() not in [lb.lower() for lb in t.labels]:
                continue
            if max_priority is not None and t.priority > max_priority:
                continue
            if not title_set and not label and max_priority is None:
                continue  # Safety: require at least one filter
            targets.append(t)

        completed = []
        for t in targets:
            try:
                await coordinator.async_complete_task(task_id=t.id, **origin_kwargs)
                completed.append(t.title)
            except Exception as err:
                _LOGGER.debug("batchComplete failed for task %s: %s", t.id, err)
        return {"completed": completed, "count": len(completed)}

    elif tool_name == "linkTask":
        source_task_id = _require_str(args, "source_task_id", "linkTask")
        target_task_id = _require_str(args, "target_task_id", "linkTask")
        link_type = _require_str(args, "link_type", "linkTask")
        if link_type not in _VALID_LINK_TYPES:
            raise ValueError(f"linkTask link_type must be one of: {', '.join(_VALID_LINK_TYPES)}")
        return await coordinator.async_link_task(
            source_task_id=source_task_id,
            target_task_id=target_task_id,
            link_type=link_type,
        )

    elif tool_name == "unlinkTask":
        task_id = _require_str(args, "task_id", "unlinkTask")
        link_id = _require_str(args, "link_id", "unlinkTask")
        return await coordinator.async_unlink_task(
            task_id=task_id,
            link_id=link_id,
        )

    elif tool_name == "getTaskLinks":
        task_id = _require_str(args, "task_id", "getTaskLinks")
        return await coordinator.async_get_task_links(task_id=task_id)

    else:
        raise ValueError(f"Unknown tool: {tool_name}")


def _resolve_loaded_coordinator(hass: Any) -> MeithealCoordinator | None:
    """Resolve the active Meitheal coordinator from ConfigEntry.runtime_data."""
    if hass is None:
        return None
    for entry in hass.config_entries.async_entries(DOMAIN):
        coordinator = getattr(entry, "runtime_data", None)
        if entry.state is ConfigEntryState.LOADED and coordinator is not None:
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

        raw_id = body.get("id")
        safe_id = raw_id if _is_valid_jsonrpc_id(raw_id) else None
        coordinator = _resolve_loaded_coordinator(request.app.get(KEY_HASS))
        if coordinator is None:
            return web.json_response(
                {
                    "jsonrpc": "2.0",
                    "id": safe_id,
                    "error": {
                        "code": -32000,
                        "message": "Meitheal integration is not loaded",
                    },
                },
                status=503,
            )

        response = await handle_mcp_request(
            coordinator,
            body,
            origin_kind="mcp",
            origin_name=request.headers.get("X-Meitheal-Origin-Name") or "Home Assistant MCP",
            origin_target=request.headers.get("X-Meitheal-Origin-Target"),
        )
        if response is None:
            return web.Response(status=202)
        return web.json_response(response)
