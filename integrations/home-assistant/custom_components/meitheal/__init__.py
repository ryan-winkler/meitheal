"""Meitheal Home Assistant integration — setup and service registration.

Registers Meitheal as a first-class HA integration with:
- todo.meitheal_tasks: TodoListEntity proxy to Meitheal REST API
- sensor.meitheal_active_tasks: Active task count
- sensor.meitheal_overdue_tasks: Overdue task count
- sensor.meitheal_total_tasks: Total task count
- meitheal.create_task: Service to create tasks
- meitheal.complete_task: Service to mark tasks done
- meitheal.sync_todo: Service to trigger manual sync
- meitheal.search_tasks: Service to search tasks by keyword
- meitheal.get_overdue_tasks: Service to retrieve overdue tasks
- Optional read-only task lookup for Home Assistant LLM agents

"""

# ruff: noqa: TRY003

from __future__ import annotations

import logging
from typing import Any

from aiohttp import DummyCookieJar
import voluptuous as vol
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse
from homeassistant.exceptions import ConfigEntryError, ConfigEntryNotReady, HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_create_clientsession

from .api import (
    MeithealApi,
    MeithealConnectionError,
    async_validate_transport,
    connection_origin,
)
from .const import (
    CONF_API_TOKEN,
    DOMAIN,
    PLATFORMS,
    SERVICE_COMPLETE_TASK,
    SERVICE_COMPLETE_TASK_BY_TAG,
    SERVICE_CREATE_TASK,
    SERVICE_GET_OVERDUE_TASKS,
    SERVICE_SEARCH_TASKS,
    SERVICE_SYNC_TODO,
)
from .coordinator import MeithealCoordinator

# The optional native LLM registry requires Core's admin-aware API.
try:
    from .llm_api import async_register_llm_api
except ImportError:
    async_register_llm_api = None

_LOGGER = logging.getLogger(__name__)

CREATE_TASK_SCHEMA = vol.Schema(
    {
        vol.Required("title"): cv.string,
        vol.Optional("description"): cv.string,
        vol.Optional("priority"): vol.All(vol.Coerce(int), vol.Range(min=1, max=5)),
        vol.Optional("due_date"): cv.string,
        vol.Optional("urgency"): vol.All(vol.Coerce(int), vol.Range(min=0, max=5)),
        vol.Optional("importance"): vol.All(vol.Coerce(int), vol.Range(min=0, max=5)),
        vol.Optional("assigned_to"): cv.string,
        vol.Optional("assignee_user"): cv.string,
    }
)

COMPLETE_TASK_SCHEMA = vol.Schema(
    {
        vol.Exclusive("task_id", "task_identifier"): cv.string,
        vol.Exclusive("title", "task_identifier"): cv.string,
    }
)

SEARCH_TASKS_SCHEMA = vol.Schema(
    {
        vol.Required("query"): cv.string,
        vol.Optional("status"): vol.In(["backlog", "todo", "in_progress", "done"]),
        vol.Optional("priority"): vol.All(vol.Coerce(int), vol.Range(min=1, max=5)),
        vol.Optional("include_completed", default=False): cv.boolean,
    }
)

COMPLETE_TASK_BY_TAG_SCHEMA = vol.Schema(
    {
        vol.Required("tag_id"): cv.string,
    }
)


type MeithealConfigEntry = ConfigEntry[MeithealCoordinator]


