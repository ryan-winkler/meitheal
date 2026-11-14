"""Tests for the Home Assistant MCP endpoint view, JSON-RPC handler, and assignee resolution."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

from homeassistant.components.http import KEY_HASS, KEY_HASS_USER
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError, Unauthorized
from homeassistant.helpers.update_coordinator import UpdateFailed
import pytest

try:
    from pytest_homeassistant.common import MockConfigEntry
except ModuleNotFoundError as error:
    if error.name != "pytest_homeassistant":
        raise
    from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.meitheal.const import DOMAIN
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
    )


async def test_mcp_create_complete_batch_and_boundary_errors(hass: HomeAssistant) -> None:
    """Exercise createTask, completeTask, batchComplete partial failure, unexpected tool error, and invalid JSON."""
    coordinator = _mock_coordinator(hass)
    coordinator.async_create_task = AsyncMock(return_value={"id": "created-1"})  # type: ignore[method-assign]
    coordinator.async_complete_task = AsyncMock(  # type: ignore[method-assign]
        side_effect=[None, HomeAssistantError("boom"), None]
    )
    coordinator.data = MeithealCoordinatorData(
        [
            MeithealTask({"id": "t-1", "title": "First", "status": "pending", "priority": 1, "labels": ["Home"]}),
            MeithealTask({"id": "t-2", "title": "Second", "status": "pending", "priority": 2, "labels": ["Home"]}),
            MeithealTask({"id": "t-done", "title": "Already", "status": "done", "priority": 1, "labels": ["Home"]}),
        ]
    )

    created = await handle_mcp_request(
        coordinator,
        {
            "jsonrpc": "2.0",
            "id": 30,
            "method": "tools/call",
            "params": {
                "name": "createTask",
                "arguments": {"title": "Wash car", "priority": 2, "assigned_to": "alice"},
            },
        },
    )
    assert created is not None and created["result"]["isError"] is False
    coordinator.async_create_task.assert_awaited_once_with(
        title="Wash car",
        description=None,
        priority=2,
        due_date=None,
        assigned_to="alice",
    )

    batch = await handle_mcp_request(
        coordinator,
        {
            "jsonrpc": "2.0",
            "id": 31,
            "method": "tools/call",
            "params": {"name": "batchComplete", "arguments": {"label": "home", "max_priority": 2}},
        },
    )
    assert batch is not None and batch["result"]["isError"] is False
    import json

    batch_payload = json.loads(batch["result"]["content"][0]["text"])
    assert batch_payload == {
        "completed": ["First"],
        "count": 1,
        "failed": [{"id": "t-2", "title": "Second", "error": "boom"}],
    }

    completed = await handle_mcp_request(
        coordinator,
        {
            "jsonrpc": "2.0",
            "id": 32,
            "method": "tools/call",
            "params": {"name": "completeTask", "arguments": {"id": "t-1"}},
        },
    )
    assert completed is not None and completed["result"]["isError"] is False

    coordinator.async_delete_task = AsyncMock(side_effect=RuntimeError("unexpected failure"))  # type: ignore[method-assign]
    boundary = await handle_mcp_request(
        coordinator,
        {
            "jsonrpc": "2.0",
            "id": 33,
            "method": "tools/call",
            "params": {"name": "deleteTask", "arguments": {"id": "t-1"}},
        },
    )
    assert boundary is not None
    assert boundary["result"]["isError"] is True
    assert "unexpected failure" in boundary["result"]["content"][0]["text"]

    class _BadJsonReq(dict):
        async def json(self):
            raise ValueError("invalid json")

    bad_json_request = _BadJsonReq({KEY_HASS_USER: SimpleNamespace(is_admin=True)})
    bad_json_request.app = {KEY_HASS: hass}  # type: ignore[attr-defined]
    response = await MeithealMcpView().post(bad_json_request)  # type: ignore[arg-type]
    assert response.status == 400
    assert json.loads(response.body or b"{}")["error"]["code"] == -32700



