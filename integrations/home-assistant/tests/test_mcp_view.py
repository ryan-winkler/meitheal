"""Verify Meitheal's MCP view on Home Assistant's HTTP server."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from custom_components.meitheal import _install_custom_sentences
from custom_components.meitheal.coordinator import MeithealCoordinator
from custom_components.meitheal.mcp_server import (
    MCP_TOOLS,
    async_handle_mcp_http,
    async_register_mcp_view,
)

ADMIN = SimpleNamespace(is_active=True, is_admin=True)
LIST = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}


def fake_hass(*coordinators):
    hass = MagicMock()
    hass.data = {}
    hass.config_entries.async_loaded_entries.return_value = [
        SimpleNamespace(runtime_data=coordinator) for coordinator in coordinators
    ]
    return hass


def coordinator():
    value = MagicMock(spec=MeithealCoordinator)
    value.data = None
    value.async_create_task = AsyncMock()
    return value


async def test_only_active_administrators_reach_the_tools():
    hass = fake_hass(coordinator())
    for user in (None, SimpleNamespace(is_active=True, is_admin=False),
                 SimpleNamespace(is_active=False, is_admin=True)):
        status, body = await async_handle_mcp_http(hass, user, LIST)
        assert status == 403 and "error" in body and "result" not in body
    status, body = await async_handle_mcp_http(hass, ADMIN, LIST)
    assert status == 200 and body["result"]["tools"] == MCP_TOOLS


async def test_each_call_uses_the_entry_that_is_loaded_now():
    first, second = coordinator(), coordinator()
    hass = fake_hass(first)
    call = {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": "createTask", "arguments": {"title": "Plan"}}}
    assert (await async_handle_mcp_http(hass, ADMIN, call))[0] == 200
    first.async_create_task.assert_awaited_once()

    # After a reload the old coordinator must not be used again.
    hass.config_entries.async_loaded_entries.return_value = [SimpleNamespace(runtime_data=second)]
    await async_handle_mcp_http(hass, ADMIN, call)
    first.async_create_task.assert_awaited_once()
    second.async_create_task.assert_awaited_once()

    hass.config_entries.async_loaded_entries.return_value = []
    status, body = await async_handle_mcp_http(hass, ADMIN, call)
    assert status == 503 and body["error"]["code"] == -32002


async def test_protocol_edges_get_protocol_answers():
    hass = fake_hass(coordinator())
    assert await async_handle_mcp_http(
        hass, ADMIN, {"jsonrpc": "2.0", "method": "notifications/initialized"}
    ) == (202, None)
    assert await async_handle_mcp_http(hass, ADMIN, {"jsonrpc": "2.0", "id": 3, "method": "ping"}) == (
        200, {"jsonrpc": "2.0", "id": 3, "result": {}})
    for invalid in ([], {"id": 1}, {"id": 1, "method": 5}):
        assert (await async_handle_mcp_http(hass, ADMIN, invalid))[0] == 400
    status, body = await async_handle_mcp_http(
        hass, ADMIN, {"id": 4, "method": "tools/call", "params": {"name": "createTask", "arguments": "x"}})
    assert status == 400 and body["error"]["code"] == -32602


def test_the_view_is_registered_once_across_reloads():
    hass = fake_hass()
    async_register_mcp_view(hass)
    async_register_mcp_view(hass)
    hass.http.register_view.assert_called_once()


def test_sentence_files_are_installed_and_refreshed(tmp_path):
    assert _install_custom_sentences(str(tmp_path)) is True
    installed = tmp_path / "en" / "meitheal.yaml"
    assert installed.read_text().strip()
    assert _install_custom_sentences(str(tmp_path)) is False
    installed.write_text("language: en\n")
    assert _install_custom_sentences(str(tmp_path)) is True
    assert installed.read_text() != "language: en\n"
