"""Recover native task contracts on actual Core coordinator/entity classes.

The credential suite exercises the managed authenticated HTTP client; these
cases isolate adapter contracts without a device or a replacement HA runtime.
"""

from datetime import date, datetime
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
import voluptuous as vol
import yaml
from hassil import Intents, recognize
from homeassistant.components.todo import TodoItem
from homeassistant.exceptions import ConfigEntryAuthFailed, HomeAssistantError
from homeassistant.helpers.update_coordinator import UpdateFailed

from custom_components.meitheal import CREATE_TASK_SCHEMA, SEARCH_TASKS_SCHEMA, COMPLETE_TASK_BY_TAG_SCHEMA
from custom_components.meitheal.api import MeithealConnectionError, MeithealResponseError
from custom_components.meitheal.coordinator import MeithealCoordinator, MeithealCoordinatorData, MeithealTask
from custom_components.meitheal.device_trigger import async_attach_trigger
from custom_components.meitheal.sensor import MeithealCompletedTodaySensor, MeithealStreakSensor
from custom_components.meitheal.todo import MeithealTodoListEntity

COMPONENT = Path(__file__).resolve().parents[1] / "custom_components/meitheal"
STATS = {"stats": {"currentStreak": 4, "totalPoints": 60, "todayCompleted": 2}}


def task(id, **fields):
    return {"id": id, "title": id, "status": "pending", **fields}


@pytest.fixture
def coordinator(hass):
    return MeithealCoordinator(hass, SimpleNamespace(async_request=AsyncMock(), origin="https://tasks.example.test"))


async def test_all_pages_and_native_metadata(coordinator):
    rows = [task(f"task-{i}", status="complete" if i % 2 else "active", labels='["Home",27,"garden"]',
        calendar_sync_state="synced", kanban_position=i, urgency=0, importance=5,
        eisenhower_quadrant="q2", created_at=1_800_000_000_000) for i in range(250)]
    coordinator.api.async_request.side_effect = [
        *[{"tasks": rows[n:n + 100], "total": 250, "offset": n, "limit": 100} for n in [0, 100, 200]], STATS]
    result = await coordinator._async_update_data()
    assert (result.total_count, result.active_count) == (250, 125)
    assert (result.streak, result.total_points, result.completed_today) == (4, 60, 2)
    first = result.tasks[0]
    assert (first.labels, first.status, first.position) == (["Home", "garden"], "in_progress", 0)
    assert (first.calendar_sync_state, first.urgency, first.importance, first.eisenhower_quadrant) == ("synced", 0, 5, "q2")
    assert first.created_at == "2027-01-15T08:00:00+00:00"
    calls = coordinator.api.async_request.call_args_list[:3]
    assert [call.kwargs["params"]["offset"] for call in calls] == ["0", "100", "200"]
    assert all(call.kwargs["params"]["sort"] == "kanban_position" for call in calls)


@pytest.mark.parametrize("payload", [[task("legacy")], {"tasks": [task("legacy")]}])
async def test_legacy_complete_list_contract(coordinator, payload):
    coordinator.api.async_request.side_effect = [payload, STATS]
    assert (await coordinator._async_update_data()).total_count == 1


@pytest.mark.parametrize("pages", [
    [None], [{"total": 1}], [{"tasks": None}], [{"tasks": [None]}], [{"tasks": [{}]}],
    [{"tasks": [task("a", title=27)]}], [{"tasks": [task("a", status=[])]}], [{"tasks": [task("a"), task("a")]}],
    [{"tasks": [], "total": True}], [{"tasks": [], "total": "0"}], [{"tasks": [], "total": -1}],
    [{"tasks": [], "total": 1}], [{"tasks": [task("a")], "total": 0}],
    [{"tasks": [task("a"), task("b")], "total": 2, "limit": 1}],
    [{"tasks": [], "total": 0, "offset": 1}], [{"tasks": [], "total": 0, "limit": False}], [{"tasks": [], "offset": 0}],
    [{"tasks": [task("a")], "total": 2}, {"tasks": [task("a")], "total": 2}],
    [{"tasks": [task("a")], "total": 2}, {"tasks": [task("b")], "total": 3}],
])
async def test_invalid_or_repeated_pages_never_publish_partial_counts(coordinator, pages):
    previous = MeithealCoordinatorData([MeithealTask(task("previous"))])
    coordinator._previous_data = previous
    coordinator.api.async_request.side_effect = pages
    with pytest.raises(UpdateFailed):
        await coordinator._async_update_data()
    assert coordinator._previous_data is previous


