"""Optional administrator-only task lookup for Home Assistant LLM agents."""

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


class MeithealLLMAPI(llm.API):
    """Expose a read-only API bound to one loaded Meitheal config entry."""

    def __init__(
        self, hass: HomeAssistant, entry: ConfigEntry[MeithealCoordinator]
    ) -> None:
        super().__init__(
            hass=hass,
            id=f"meitheal_tasks-{entry.entry_id}",
            name="Meitheal Tasks (read only)",
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
        """Return the read-only tools for this administrator and config entry."""
        await self.async_require_coordinator(llm_context)
        return llm.APIInstance(
            api=self,
            api_prompt="Look up Meitheal tasks. These tools can only read task data.",
            llm_context=llm_context,
            tools=[SearchTasksTool(self), GetTaskDetailsTool(self)],
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


def async_register_llm_api(
    hass: HomeAssistant, entry: ConfigEntry[MeithealCoordinator]
) -> Callable[[], None] | None:
    """Register the optional API only on Core with native admin enforcement."""
    if not hasattr(llm.API, "requires_admin"):
        return None
    return llm.async_register_api(hass, MeithealLLMAPI(hass, entry))
