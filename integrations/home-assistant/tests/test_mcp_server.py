"""Tests for the Home Assistant MCP endpoint view, JSON-RPC handler, and assignee resolution."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

from homeassistant.components.http import KEY_HASS, KEY_HASS_USER
from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import CONF_HOST, CONF_PORT, CONF_SSL
from homeassistant.core import Context, HomeAssistant
from homeassistant.exceptions import Unauthorized
from homeassistant.helpers.update_coordinator import UpdateFailed
import pytest

try:
    from pytest_homeassistant.common import MockConfigEntry
    from pytest_homeassistant.test_util.aiohttp import AiohttpClientMocker
except ModuleNotFoundError as error:
    if error.name != "pytest_homeassistant":
        raise
    from pytest_homeassistant_custom_component.common import MockConfigEntry
    from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from custom_components.meitheal.api import build_origin_headers
from custom_components.meitheal.const import CONF_API_TOKEN, DOMAIN
from custom_components.meitheal.coordinator import MeithealCoordinator
from custom_components.meitheal.mcp_server import (
    MeithealMcpView,
    _resolve_loaded_coordinator,
    handle_mcp_request,
)


def _mock_coordinator(hass: HomeAssistant, async_request: AsyncMock | None = None) -> MeithealCoordinator:
    api = SimpleNamespace(
        async_request=async_request or AsyncMock(),
        origin="https://tasks.example.test",
    )
    return MeithealCoordinator(hass, api)  # type: ignore[arg-type]


async def test_mcp_notifications_return_none(hass: HomeAssistant) -> None:
    """JSON-RPC notifications without an id return None (mapped to HTTP 202)."""
    coordinator = _mock_coordinator(hass)

    assert (
        await handle_mcp_request(
            coordinator,
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
        )
        is None
    )
    assert (
        await handle_mcp_request(
            coordinator,
            {"jsonrpc": "2.0", "method": "notifications/cancelled"},
        )
        is None
    )


async def test_mcp_rejects_malformed_requests_and_params(hass: HomeAssistant) -> None:
    """Non-dict JSON-RPC payloads and malformed tools/call params return standard JSON-RPC errors."""
    coordinator = _mock_coordinator(hass)

    bad_payload = await handle_mcp_request(coordinator, ["not", "an", "object"])
    assert bad_payload is not None
    assert bad_payload["error"]["code"] == -32600

    bad_params = await handle_mcp_request(
        coordinator,
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": "invalid"},
    )
    assert bad_params is not None
    assert bad_params["error"]["code"] == -32602

    bad_args = await handle_mcp_request(
        coordinator,
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": "meitheal_list_tasks", "arguments": ["bad"]},
        },
    )
    assert bad_args is not None
    assert bad_args["error"]["code"] == -32602


async def test_resolve_loaded_coordinator_uses_runtime_data(hass: HomeAssistant) -> None:
    """Only LOADED entries with runtime_data resolve cleanly across reloads."""
    coordinator = _mock_coordinator(hass)
    entry = MockConfigEntry(domain=DOMAIN, title="Meitheal", data={}, unique_id=DOMAIN)
    entry.add_to_hass(hass)

    assert _resolve_loaded_coordinator(hass) is None

    entry.runtime_data = coordinator
    entry.mock_state(hass, ConfigEntryState.LOADED)
    assert _resolve_loaded_coordinator(hass) is coordinator


async def test_mcp_view_requires_admin(hass: HomeAssistant) -> None:
    """Non-admin Home Assistant users must be rejected by @require_admin on MeithealMcpView."""
    view = MeithealMcpView()

    class _Req(dict):
        async def json(self):
            return {"jsonrpc": "2.0", "id": 1, "method": "ping"}

    req = _Req({KEY_HASS_USER: SimpleNamespace(is_admin=False)})
    req.app = {KEY_HASS: hass}  # type: ignore[attr-defined]

    with pytest.raises(Unauthorized):
        await view.post(req)  # type: ignore[arg-type]

    admin_req = _Req({KEY_HASS_USER: SimpleNamespace(is_admin=True)})
    admin_req.app = {KEY_HASS: hass}  # type: ignore[attr-defined]
    res = await view.post(admin_req)  # type: ignore[arg-type]
    assert res.status == 503


async def test_resolve_assignee_handles_exact_id_unique_name_ambiguous_and_missing(hass: HomeAssistant) -> None:
    """Assignee resolution preserves canonical IDs and guards ambiguous display names."""
    async_request = AsyncMock(
        return_value={
            "users": [
                {"id": "custom_agent_1", "name": "Claude"},
                {"id": "ha_person_alice", "name": "Alex"},
                {"id": "ha_person_alex2", "name": "Alex"},
            ]
        }
    )
    coordinator = _mock_coordinator(hass, async_request=async_request)

    assert await coordinator.async_resolve_assignee("custom_agent_1") == "custom_agent_1"
    assert await coordinator.async_resolve_assignee("ha_person_alice") == "ha_person_alice"
    assert async_request.await_count == 0

    assert await coordinator.async_resolve_assignee("  claude ") == "custom_agent_1"

    with pytest.raises(UpdateFailed, match="Multiple assignees match"):
        await coordinator.async_resolve_assignee("Alex")

    with pytest.raises(UpdateFailed, match="No assignee found"):
        await coordinator.async_resolve_assignee("Nobody")


async def test_mcp_mutations_thread_and_sanitize_origin_headers(hass: HomeAssistant) -> None:
    """MCP createTask and updateTask pass verified origin headers and strip unsafe targets."""
    async_request = AsyncMock(side_effect=[{"id": "t1"}, None])
    coordinator = _mock_coordinator(hass, async_request=async_request)
    coordinator.async_request_refresh = AsyncMock()

    create_res = await handle_mcp_request(
        coordinator,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "createTask",
                "arguments": {"title": "MCP task"},
                "_meta": {
                    "origin_name": "Claude Desktop\r\nEvil",
                    "origin_target": "javascript:alert(1)",
                },
            },
        },
    )
    assert create_res is not None
    assert create_res["result"]["isError"] is False
    assert async_request.await_args_list[0].kwargs["extra_headers"] == {
        "X-Meitheal-Origin-Kind": "mcp",
        "X-Meitheal-Origin-Name": "Claude Desktop Evil",
    }

    update_res = await handle_mcp_request(
        coordinator,
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "updateTask",
                "arguments": {
                    "id": "t1",
                    "title": "Renamed",
                    "origin_name": "Home Assistant MCP",
                    "origin_target": "/config/integrations/integration/meitheal",
                },
            },
        },
    )
    assert update_res is not None
    assert update_res["result"]["isError"] is False
    update_call = async_request.await_args_list[1]
    assert update_call.kwargs["payload"] == {"title": "Renamed"}
    assert update_call.kwargs["extra_headers"] == {
        "X-Meitheal-Origin-Kind": "mcp",
        "X-Meitheal-Origin-Name": "Home Assistant MCP",
        "X-Meitheal-Origin-Target": "/config/integrations/integration/meitheal",
    }


def test_build_origin_headers_rejects_unsafe_targets() -> None:
    """Only strictly relative paths without schemes or control characters are accepted."""
    assert build_origin_headers("ha_automation", "Bedtime", "/config/automation/edit/bedtime") == {
        "X-Meitheal-Origin-Kind": "ha_automation",
        "X-Meitheal-Origin-Name": "Bedtime",
        "X-Meitheal-Origin-Target": "/config/automation/edit/bedtime",
    }
    for bad in ("javascript:alert(1)", "http://evil.test/x", "//evil.test/x", "/\\evil", "data:text/html,hi", "/a\nb"):
        assert "X-Meitheal-Origin-Target" not in build_origin_headers("ha_automation", "Bedtime", bad)
    assert "X-Meitheal-Origin-Kind" not in build_origin_headers("spoofed_kind", "Bedtime", None)


async def test_service_call_from_automation_context_sends_origin_headers(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
) -> None:
    """Service calls invoked inside an automation context attribute the automation name and edit target."""
    origin = "https://tasks.example.test"
    token = "mth_" + "d" * 64
    aioclient_mock.get(f"{origin}/api/tasks", json={"tasks": []})
    aioclient_mock.get(f"{origin}/api/gamification", status=403)
    aioclient_mock.post(f"{origin}/api/tasks", json={"id": "auto-task-1"})

    entry = MockConfigEntry(
        domain=DOMAIN,
        data={CONF_HOST: "tasks.example.test", CONF_PORT: 443, CONF_SSL: True, CONF_API_TOKEN: token},
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    try:
        auto_ctx = Context()
        hass.states.async_set(
            "automation.bedtime_routine",
            "on",
            {"friendly_name": "Bedtime Routine", "id": "bedtime_123"},
            context=auto_ctx,
        )
        await hass.services.async_call(
            DOMAIN,
            "create_task",
            {"title": "Lock back door"},
            blocking=True,
            context=Context(parent_id=auto_ctx.id),
        )
    finally:
        await hass.config_entries.async_unload(entry.entry_id)

    post_calls = [
        headers
        for method, url, _, headers in aioclient_mock.mock_calls
        if method == "POST" and str(url) == f"{origin}/api/tasks"
    ]
    assert len(post_calls) == 1
    assert post_calls[0]["X-Meitheal-Origin-Kind"] == "ha_automation"
    assert post_calls[0]["X-Meitheal-Origin-Name"] == "Bedtime Routine"
    assert post_calls[0]["X-Meitheal-Origin-Target"] == "/config/automation/edit/bedtime_123"