@pytest.mark.parametrize("status", [401, 403])
async def test_later_page_auth_failure_requires_reauth(coordinator, status):
    coordinator.api.async_request.side_effect = [{"tasks": [task("a")], "total": 2}, MeithealResponseError(status)]
    with pytest.raises(ConfigEntryAuthFailed):
        await coordinator._async_update_data()
    assert coordinator._previous_data is None


@pytest.mark.parametrize("stats", [MeithealResponseError(403), MeithealConnectionError("Unavailable"), {},
    {"stats": {"currentStreak": True, "totalPoints": 1, "todayCompleted": 2}}])
async def test_optional_stats_unknown_without_hiding_tasks(coordinator, stats):
    coordinator.api.async_request.side_effect = [{"tasks": [task("open")]}, stats]
    coordinator.data = await coordinator._async_update_data()
    coordinator.last_update_success = True
    streak = MeithealStreakSensor(coordinator, SimpleNamespace(entry_id="test"))
    today = MeithealCompletedTodaySensor(coordinator, SimpleNamespace(entry_id="test"))
    assert coordinator.data.total_count == 1
    assert streak.native_value is None and today.native_value is None
    assert not streak.available and not today.available
    assert streak.extra_state_attributes["gamification_error"] == "Statistics unavailable"


async def test_native_creation_fields_and_flat_receipt(coordinator):
    coordinator.async_request_refresh = AsyncMock()
    coordinator.api.async_request.return_value = {"id": "created"}
    with patch.object(coordinator, "_fire_event") as event:
        await coordinator.async_create_task("Plan", "Notes", priority=2, due_date="2026-12-02", urgency=0, importance=5)
        coordinator.api.async_request.assert_awaited_once_with("POST", "/api/tasks", payload={"title": "Plan",
            "description": "Notes", "priority": 2, "due_date": "2026-12-02", "urgency": 0, "importance": 5}, read_json=True, event_authority=set())
        event.assert_called_once_with("meitheal_task_created", {"task_id": "created", "title": "Plan"})
    coordinator.async_request_refresh.assert_awaited_once()


@pytest.mark.parametrize("result", [None, {}, {"task": {"id": "nested"}}, {"id": ""}, {"id": "one", "error": "Rejected"}])
async def test_bad_create_receipt_emits_no_success(coordinator, result):
    coordinator.api.async_request.return_value = result
    coordinator.async_request_refresh = AsyncMock()
    with patch.object(coordinator, "_fire_event") as event, pytest.raises(UpdateFailed):
        await coordinator.async_create_task("No false success")
    event.assert_not_called()
    coordinator.async_request_refresh.assert_not_awaited()


async def test_failed_create_emits_no_success(coordinator):
    coordinator.api.async_request.side_effect = MeithealResponseError(403)
    with patch.object(coordinator, "_fire_event") as event, pytest.raises(MeithealResponseError):
        await coordinator.async_create_task("Rejected")
    event.assert_not_called()


async def test_empty_delete_acknowledgement_refreshes_and_emits(coordinator):
    coordinator.data = MeithealCoordinatorData([MeithealTask(task("delete", title="Delete me"))])
    coordinator.api.async_request.return_value = None
    coordinator.async_request_refresh = AsyncMock()
    with patch.object(coordinator, "_fire_event") as event:
        await coordinator.async_delete_task("delete")
        event.assert_called_once_with("meitheal_task_deleted", {"task_id": "delete", "title": "Delete me"})
    coordinator.api.async_request.assert_awaited_once_with("DELETE", "/api/tasks/delete", event_authority=set())
    coordinator.async_request_refresh.assert_awaited_once()


