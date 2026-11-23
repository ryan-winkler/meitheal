"""Meitheal MCP (Model Context Protocol) server endpoint.

Exposes Meitheal's task management as a live MCP server, allowing
any MCP-compatible agent (Claude, Antigravity, Codex, etc.) to
create, search, complete, and manage tasks programmatically.

Endpoint: POST /api/meitheal/mcp (Home Assistant Core admin HTTP view)
App MCP: Separate bearer-authenticated endpoint discovered at GET /.well-known/mcp.json

The MCP spec is tool-based: client sends a tool call, server executes
and returns the result. This module processes incoming tool calls and
routes them to the coordinator.

Tools (18 — separate from the HA LLM API surface):
  - createTask, searchTasks, completeTask, updateTask, deleteTask, getTask
  - getOverdueTasks, getTodaysTasks, getTaskSummary, dailyBriefing
  - getCalendarEvents, getUpcoming, batchComplete
  - linkTask, unlinkTask, getTaskLinks
  - listRoutines, completeRoutine

See: https://modelcontextprotocol.io/
"""

from __future__ import annotations

import json
import logging
import math
from datetime import date, datetime, timedelta
from typing import Any
from urllib.parse import unquote

from aiohttp import web
from homeassistant.components.http import (
    KEY_HASS,
    KEY_HASS_USER,
    HomeAssistantView,
    require_admin,
)
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import Context
from homeassistant.exceptions import HomeAssistantError
from homeassistant.loader import async_get_integration
from homeassistant.util import dt as dt_util

from .api import human_request_scope
from .const import DOMAIN
from .coordinator import (
    CLOSED_STATUSES,
    CREATABLE_TASK_KINDS,
    SHOPPING_CATEGORIES,
    TASK_KINDS,
    MeithealCoordinator,
)

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
_UPDATE_TASK_FIELDS = frozenset({
    "title",
    "status",
    "priority",
    "due_date",
    "description",
    "task_kind",
    "checklists",
    "custom_fields",
})
_SHOPPING_ITEM_SCHEMA = {
    "type": "object",
    "required": ["name"],
    "properties": {
        "name": {"type": "string", "minLength": 1},
        "qty": {"oneOf": [{"type": "string"}, {"type": "number", "exclusiveMinimum": 0}]},
        "category": {"type": "string", "enum": list(SHOPPING_CATEGORIES)},
        "checked": {"type": "boolean"},
    },
}
_CHECKLIST_ITEM_SCHEMA = {
    "type": "object",
    "required": ["text"],
    "properties": {
        "id": {"type": "string"},
        "text": {"type": "string", "minLength": 1},
        "done": {"type": "boolean"},
    },
}

