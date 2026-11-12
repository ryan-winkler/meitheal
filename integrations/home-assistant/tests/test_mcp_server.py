"""Tests for the Home Assistant MCP endpoint view, JSON-RPC handler, and assignee resolution."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

from aiohttp.web_exceptions import HTTPUnauthorized
from homeassistant.components.http import KEY_HASS, KEY_HASS_USER
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import UpdateFailed
import pytest

try:
    from pytest_homeassistant.common import MockConfigEntry
except ModuleNotFoundError as error:
    if error.name != "pytest_homeassistant":
        raise
    from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.meitheal.const import DOMAIN
from custom_components.meitheal.coordinator import MeithealCoordinator
from custom_components.meitheal.mcp_server import (
    MeithealMcpView,
    _resolve_loaded_coordinator,
    handle_mcp_request,
)


def _mock_coordinator(async_request: AsyncMock | None = None) -> MeithealCoordinator:
    api = SimpleNamespace(
        async_request=async_request or AsyncMock(),
        origin="https://tasks.example.test",
    )
    return MeithealCoordinator(SimpleNamespace(data={}), api)  # type: ignore[arg-type]


async def test_mcp_notifications_return_none() -> None:
    """JSON-RPC notifications without an id return None (mapped to HTTP 202)."""
    coordinator = _mock_coordinator()

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


async def test_mcp_rejects_malformed_requests_and_params() -> None:
    """Non-dict JSON-RPC payloads and malformed tools/call params return standard JSON-RPC errors."""
    coordinator = _mock_coordinator()

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
    coordinator = _mock_coordinator()
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

    with pytest.raises(HTTPUnauthorized):
        await view.post(req)  # type: ignore[arg-type]

    admin_req = _Req({KEY_HASS_USER: SimpleNamespace(is_admin=True)})
    admin_req.app = {KEY_HASS: hass}  # type: ignore[attr-defined]
    res = await view.post(admin_req)  # type: ignore[arg-type]
    assert res.status == 503


async def test_resolve_assignee_handles_exact_id_unique_name_ambiguous_and_missing() -> None:
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
    coordinator = _mock_coordinator(async_request=async_request)

    assert await coordinator.async_resolve_assignee("custom_agent_1") == "custom_agent_1"
    assert await coordinator.async_resolve_assignee("ha_person_alice") == "ha_person_alice"
    assert async_request.await_count == 0

    assert await coordinator.async_resolve_assignee("  claude ") == "custom_agent_1"

    with pytest.raises(UpdateFailed, match="Multiple assignees match"):
        await coordinator.async_resolve_assignee("Alex")

    with pytest.raises(UpdateFailed, match="No assignee found"):
        await coordinator.async_resolve_assignee("Nobody")
