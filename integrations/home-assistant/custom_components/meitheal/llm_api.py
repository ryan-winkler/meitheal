"""Optional administrator-only task tools for Home Assistant LLM agents.

Two APIs are registered per config entry: a read-only lookup, and a full one
that can also create, update, comment on and complete tasks. Home Assistant's
conversation agents and its MCP Server integration can each be given either,
so an external MCP client signed in through Home Assistant reaches Meitheal
without a separate address or credential.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import probatio

from homeassistant.config_entries import ConfigEntry, ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError, Unauthorized
from homeassistant.helpers import llm
from homeassistant.util.json import JsonObjectType

from .api import task_path
from .const import DOMAIN
from .coordinator import MeithealCoordinator, MeithealTask
from .helpers import ASSIGNEE_ID, assignee_for_user


class MeithealLLMAPI(llm.API):
    """Expose task management tools bound to one loaded Meitheal config entry."""

    id_prefix = "meitheal_tasks_read"
    api_name = "Meitheal Tasks (read only)"
    prompt = "Look up Meitheal tasks. These tools can only read task data."

    def __init__(
        self, hass: HomeAssistant, entry: ConfigEntry[MeithealCoordinator]
    ) -> None:
        super().__init__(
            hass=hass,
            id=f"{self.id_prefix}-{entry.entry_id}",
            name=self.api_name,
            requires_admin=True,
        )
        self._entry = entry
        self._coordinator = entry.runtime_data

    async def async_require_coordinator(
        self, llm_context: llm.LLMContext
    ) -> MeithealCoordinator:
        """Check current authorization and keep cached tools on their own entry."""
        context = llm_context.context
        user = (
            await self.hass.auth.async_get_user(context.user_id)
            if context and context.user_id
            else None
        )
        if not user or not user.is_active or not user.is_admin:
            raise Unauthorized(context=context)

        entry = self.hass.config_entries.async_get_entry(self._entry.entry_id)
        if (
            entry is not self._entry
            or entry.state is not ConfigEntryState.LOADED
            or getattr(entry, "runtime_data", None) is not self._coordinator
        ):
            raise HomeAssistantError("Meitheal entry is unavailable")
        return self._coordinator

    async def async_get_api_instance(
        self, llm_context: llm.LLMContext
    ) -> llm.APIInstance:
        """Return task management tools for this administrator and config entry."""
        await self.async_require_coordinator(llm_context)
        return llm.APIInstance(
            api=self,
            api_prompt=self.prompt,
            llm_context=llm_context,
            tools=self.tools(),
        )

    def tools(self) -> list[llm.Tool]:
        """Return the tools this API offers."""
        return [SearchTasksTool(self), GetTaskDetailsTool(self)]


class MeithealManageLLMAPI(MeithealLLMAPI):
    """Expose task reading and writing, bound to one loaded Meitheal config entry."""

    id_prefix = "meitheal_tasks"
    api_name = "Meitheal Tasks"
    prompt = (
        "Manage the household's Meitheal tasks. Call meitheal_list_tasks to see the "
        "tasks assigned to the person you are helping. Read a task and its comments "
        "before changing it. Answer on a task with meitheal_add_comment. Only change, "
        "complete or reassign a task when asked to."
    )

    def tools(self) -> list[llm.Tool]:
        return [
            *super().tools(),
            ListTasksTool(self),
            GetTaskCommentsTool(self),
            CreateTaskTool(self),
            UpdateTaskTool(self),
            CompleteTaskTool(self),
            AddCommentTool(self),
        ]


class MeithealReadTool(llm.Tool):
    """Authorize and validate every call, including calls in a reused conversation."""

    integration = DOMAIN
    annotations = llm.ToolAnnotations(
        read_only=True, destructive=False, idempotent=True
    )

    def __init__(self, api: MeithealLLMAPI) -> None:
        self._api = api

    async def async_call(
        self,
        hass: HomeAssistant,
        tool_input: llm.ToolInput,
        llm_context: llm.LLMContext,
    ) -> llm.ToolResult:
        coordinator = await self._api.async_require_coordinator(llm_context)
        try:
            args = self.parameters(tool_input.tool_args)
        except probatio.Invalid:
            raise HomeAssistantError("Invalid Meitheal tool arguments") from None
        # Authorization above proved this user exists; "me" resolves to them.
        # Kept per call, not on the tool, which concurrent conversations share.
        caller = assignee_for_user(llm_context.context.user_id)
        return llm.ToolResult(await self._async_read(coordinator, {**args, _CALLER: caller}))

    async def _async_read(
        self, coordinator: MeithealCoordinator, args: dict[str, Any]
    ) -> JsonObjectType:
        raise NotImplementedError


class SearchTasksTool(MeithealReadTool):
    """Search Meitheal tasks by keyword."""

    name = "meitheal_search_tasks"
    description = "Search Meitheal tasks by keyword and return up to 20 matches."
    parameters = probatio.Schema(
        {probatio.Required("query"): probatio.All(str, probatio.Length(min=1, max=200))}
    )

    async def _async_read(
        self, coordinator: MeithealCoordinator, args: dict[str, Any]
    ) -> JsonObjectType:
        return await coordinator.async_search_tasks(query=args["query"])


class GetTaskDetailsTool(MeithealReadTool):
    """Read a single task by its exact Meitheal identifier."""

    name = "meitheal_get_task"
    description = "Get details for the exact task ID returned by Meitheal search."
    parameters = probatio.Schema(
        {
            probatio.Required("task_id"): probatio.All(
                str, probatio.Length(min=1, max=128), probatio.NotIn((".", ".."))
            )
        }
    )

    async def _async_read(
        self, coordinator: MeithealCoordinator, args: dict[str, Any]
    ) -> JsonObjectType:
        data = await coordinator.api.async_request(
            "GET", task_path(args["task_id"]), read_json=True
        )
        if not isinstance(data, dict) or not data.get("id"):
            raise HomeAssistantError("Meitheal returned invalid task details")
        task = MeithealTask(data)
        return {
            "id": task.id,
            "title": task.title,
            "status": task.status,
            "description": task.description,
            "priority": task.priority,
            "due_date": task.due_date,
        }


# Key under which each call carries the caller's own Meitheal assignee ID.
_CALLER = "caller_assignee"


def _assignee(args: dict[str, Any]) -> str:
    """Resolve "me" to the calling Home Assistant user's Meitheal assignee ID."""
    return args[_CALLER] if args["assignee"] == "me" else args["assignee"]


