"""Network-boundary regression tests; HA runtime acceptance still needs Tier 2.

Run with uv run --python 3.13 --with aiohttp --with voluptuous --with pyyaml --with hassil python -m
unittest discover -s tests/python -p 'test_ha_integration.py'. HA lifecycle
classes are deliberately small stubs; production coordinator/adapters and HTTP
serialization run unchanged against a local aiohttp server.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import sys
import unittest
from dataclasses import dataclass
from datetime import date
from enum import IntFlag, StrEnum
from pathlib import Path
from types import ModuleType, SimpleNamespace

import aiohttp
import voluptuous as vol
import yaml
from aiohttp import web
from hassil import Intents, recognize

ROOT = Path(__file__).resolve().parents[2]
COMPONENT = ROOT / "integrations/home-assistant/custom_components/meitheal"


def module(name, **attributes):
    """Expose only the HA imports exercised by these integration adapters."""
    result = ModuleType(name)
    result.__dict__.update(attributes)
    result.__path__ = []
    sys.modules[name] = result
    parent, _, child = name.rpartition(".")
    if parent in sys.modules:
        setattr(sys.modules[parent], child, result)
    return result


class Generic:
    def __class_getitem__(cls, item):
        return cls


class LLMAPI:
    """Keep the real HA API's keyword-only constructor contract."""

    def __init__(self, *, hass, id, name, requires_admin=False):
        self.hass = hass
        self.id = id
        self.name = name
        self.requires_admin = requires_admin


class Coordinator(Generic):
    def __init__(self, hass, logger, **kwargs):
        self.hass = hass
        self.data = None
        self.last_update_success = True

    async def async_request_refresh(self):
        self.data = await self._async_update_data()


class CoordinatorEntity(Generic):
    def __init__(self, coordinator):
        self.coordinator = coordinator

    @property
    def available(self):
        return self.coordinator.last_update_success and self.coordinator.data is not None


class UpdateFailed(Exception):
    pass


class HomeAssistantError(Exception):
    pass


class TodoStatus(StrEnum):
    NEEDS_ACTION = "needs_action"
    COMPLETED = "completed"


class TodoFeature(IntFlag):
    CREATE_TODO_ITEM = 1
    DELETE_TODO_ITEM = 2
    UPDATE_TODO_ITEM = 4
    MOVE_TODO_ITEM = 8
    SET_DUE_DATE_ON_ITEM = 16
    SET_DESCRIPTION_ON_ITEM = 32


@dataclass
class TodoItem:
    uid: str | None = None
    summary: str | None = None
    status: TodoStatus | None = None
    due: date | None = None
    description: str | None = None


module("homeassistant")
module("homeassistant.components")
module("homeassistant.components.todo", TodoItem=TodoItem, TodoItemStatus=TodoStatus,
       TodoListEntity=type("TodoListEntity", (), {}), TodoListEntityFeature=TodoFeature)
module("homeassistant.components.sensor", SensorEntity=type("SensorEntity", (), {}),
       SensorStateClass=SimpleNamespace(MEASUREMENT="measurement", TOTAL_INCREASING="total_increasing"))
module("homeassistant.config_entries", ConfigEntry=Generic)
module("homeassistant.const", Platform=SimpleNamespace(TODO="todo", SENSOR="sensor", BINARY_SENSOR="binary_sensor"),
       CONF_HOST="host", CONF_PORT="port", CONF_DEVICE_ID="device_id", CONF_DOMAIN="domain",
       CONF_PLATFORM="platform", CONF_TYPE="type")
module("homeassistant.core", HomeAssistant=object, ServiceCall=object, ServiceResponse=dict,
       SupportsResponse=SimpleNamespace(ONLY="only"), CALLBACK_TYPE=object)
module("homeassistant.exceptions", HomeAssistantError=HomeAssistantError)
module("homeassistant.helpers")
module("homeassistant.helpers.aiohttp_client", async_get_clientsession=lambda hass: hass.session)
module("homeassistant.helpers.update_coordinator", DataUpdateCoordinator=Coordinator,
       CoordinatorEntity=CoordinatorEntity, UpdateFailed=UpdateFailed)