async def test_unique_exact_titles_and_completed_loop_skip(coordinator):
    coordinator.data = MeithealCoordinatorData([MeithealTask(task("a", title="Milk")),
        MeithealTask(task("b", title="Milk")), MeithealTask(task("c", title="Other", status="complete"))])
    with pytest.raises(UpdateFailed, match="Multiple"):
        await coordinator.async_complete_task(title="milk")
    with pytest.raises(UpdateFailed, match="Task not found"):
        coordinator.resolve_task_title("Mil")
    assert coordinator.resolve_task_title(" OTHER ") == "c"
    coordinator.api.async_request.return_value = {"id": "c", "status": "complete"}
    with patch.object(coordinator, "_fire_event") as event:
        await coordinator.async_complete_task(task_id="c")
    coordinator.api.async_request.assert_awaited_once_with("GET", "/api/tasks/c", read_json=True)
    event.assert_not_called()


@pytest.mark.parametrize("raw,expected", [("2026-12-01", date(2026, 12, 1)),
    ("2026-12-01T09:30:00+00:00", datetime.fromisoformat("2026-12-01T09:30:00+00:00")), ("invalid", None)])
async def test_todo_dates_parse_and_serialize(coordinator, raw, expected):
    assert MeithealTodoListEntity._task_to_item(MeithealTask(task("due", due_date=raw))).due == expected
    todo = MeithealTodoListEntity(coordinator, SimpleNamespace(entry_id="test"))
    coordinator.async_create_task = AsyncMock()
    await todo.async_create_todo_item(TodoItem(summary="Milk", description="Notes", due=expected))
    coordinator.async_create_task.assert_awaited_once_with(title="Milk", description="Notes", due_date=expected.isoformat() if expected else None)


async def test_todo_persists_full_order_both_directions(coordinator):
    todo = MeithealTodoListEntity(coordinator, SimpleNamespace(entry_id="test"))
    coordinator.data = MeithealCoordinatorData([MeithealTask(task(id)) for id in ["a", "b", "c"]])
    async def reordered():
        ids = coordinator.api.async_request.call_args.kwargs["payload"]["ordered_ids"]
        coordinator.data = MeithealCoordinatorData([MeithealTask(task(id)) for id in ids])
    coordinator.async_request_refresh = AsyncMock(side_effect=reordered)
    coordinator.api.async_request.return_value = {"ok": True}
    await todo.async_move_todo_item("a", "b")
    await todo.async_move_todo_item("c")
    assert [call.kwargs["payload"] for call in coordinator.api.async_request.call_args_list] == [
        {"ordered_ids": ["b", "a", "c"]}, {"ordered_ids": ["c", "b", "a"]}]
    assert all(call.args == ("POST", "/api/tasks/reorder") for call in coordinator.api.async_request.call_args_list)


@pytest.mark.parametrize("uids", [("missing", None), ("a", "missing"), ("a", "a")])
async def test_unknown_todo_move_never_writes(coordinator, uids):
    coordinator.data = MeithealCoordinatorData([MeithealTask(task("a"))])
    with pytest.raises(HomeAssistantError):
        await MeithealTodoListEntity(coordinator, SimpleNamespace(entry_id="test")).async_move_todo_item(*uids)
    coordinator.api.async_request.assert_not_awaited()


async def test_device_trigger_normalized_event_list(hass):
    with patch("homeassistant.components.homeassistant.triggers.event.async_attach_trigger", new_callable=AsyncMock) as attach:
        await async_attach_trigger(hass, {"type": "task_overdue"}, AsyncMock(), {})
    assert attach.call_args.args[1] == {"platform": "event", "event_type": ["meitheal_task_overdue"], "event_data": {"domain": "meitheal"}}