_TASK_ID = probatio.All(str, probatio.Length(min=1, max=128), probatio.NotIn((".", "..")))
_ASSIGNEE = probatio.Any("me", probatio.All(str, probatio.Match(ASSIGNEE_ID)))
_OPEN_STATUSES = ("backlog", "pending", "active")
_DONE_STATUSES = ("complete", "done")


def _task_summary(data: dict[str, Any]) -> JsonObjectType:
    """Return the task fields an agent needs, without internal columns."""
    return {
        "id": data.get("id"),
        "ticket_key": data.get("ticket_key"),
        "title": data.get("title"),
        "description": data.get("description") or "",
        "status": data.get("status"),
        "priority": data.get("priority"),
        "due_date": data.get("due_date"),
        "assigned_to": data.get("assigned_to"),
    }


def _acknowledged(data: Any, task_id: str | None = None) -> dict[str, Any]:
    """Accept only a task receipt, so a rejected write is never reported as done."""
    if (
        not isinstance(data, dict)
        or not isinstance(data.get("id"), str)
        or not data["id"]
        or data.get("error")
        or (task_id is not None and task_id not in (data["id"], data.get("ticket_key")))
    ):
        raise HomeAssistantError("Meitheal did not acknowledge the change")
    return data


class MeithealWriteTool(MeithealReadTool):
    """A tool that changes Meitheal. Shares the per-call authorization of read tools."""

    annotations = llm.ToolAnnotations(
        read_only=False, destructive=False, idempotent=False
    )