module("homeassistant.helpers.entity", EntityCategory=SimpleNamespace(DIAGNOSTIC="diagnostic"), DeviceInfo=dict)
module("homeassistant.helpers.entity_platform", AddEntitiesCallback=object)
module("homeassistant.helpers.device_registry", DeviceEntryType=SimpleNamespace(SERVICE="service"))
module("homeassistant.helpers.issue_registry", IssueSeverity=SimpleNamespace(ERROR="error"),
       async_create_issue=lambda *a, **k: None, async_delete_issue=lambda *a, **k: None)
module("homeassistant.helpers.config_validation", string=str, boolean=vol.Boolean())
module("homeassistant.helpers.trigger", TriggerActionType=object, TriggerInfo=dict)
module("homeassistant.helpers.typing", ConfigType=dict)
module("homeassistant.components.device_automation", DEVICE_TRIGGER_BASE_SCHEMA=vol.Schema({}))
module("homeassistant.components.homeassistant")
module("homeassistant.components.homeassistant.triggers")
module("homeassistant.components.homeassistant.triggers.event")
module("homeassistant.helpers.llm", API=LLMAPI, APIInstance=object,
       LLMContext=object, Tool=type("Tool", (), {}), ToolInput=object)
module("homeassistant.util")
module("homeassistant.util.json", JsonObjectType=dict)
module("custom_components")
module("custom_components.meitheal").__path__ = [str(COMPONENT)]

coordinator_module = importlib.import_module("custom_components.meitheal.coordinator")
todo_module = importlib.import_module("custom_components.meitheal.todo")
llm_module = importlib.import_module("custom_components.meitheal.llm_api")
sensor_module = importlib.import_module("custom_components.meitheal.sensor")
device_trigger_module = importlib.import_module("custom_components.meitheal.device_trigger")
setup_spec = importlib.util.spec_from_file_location("custom_components.meitheal.setup", COMPONENT / "__init__.py")
setup_module = importlib.util.module_from_spec(setup_spec)
setup_module.__package__ = "custom_components.meitheal"
setup_spec.loader.exec_module(setup_module)


