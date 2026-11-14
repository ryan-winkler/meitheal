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
from custom_components.meitheal.coordinator import MeithealCoordinator, MeithealCoordinatorData, MeithealTask
from custom_components.meitheal.mcp_server import (
    MCP_TOOLS,
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

    missing_version = await handle_mcp_request(coordinator, {"id": 1, "method": "ping"})
    assert missing_version is not None
    assert missing_version["error"]["code"] == -32600

    bool_id = await handle_mcp_request(
        coordinator, {"jsonrpc": "2.0", "id": True, "method": "ping"}
    )
    assert bool_id is not None
    assert bool_id["error"]["code"] == -32600
    assert bool_id["id"] is None

    nan_id = await handle_mcp_request(
        coordinator, {"jsonrpc": "2.0", "id": float("nan"), "method": "ping"}
    )
    assert nan_id is not None
    assert nan_id["error"]["code"] == -32600
    assert nan_id["id"] is None

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
            "params": {"name": "searchTasks", "arguments": ["bad"]},
        },
    )
    assert bad_args is not None
    assert bad_args["error"]["code"] == -32602

    init_default = await handle_mcp_request(
        coordinator,
        {"jsonrpc": "2.0", "id": 3, "method": "initialize", "params": {}},
    )
    assert init_default is not None
    assert init_default["result"]["protocolVersion"] == "2025-03-26"

    for negotiated_version in ("2025-11-25", "2024-11-05"):
        init_negotiated = await handle_mcp_request(
            coordinator,
            {
                "jsonrpc": "2.0",
                "id": 4,
                "method": "initialize",
                "params": {"protocolVersion": negotiated_version},
            },
        )
        assert init_negotiated is not None
        assert init_negotiated["result"]["protocolVersion"] == negotiated_version


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
        def __init__(self, data: dict, payload: object = None) -> None:
            super().__init__(data)
            self._payload = payload or {"jsonrpc": "2.0", "id": 1, "method": "ping"}

        async def json(self):
            return self._payload

    req = _Req({KEY_HASS_USER: SimpleNamespace(is_admin=False)})
    req.app = {KEY_HASS: hass}  # type: ignore[attr-defined]

    with pytest.raises(Unauthorized):
        await view.post(req)  # type: ignore[arg-type]

    admin_req = _Req(
        {KEY_HASS_USER: SimpleNamespace(is_admin=True)},
        {"jsonrpc": "2.0", "id": True, "method": "ping"},
    )
    admin_req.app = {KEY_HASS: hass}  # type: ignore[attr-defined]
    res = await view.post(admin_req)  # type: ignore[arg-type]
    assert res.status == 503
    assert b'"id": null' in (res.body or b"")


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


async def test_mcp_status_interop_and_completed_search(hass: HomeAssistant) -> None:
    """MCP schemas accept canonical and HA status aliases, and completed search sets include_completed."""
    tools = {tool["name"]: tool for tool in MCP_TOOLS}
    expected_statuses = [
        "backlog",
        "pending",
        "active",
        "complete",
        "todo",
        "in_progress",
        "done",
    ]
    assert tools["searchTasks"]["inputSchema"]["properties"]["status"]["enum"] == expected_statuses
    assert tools["updateTask"]["inputSchema"]["properties"]["status"]["enum"] == expected_statuses

    async_request = AsyncMock(
        return_value={
            "sections": [
                {
                    "id": "tasks",
                    "items": [
                        {
                            "taskId": "task-1",
                            "title": "Bleed radiators",
                            "meta": {"status": "complete", "priority": 2},
                        }
                    ],
                }
            ]
        }
    )
    coordinator = _mock_coordinator(hass, async_request=async_request)

    for done_status in ("done", "complete"):
        response = await handle_mcp_request(
            coordinator,
            {
                "jsonrpc": "2.0",
                "id": 10,
                "method": "tools/call",
                "params": {"name": "searchTasks", "arguments": {"status": done_status}},
            },
        )
        assert response is not None
        assert response["result"]["isError"] is False
        _, call_kwargs = async_request.call_args
        assert call_kwargs["params"]["status"] == done_status
        assert call_kwargs["params"]["include_completed"] == "1"

    explicit_false = await handle_mcp_request(
        coordinator,
        {
            "jsonrpc": "2.0",
            "id": 11,
            "method": "tools/call",
            "params": {
                "name": "searchTasks",
                "arguments": {"status": "done", "include_completed": False},
            },
        },
    )
    assert explicit_false is not None
    assert explicit_false["result"]["isError"] is False
    _, explicit_kwargs = async_request.call_args
    assert "include_completed" not in explicit_kwargs["params"]


    q_alias = await handle_mcp_request(
        coordinator,
        {
            "jsonrpc": "2.0",
            "id": 12,
            "method": "tools/call",
            "params": {"name": "searchTasks", "arguments": {"q": "radiators"}},
        },
    )
    assert q_alias is not None
    assert q_alias["result"]["isError"] is False
    _, q_kwargs = async_request.call_args
    assert q_kwargs["params"]["q"] == "radiators"


