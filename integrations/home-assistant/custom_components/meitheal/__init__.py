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
- Optional task lookup and management tools for Home Assistant LLM agents

"""

from __future__ import annotations

import logging
import os
import shutil
from typing import Any
from urllib.parse import quote

from aiohttp import DummyCookieJar
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse
from homeassistant.exceptions import ConfigEntryError, ConfigEntryNotReady, HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_create_clientsession
import voluptuous as vol

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
        vol.Optional("status"): vol.In(
            ["backlog", "pending", "active", "complete", "todo", "in_progress", "done"]
        ),
        vol.Optional("priority"): vol.All(vol.Coerce(int), vol.Range(min=1, max=5)),
        vol.Optional("include_completed"): cv.boolean,
    }
)

COMPLETE_TASK_BY_TAG_SCHEMA = vol.Schema(
    {
        vol.Required("tag_id"): cv.string,
    }
)


type MeithealConfigEntry = ConfigEntry[MeithealCoordinator]


def _resolve_service_origin(
    hass: HomeAssistant, call: ServiceCall
) -> tuple[str | None, str | None, str | None]:
    """Derive verified HA automation or script provenance from ServiceCall context."""
    context = call.context
    if context is None:
        return (None, None, None)

    origin_event = getattr(context, "origin_event", None)
    if origin_event is not None and getattr(origin_event, "event_type", None) in (
        "automation_triggered",
        "script_started",
    ):
        data = getattr(origin_event, "data", {}) or {}
        entity_id = data.get("entity_id")
        friendly = data.get("name")
        state = hass.states.get(entity_id) if isinstance(entity_id, str) and entity_id else None
        if origin_event.event_type == "automation_triggered" or (
            isinstance(entity_id, str) and entity_id.startswith("automation.")
        ):
            auto_id = state.attributes.get("id") if state else None
            name = (
                (str(friendly).strip() if isinstance(friendly, str) and friendly.strip() else None)
                or (state.attributes.get("friendly_name") if state else None)
                or (entity_id if isinstance(entity_id, str) else None)
            )
            target = (
                f"/config/automation/edit/{quote(str(auto_id), safe='')}"
                if auto_id
                else "/config/automation/dashboard"
            )
            return ("ha_automation", str(name) if name else None, target)

        slug = entity_id.removeprefix("script.") if isinstance(entity_id, str) else None
        name = (
            (str(friendly).strip() if isinstance(friendly, str) and friendly.strip() else None)
            or (state.attributes.get("friendly_name") if state else None)
            or (entity_id if isinstance(entity_id, str) else None)
        )
        target = f"/config/script/edit/{quote(slug, safe='')}" if slug else "/config/script/dashboard"
        return ("ha_script", str(name) if name else None, target)

    context_ids = {cid for cid in (context.id, context.parent_id) if cid}
    if context_ids:
        for state in hass.states.async_all(["automation", "script"]):
            state_ctx = getattr(state, "context", None)
            if state_ctx is None or state_ctx.id not in context_ids:
                continue
            name = state.attributes.get("friendly_name") or state.name or state.entity_id
            if state.domain == "automation":
                auto_id = state.attributes.get("id")
                target = (
                    f"/config/automation/edit/{quote(str(auto_id), safe='')}"
                    if auto_id
                    else "/config/automation/dashboard"
                )
                return ("ha_automation", str(name), target)
            slug = state.object_id
            target = f"/config/script/edit/{quote(slug, safe='')}" if slug else "/config/script/dashboard"
            return ("ha_script", str(name), target)

    return (None, None, None)


def _install_custom_sentences(src_base: str, dst_base: str) -> None:
    """Copy bundled custom Assist sentences to the HA config directory (runs in executor)."""
    if not os.path.isdir(src_base):
        return
    for lang in os.listdir(src_base):
        lang_src = os.path.join(src_base, lang)
        if not os.path.isdir(lang_src):
            continue
        lang_dst = os.path.join(dst_base, lang)
        os.makedirs(lang_dst, exist_ok=True)
        for fn in os.listdir(lang_src):
            if fn.endswith(".yaml"):
                dst_file = os.path.join(lang_dst, fn)
                if not os.path.exists(dst_file):
                    shutil.copy2(os.path.join(lang_src, fn), dst_file)


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
            origin_kind, origin_name, origin_target = _resolve_service_origin(hass, call)
            origin_kwargs = (
                {
                    "origin_kind": origin_kind,
                    "origin_name": origin_name,
                    "origin_target": origin_target,
                }
                if origin_kind
                else {}
            )
            await coordinator.async_create_task(
                title=call.data["title"],
                description=call.data.get("description"),
                priority=call.data.get("priority"),
                due_date=call.data.get("due_date"),
                urgency=call.data.get("urgency"),
                importance=call.data.get("importance"),
                assigned_to=assigned_to,
                **origin_kwargs,
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
            origin_kind, origin_name, origin_target = _resolve_service_origin(hass, call)
            origin_kwargs = (
                {
                    "origin_kind": origin_kind,
                    "origin_name": origin_name,
                    "origin_target": origin_target,
                }
                if origin_kind
                else {}
            )
            await coordinator.async_complete_task(
                task_id=call.data.get("task_id"),
                title=call.data.get("title"),
                **origin_kwargs,
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
            include_completed=call.data.get("include_completed"),
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
            origin_kind, origin_name, origin_target = _resolve_service_origin(hass, call)
            origin_kwargs = (
                {
                    "origin_kind": origin_kind,
                    "origin_name": origin_name,
                    "origin_target": origin_target,
                }
                if origin_kind
                else {}
            )
            await coordinator.async_complete_task_by_tag(
                tag_id=call.data["tag_id"],
                **origin_kwargs,
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

    # Register live MCP HTTP view once; each request resolves runtime_data dynamically
    try:
        domain_state = hass.data.setdefault(DOMAIN, {})
        if not domain_state.get("mcp_view_registered"):
            from .mcp_server import MeithealMcpView

            hass.http.register_view(MeithealMcpView())
            domain_state["mcp_view_registered"] = True
    except Exception as exc:
        _LOGGER.debug("Could not register Meitheal MCP HTTP view: %s", exc)

    # Ensure custom sentences are copied to <config>/custom_sentences/ off the event loop
    try:
        src_base = os.path.join(os.path.dirname(__file__), "custom_sentences")
        dst_base = hass.config.path("custom_sentences")
        await hass.async_add_executor_job(_install_custom_sentences, src_base, dst_base)
    except Exception as exc:
        _LOGGER.debug("Could not copy custom sentences to config dir: %s", exc)

    if async_register_llm_api is not None:
        try:
            if unregister_llm := async_register_llm_api(hass, entry):
                entry.async_on_unload(unregister_llm)
        except HomeAssistantError:
            _LOGGER.warning("Could not register Meitheal's LLM API")

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
