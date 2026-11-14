"""Exercise the native Assist caller and entity exposure boundaries."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.auth.const import GROUP_ID_ADMIN, GROUP_ID_USER
from homeassistant.components.homeassistant.exposed_entities import (
    async_expose_entity,
    async_should_expose,
)
from homeassistant.const import CONF_HOST, CONF_PORT, CONF_SSL
from homeassistant.core import Context, HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er, intent
from homeassistant.setup import async_setup_component

try:
    from pytest_homeassistant.common import MockConfigEntry
    from pytest_homeassistant.test_util.aiohttp import AiohttpClientMocker
except ModuleNotFoundError as error:
    if error.name != "pytest_homeassistant":
        raise
    from pytest_homeassistant_custom_component.common import MockConfigEntry
    from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from custom_components.meitheal import intents
from custom_components.meitheal.const import CONF_API_TOKEN, DOMAIN


@pytest.mark.parametrize("platform", ["intent", "conversation"])
async def test_custom_intents_require_current_active_admin(
    hass: HomeAssistant, hass_owner_user, platform: str
) -> None:
    """Check the actual Core dispatcher with authenticated and userless contexts."""
    admin = await hass.auth.async_create_user("Admin", group_ids=[GROUP_ID_ADMIN])
    member = await hass.auth.async_create_user("Member", group_ids=[GROUP_ID_USER])
    inactive = await hass.auth.async_create_user("Inactive", group_ids=[GROUP_ID_ADMIN])
    await hass.auth.async_update_user(inactive, is_active=False)
    intents.async_register_intents(hass)
    registered = (
        intents.INTENT_ADD_TASK,
        intents.INTENT_ADD_TASK_PROMPT,
        intents.INTENT_DONE_TASK,
        intents.INTENT_SHOW_TASKS,
        intents.INTENT_OVERDUE,
        intents.INTENT_TODAY,
        intents.INTENT_SUMMARY,
        intents.INTENT_DELETE_TASK,
        intents.INTENT_BRIEFING,
    )

    with patch.object(intents, "_get_coordinator") as coordinator:
        for user_id in (None, "unknown-user", member.id, inactive.id):
            for name in registered:
                with pytest.raises(intent.IntentHandleError, match="active Home Assistant administrator"):
                    await intent.async_handle(
                        hass, platform, name, context=Context(user_id=user_id)
                    )
        coordinator.assert_not_called()

        task = SimpleNamespace(id="task-1", title="Check the garden", status="todo")
        coordinator.return_value = SimpleNamespace(
            async_create_task=AsyncMock(),
            async_complete_task=AsyncMock(),
            async_delete_task=AsyncMock(),
            resolve_task_title=lambda title: task.id,
            data=SimpleNamespace(tasks=[task]),
        )
        context = Context(user_id=admin.id)
        slots = {"item": {"value": task.title}}
        for name in (intents.INTENT_ADD_TASK, intents.INTENT_DONE_TASK, intents.INTENT_DELETE_TASK):
            await intent.async_handle(hass, platform, name, slots, context=context)
        result = await intent.async_handle(
            hass, platform, intents.INTENT_SHOW_TASKS, context=context
        )
        assert task.title in result.speech["plain"]["speech"]
        coordinator.return_value.async_create_task.assert_awaited_once_with(title=task.title)
        coordinator.return_value.async_complete_task.assert_awaited_once_with(title=task.title)
        coordinator.return_value.async_delete_task.assert_awaited_once_with(task.id)

        await hass.auth.async_update_user(admin, group_ids=[GROUP_ID_USER])
        coordinator.reset_mock()
        with pytest.raises(intent.IntentHandleError, match="active Home Assistant administrator"):
            await intent.async_handle(
                hass, platform, intents.INTENT_SHOW_TASKS, context=context
            )
        coordinator.assert_not_called()


@pytest.mark.parametrize("expose", [False, True])
async def test_reload_keeps_home_assistant_exposure_choice_and_todo_service(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, hass_owner_user, expose: bool
) -> None:
    """Reload preserves the chosen exposure and the ordinary authenticated Todo API."""
    assert await async_setup_component(hass, "homeassistant", {})
    origin = "https://tasks.example.test"
    tasks_url = f"{origin}/api/tasks"
    token = "mth_" + "a" * 64
    aioclient_mock.get(tasks_url, json={"tasks": [{"id": "task-1", "title": "Check the garden"}]})
    aioclient_mock.get(f"{origin}/api/gamification", status=403)
    aioclient_mock.delete(f"{tasks_url}/task-1", status=204)
    entry = MockConfigEntry(
        domain=DOMAIN,
        title="Meitheal",
        data={CONF_HOST: "tasks.example.test", CONF_PORT: 443, CONF_SSL: True, CONF_API_TOKEN: token},
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    entity_id = er.async_get(hass).async_get_entity_id("todo", DOMAIN, f"{entry.entry_id}_todo")
    assert entity_id == "todo.meitheal_tasks"
    async_expose_entity(hass, "conversation", entity_id, expose)
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert async_should_expose(hass, "conversation", entity_id) is expose

    await hass.services.async_call(
        "todo",
        "remove_item",
        {"entity_id": entity_id, "item": "task-1"},
        blocking=True,
        context=Context(user_id=hass_owner_user.id),
    )
    assert any(
        method == "DELETE" and str(url) == f"{tasks_url}/task-1"
        and headers["Authorization"] == f"Bearer {token}"
        for method, url, _, headers in aioclient_mock.mock_calls
    )


async def test_intent_add_and_done_return_failure_speech_on_error(
    hass: HomeAssistant, hass_owner_user
) -> None:
    """Add and Done intents turn coordinator failures into spoken error responses."""
    admin = await hass.auth.async_create_user("AdminErr", group_ids=[GROUP_ID_ADMIN])
    intents.async_register_intents(hass)
    context = Context(user_id=admin.id)
    slots = {"item": {"value": "Clean chimney"}}
    mock_coord = SimpleNamespace(
        async_create_task=AsyncMock(side_effect=HomeAssistantError("add failed")),
        async_complete_task=AsyncMock(side_effect=ValueError("done failed")),
    )
    with patch.object(intents, "_get_coordinator", return_value=mock_coord):
        add_res = await intent.async_handle(
            hass, "conversation", intents.INTENT_ADD_TASK, slots, context=context
        )
        done_res = await intent.async_handle(
            hass, "conversation", intents.INTENT_DONE_TASK, slots, context=context
        )
    assert "add failed" in add_res.speech["plain"]["speech"]
    assert "done failed" in done_res.speech["plain"]["speech"]