async def test_mcp_tool_argument_validation(hass: HomeAssistant) -> None:
    """Missing required IDs, invalid enums, and out-of-range lookaheads return tool errors cleanly."""
    coordinator = _mock_coordinator(hass)
    coordinator.data = MeithealCoordinatorData(
        [MeithealTask({"id": "t-1", "title": "Check boiler", "status": "pending", "priority": 2})]
    )

    invalid_calls = [
        ("getTask", {}, "getTask requires a non-empty string id"),
        ("linkTask", {"source_task_id": "t-1", "target_task_id": "t-2", "link_type": "invalid"}, "link_type must be one of"),
        ("unlinkTask", {"task_id": "t-1"}, "unlinkTask requires a non-empty string link_id"),
        ("getTaskLinks", {}, "getTaskLinks requires a non-empty string task_id"),
        ("getCalendarEvents", {"days_ahead": True}, "getCalendarEvents days_ahead must be an integer between 1 and 30"),
        ("getUpcoming", {"days_ahead": 99}, "getUpcoming days_ahead must be an integer between 1 and 30"),
        ("searchTasks", {"status": "cancelled"}, "searchTasks status must be one of"),
        ("searchTasks", {"priority": True}, "searchTasks priority must be an integer between 1 and 5"),
        ("searchTasks", {"query": "boiler", "q": 123}, "searchTasks q must be a string"),
        ("searchTasks", {"unknown": "x"}, "searchTasks received unsupported fields"),
        ("createTask", {"title": "Test", "priority": 0}, "createTask priority must be an integer between 1 and 5"),
        ("createTask", {"title": "Test", "assigned_to": 42}, "createTask assigned_to must be a non-empty string"),
        ("createTask", {"title": "Test", "due_date": 20261201}, "createTask due_date must be a non-empty string"),
        ("completeTask", {}, "completeTask requires id or title"),
        ("completeTask", {"id": 123}, "completeTask id must be a non-empty string"),
        ("completeTask", {"id": "t-1", "task_id": "t-1"}, "completeTask received unsupported fields"),
        ("updateTask", {"id": "t-1", "status": "cancelled"}, "updateTask status must be one of"),
        ("updateTask", {"id": "t-1"}, "updateTask requires at least one updatable field"),
        ("updateTask", {"id": "t-1", "due_date": 20261201}, "updateTask due_date must be a non-empty string"),
        ("updateTask", {"id": "t-1", "due_date": None}, "updateTask due_date cannot be null"),
        ("updateTask", {"id": "t-1", "description": 123}, "updateTask description must be a string"),
        ("updateTask", {"id": "t-1", "title": "Ok", "updated_at": 1}, "updateTask received unsupported fields"),
        ("batchComplete", {"max_priority": True}, "batchComplete max_priority must be an integer between 1 and 5"),
        ("batchComplete", {"max_priority": 0}, "batchComplete max_priority must be an integer between 1 and 5"),
        ("batchComplete", {"label": "chore", "priority": 1}, "batchComplete received unsupported fields"),
    ]
    batch_tool = next(t for t in MCP_TOOLS if t["name"] == "batchComplete")
    assert batch_tool["inputSchema"]["properties"]["max_priority"]["minimum"] == 1
    assert batch_tool["inputSchema"]["properties"]["max_priority"]["maximum"] == 5
    for name, arguments, expected_error in invalid_calls:
        res = await handle_mcp_request(
            coordinator,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            },
        )
        assert res is not None, name
        assert res["result"]["isError"] is True, name
        assert expected_error in res["result"]["content"][0]["text"], name

    coordinator.data = None
    no_data = await handle_mcp_request(
        coordinator,
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": "batchComplete", "arguments": {"action": "list_completed"}},
        },
    )
    assert no_data is not None
    assert no_data["result"]["isError"] is True


async def test_mcp_strips_required_and_optional_strings(hass: HomeAssistant) -> None:
    """Required IDs and updateTask title/due_date strip outer whitespace before calling the coordinator."""
    coordinator = _mock_coordinator(hass)
    coordinator.async_update_task = AsyncMock(return_value={"ok": True})  # type: ignore[method-assign]

    res = await handle_mcp_request(
        coordinator,
        {
            "jsonrpc": "2.0",
            "id": 20,
            "method": "tools/call",
            "params": {
                "name": "updateTask",
                "arguments": {
                    "id": "  task-42  ",
                    "title": "  Clean gutters  ",
                    "due_date": "  2026-12-01  ",
                    "description": "",
                },
            },
        },
    )
    assert res is not None
    assert res["result"]["isError"] is False
    coordinator.async_update_task.assert_awaited_once_with(
        "task-42",
        {
            "title": "Clean gutters",
            "due_date": "2026-12-01",
            "description": "",
        },
        origin_kind="mcp",
        origin_name="Home Assistant MCP",
        origin_target=None,
    )


async def test_mcp_mutations_thread_and_sanitize_origin_headers(hass: HomeAssistant) -> None:
    """MCP mutations pass the client name, keep the kind as mcp, strip unsafe targets and ignore origin arguments."""
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
                "arguments": {"id": "t1", "title": "Renamed"},
                "_meta": {
                    "origin_kind": "ha_automation",
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

    # Provenance is never read from tool arguments.
    spoofed = await handle_mcp_request(
        coordinator,
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "updateTask",
                "arguments": {"id": "t1", "title": "Again", "origin_kind": "ha_automation"},
            },
        },
    )
    assert spoofed is not None
    assert spoofed["result"]["isError"] is True
    assert "unsupported fields: origin_kind" in spoofed["result"]["content"][0]["text"]
    assert len(async_request.await_args_list) == 2


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