# MCP tool definitions with full JSON Schema inputSchemas
MCP_TOOLS = [
    {
        "name": "createTask",
        "description": "Create a new task, event, or shopping list with optional schedule, checklists, and custom fields",
        "inputSchema": {
            "type": "object",
            "required": ["title"],
            "properties": {
                "title": {"type": "string", "description": "Task title"},
                "description": {"type": "string", "description": "Task description"},
                "priority": {"type": "integer", "minimum": 1, "maximum": 5, "description": "Priority 1-5 (1=urgent)"},
                "due_date": {"type": "string", "description": "Due date YYYY-MM-DD or ISO timestamp"},
                "start_date": {"type": "string", "description": "Start date or ISO timestamp (used for events)"},
                "end_date": {"type": "string", "description": "End date or ISO timestamp (used for events)"},
                "task_kind": {"type": "string", "enum": list(CREATABLE_TASK_KINDS), "description": "Behavioral kind (standard_action, calendar_event, shopping_item, checklist, quick_capture)"},
                "assigned_to": {"type": "string", "description": "Assignee identifier (user ID or agent ID)"},
                "checklists": {"type": "array", "items": _CHECKLIST_ITEM_SCHEMA, "description": "Checklist items"},
                "custom_fields": {
                    "type": "object",
                    "additionalProperties": True,
                    "properties": {
                        "items": {"type": "array", "items": _SHOPPING_ITEM_SCHEMA, "description": "Structured shopping list items"},
                    },
                },
            },
        },
    },
    {
        "name": "searchTasks",
        "description": "Search tasks by keyword, status, priority, task_kind, labels, custom fields, comments, or task IDs",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search keyword"},
                "q": {"type": "string", "description": "Search keyword (alias for query)"},
                "status": {"type": "string", "enum": _VALID_STATUSES},
                "priority": {"type": "integer", "minimum": 1, "maximum": 5},
                "task_kind": {"type": "string", "enum": list(TASK_KINDS)},
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
        "description": "Update task fields (title, status, priority, due_date, start_date, end_date, task_kind, description, checklists, custom_fields)",
        "inputSchema": {
            "type": "object",
            "required": ["id"],
            "properties": {
                "id": {"type": "string", "description": "Task UUID"},
                "title": {"type": "string"},
                "status": {"type": "string", "enum": _VALID_STATUSES},
                "priority": {"type": "integer", "minimum": 1, "maximum": 5},
                "due_date": {"type": "string"},
                "start_date": {"type": ["string", "null"]},
                "end_date": {"type": ["string", "null"]},
                "task_kind": {"type": "string", "enum": list(CREATABLE_TASK_KINDS)},
                "description": {"type": "string"},
                "checklists": {"type": "array", "items": _CHECKLIST_ITEM_SCHEMA},
                "custom_fields": {
                    "type": "object",
                    "additionalProperties": True,
                    "properties": {
                        "items": {"type": "array", "items": _SHOPPING_ITEM_SCHEMA},
                    },
                },
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
        "description": "Complete multiple tasks at once by label or priority filter. Returns the completed titles and any tasks that failed, with the reason.",
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
    {
        "name": "listRoutines",
        "description": "List household routines with cadence, streak, and current-period completion status",
        "inputSchema": {
            "type": "object",
            "properties": {
                "area_id": {"type": "string", "description": "Filter by Area ID or 'default'"},
                "project_id": {"type": "string", "description": "Filter by Project ID"},
            },
        },
    },
    {
        "name": "completeRoutine",
        "description": "Complete a household routine occurrence for the current period by template ID",
        "inputSchema": {
            "type": "object",
            "required": ["template_id"],
            "properties": {
                "template_id": {"type": "string", "description": "Routine template UUID"},
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
                    "version": str((await async_get_integration(coordinator.hass, DOMAIN)).version),
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
        except Exception as err:  # JSON-RPC boundary reports every tool failure
            _LOGGER.exception("MCP tool %s failed", tool_name)
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


def _scheduled_sort_key(raw: str, local_now: datetime) -> tuple[float, str]:
    """Return a chronological sort key (epoch seconds, raw string)."""
    value = raw.strip()
    try:
        if len(value) == 10:
            parsed_day = date.fromisoformat(value)
            dt = datetime(
                parsed_day.year,
                parsed_day.month,
                parsed_day.day,
                tzinfo=local_now.tzinfo,
            )
            return (dt.timestamp(), raw)
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None and local_now.tzinfo is not None:
            dt = dt.replace(tzinfo=local_now.tzinfo)
        return (dt.timestamp(), raw)
    except (ValueError, TypeError, OverflowError):
        return (float("inf"), raw)


def _parse_optional_task_kind(
    args: dict[str, Any], tool_name: str, *, allow_routine_instance: bool = True
) -> str | None:
    """Validate optional task_kind argument against Meitheal's canonical kinds."""
    if "task_kind" not in args or args["task_kind"] is None:
        return None
    allowed = TASK_KINDS if allow_routine_instance else CREATABLE_TASK_KINDS
    raw = args["task_kind"]
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError(f"{tool_name} task_kind must be one of: {', '.join(allowed)}")
    normalized = raw.strip().lower()
    if normalized not in allowed:
        raise ValueError(f"{tool_name} task_kind must be one of: {', '.join(allowed)}")
    return normalized


def _parse_optional_checklists(
    args: dict[str, Any], tool_name: str
) -> list[dict[str, Any]] | None:
    """Validate optional checklist items list."""
    if "checklists" not in args or args["checklists"] is None:
        return None
    raw = args["checklists"]
    if not isinstance(raw, list):
        raise ValueError(f"{tool_name} checklists must be a list of checklist objects")
    items: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict) or not isinstance(entry.get("text"), str) or not entry["text"].strip():
            raise ValueError(f"{tool_name} checklist entries require a non-empty string text")
        if "done" in entry and type(entry["done"]) is not bool:
            raise ValueError(f"{tool_name} checklist entry done must be a boolean")
        if "id" in entry and not isinstance(entry["id"], str):
            raise ValueError(f"{tool_name} checklist entry id must be a string")
        normalized_item: dict[str, Any] = {
            "text": entry["text"].strip(),
            "done": bool(entry.get("done", False)),
        }
        if isinstance(entry.get("id"), str) and entry["id"]:
            normalized_item["id"] = entry["id"]
        items.append(normalized_item)
    return items


def _parse_optional_custom_fields(
    args: dict[str, Any], tool_name: str
) -> dict[str, Any] | None:
    """Validate optional custom_fields object including 8-category shopping items."""
    if "custom_fields" not in args or args["custom_fields"] is None:
        return None
    raw = args["custom_fields"]
    if not isinstance(raw, dict):
        raise ValueError(f"{tool_name} custom_fields must be an object")
    out = dict(raw)
    if "items" in out:
        raw_items = out["items"]
        if not isinstance(raw_items, list):
            raise ValueError(f"{tool_name} custom_fields.items must be a list")
        normalized_items: list[dict[str, Any]] = []
        for entry in raw_items:
            if not isinstance(entry, dict):
                raise ValueError(f"{tool_name} custom_fields.items entries must be objects")
            name = entry.get("name")
            if not isinstance(name, str) or not name.strip():
                raise ValueError(f"{tool_name} shopping item name must be a non-empty string")
            item: dict[str, Any] = {"name": name.strip()}
            if "qty" in entry and entry["qty"] is not None:
                qty_val = entry["qty"]
                if isinstance(qty_val, str):
                    if qty_val.strip():
                        item["qty"] = qty_val.strip()
                elif (
                    isinstance(qty_val, (int, float))
                    and not isinstance(qty_val, bool)
                    and math.isfinite(qty_val)
                    and qty_val > 0
                ):
                    item["qty"] = qty_val
                else:
                    raise ValueError(
                        f"{tool_name} shopping item qty must be a string or positive number"
                    )
            if "category" in entry and entry["category"] is not None:
                if not isinstance(entry["category"], str):
                    raise ValueError(
                        f"{tool_name} shopping item category must be one of: {', '.join(SHOPPING_CATEGORIES)}"
                    )
                cat = entry["category"].strip().lower()
                if cat not in SHOPPING_CATEGORIES:
                    raise ValueError(
                        f"{tool_name} shopping item category must be one of: {', '.join(SHOPPING_CATEGORIES)}"
                    )
                item["category"] = cat
            if "checked" in entry and entry["checked"] is not None:
                if type(entry["checked"]) is not bool:
                    raise ValueError(f"{tool_name} shopping item checked must be a boolean")
                item["checked"] = entry["checked"]
            normalized_items.append(item)
        out["items"] = normalized_items
    return out


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

    data = await coordinator.async_data_for_context() if tool_name in {
        "getTask", "getOverdueTasks", "getTodaysTasks", "getTaskSummary", "dailyBriefing",
        "getCalendarEvents", "getUpcoming", "batchComplete",
    } else None

    if tool_name == "createTask":
        title = _require_str(args, "title", "createTask")
        description = _optional_str(args, "description", "createTask")
        priority = _parse_optional_priority(args, "createTask")
        due_date = _optional_str(args, "due_date", "createTask", non_empty=True)
        assigned_to = _optional_str(args, "assigned_to", "createTask", non_empty=True)
        extra_kwargs: dict[str, Any] = {}
        task_kind = _parse_optional_task_kind(args, "createTask", allow_routine_instance=False)
        if task_kind is not None:
            extra_kwargs["task_kind"] = task_kind
        start_date = _optional_str(args, "start_date", "createTask", non_empty=True)
        if start_date is not None:
            extra_kwargs["start_date"] = start_date
        end_date = _optional_str(args, "end_date", "createTask", non_empty=True)
        if end_date is not None:
            extra_kwargs["end_date"] = end_date
        checklists = _parse_optional_checklists(args, "createTask")
        if checklists is not None:
            extra_kwargs["checklists"] = checklists
        custom_fields = _parse_optional_custom_fields(args, "createTask")
        if custom_fields is not None:
            extra_kwargs["custom_fields"] = custom_fields
        await coordinator.async_create_task(
            title=title,
            description=description,
            priority=priority,
            due_date=due_date,
            assigned_to=assigned_to,
            **extra_kwargs,
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
        has_start_date = "start_date" in args
        has_end_date = "end_date" in args
        start_date = (
            _optional_str(args, "start_date", "updateTask", non_empty=True)
            if has_start_date and args["start_date"] is not None
            else None
        )
        end_date = (
            _optional_str(args, "end_date", "updateTask", non_empty=True)
            if has_end_date and args["end_date"] is not None
            else None
        )
        description = _optional_str(args, "description", "updateTask")
        task_kind = _parse_optional_task_kind(args, "updateTask", allow_routine_instance=False)
        checklists = _parse_optional_checklists(args, "updateTask")
        custom_fields = _parse_optional_custom_fields(args, "updateTask")
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
        if has_start_date:
            updates["start_date"] = start_date
        if has_end_date:
            updates["end_date"] = end_date
        if task_kind is not None:
            updates["task_kind"] = task_kind
        if description is not None:
            updates["description"] = description
        if checklists is not None:
            updates["checklists"] = checklists
        if custom_fields is not None:
            updates["custom_fields"] = custom_fields
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
        task_kind = _parse_optional_task_kind(args, "searchTasks")
        include_completed = args.get("include_completed")
        if include_completed is not None and type(include_completed) is not bool:
            raise ValueError("searchTasks include_completed must be a boolean")
        search_kwargs: dict[str, Any] = {
            "query": query,
            "status": status,
            "priority": priority,
            "include_completed": include_completed,
        }
        if task_kind is not None:
            search_kwargs["task_kind"] = task_kind
        return await coordinator.async_search_tasks(**search_kwargs)

    elif tool_name == "getTask":
        task_id = _require_str(args, "id", "getTask")
        if not data:
            raise ValueError("No task data available")
        for t in data.tasks:
            if t.id == task_id:
                return {
                    "id": t.id, "title": t.title, "status": t.status,
                    "priority": t.priority, "task_kind": t.task_kind,
                    "due_date": t.due_date, "start_date": t.start_date, "end_date": t.end_date,
                    "description": t.description, "labels": t.labels,
                    "checklists": t.checklists, "custom_fields": t.custom_fields,
                    "created_at": t.created_at, "updated_at": t.updated_at,
                    "is_overdue": t.is_overdue,
                }
        raise ValueError(f"Task {task_id} not found")

    elif tool_name == "getOverdueTasks":
        if not data:
            return {"tasks": [], "count": 0}
        overdue = [
            {
                "id": t.id,
                "title": t.title,
                "due_date": t.effective_scheduled_date or t.due_date,
                "priority": t.priority,
                "task_kind": t.task_kind,
            }
            for t in data.tasks if t.is_overdue
        ]
        return {"tasks": overdue, "count": len(overdue)}

    elif tool_name == "getTodaysTasks":
        if not data:
            return {"tasks": [], "count": 0}
        local_now = dt_util.now()
        results = []
        for t in data.tasks:
            if t.status in CLOSED_STATUSES:
                continue
            if t.is_overdue or t.is_due_on(local_now):
                results.append({
                    "id": t.id,
                    "title": t.title,
                    "task_kind": t.task_kind,
                    "due_date": t.effective_scheduled_date or t.due_date,
                    "start_date": t.start_date,
                    "end_date": t.end_date,
                    "priority": t.priority,
                    "is_overdue": t.is_overdue,
                })
        return {"tasks": results, "count": len(results)}

    elif tool_name == "getTaskSummary":
        if not data:
            return {"total": 0, "active": 0, "overdue": 0, "done": 0}
        done = sum(1 for t in data.tasks if t.status == "done")
        return {
            "total": data.total_count, "active": data.active_count,
            "overdue": data.overdue_count, "done": done,
        }

    elif tool_name == "dailyBriefing":
        if not data:
            return {"greeting": "Hello", "tasks": {"active": 0, "overdue": 0, "total": 0}}
        now = dt_util.now()
        hour = now.hour
        greeting = "Good morning" if hour < 12 else ("Good afternoon" if hour < 17 else "Good evening")
        today_tasks = [
            {"title": t.title, "priority": t.priority, "task_kind": t.task_kind}
            for t in data.tasks
            if t.is_due_on(now)
        ][:5]
        overdue = [
            {"title": t.title, "due_date": t.effective_scheduled_date or t.due_date}
            for t in data.tasks if t.is_overdue
        ][:5]
        urgent = [
            {"title": t.title, "priority": t.priority}
            for t in data.tasks if t.status not in CLOSED_STATUSES and t.priority <= 2
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
        if not data:
            return {"events": [], "count": 0}
        local_now = dt_util.now()
        today_day = local_now.date()
        cutoff_day = today_day + timedelta(days=days_ahead)
        events = []
        for t in data.tasks:
            if t.status in CLOSED_STATUSES:
                continue
            sync_state = getattr(t, "calendar_sync_state", None)
            if t.task_kind != "calendar_event" and sync_state not in ("synced", "confirmed"):
                continue
            start_day = t.scheduled_local_date(local_now)
            end_day = t.end_local_date(local_now) or start_day
            scheduled = t.effective_scheduled_date
            if (
                scheduled
                and start_day is not None
                and end_day is not None
                and start_day <= cutoff_day
                and end_day >= today_day
            ):
                events.append({
                    "id": t.id,
                    "title": t.title,
                    "date": scheduled,
                    "start_date": t.start_date,
                    "end_date": t.end_date,
                    "task_kind": t.task_kind,
                    "description": t.description or "",
                    "source": "ha_calendar" if sync_state in ("synced", "confirmed") else "meitheal",
                })
        events.sort(key=lambda e: _scheduled_sort_key(str(e["date"]), local_now))
        return {"events": events, "count": len(events)}

    elif tool_name == "getUpcoming":
        days_ahead = _parse_days_ahead(args, "getUpcoming")
        if not data:
            return {"items": [], "count": 0}
        local_now = dt_util.now()
        today_day = local_now.date()
        cutoff_day = today_day + timedelta(days=days_ahead)
        items = []
        for t in data.tasks:
            if t.status in CLOSED_STATUSES:
                continue
            sync_state = getattr(t, "calendar_sync_state", None)
            is_event = t.task_kind == "calendar_event" or sync_state in ("synced", "confirmed")
            start_day = t.scheduled_local_date(local_now)
            end_day = (t.end_local_date(local_now) or start_day) if is_event else start_day
            scheduled = t.effective_scheduled_date
            if (
                not scheduled
                or start_day is None
                or end_day is None
                or end_day < today_day
                or start_day > cutoff_day
            ):
                continue
            items.append({
                "id": t.id,
                "title": t.title,
                "date": scheduled,
                "task_kind": t.task_kind,
                "type": "calendar_event" if is_event else "task",
                "priority": t.priority,
                "is_overdue": t.is_overdue,
            })
        items.sort(key=lambda e: _scheduled_sort_key(str(e["date"]), local_now))
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
        if not data:
            raise ValueError("No task data available")

        if action == "list_completed":
            done = [
                {"title": t.title, "updated": t.updated_at}
                for t in data.tasks if t.status == "done"
            ]
            return {"completed_tasks": done[:10], "total_done": len(done)}

        title_set = {x.lower() for x in titles}
        targets = []
        for t in data.tasks:
            if t.status in CLOSED_STATUSES:
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
        failed = []
        for t in targets:
            try:
                await coordinator.async_complete_task(task_id=t.id, **origin_kwargs)
                completed.append(t.title)
            except (HomeAssistantError, ValueError) as err:
                _LOGGER.warning("batchComplete failed for task %s: %s", t.id, err)
                failed.append({"id": t.id, "title": t.title, "error": str(err)})
            except Exception as err:
                _LOGGER.exception("batchComplete hit unexpected error for task %s", t.id)
                failed.append({"id": t.id, "title": t.title, "error": str(err)})
        return {"completed": completed, "count": len(completed), "failed": failed}

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

    elif tool_name == "listRoutines":
        area_id = _optional_str(args, "area_id", "listRoutines", non_empty=True)
        project_id = _optional_str(args, "project_id", "listRoutines", non_empty=True)
        routines = await coordinator.async_list_routines(
            area_id=area_id, project_id=project_id
        )
        return {"routines": routines, "count": len(routines)}

    elif tool_name == "completeRoutine":
        template_id = _require_str(args, "template_id", "completeRoutine")
        return await coordinator.async_complete_routine(
            template_id=template_id,
            **origin_kwargs,
        )

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
        except ValueError:
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

        async def execute() -> dict[str, Any] | None:
            return await handle_mcp_request(
                coordinator,
                body,
                origin_kind="mcp",
                # Clients percent-encode UTF-8 names (see the agent automation guide); decode once
                # so build_origin_headers does not encode the "%" a second time.
                origin_name=unquote(request.headers.get("X-Meitheal-Origin-Name") or "") or "Home Assistant MCP",
                origin_target=request.headers.get("X-Meitheal-Origin-Target"),
            )
        try:
            if body.get("method") == "tools/call":
                user = request[KEY_HASS_USER]
                async with human_request_scope(request.app[KEY_HASS], coordinator.api, Context(user_id=user.id)):
                    response = await execute()
            else:
                response = await execute()
        except HomeAssistantError:
            return web.json_response({"jsonrpc": "2.0", "id": safe_id,
                "error": {"code": -32000, "message": "Current Home Assistant Board access could not be verified"}}, status=403)
        if response is None:
            return web.Response(status=202)
        return web.json_response(response)
