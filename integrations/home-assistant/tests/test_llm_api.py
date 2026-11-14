"""Verify the optional LLM registry and its tool-call boundaries."""

from unittest.mock import ANY, AsyncMock

import probatio
import pytest

from homeassistant.auth.const import GROUP_ID_USER
from homeassistant.auth.models import User
from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import CONF_HOST, CONF_PORT, CONF_SSL
from homeassistant.core import Context, HomeAssistant
from homeassistant.exceptions import HomeAssistantError, Unauthorized
from homeassistant.helpers import llm

try:
    from pytest_homeassistant.common import MockConfigEntry
    from pytest_homeassistant.test_util.aiohttp import AiohttpClientMocker
except ModuleNotFoundError as error:
    if error.name != "pytest_homeassistant":
        raise
    from pytest_homeassistant_custom_component.common import MockConfigEntry
    from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from custom_components.meitheal.api import MeithealApi
from custom_components.meitheal.const import DOMAIN
from custom_components.meitheal.coordinator import MeithealCoordinator
from custom_components.meitheal.llm_api import async_register_llm_api

NATIVE_ADMIN = hasattr(llm.API, "requires_admin")
SEARCH = "meitheal_search_tasks"
GET_TASK = "meitheal_get_task"
CREATE_TASK = "meitheal_create_task"
COMPLETE_TASK = "meitheal_complete_task"


def llm_context(user_id: str | None) -> llm.LLMContext:
    """Build a conversation context with the requested principal."""
    return llm.LLMContext(
        platform="test",
        context=Context(user_id=user_id),
        language="en",
        assistant="conversation",
        device_id=None,
    )


async def async_call(
    instance: llm.APIInstance,
    name: str,
    args: dict[str, object],
    context: llm.LLMContext | None = None,
) -> llm.ToolResult:
    """Call the selected tool with a current or retained Core context."""
    tool = next(tool for tool in instance.tools if tool.name == name)
    return await tool.async_call(
        instance.api.hass, llm.ToolInput(name, args), context or instance.llm_context
    )


async def test_optional_registry_follows_entry_lifecycle(
    hass: HomeAssistant,
    hass_admin_user: User,
    aioclient_mock: AiohttpClientMocker,
) -> None:
    """Core loads ordinary services on both versions and removes the optional API."""
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={CONF_HOST: "tasks.example.test", CONF_PORT: 443, CONF_SSL: True},
    )
    entry.add_to_hass(hass)
    aioclient_mock.get("https://tasks.example.test/api/tasks", json={"tasks": []})
    aioclient_mock.get("https://tasks.example.test/api/gamification", status=403)
    assert await hass.config_entries.async_setup(entry.entry_id)
    assert hass.services.has_service(DOMAIN, "create_task")

    api_id = f"meitheal_tasks-{entry.entry_id}"
    assert (api_id in {api.id for api in llm.async_get_apis(hass)}) is NATIVE_ADMIN
    if NATIVE_ADMIN:
        instance = await llm.async_get_api(hass, api_id, llm_context(hass_admin_user.id))
        assert instance.api.requires_admin

    assert await hass.config_entries.async_unload(entry.entry_id)
    assert api_id not in {api.id for api in llm.async_get_apis(hass)}
    if NATIVE_ADMIN:
        with pytest.raises(HomeAssistantError, match="Meitheal entry is unavailable"):
            await async_call(instance, SEARCH, {"query": "fixture"})


@pytest.fixture
def registered_entries(hass: HomeAssistant):
    """Provide distinct loaded entries to verify routing without changing the manifest."""
    entries = []
    for label in ("entry-a", "entry-b"):
        entry = MockConfigEntry(domain=DOMAIN, title=label, state=ConfigEntryState.LOADED)
        entry.add_to_hass(hass)
        client = AsyncMock(spec=MeithealApi)
        client.async_request.side_effect = [
            {"sections": [{"id": "tasks", "items": [{"id": label, "title": label}]}]},
            {"id": label, "title": label, "description": "Fixture", "private": "omit"},
        ]
        entry.runtime_data = MeithealCoordinator(hass, client)
        unregister = async_register_llm_api(hass, entry)
        assert unregister is not None
        entries.append((entry, client, unregister))
    yield entries
    for _, _, unregister in entries:
        unregister()