@pytest.mark.parametrize("language,phrase,title", [("en", "add buy milk to my tasks", "buy milk"), ("ga", "cuir bainne le mo thascanna", "bainne")])
def test_real_hassil_yaml_sentences(language, phrase, title):
    payload = yaml.safe_load((COMPONENT / "custom_sentences" / language / "meitheal.yaml").read_text())
    assert payload["language"] == language and payload["lists"]["item"] == {"wildcard": True}
    result = recognize(phrase, Intents.from_dict(payload))
    assert result is not None and result.intent.name == "MeithealAddTask" and result.entities["item"].value == title
    assert not list((COMPONENT / "custom_sentences").glob("*/*.json"))


def test_runtime_schemas_metadata_and_auth_translations_agree():
    create = {"title": "Plan", "description": "Notes", "priority": 2, "due_date": "2026-12-01", "urgency": 0, "importance": 5}
    fields = {"query": "milk", "priority": 2, "include_completed": True, "status": "done"}
    assert CREATE_TASK_SCHEMA(create) == create and SEARCH_TASKS_SCHEMA(fields) == fields
    with pytest.raises(vol.Invalid):
        CREATE_TASK_SCHEMA({"title": "Bad priority", "priority": 6})
    services = yaml.safe_load((COMPONENT / "services.yaml").read_text())
    assert set(services["create_task"]["fields"]) == set(create)
    assert set(services["search_tasks"]["fields"]) == set(fields)
    strings = json.loads((COMPONENT / "strings.json").read_text())
    assert strings == json.loads((COMPONENT / "translations/en.json").read_text())
    assert "api_token" in strings["config"]["step"]["reauth_confirm"]["data"]


async def test_real_intent_dispatch_never_deletes_an_ambiguous_title(coordinator, hass, hass_owner_user):
    from homeassistant.core import Context
    from homeassistant.helpers import intent
    from custom_components.meitheal import intents

    coordinator.data = MeithealCoordinatorData([MeithealTask(task("a", title="Milk")), MeithealTask(task("b", title="Milk"))])
    intents.async_register_intents(hass)
    with patch.object(intents, "_get_coordinator", return_value=coordinator):
        result = await intent.async_handle(hass, "conversation", intents.INTENT_DELETE_TASK,
            {"item": {"value": "milk"}}, context=Context(user_id=hass_owner_user.id))
    assert "Multiple" in result.speech["plain"]["speech"]
    assert "Deleted" not in result.speech["plain"]["speech"]
    coordinator.api.async_request.assert_not_awaited()


@pytest.mark.parametrize("labels", ["{", "{}", '["Home", {}, 27]', None])
def test_labels_do_not_leak_serialized_or_object_members(labels):
    expected = ["Home"] if labels == '["Home", {}, 27]' else []
    assert MeithealTask(task("labels", labels=labels)).labels == expected


async def test_move_without_data_and_unacknowledged_order_fail(coordinator):
    todo = MeithealTodoListEntity(coordinator, SimpleNamespace(entry_id="test"))
    with pytest.raises(HomeAssistantError):
        await todo.async_move_todo_item("missing")
    coordinator.api.async_request.assert_not_awaited()
    coordinator.api.async_request.return_value = {"ok": False}
    coordinator.async_request_refresh = AsyncMock()
    with pytest.raises(UpdateFailed):
        await coordinator.async_reorder_tasks(["a"])
    coordinator.async_request_refresh.assert_not_awaited()


async def test_reopened_cached_completion_is_not_skipped(coordinator):
    coordinator.data = MeithealCoordinatorData([MeithealTask(task("a", status="complete"))])
    coordinator.api.async_request.side_effect = [{"id": "a", "status": "pending"}, {"id": "a", "status": "complete"}]
    coordinator.async_request_refresh = AsyncMock()
    await coordinator.async_complete_task(task_id="a")
    assert [call.args[0] for call in coordinator.api.async_request.call_args_list] == ["GET", "PUT"]