async def async_setup_entry(hass: HomeAssistant, entry: MeithealConfigEntry) -> bool:
    """Set up Meitheal from a config entry."""
    token = entry.data.get(CONF_API_TOKEN)
    try:
        origin = connection_origin(entry.data)
        await async_validate_transport(hass, origin, token)
    except ValueError:
        raise ConfigEntryError("Reconfigure the Meitheal connection") from None
    except MeithealConnectionError as err:
        raise ConfigEntryNotReady(str(err)) from None

    session = async_create_clientsession(hass, cookie_jar=DummyCookieJar())
    coordinator = MeithealCoordinator(hass, MeithealApi(session, origin, token))
    coordinator.config_entry = entry
    await coordinator.async_config_entry_first_refresh()

    # IQS rule: runtime-data — store coordinator on the entry, not hass.data
    entry.runtime_data = coordinator

    # ── Register Meitheal as a device ────────────────────────────────────
    # This creates a device entry so Meitheal appears in Settings → Devices,
    # and enables companion app features: device automations, Android shortcuts,
    # iOS quick actions, Siri shortcuts, and widget integrations.
    from homeassistant.helpers import device_registry as dr
    dev_reg = dr.async_get(hass)
    dev_reg.async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, "meitheal_hub")},
        name="Meitheal",
        manufacturer="Coolock Village",
        model="Task Engine",
        sw_version=entry.data.get("version", "0.2.0"),
        entry_type=dr.DeviceEntryType.SERVICE,
        configuration_url=str(origin),
    )

    # Forward to platforms (todo, sensor)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # ── Service handlers ─────────────────────────────────────────────────

    async def handle_create_task(call: ServiceCall) -> None:
        """Handle meitheal.create_task service call."""
        try:
            assigned_to = call.data.get("assigned_to") or call.data.get("assignee_user")
            await coordinator.async_create_task(
                title=call.data["title"],
                description=call.data.get("description"),
                priority=call.data.get("priority"),
                due_date=call.data.get("due_date"),
                urgency=call.data.get("urgency"),
                importance=call.data.get("importance"),
                assigned_to=assigned_to,
            )
        except Exception as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="create_failed",
                translation_placeholders={"error": str(err)},
            ) from err

    async def handle_complete_task(call: ServiceCall) -> None:
        """Handle meitheal.complete_task service call."""
        try:
            await coordinator.async_complete_task(
                task_id=call.data.get("task_id"),
                title=call.data.get("title"),
            )
        except Exception as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="complete_failed",
                translation_placeholders={"error": str(err)},
            ) from err

    async def handle_sync_todo(call: ServiceCall) -> None:
        """Handle meitheal.sync_todo service call."""
        try:
            await coordinator.async_request_refresh()
        except Exception as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="addon_unavailable",
            ) from err

    async def handle_search_tasks(call: ServiceCall) -> ServiceResponse:
        """Handle meitheal.search_tasks service call."""
        if not coordinator:
            return {"tasks": []}

        return await coordinator.async_search_tasks(
            query=str(call.data.get("query", "")),
            status=call.data.get("status"),
            priority=call.data.get("priority"),
            include_completed=bool(call.data.get("include_completed", False)),
        )

    async def handle_get_overdue_tasks(call: ServiceCall) -> ServiceResponse:
        """Handle meitheal.get_overdue_tasks service call."""
        if not coordinator.data:
            return {"tasks": []}

        results = [
            {
                "id": task.id,
                "title": task.title,
                "status": task.status,
                "priority": task.priority,
                "due_date": task.due_date,
                "description": task.description,
            }
            for task in coordinator.data.tasks
            if task.is_overdue
        ]

        return {"tasks": results}

    # ── Register services ────────────────────────────────────────────────

    hass.services.async_register(
        DOMAIN, SERVICE_CREATE_TASK, handle_create_task, schema=CREATE_TASK_SCHEMA
    )
    hass.services.async_register(
        DOMAIN, SERVICE_COMPLETE_TASK, handle_complete_task, schema=COMPLETE_TASK_SCHEMA
    )
    hass.services.async_register(DOMAIN, SERVICE_SYNC_TODO, handle_sync_todo)
    hass.services.async_register(
        DOMAIN,
        SERVICE_SEARCH_TASKS,
        handle_search_tasks,
        schema=SEARCH_TASKS_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_GET_OVERDUE_TASKS,
        handle_get_overdue_tasks,
        supports_response=SupportsResponse.ONLY,
    )

    # Phase 7: NFC tag completion service
    async def handle_complete_task_by_tag(call: ServiceCall) -> None:
        """Handle meitheal.complete_task_by_tag service call."""
        try:
            await coordinator.async_complete_task_by_tag(
                tag_id=call.data["tag_id"],
            )
        except Exception as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="nfc_complete_failed",
                translation_placeholders={"error": str(err)},
            ) from err

    hass.services.async_register(
        DOMAIN,
        SERVICE_COMPLETE_TASK_BY_TAG,
        handle_complete_task_by_tag,
        schema=COMPLETE_TASK_BY_TAG_SCHEMA,
    )

    if async_register_llm_api is not None:
        try:
            if unregister_llm := async_register_llm_api(hass, entry):
                entry.async_on_unload(unregister_llm)
        except HomeAssistantError:
            _LOGGER.warning("Could not register Meitheal's read-only LLM API")

    # Register custom intents — accent-friendly voice commands that work
    # WITHOUT an LLM. Uses HA's built-in sentence matching engine.
    # Triggers: "add X to my tasks", "done with X", "show my tasks",
    # "what's overdue", "today's tasks", "task count"
    # Also supports phonetic variants: "me hall", "may hall", "MH"
    try:
        from .intents import async_register_intents
        async_register_intents(hass)
    except Exception:
        _LOGGER.warning("Could not register Meitheal intents — voice triggers disabled")

    # Register proactive notification service
    # meitheal.notify_overdue — pushes overdue task alerts through HA notify
    async def handle_notify_overdue(call: ServiceCall) -> None:
        """Push overdue task notifications through HA persistent_notification."""
        if not coordinator.data or not coordinator.data.overdue_count:
            return

        overdue = [t for t in coordinator.data.tasks if t.is_overdue]
        titles = ", ".join(t.title for t in overdue[:5])
        extra = f" (+{len(overdue) - 5} more)" if len(overdue) > 5 else ""

        await hass.services.async_call(
            "persistent_notification",
            "create",
            {
                "title": f"⏰ {len(overdue)} Overdue Tasks",
                "message": f"These tasks are past due: {titles}{extra}",
                "notification_id": "meitheal_overdue",
            },
        )

    hass.services.async_register(
        DOMAIN, "notify_overdue", handle_notify_overdue
    )

    return True


async def async_unload_entry(hass: HomeAssistant, entry: MeithealConfigEntry) -> bool:
    """Unload a Meitheal config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        await entry.runtime_data.async_shutdown()
        # Remove services (single_config_entry — always safe to remove)
        hass.services.async_remove(DOMAIN, SERVICE_CREATE_TASK)
        hass.services.async_remove(DOMAIN, SERVICE_COMPLETE_TASK)
        hass.services.async_remove(DOMAIN, SERVICE_SYNC_TODO)
        hass.services.async_remove(DOMAIN, SERVICE_SEARCH_TASKS)
        hass.services.async_remove(DOMAIN, SERVICE_GET_OVERDUE_TASKS)
        hass.services.async_remove(DOMAIN, SERVICE_COMPLETE_TASK_BY_TAG)
        hass.services.async_remove(DOMAIN, "notify_overdue")
    return unload_ok