@pytest.mark.skipif(not NATIVE_ADMIN, reason="Core does not provide an admin-aware registry")
async def test_read_tools_use_the_selected_entry(
    hass: HomeAssistant, hass_admin_user: User, registered_entries
) -> None:
    """The API is per-entry, serializable, read-only, and bounded."""
    for entry, client, _ in reversed(registered_entries):
        instance = await llm.async_get_api(
            hass, f"meitheal_tasks_read-{entry.entry_id}", llm_context(hass_admin_user.id)
        )
        assert {tool.name for tool in instance.tools} == {SEARCH, GET_TASK}
        # Creating and completing live in the manage API, so this one stays read-only.
        manage = await llm.async_get_api(
            hass, f"meitheal_tasks-{entry.entry_id}", llm_context(hass_admin_user.id)
        )
        assert {SEARCH, GET_TASK, CREATE_TASK, COMPLETE_TASK} <= {tool.name for tool in manage.tools}
        for tool in instance.tools:
            assert tool.integration == DOMAIN
            assert tool.annotations.read_only
            assert not tool.annotations.destructive
            assert probatio.to_openapi(tool.parameters)["type"] == "object"

        search = await async_call(instance, SEARCH, {"query": "fixture"})
        assert search.data["tasks"][0]["id"] == entry.title
        client.async_request.assert_awaited_once_with(
            "GET", "/api/search", params={"scope": "tasks", "limit": "20", "q": "fixture"},
            read_json=True,
        )

        task = await async_call(instance, GET_TASK, {"task_id": entry.title})
        assert task.data["id"] == entry.title
        assert task.data["description"] == "Fixture"
        assert "private" not in task.data
        client.async_request.assert_awaited_with(
            "GET", f"/api/tasks/{entry.title}", read_json=True
        )


@pytest.mark.skipif(not NATIVE_ADMIN, reason="Core does not provide an admin-aware registry")
async def test_cached_tools_recheck_user_entry_and_arguments(
    hass: HomeAssistant, hass_admin_user: User, registered_entries
) -> None:
    """Denials happen before any request to the selected integration."""
    entry, client, _ = registered_entries[0]
    api_id = f"meitheal_tasks_read-{entry.entry_id}"
    context = llm_context(hass_admin_user.id)
    instance = await llm.async_get_api(hass, api_id, context)
    member = await hass.auth.async_create_user("Fixture member", group_ids=[GROUP_ID_USER])

    for user_id in (None, "unknown", member.id):
        other = llm_context(user_id)
        with pytest.raises(Unauthorized):
            await llm.async_get_api(hass, api_id, other)
        with pytest.raises(Unauthorized):
            await async_call(instance, SEARCH, {"query": "fixture"}, other)

    for name, arguments in (
        (SEARCH, {}),
        (SEARCH, {"query": 7}),
        (SEARCH, {"query": "x" * 201}),
        (SEARCH, {"query": "fixture", "status": "invented"}),
        (GET_TASK, {"task_id": ".."}),
    ):
        with pytest.raises(HomeAssistantError, match="Invalid Meitheal tool arguments"):
            await async_call(instance, name, arguments)

    original_coordinator = entry.runtime_data
    entry.runtime_data = MeithealCoordinator(hass, client)
    with pytest.raises(HomeAssistantError, match="Meitheal entry is unavailable"):
        await async_call(instance, SEARCH, {"query": "fixture"})
    entry.runtime_data = original_coordinator

    await hass.auth.async_update_user(hass_admin_user, group_ids=[GROUP_ID_USER])
    with pytest.raises(Unauthorized):
        await async_call(instance, SEARCH, {"query": "fixture"})

    client.async_request.assert_not_awaited()


