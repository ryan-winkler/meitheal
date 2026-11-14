"""Optional administrator-only task lookup for Home Assistant LLM agents."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from homeassistant.config_entries import ConfigEntry, ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError, Unauthorized
from homeassistant.helpers import llm
from homeassistant.util.json import JsonObjectType
import probatio

from .api import task_path
from .const import DOMAIN
from .coordinator import MeithealCoordinator, MeithealTask


class MeithealLLMAPI(llm.API):
    """Expose task management tools bound to one loaded Meitheal config entry."""

    def __init__(
        self, hass: HomeAssistant, entry: ConfigEntry[MeithealCoordinator]
    ) -> None:
        super().__init__(
            hass=hass,
            id=f"meitheal_tasks-{entry.entry_id}",
            name="Meitheal Tasks",
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
            api_prompt="Manage Meitheal tasks. You can search, read, create, and complete tasks.",
            llm_context=llm_context,
            tools=[
                SearchTasksTool(self),
                GetTaskDetailsTool(self),
                CreateTaskTool(self),
                CompleteTaskTool(self),
            ],
        )


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
        return llm.ToolResult(await self._async_read(coordinator, args))

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


class CreateTaskTool(llm.Tool):
    """Create a new Meitheal task."""

    integration = DOMAIN
    name = "meitheal_create_task"
    description = "Create a new task in Meitheal with title, description, priority, and optional assignee."
    annotations = llm.ToolAnnotations(
        read_only=False, destructive=False, idempotent=False
    )
    parameters = probatio.Schema(
        {
            probatio.Required("title"): probatio.All(str, probatio.Length(min=1, max=500)),
            probatio.Optional("description"): str,
            probatio.Optional("priority"): probatio.All(int, probatio.Range(min=1, max=5)),
            probatio.Optional("due_date"): str,
            probatio.Optional("assigned_to"): str,
        }
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
        await coordinator.async_create_task(
            title=args["title"],
            description=args.get("description"),
            priority=args.get("priority"),
            due_date=args.get("due_date"),
            assigned_to=args.get("assigned_to"),
        )
        return llm.ToolResult({"status": "created", "title": args["title"]})


class CompleteTaskTool(llm.Tool):
    """Mark a Meitheal task as completed."""

    integration = DOMAIN
    name = "meitheal_complete_task"
    description = "Complete an existing Meitheal task by its task ID or exact title."
    annotations = llm.ToolAnnotations(
        read_only=False, destructive=False, idempotent=True
    )
    parameters = probatio.Schema(
        {
            probatio.Optional("task_id"): probatio.All(
                str, probatio.Length(min=1, max=128), probatio.NotIn((".", ".."))
            ),
            probatio.Optional("title"): probatio.All(str, probatio.Length(min=1, max=500)),
        }
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
        task_id = args.get("task_id")
        title = args.get("title")
        if not task_id and not title:
            raise HomeAssistantError("Must provide task_id or title to complete a task")
        await coordinator.async_complete_task(task_id=task_id, title=title)
        return llm.ToolResult({"status": "completed", "task_id": task_id, "title": title})


def async_register_llm_api(
    hass: HomeAssistant, entry: ConfigEntry[MeithealCoordinator]
) -> Callable[[], None] | None:
    """Register the optional API only on Core with native admin enforcement."""
    if not hasattr(llm.API, "requires_admin"):
        return None
    return llm.async_register_api(hass, MeithealLLMAPI(hass, entry))