@pytest.mark.parametrize("result", [None, {}, {"id": "other"}, {"id": "a"}, {"id": "a", "status": "pending"}, {"id": "a", "error": "Rejected"}])
async def test_completion_rejects_bad_receipt_without_success_event(coordinator, result):
    coordinator.api.async_request.return_value = result
    with patch.object(coordinator, "_fire_event") as event, pytest.raises(UpdateFailed):
        await coordinator.async_complete_task(task_id="a")
    event.assert_not_called()


@pytest.mark.parametrize("repeated", [False, True])
async def test_nfc_uses_authenticated_route_without_repeat_completion_event(coordinator, repeated):
    result = {"ok": True, "task_id": "tag-task", **({"already_complete": True} if repeated else {
        "task": {"id": "tag-task", "status": "complete"}})}
    coordinator.api.async_request.return_value = result
    coordinator.async_request_refresh = AsyncMock()
    with patch.object(coordinator, "_fire_event") as event:
        assert await coordinator.async_complete_task_by_tag("tag") == result
    coordinator.api.async_request.assert_awaited_once_with("POST", "/api/nfc/complete", payload={"tag_id": "tag"}, read_json=True, event_authority=set())
    assert event.call_count == (0 if repeated else 1)
    coordinator.async_request_refresh.assert_awaited_once()


@pytest.mark.parametrize("status", [401, 403, 404, 409])
async def test_nfc_denial_unknown_and_duplicate_tags_emit_no_success(coordinator, status):
    coordinator.api.async_request.side_effect = MeithealResponseError(status)
    with patch.object(coordinator, "_fire_event") as event, pytest.raises(MeithealResponseError):
        await coordinator.async_complete_task_by_tag("tag")
    event.assert_not_called()


@pytest.mark.parametrize("result", [None, {}, {"ok": True, "task_id": "a"},
    {"ok": True, "task_id": "a", "already_complete": "true"},
    {"ok": True, "task_id": "a", "task": {"id": "a", "status": "pending"}}])
async def test_malformed_nfc_success_emits_no_success(coordinator, result):
    coordinator.api.async_request.return_value = result
    with patch.object(coordinator, "_fire_event") as event, pytest.raises(UpdateFailed):
        await coordinator.async_complete_task_by_tag("tag")
    event.assert_not_called()


def test_nfc_metadata_matches_existing_runtime_service_schema():
    services = yaml.safe_load((COMPONENT / "services.yaml").read_text())
    assert set(services["complete_task_by_tag"]["fields"]) == {"tag_id"}
    assert COMPLETE_TASK_BY_TAG_SCHEMA({"tag_id": "tag"}) == {"tag_id": "tag"}
    strings = json.loads((COMPONENT / "strings.json").read_text())
    assert strings["services"]["complete_task_by_tag"]["fields"]["tag_id"]["name"]


async def test_todo_inventory_excludes_deferred_without_changing_sensors(coordinator):
    rows = [task("first"), task("deferred", deferred_at=1_800_000_000_000, deferral_revision="held-revision"), task("last")]
    coordinator.data = MeithealCoordinatorData([MeithealTask(row) for row in rows])
    todo = MeithealTodoListEntity(coordinator, SimpleNamespace(entry_id="test"))
    assert [item.uid for item in todo.todo_items] == ["first", "last"]
    assert coordinator.data.total_count == coordinator.data.active_count == 3
    assert [item.id for item in coordinator.data.tasks] == ["first", "deferred", "last"]
    assert coordinator.data.tasks[1].deferred_at == 1_800_000_000_000
    assert coordinator.data.tasks[1].deferral_revision == "held-revision"