class ListTasksTool(MeithealReadTool):
    """List the tasks assigned to one assignee."""

    name = "meitheal_list_tasks"
    description = (
        "List open Meitheal tasks assigned to someone. Leave assignee as \"me\" for the "
        "person you are helping, or pass an assignee ID seen on a task."
    )
    parameters = probatio.Schema(
        {
            probatio.Optional("assignee", default="me"): _ASSIGNEE,
            probatio.Optional("include_completed", default=False): bool,
        }
    )

    async def _async_read(
        self, coordinator: MeithealCoordinator, args: dict[str, Any]
    ) -> JsonObjectType:
        assignee = _assignee(args)
        data = await coordinator.api.async_request(
            "GET",
            "/api/tasks",
            params={"assigned_to": assignee, "limit": "200", "sort": "updated_at"},
            read_json=True,
        )
        rows = data.get("tasks") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            raise HomeAssistantError("Meitheal returned an invalid task list")
        tasks = [
            _task_summary(row)
            for row in rows
            if isinstance(row, dict)
            and (args["include_completed"] or row.get("status") not in _DONE_STATUSES)
        ]
        return {"assignee": assignee, "tasks": tasks[:50], "count": len(tasks)}


class GetTaskCommentsTool(MeithealReadTool):
    """Read the discussion on one task."""

    name = "meitheal_get_task_comments"
    description = "Read the comments on a Meitheal task, oldest first."
    parameters = probatio.Schema({probatio.Required("task_id"): _TASK_ID})

    async def _async_read(
        self, coordinator: MeithealCoordinator, args: dict[str, Any]
    ) -> JsonObjectType:
        data = await coordinator.api.async_request(
            "GET", f"{task_path(args['task_id'])}/comments", read_json=True
        )
        rows = data.get("comments") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            raise HomeAssistantError("Meitheal returned invalid comments")
        return {
            "comments": [
                {
                    "author": row.get("author"),
                    "content": row.get("content"),
                    "created_at": row.get("created_at"),
                }
                for row in rows[-50:]
                if isinstance(row, dict)
            ]
        }


class CreateTaskTool(MeithealWriteTool):
    """Create a task, optionally for a named assignee."""

    name = "meitheal_create_task"
    description = (
        "Create a Meitheal task. Set assignee to \"me\" for the person you are helping, "
        "or to an assignee ID. Without it Meitheal uses the household's default assignee."
    )
    parameters = probatio.Schema(
        {
            probatio.Required("title"): probatio.All(str, probatio.Length(min=1, max=500)),
            probatio.Optional("description"): probatio.All(str, probatio.Length(max=10000)),
            probatio.Optional("priority"): probatio.All(int, probatio.Range(min=1, max=5)),
            probatio.Optional("due_date"): probatio.All(str, probatio.Length(min=1, max=40)),
            probatio.Optional("assignee"): _ASSIGNEE,
        }
    )

    async def _async_read(
        self, coordinator: MeithealCoordinator, args: dict[str, Any]
    ) -> JsonObjectType:
        payload = {key: value for key, value in args.items() if key not in ("assignee", _CALLER)}
        if "assignee" in args:
            payload["assigned_to"] = _assignee(args)
        authority: set[str] = set()
        created = _acknowledged(
            await coordinator.api.async_request(
                "POST",
                "/api/tasks",
                payload=payload,
                read_json=True,
                event_authority=authority,
            )
        )
        if "meitheal_task_created" not in authority:
            coordinator._fire_event(
                "meitheal_task_created",
                {"task_id": created["id"], "title": payload["title"]},
            )
        coordinator._fire_logbook("Meitheal", f"created task: {payload['title']}")
        await coordinator.async_request_refresh()
        return _task_summary(created)