class IntegrationNetworkTests(unittest.IsolatedAsyncioTestCase):
    async def test_device_trigger_passes_normalized_event_type_list(self):
        from unittest.mock import patch

        captured = []
        async def attach(hass, config, action, trigger_info, *, platform_type):
            captured.append((config, platform_type))
            return lambda: None
        event_module = sys.modules["homeassistant.components.homeassistant.triggers.event"]
        with patch.object(event_module, "async_attach_trigger", attach, create=True):
            await device_trigger_module.async_attach_trigger(
                self.hass, {"type": "task_overdue"}, object(), {}
            )
        self.assertEqual(captured, [({"platform": "event",
                                     "event_type": ["meitheal_task_overdue"],
                                     "event_data": {"domain": "meitheal"}}, "device")])

    async def asyncSetUp(self):
        self.tasks = []
        self.requests = []
        self.events = []
        self.gamification_status = 200
        self.gamification = {"stats": {"currentStreak": 4, "totalPoints": 60, "todayCompleted": 2}}
        self.ignore_offset = False
        self.failure = None
        self.invalid_json = None
        app = web.Application()
        app.router.add_route("*", "/{path:.*}", self.handle_request)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        self.session = aiohttp.ClientSession()
        self.hass = SimpleNamespace(session=self.session,
                                    bus=SimpleNamespace(async_fire=lambda event, data: self.events.append((event, data))))
        self.coordinator = coordinator_module.MeithealCoordinator(self.hass, "127.0.0.1", port)
        self.hass.config_entries = SimpleNamespace(async_entries=lambda domain: [SimpleNamespace(runtime_data=self.coordinator)])
        entry = SimpleNamespace(entry_id="test")
        self.todo = todo_module.MeithealTodoListEntity(self.coordinator, entry)

    async def asyncTearDown(self):
        await self.session.close()
        await self.runner.cleanup()

    async def handle_request(self, request):
        body = await request.json() if request.can_read_body else None
        self.requests.append((request.method, request.path, dict(request.query), body, dict(request.headers)))
        if self.failure and request.path == self.failure:
            return web.Response(status=403, text="Forbidden", content_type="text/plain")
        if self.invalid_json and request.path == self.invalid_json:
            return web.Response(status=200, text="{broken", content_type="application/json")
        if request.path == "/api/tasks" and request.method == "GET":
            offset = 0 if self.ignore_offset else int(request.query["offset"])
            limit = int(request.query["limit"])
            tasks = sorted(self.tasks, key=lambda t: (t.get("kanban_position") is None,
                                                    t.get("kanban_position", 0), t["id"]))
            return web.json_response({"tasks": tasks[offset:offset + limit], "total": len(tasks), "limit": limit, "offset": offset})
        if request.path == "/api/gamification":
            return web.json_response(self.gamification, status=self.gamification_status)
        if request.path == "/api/tasks" and request.method == "POST":
            self.tasks.append({"id": f"new-{len(self.tasks)}", "status": "pending", **body})
            return web.json_response(self.tasks[-1], status=201)
        if request.path == "/api/tasks/reorder":
            for position, task_id in enumerate(body["ordered_ids"]):
                next(t for t in self.tasks if t["id"] == task_id)["kanban_position"] = position
            return web.json_response({"ok": True})
        if request.path.startswith("/api/tasks/"):
            task_id = request.path.rsplit("/", 1)[-1]
            if request.method == "DELETE":
                self.tasks = [t for t in self.tasks if t["id"] != task_id]
                return web.Response(status=204)
            task = next(t for t in self.tasks if t["id"] == task_id)
            task.update(body)
            return web.json_response(task)
        if request.path == "/api/nfc/complete":
            return web.json_response({"ok": True, "task_id": "tag-task", "already_complete": True})
        if request.path == "/api/areas":
            return web.json_response({"areas": [{"id": "home", "name": "Home"}]})
        if request.path == "/api/goals":
            return web.json_response({"goals": [{"id": "goal", "progress": 50}]})
        if request.path == "/api/goals/goal":
            return web.json_response({"id": "goal", **body})
        if request.path == "/api/search":
            return web.json_response({"sections": [{"id": "tasks", "items": []}]})
        return web.json_response({"error": "not found"}, status=404)

    async def test_all_pages_status_labels_and_calendar_metadata(self):
        self.tasks = [{"id": f"task-{i:03}", "title": f"Task {i}", "status": "complete" if i % 2 else "pending",
                       "labels": '["Home", "garden"]', "calendar_sync_state": "synced",
                       "due_date": "2000-01-01", "kanban_position": i,
                       "created_at": 1735689600000} for i in range(205)]
        await self.coordinator.async_request_refresh()
        data = self.coordinator.data
        self.assertEqual(data.total_count, 205)
        self.assertEqual(data.active_count, 103)
        self.assertEqual(data.overdue_count, 103)
        task = data.tasks[1]
        self.assertEqual((task.status, task.labels, task.calendar_sync_state), ("done", ["Home", "garden"], "synced"))
        self.assertTrue(task.created_at.startswith("2025-01-01"))
        self.assertEqual(self.todo.todo_items[1].status, TodoStatus.COMPLETED)
        self.assertEqual(self.todo.todo_items[1].due, date(2000, 1, 1))
        pages = [request for request in self.requests if request[1] == "/api/tasks"]
        self.assertEqual([p[2]["offset"] for p in pages], ["0", "100", "200"])
        self.assertTrue(all(p[2]["sort"] == "kanban_position" for p in pages))

    async def test_repeated_page_does_not_publish_partial_counts(self):
        self.tasks = [{"id": str(i), "title": str(i)} for i in range(101)]
        self.ignore_offset = True
        with self.assertRaisesRegex(UpdateFailed, "pagination changed"):
            await self.coordinator._async_update_data()
        self.assertIsNone(self.coordinator.data)

    async def test_todo_and_llm_create_preserve_first_class_fields(self):
        await self.todo.async_create_todo_item(TodoItem(summary="Milk", description="Whole milk", due=date(2026, 12, 1)))
        tool = llm_module.CreateTaskTool()
        result = await tool.async_call(self.hass, SimpleNamespace(tool_args={"title": "Plan", "description": "Notes",
                                      "priority": 2, "due_date": "2026-12-02", "urgency": 0, "importance": 5}), None)
        self.assertTrue(result["success"])
        created = [r for r in self.requests if r[0] == "POST"]
        self.assertEqual(created[0][1:4:2], ("/api/tasks", {"title": "Milk", "description": "Whole milk", "due_date": "2026-12-01"}))
        self.assertEqual(created[1][3], {"title": "Plan", "description": "Notes", "priority": 2,
                                      "due_date": "2026-12-02", "urgency": 0, "importance": 5})
        self.assertEqual(created[1][4]["X-Automation-Source"], "ha")

    async def test_failed_create_is_not_reported_as_success(self):
        self.failure = "/api/tasks"
        with self.assertRaisesRegex(UpdateFailed, "403"):
            await self.coordinator.async_create_task("Fail")
        self.assertEqual(self.events, [])

    async def test_reorder_persists_full_order_in_both_directions(self):
        self.tasks = [{"id": task_id, "title": task_id, "kanban_position": i} for i, task_id in enumerate(["a", "b", "c"])]
        await self.coordinator.async_request_refresh()
        await self.todo.async_move_todo_item("a", "b")
        self.assertEqual([t.id for t in self.coordinator.data.tasks], ["b", "a", "c"])
        await self.todo.async_move_todo_item("c", None)
        self.assertEqual([t.id for t in self.coordinator.data.tasks], ["c", "b", "a"])
        self.assertFalse(any(r[0] == "PUT" for r in self.requests))

    async def test_remove_by_title_uses_unique_exact_match(self):
        self.tasks = [{"id": "a", "title": "Milk"}, {"id": "b", "title": "Milk"}, {"id": "c", "title": "Other"}]
        await self.coordinator.async_request_refresh()
        tool = llm_module.RemoveFromTodoListTool()
        result = await tool.async_call(self.hass, SimpleNamespace(tool_args={"title": "milk"}), None)
        self.assertIn("Multiple", result["error"])
        self.assertFalse(any(r[0] == "DELETE" for r in self.requests))
        result = await tool.async_call(self.hass, SimpleNamespace(tool_args={"title": "OTHER"}), None)
        self.assertEqual(result.get("error"), None)
        self.assertNotIn("c", [t["id"] for t in self.tasks])
        with self.assertRaisesRegex(UpdateFailed, "Multiple"):
            await self.coordinator.async_complete_task(title="Milk")

    async def test_delete_204_refreshes_coordinator_and_emits_deleted_event(self):
        self.tasks = [{"id": "delete-me", "title": "Delete me"},
                      {"id": "keep", "title": "Keep"}]
        await self.coordinator.async_request_refresh()
        await self.coordinator.async_delete_task("delete-me")
        self.assertEqual([task.id for task in self.coordinator.data.tasks], ["keep"])
        deleted = [data for event, data in self.events if event == "meitheal_task_deleted"]
        self.assertEqual(len(deleted), 1)
        self.assertEqual(deleted[0]["task_id"], "delete-me")
        self.assertEqual(deleted[0]["domain"], "meitheal")

    async def test_malformed_json_success_remains_an_error(self):
        self.invalid_json = "/api/areas"
        with self.assertRaisesRegex(UpdateFailed, "invalid JSON"):
            await self.coordinator.async_list_areas()

    async def test_label_batch_skips_already_completed_tasks(self):
        self.tasks = [{"id": "a", "title": "Open", "status": "pending", "labels": '["home"]'},
                      {"id": "b", "title": "Done", "status": "complete", "labels": '["home"]'},
                      {"id": "c", "title": "Other", "status": "pending", "labels": '["work"]'}]
        await self.coordinator.async_request_refresh()
        result = await llm_module.BatchCompleteTasksTool().async_call(self.hass, SimpleNamespace(tool_args={"label": "home"}), None)
        self.assertEqual(result["completed"], ["Open"])
        self.assertEqual([(r[1], r[3]) for r in self.requests if r[0] == "PUT"], [("/api/tasks/a", {"status": "complete"})])

    async def test_optional_gamification_failure_is_not_zero_or_task_failure(self):
        await self.coordinator.async_request_refresh()
        streak = sensor_module.MeithealStreakSensor(self.coordinator, SimpleNamespace(entry_id="test"))
        today = sensor_module.MeithealCompletedTodaySensor(self.coordinator, SimpleNamespace(entry_id="test"))
        self.assertEqual((streak.native_value, today.native_value), (4, 2))
        self.gamification_status = 404
        await self.coordinator.async_request_refresh()
        self.assertEqual(self.coordinator.data.total_count, 0)
        self.assertIsNone(streak.native_value)
        self.assertFalse(streak.available)
        self.assertFalse(today.available)
        self.assertIsNotNone(self.coordinator.data.gamification_error)

    async def test_hierarchy_methods_use_native_contracts(self):
        self.assertEqual((await self.coordinator.async_list_areas())[0]["id"], "home")
        self.assertEqual((await self.coordinator.async_list_goals("home"))[0]["progress"], 50)
        await self.coordinator.async_set_goal_progress("goal", 75)
        self.assertEqual(self.requests[-2][2], {"area_id": "home"})
        self.assertEqual(self.requests[-1][3], {"progress": 75})

    async def test_search_service_schema_matches_advertised_fields(self):
        fields = {"query": "milk", "priority": 2, "include_completed": True, "status": "done"}
        self.assertEqual(setup_module.SEARCH_TASKS_SCHEMA(fields), fields)
        await self.coordinator.async_search_tasks(**fields)
        self.assertEqual(self.requests[-1][2], {"scope": "tasks", "limit": "20", "q": "milk", "status": "done",
                                               "priority": "2", "include_completed": "1"})

    async def test_nfc_retry_does_not_repeat_completion_event(self):
        await self.coordinator.async_complete_task_by_tag("tag")
        self.assertFalse(any(event == "meitheal_task_completed" for event, _ in self.events))
        self.failure = "/api/nfc/complete"
        with self.assertRaisesRegex(UpdateFailed, "403"):
            await self.coordinator.async_complete_task_by_tag("tag")