async def test_todo_move_filters_deferred_ids(coordinator):
    coordinator.data = MeithealCoordinatorData([MeithealTask(task("first")),
        MeithealTask(task("deferred", deferred_at=1_800_000_000_000)), MeithealTask(task("last"))])
    coordinator.api.async_request.return_value = {"ok": True}
    coordinator.async_request_refresh = AsyncMock()
    await MeithealTodoListEntity(coordinator, SimpleNamespace(entry_id="test")).async_move_todo_item("last")
    coordinator.api.async_request.assert_awaited_once_with("POST", "/api/tasks/reorder",
        payload={"ordered_ids": ["last", "first"]}, read_json=True)


@pytest.mark.parametrize("moved,previous", [("deferred", None), ("ordinary", "deferred")])
async def test_todo_deferred_move_or_anchor_never_writes(coordinator, moved, previous):
    coordinator.data = MeithealCoordinatorData([MeithealTask(task("ordinary")), MeithealTask(task("deferred", deferred_at=1))])
    coordinator.api.async_request.return_value = {"ok": True}
    coordinator.async_request_refresh = AsyncMock()
    with pytest.raises(HomeAssistantError):
        await MeithealTodoListEntity(coordinator, SimpleNamespace(entry_id="test")).async_move_todo_item(moved, previous)
    coordinator.api.async_request.assert_not_awaited()


@pytest.mark.parametrize("deferred_at", [0, "", False, "not-a-timestamp"])
async def test_todo_deferral_filter_uses_native_nullness(coordinator, deferred_at):
    coordinator.data = MeithealCoordinatorData([MeithealTask(task("ordinary")), MeithealTask(task("held", deferred_at=deferred_at))])
    todo = MeithealTodoListEntity(coordinator, SimpleNamespace(entry_id="test"))
    assert [item.uid for item in todo.todo_items] == ["ordinary"]
    assert coordinator.data.total_count == 2


async def test_todo_reorder_does_not_add_a_2000_task_cap(coordinator):
    rows = [task(f"task-{i}") for i in range(2001)]
    rows.insert(100, task("deferred", deferred_at=1))
    coordinator.data = MeithealCoordinatorData([MeithealTask(row) for row in rows])
    coordinator.api.async_request.return_value = {"ok": True}
    coordinator.async_request_refresh = AsyncMock()
    await MeithealTodoListEntity(coordinator, SimpleNamespace(entry_id="test")).async_move_todo_item("task-2000")
    ids = coordinator.api.async_request.call_args.kwargs["payload"]["ordered_ids"]
    assert len(ids) == 2001 and "deferred" not in ids and ids[0] == "task-2000"
    assert coordinator.data.total_count == 2002


async def test_actual_core_device_trigger_consumes_namespaced_app_overdue_event(hass):
    """Use Core's real event trigger attachment, not a configuration-only mock."""
    contract = json.loads((Path(__file__).parent / "fixtures/app-task-overdue.json").read_text())
    delivered = []

    async def action(variables, context):
        delivered.append(variables["trigger"])

    detach = await async_attach_trigger(hass, {"type": "task_overdue"}, action, {
        "trigger_data": {"id": "app-overdue-contract"}, "variables": {},
    })
    try:
        # A similarly named event without the namespace metadata is not this
        # device contract. Keep the consumer filter instead of weakening it.
        missing_domain = {key: value for key, value in contract["event_data"].items() if key != "domain"}
        hass.bus.async_fire(contract["event_type"], missing_domain)
        await hass.async_block_till_done()
        assert delivered == []
        hass.bus.async_fire(contract["event_type"], contract["event_data"])
        await hass.async_block_till_done()
        assert len(delivered) == 1
        assert delivered[0]["platform"] == "device"
        assert delivered[0]["id"] == "app-overdue-contract"
        assert delivered[0]["event"].event_type == contract["event_type"]
        assert dict(delivered[0]["event"].data) == contract["event_data"]
    finally:
        detach()
    hass.bus.async_fire(contract["event_type"], contract["event_data"])
    await hass.async_block_till_done()
    assert len(delivered) == 1