class UpdateTaskTool(MeithealWriteTool):
    """Change fields on an existing task, including who it is assigned to."""

    name = "meitheal_update_task"
    description = (
        "Update a Meitheal task. To hand a task to someone, set assignee to \"me\", an "
        "assignee ID, or \"unassigned\". Use meitheal_complete_task to finish a task."
    )
    parameters = probatio.Schema(
        {
            probatio.Required("task_id"): _TASK_ID,
            probatio.Optional("title"): probatio.All(str, probatio.Length(min=1, max=500)),
            probatio.Optional("description"): probatio.All(str, probatio.Length(max=10000)),
            probatio.Optional("status"): probatio.In(_OPEN_STATUSES),
            probatio.Optional("priority"): probatio.All(int, probatio.Range(min=1, max=5)),
            probatio.Optional("due_date"): probatio.All(str, probatio.Length(min=1, max=40)),
            probatio.Optional("assignee"): probatio.Any("unassigned", _ASSIGNEE),
        }
    )

    async def _async_read(
        self, coordinator: MeithealCoordinator, args: dict[str, Any]
    ) -> JsonObjectType:
        payload = {
            key: value for key, value in args.items() if key not in ("task_id", "assignee", _CALLER)
        }
        if "assignee" in args:
            payload["assigned_to"] = (
                None if args["assignee"] == "unassigned" else _assignee(args)
            )
        if not payload:
            raise HomeAssistantError("Invalid Meitheal tool arguments")
        updated = _acknowledged(
            await coordinator.api.async_request(
                "PUT", task_path(args["task_id"]), payload=payload, read_json=True
            ),
            args["task_id"],
        )
        await coordinator.async_request_refresh()
        return _task_summary(updated)


class CompleteTaskTool(MeithealWriteTool):
    """Mark one task complete by its exact identifier."""

    name = "meitheal_complete_task"
    description = "Mark the Meitheal task with this exact ID complete."
    parameters = probatio.Schema({probatio.Required("task_id"): _TASK_ID})
    annotations = llm.ToolAnnotations(
        read_only=False, destructive=False, idempotent=True
    )

    async def _async_read(
        self, coordinator: MeithealCoordinator, args: dict[str, Any]
    ) -> JsonObjectType:
        # The coordinator verifies the receipt and fires the completion event once.
        await coordinator.async_complete_task(task_id=args["task_id"])
        return {"id": args["task_id"], "status": "complete"}


class AddCommentTool(MeithealWriteTool):
    """Answer on a task."""

    name = "meitheal_add_comment"
    description = (
        "Add a comment to a Meitheal task, for example what was done or a question "
        "for the household."
    )
    parameters = probatio.Schema(
        {
            probatio.Required("task_id"): _TASK_ID,
            probatio.Required("comment"): probatio.All(str, probatio.Length(min=1, max=10000)),
        }
    )

    async def _async_read(
        self, coordinator: MeithealCoordinator, args: dict[str, Any]
    ) -> JsonObjectType:
        created = await coordinator.api.async_request(
            "POST",
            f"{task_path(args['task_id'])}/comments",
            payload={"content": args["comment"]},
            read_json=True,
        )
        if not isinstance(created, dict) or created.get("id") is None or created.get("error"):
            raise HomeAssistantError("Meitheal did not acknowledge the comment")
        return {"id": created["id"], "author": created.get("author")}


def async_register_llm_api(
    hass: HomeAssistant, entry: ConfigEntry[MeithealCoordinator]
) -> Callable[[], None] | None:
    """Register the optional APIs only on Core with native admin enforcement."""
    if not hasattr(llm.API, "requires_admin"):
        return None
    unregister = [
        llm.async_register_api(hass, api(hass, entry))
        for api in (MeithealLLMAPI, MeithealManageLLMAPI)
    ]

    def async_unregister() -> None:
        for remove in unregister:
            remove()

    return async_unregister