class ResourceContractTests(unittest.TestCase):
    def test_english_translation_resource_covers_entity_and_service_names(self):
        strings = json.loads((COMPONENT / "strings.json").read_text())
        translated = json.loads((COMPONENT / "translations/en.json").read_text())
        self.assertEqual(translated, strings)

    def test_llm_api_registers_with_real_constructor_contract(self):
        from unittest.mock import patch

        registered = []
        unregister = lambda: None
        def register(hass, api):
            registered.append(api)
            return unregister
        with patch.object(llm_module.llm, "async_register_api", register, create=True):
            self.assertIs(llm_module.async_register_llm_api(object(), "entry"), unregister)
        self.assertEqual(registered[0].id, "meitheal_tasks-entry")
        self.assertEqual(registered[0].name, "Meitheal Tasks")

    def test_labels_reject_invalid_json_and_non_string_members(self):
        Task = coordinator_module.MeithealTask
        self.assertEqual(Task({"labels": "not json"}).labels, [])
        self.assertEqual(Task({"labels": '["Home", 4, {}]'}).labels, ["Home"])
        self.assertEqual(Task({"labels": {"home": True}}).labels, [])

    def test_sentence_resources_use_yaml_and_define_title_wildcard(self):
        files = sorted((COMPONENT / "custom_sentences").glob("*/meitheal.yaml"))
        self.assertEqual(len(files), 2)
        for path in files:
            data = yaml.safe_load(path.read_text())
            self.assertEqual(data["language"], path.parent.name)
            self.assertEqual(data["lists"]["item"], {"wildcard": True})
            self.assertIn("MeithealAddTask", data["intents"])
        self.assertFalse(list((COMPONENT / "custom_sentences").glob("*/*.json")))

    def test_english_and_irish_phrases_match_real_sentence_parser(self):
        for language, phrase, title in [
            ("en", "add buy milk to my tasks", "buy milk"),
            ("ga", "cuir bainne le mo thascanna", "bainne"),
        ]:
            data = yaml.safe_load((COMPONENT / "custom_sentences" / language / "meitheal.yaml").read_text())
            result = recognize(phrase, Intents.from_dict(data))
            self.assertIsNotNone(result)
            self.assertEqual(result.intent.name, "MeithealAddTask")
            self.assertEqual(result.entities["item"].value, title)

    def test_nfc_service_metadata_and_runtime_schema_agree(self):
        services = yaml.safe_load((COMPONENT / "services.yaml").read_text())
        self.assertIn("complete_task_by_tag", services)
        self.assertEqual(setup_module.COMPLETE_TASK_BY_TAG_SCHEMA({"tag_id": "tag"}), {"tag_id": "tag"})
        self.assertEqual(set(services["search_tasks"]["fields"]), {"query", "status", "priority", "include_completed"})
        with self.assertRaises(vol.Invalid):
            llm_module.SearchTasksTool.parameters({"urgency": 3})


if __name__ == "__main__":
    unittest.main()
