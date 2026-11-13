"""Verify the optional LLM registry and its tool-call boundaries."""

from unittest.mock import AsyncMock

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
            hass, f"meitheal_tasks-{entry.entry_id}", llm_context(hass_admin_user.id)
        )
        assert {tool.name for tool in instance.tools} == {SEARCH, GET_TASK, CREATE_TASK, COMPLETE_TASK}
        for tool in instance.tools:
            assert tool.integration == DOMAIN
            if tool.name in (SEARCH, GET_TASK):
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
    api_id = f"meitheal_tasks-{entry.entry_id}"
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
@pytest.mark.parametrize(
    "platform,assistant,expected_name",
    [
        ("google_generative_ai_conversation", "conversation", "Gemini Conversation"),
        ("test", "Gemini", "Gemini Conversation"),
        ("conversation", "Kitchen", "Home Assistant Assist (Kitchen)"),
        ("conversation", "conversation", "Home Assistant Conversation"),
    ],
)
async def test_llm_write_tools_send_verified_origin_headers(
    hass: HomeAssistant,
    hass_admin_user: User,
    platform: str,
    assistant: str,
    expected_name: str,
) -> None:
    """Create and complete LLM tools attach verified conversation-agent provenance headers."""
    entry = MockConfigEntry(domain=DOMAIN, title="llm-origin", state=ConfigEntryState.LOADED)
    entry.add_to_hass(hass)
    client = AsyncMock(spec=MeithealApi)
    client.async_request.side_effect = [
        {"id": "task-created"},
        {"id": "task-created", "status": "done"},
    ]
    entry.runtime_data = MeithealCoordinator(hass, client)
    entry.runtime_data.async_request_refresh = AsyncMock()
    unregister = async_register_llm_api(hass, entry)
    assert unregister is not None
    try:
        ctx = llm.LLMContext(
            platform=platform,
            context=Context(user_id=hass_admin_user.id),
            language="en",
            assistant=assistant,
            device_id=None,
        )
        instance = await llm.async_get_api(hass, f"meitheal_tasks-{entry.entry_id}", ctx)
        await async_call(instance, CREATE_TASK, {"title": "Water plants"})
        await async_call(instance, COMPLETE_TASK, {"task_id": "task-created"})
    finally:
        unregister()

    expected_headers = {
        "X-Meitheal-Origin-Kind": "conversation_agent",
        "X-Meitheal-Origin-Name": expected_name,
        "X-Meitheal-Origin-Target": "/config/voice-assistants/assistants",
    }
    assert client.async_request.await_count == 2
    assert client.async_request.await_args_list[0].kwargs["extra_headers"] == expected_headers
    assert client.async_request.await_args_list[1].kwargs["extra_headers"] == expected_headers


async def test_intent_origin_scope_attaches_assist_headers_over_http(
    hass: HomeAssistant,
    hass_admin_user: User,
    aioclient_mock: AiohttpClientMocker,
) -> None:
    """Custom intents attach Home Assistant Assist origin headers via MeithealApi without changing coordinator args."""
    from homeassistant.helpers import intent
    from custom_components.meitheal import intents

    origin = "https://tasks.example.test"
    token = "mth_" + "c" * 64
    aioclient_mock.get(f"{origin}/api/tasks", json={"tasks": []})
    aioclient_mock.get(f"{origin}/api/gamification", status=403)
    aioclient_mock.post(f"{origin}/api/tasks", json={"id": "assist-task-1"})
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={CONF_HOST: "tasks.example.test", CONF_PORT: 443, CONF_SSL: True, "api_token": token},
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    try:
        await intent.async_handle(
            hass,
            "conversation",
            intents.INTENT_ADD_TASK,
            {"item": {"value": "Buy tea"}},
            context=Context(user_id=hass_admin_user.id),
        )
    finally:
        await hass.config_entries.async_unload(entry.entry_id)

    post_calls = [
        headers
        for method, url, _, headers in aioclient_mock.mock_calls
        if method == "POST" and str(url) == f"{origin}/api/tasks"
    ]
    assert len(post_calls) == 1
    assert post_calls[0]["X-Meitheal-Origin-Kind"] == "conversation_agent"
    assert post_calls[0]["X-Meitheal-Origin-Name"] == "Home Assistant Assist"
    assert post_calls[0]["X-Meitheal-Origin-Target"] == "/config/voice-assistants/assistants"