@pytest.mark.skipif(not NATIVE_ADMIN, reason="Core does not provide an admin-aware registry")
async def test_manage_api_reads_and_changes_tasks_for_the_caller(
    hass: HomeAssistant, hass_admin_user: User
) -> None:
    """The full API lists the caller's tasks, answers, updates, hands off and completes."""
    entry = MockConfigEntry(domain=DOMAIN, title="manage", state=ConfigEntryState.LOADED)
    entry.add_to_hass(hass)
    client = AsyncMock(spec=MeithealApi)
    coordinator = entry.runtime_data = MeithealCoordinator(hass, client)
    coordinator.async_request_refresh = AsyncMock()
    coordinator.async_complete_task = AsyncMock()
    unregister = async_register_llm_api(hass, entry)
    me = f"ha_{hass_admin_user.id}"
    try:
        read_only = await llm.async_get_api(
            hass, f"meitheal_tasks_read-{entry.entry_id}", llm_context(hass_admin_user.id)
        )
        assert {tool.name for tool in read_only.tools} == {SEARCH, GET_TASK}

        instance = await llm.async_get_api(
            hass, f"meitheal_tasks-{entry.entry_id}", llm_context(hass_admin_user.id)
        )
        assert instance.api.requires_admin and instance.api.name == "Meitheal Tasks"
        tools = {tool.name: tool for tool in instance.tools}
        assert set(tools) == {
            SEARCH, GET_TASK, "meitheal_list_tasks", "meitheal_get_task_comments",
            "meitheal_create_task", "meitheal_update_task", "meitheal_complete_task",
            "meitheal_add_comment",
        }
        for name, tool in tools.items():
            assert probatio.to_openapi(tool.parameters)["type"] == "object"
            assert tool.annotations.read_only is (
                name in (SEARCH, GET_TASK, "meitheal_list_tasks", "meitheal_get_task_comments")
            )
            assert not tool.annotations.destructive

        client.async_request.return_value = {"tasks": [
            {"id": "open", "title": "Open", "status": "pending", "assigned_to": me, "private": "omit"},
            {"id": "done", "title": "Done", "status": "complete", "assigned_to": me},
        ]}
        mine = await async_call(instance, "meitheal_list_tasks", {})
        assert mine.data["assignee"] == me
        assert [task["id"] for task in mine.data["tasks"]] == ["open"]
        assert "private" not in mine.data["tasks"][0]
        client.async_request.assert_awaited_with(
            "GET", "/api/tasks",
            params={"assigned_to": me, "limit": "200", "sort": "updated_at"}, read_json=True,
        )
        everything = await async_call(
            instance, "meitheal_list_tasks",
            {"assignee": "custom_1a2b3c4d", "include_completed": True},
        )
        assert everything.data["count"] == 2
        assert client.async_request.await_args.kwargs["params"]["assigned_to"] == "custom_1a2b3c4d"

        client.async_request.return_value = {"id": "new", "title": "Plan", "assigned_to": me}
        created = await async_call(
            instance, "meitheal_create_task", {"title": "Plan", "priority": 2, "assignee": "me"}
        )
        assert created.data["id"] == "new"
        client.async_request.assert_awaited_with(
            "POST",
            "/api/tasks",
            payload={"title": "Plan", "priority": 2, "assigned_to": me},
            read_json=True,
            event_authority=ANY,
        )

        client.async_request.return_value = {"id": "open", "status": "active", "assigned_to": None}
        await async_call(
            instance, "meitheal_update_task",
            {"task_id": "open", "status": "active", "assignee": "unassigned"},
        )
        client.async_request.assert_awaited_with(
            "PUT", "/api/tasks/open",
            payload={"status": "active", "assigned_to": None}, read_json=True,
        )
        await async_call(
            instance, "meitheal_update_task", {"task_id": "open", "assignee": "custom_1a2b3c4d"}
        )
        assert client.async_request.await_args.kwargs["payload"] == {"assigned_to": "custom_1a2b3c4d"}

        client.async_request.return_value = {"id": 7, "author": "Automation: Home Assistant"}
        comment = await async_call(
            instance, "meitheal_add_comment", {"task_id": "open", "comment": "Done, see notes."}
        )
        assert comment.data == {"id": 7, "author": "Automation: Home Assistant"}
        client.async_request.assert_awaited_with(
            "POST", "/api/tasks/open/comments", payload={"content": "Done, see notes."}, read_json=True,
        )

        client.async_request.return_value = {"comments": [{"author": "Aoife", "content": "Thanks", "created_at": 1, "owner": "omit"}]}
        comments = await async_call(instance, "meitheal_get_task_comments", {"task_id": "open"})
        assert comments.data == {"comments": [{"author": "Aoife", "content": "Thanks", "created_at": 1}]}

        await async_call(instance, "meitheal_complete_task", {"task_id": "open"})
        coordinator.async_complete_task.assert_awaited_once_with(task_id="open")

        # A rejected or mismatched receipt is never reported as a successful change.
        for receipt in (None, {}, {"id": "other"}, {"id": "open", "error": "Rejected"}):
            client.async_request.return_value = receipt
            with pytest.raises(HomeAssistantError, match="did not acknowledge"):
                await async_call(instance, "meitheal_update_task", {"task_id": "open", "title": "New"})
        client.async_request.return_value = {"error": "Rejected"}
        with pytest.raises(HomeAssistantError, match="did not acknowledge"):
            await async_call(instance, "meitheal_add_comment", {"task_id": "open", "comment": "x"})

        awaited = client.async_request.await_count
        for name, arguments in (
            ("meitheal_list_tasks", {"assignee": "Claude"}),
            ("meitheal_create_task", {"title": ""}),
            ("meitheal_create_task", {"title": "Plan", "assignee": "ha_../x"}),
            ("meitheal_update_task", {"task_id": "open"}),
            ("meitheal_update_task", {"task_id": "open", "status": "complete"}),
            ("meitheal_update_task", {"task_id": "..", "title": "x"}),
            ("meitheal_add_comment", {"task_id": "open", "comment": ""}),
            ("meitheal_complete_task", {}),
        ):
            with pytest.raises(HomeAssistantError, match="Invalid Meitheal tool arguments"):
                await async_call(instance, name, arguments)

        member = await hass.auth.async_create_user("Fixture member", group_ids=[GROUP_ID_USER])
        for user_id in (None, member.id):
            with pytest.raises(Unauthorized):
                await async_call(
                    instance, "meitheal_create_task", {"title": "Denied"}, llm_context(user_id)
                )
        assert client.async_request.await_count == awaited
    finally:
        unregister()
    assert not {api.id for api in llm.async_get_apis(hass)} & {
        f"meitheal_tasks-{entry.entry_id}", f"meitheal_tasks_read-{entry.entry_id}"
    }
