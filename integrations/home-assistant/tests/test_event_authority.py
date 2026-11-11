"""Native mutations through built App + loopback Core protocol + real Core triggers.

Requires the same checkout's App build and Node on PATH. CI and explicit
MEITHEAL_REQUIRE_APP_PROTOCOL=1 qualification fail if these are absent; ordinary
Python-only local runs may skip the six App cases. No installed HA, Supervisor,
physical device or registry is accessed by this fixture.
"""
import asyncio
from contextlib import asynccontextmanager
from datetime import date
import json
import os
from pathlib import Path
import shutil
import sqlite3
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from aiohttp import ClientSession, WSMsgType, web
from homeassistant.components.todo import TodoItem, TodoItemStatus
from homeassistant.helpers.update_coordinator import UpdateFailed
import pytest
from yarl import URL

from custom_components.meitheal.api import MeithealApi, MeithealResponseError
from custom_components.meitheal.coordinator import MeithealCoordinator, MeithealCoordinatorData, MeithealTask
from custom_components.meitheal.device_trigger import async_attach_trigger
from custom_components.meitheal.todo import MeithealTodoListEntity

ROOT = Path(__file__).resolve().parents[3]
HEADER = "X-Meitheal-HA-Event-Authority"
TYPES = ["created", "updated", "completed", "deleted", "overdue"]
pytestmark = pytest.mark.usefixtures("socket_enabled")


@asynccontextmanager
async def app_core(hass, aiohttp_server, tmp_path, *, mode="app", enabled=None):
    """Forward real App fire_event frames onto this test's actual Core bus."""
    entry = ROOT / "apps/web/dist/server/entry.mjs"
    missing = []
    if not entry.is_file():
        missing.append("built App apps/web/dist/server/entry.mjs")
    if not shutil.which("node"):
        missing.append("Node on PATH")
    if missing:
        reason = ("App/Core protocol prerequisites missing: " + ", ".join(missing)
                  + ". Use Node 22/pnpm 10.34.9, install the frozen workspace and build "
                    "with pnpm --filter @meitheal/web build from the tested checkout.")
        required = any(os.environ.get(key, "").lower() in ("1", "true")
                       for key in ("CI", "MEITHEAL_REQUIRE_APP_PROTOCOL"))
        if required:
            pytest.fail(reason, pytrace=False)
        pytest.skip("Python-only local mode: " + reason)
    frames = []
    held = []
    authenticated = asyncio.Event()

    async def core(request):
        socket = web.WebSocketResponse()
        await socket.prepare(request)
        await socket.send_json({"type": "auth_required", "ha_version": "2026.11.1"})
        async for raw in socket:
            if raw.type != WSMsgType.TEXT:
                continue
            message = json.loads(raw.data)
            if message["type"] == "auth":
                if mode == "held-auth":
                    held.append(socket)
                    authenticated.set()
                else:
                    await socket.send_json({"type": "auth_ok", "ha_version": "2026.11.1"})
            elif message["type"] == "ping":
                await socket.send_json({"id": message["id"], "type": "pong"})
            else:
                kind = message["type"]
                if kind == "fire_event":
                    frames.append(message)
                    if mode != "failed-ack":
                        hass.bus.async_fire(message["event_type"], message["event_data"])
                    if mode == "lost-ack":
                        continue
                result = [{"id": "event-fixture-admin", "is_active": True,
                           "system_generated": False, "is_owner": True,
                           "group_ids": ["system-admin"]}] if kind == "config/auth/list" else []
                await socket.send_json({"id": message["id"], "type": "result",
                                        "success": mode != "failed-ack" or kind != "fire_event", "result": result})
        return socket

    protocol = web.Application()
    protocol.router.add_get("/core", core)
    core_server = await aiohttp_server(protocol)
    env = {**os.environ, "MEITHEAL_DB_URL": f"file:{tmp_path / 'tasks.db'}",
           "MEITHEAL_EVENT_CORE_WS": str(core_server.make_url("/core")).replace("http:", "ws:"),
           "SUPERVISOR_TOKEN": "event-authority-fixture", "NODE_ENV": "production"}
    if mode == "standalone":
        env.pop("SUPERVISOR_TOKEN", None)
    for key in ["HA_BASE_URL", "HA_TOKEN", "MEITHEAL_DEV_USER_ID"]:
        env.pop(key, None)
    with sqlite3.connect(tmp_path / "tasks.db") as db:
        db.execute("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)")
        if enabled is not None:
            db.execute("INSERT INTO settings(key,value,updated_at) VALUES(?,?,0)", ("n8n_events", json.dumps(enabled)))
    log_path = tmp_path / "app.log"
    with log_path.open("wb") as log:
        process = await asyncio.create_subprocess_exec(
            "node", str(ROOT / "tests/scripts/native-event-authority-fixture.mjs"),
            cwd=ROOT, env=env, stdout=asyncio.subprocess.PIPE, stderr=log)

        async def port_line():
            while line := await process.stdout.readline():
                log.write(line)
                try:
                    info = json.loads(line)
                except ValueError:
                    continue
                if "eventFixturePort" in info:
                    return info["eventFixturePort"]
            raise AssertionError(f"App exited before listening: {log_path.read_text()}")

        try:
            port = await asyncio.wait_for(port_line(), 15)

            async def drain():
                while line := await process.stdout.readline():
                    log.write(line)

            reader = asyncio.create_task(drain())
            async with ClientSession() as session:
                api = MeithealApi(session, URL(f"http://127.0.0.1:{port}"), None)
                await api.async_request("GET", "/api/tasks", read_json=True)
                coordinator = MeithealCoordinator(hass, api)
                coordinator.async_request_refresh = AsyncMock()
                yield coordinator, frames, held, authenticated
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
        finally:
            if process.returncode is None:
                process.terminate()
                await asyncio.wait_for(process.wait(), 5)


async def attach_actions(hass):
    actions = []
    detaches = []

    async def action(variables, context):
        event = variables["trigger"]["event"]
        actions.append((event.event_type, dict(event.data)))

    for kind in TYPES:
        detaches.append(await async_attach_trigger(hass, {"type": f"task_{kind}"}, action,
            {"trigger_data": {"id": kind}, "variables": {}}))
    return actions, detaches


async def settled(hass, predicate):
    async with asyncio.timeout(5):
        while not predicate():
            await asyncio.sleep(0.01)
            await hass.async_block_till_done()
    await hass.async_block_till_done()


@pytest.mark.parametrize("mode,enabled,source", [
    ("app", None, "meitheal"), ("standalone", None, "component"),
    ("app", [], "component"),
])
async def test_native_mutations_have_one_event_producer(hass, aiohttp_server, tmp_path, mode, enabled, source):
    actions, detaches = await attach_actions(hass)
    try:
        async with app_core(hass, aiohttp_server, tmp_path, mode=mode, enabled=enabled) as (coordinator, frames, *_):
            if enabled == []:
                # Caller headers cannot appoint the App or suppress the fallback.
                coordinator.api.session.headers[HEADER] = "meitheal_task_created,meitheal_task_completed,meitheal_task_updated,meitheal_task_deleted"
            await coordinator.async_create_task("Native event authority")
            tasks = await coordinator.api.async_request("GET", "/api/tasks", read_json=True)
            task_id = tasks["tasks"][0]["id"]
            await settled(hass, lambda: len(actions) >= 1)
            if source == "meitheal":
                # Wait for the actual App protocol frame too: a native duplicate
                # can otherwise win the race and make a count of one misleading.
                await settled(hass, lambda: any(frame["event_type"] == "meitheal_task_created" for frame in frames))
            assert len([a for a in actions if a[0] == "meitheal_task_created"]) == 1
            await coordinator.async_update_task(task_id, {"title": "Updated native event"})
            await settled(hass, lambda: len([a for a in actions if a[0] == "meitheal_task_updated"]) >= 1)
            assert len([a for a in actions if a[0] == "meitheal_task_updated"]) == 1
            await coordinator.async_complete_task(task_id=task_id)
            await settled(hass, lambda: len([a for a in actions if a[0] == "meitheal_task_completed"]) >= 1)
            assert len([a for a in actions if a[0] == "meitheal_task_completed"]) == 1
            # Two rapid valid transitions must each reach the action; no time-window dedupe.
            await coordinator.async_update_task(task_id, {"status": "pending"})
            await coordinator.async_complete_task(task_id=task_id)
            await settled(hass, lambda: len([a for a in actions if a[0] == "meitheal_task_completed"]) >= 2)
            assert len([a for a in actions if a[0] == "meitheal_task_completed"]) == 2
            # The NFC wrapper must preserve the task mutation's authority header.
            await coordinator.async_update_task(task_id, {"status": "pending", "nfc_tag_id": "event-fixture-tag"})
            await coordinator.async_complete_task_by_tag("event-fixture-tag")
            await settled(hass, lambda: len([a for a in actions if a[0] == "meitheal_task_completed"]) >= 3)
            assert len([a for a in actions if a[0] == "meitheal_task_completed"]) == 3
            await coordinator.async_complete_task_by_tag("event-fixture-tag")
            if source == "meitheal":
                # App owns the no-transition decision too, even without cached native data.
                await coordinator.async_complete_task(task_id=task_id)
            await hass.async_block_till_done()
            assert len([a for a in actions if a[0] == "meitheal_task_completed"]) == 3
            await coordinator.async_delete_task(task_id)
            await settled(hass, lambda: len([a for a in actions if a[0] == "meitheal_task_deleted"]) >= 1)
            assert len([a for a in actions if a[0] == "meitheal_task_deleted"]) == 1
            assert all(data["domain"] == "meitheal" and data["source"] == source for _, data in actions)
            if source == "component":
                assert not frames
    finally:
        for detach in detaches:
            detach()


async def test_concurrent_native_requests_bind_authority_to_their_own_receipts(aiohttp_server):
    """Force overlapping HTTP responses on one actual native API client."""
    first_arrived = asyncio.Event()
    second_finished = asyncio.Event()

    async def response(request):
        if request.path == "/api/tasks/owned":
            first_arrived.set()
            await second_finished.wait()
            return web.json_response({"id": "owned"}, headers={HEADER: "meitheal_task_updated,unknown"})
        await first_arrived.wait()
        second_finished.set()
        return web.Response(status=204)

    server_app = web.Application()
    server_app.router.add_put("/api/tasks/owned", response)
    server_app.router.add_delete("/api/tasks/fallback", response)
    server = await aiohttp_server(server_app)
    async with ClientSession() as session:
        api = MeithealApi(session, server.make_url("").origin(), None)
        owned, fallback = set(), set()
        await asyncio.gather(
            api.async_request("PUT", "/api/tasks/owned", payload={"title": "Owned"}, event_authority=owned),
            api.async_request("DELETE", "/api/tasks/fallback", event_authority=fallback),
        )
        assert owned == {"meitheal_task_updated"}
        assert fallback == set()


@pytest.mark.parametrize("mode,expected", [("lost-ack", 1), ("failed-ack", 0), ("held-auth", 0)])
async def test_app_owned_delivery_failure_never_starts_native_second_producer(hass, aiohttp_server, tmp_path, mode, expected):
    actions, detaches = await attach_actions(hass)
    try:
        async with app_core(hass, aiohttp_server, tmp_path, mode=mode) as (coordinator, frames, held, authenticated):
            # A held Core connection or lost fire_event acknowledgement cannot hold the mutation response.
            await asyncio.wait_for(coordinator.async_create_task("Best effort delivery"), 3)
            if mode == "held-auth":
                await asyncio.wait_for(authenticated.wait(), 3)
            else:
                await settled(hass, lambda: len(frames) == 1)
            await hass.async_block_till_done()
            assert len(actions) == expected
            assert all(data["source"] == "meitheal" for _, data in actions)
            if mode == "held-auth":
                await held[0].send_json({"type": "auth_ok", "ha_version": "2026.11.1"})
                await settled(hass, lambda: len(actions) == 1)
                assert actions[0][1]["source"] == "meitheal"
    finally:
        for detach in detaches:
            detach()


@pytest.mark.parametrize("mode,enabled,completion_source,update_source", [
    ("app", None, "meitheal", "meitheal"),
    ("standalone", None, "component", "component"),
    ("app", ["task.created", "task.updated"], "component", "meitheal"),
])
async def test_todo_mixed_completion_uses_one_authoritative_producer(
    hass, aiohttp_server, tmp_path, mode, enabled, completion_source, update_source,
):
    actions, detaches = await attach_actions(hass)
    try:
        async with app_core(hass, aiohttp_server, tmp_path, mode=mode, enabled=enabled) as (coordinator, frames, *_):
            await coordinator.async_create_task("Todo original")
            tasks = await coordinator.api.async_request("GET", "/api/tasks", read_json=True)
            original = tasks["tasks"][0]
            task_id = original["id"]
            path = f"/api/tasks/{task_id}"
            todo = MeithealTodoListEntity(coordinator, SimpleNamespace(entry_id="event-todo"))
            coordinator.data = MeithealCoordinatorData([MeithealTask({**original, "status": "complete"})])
            assert (await coordinator.api.async_request("GET", path, read_json=True))["status"] == "pending"

            def events(kind):
                return [data for name, data in actions if name == f"meitheal_task_{kind}"]

            item = TodoItem(uid=task_id, summary="Todo completed", due=date(2027, 1, 15), status=TodoItemStatus.COMPLETED)
            with patch.object(coordinator.api, "async_request", wraps=coordinator.api.async_request) as requests:
                await todo.async_update_todo_item(item)
                writes = [c for c in requests.await_args_list if c.args[0] == "PUT"]
                assert len(writes) == 1
                assert {key: writes[0].kwargs["payload"][key] for key in ("title", "due_date", "status")} == {
                    "title": "Todo completed", "due_date": "2027-01-15", "status": "done",
                }
            saved = await coordinator.api.async_request("GET", path, read_json=True)
            assert (saved["title"], saved["due_date"], saved["status"]) == ("Todo completed", "2027-01-15", "complete")
            await settled(hass, lambda: len(events("completed")) >= 1 and len(events("updated")) >= 1)
            assert [(e["domain"], e["source"]) for e in events("completed")] == [("meitheal", completion_source)]

            # Stale poll data must neither suppress a real completion nor invent a repeat.
            coordinator.data = MeithealCoordinatorData([MeithealTask(original)])
            await todo.async_update_todo_item(TodoItem(uid=task_id, summary="Edited after completion", status=TodoItemStatus.COMPLETED))
            await settled(hass, lambda: len(events("updated")) >= 2)
            assert len(events("completed")) == 1
            assert (await coordinator.api.async_request("GET", path, read_json=True))["title"] == "Edited after completion"

            await todo.async_update_todo_item(TodoItem(uid=task_id, status=TodoItemStatus.NEEDS_ACTION))
            assert (await coordinator.api.async_request("GET", path, read_json=True))["status"] == "pending"
            await todo.async_update_todo_item(TodoItem(uid=task_id, status=TodoItemStatus.COMPLETED))
            await settled(hass, lambda: len(events("completed")) >= 2 and len(events("updated")) >= 4)
            assert [e["source"] for e in events("completed")] == [completion_source] * 2
            assert [e["source"] for e in events("updated")] == [update_source] * 4
            assert sum(f["event_type"] == "meitheal_task_completed" for f in frames) == (2 if completion_source == "meitheal" else 0)
    finally:
        for detach in detaches:
            detach()


async def test_concurrent_todo_completion_cannot_act_on_the_same_snapshot(hass, aiohttp_server, tmp_path):
    actions, detaches = await attach_actions(hass)
    try:
        async with app_core(hass, aiohttp_server, tmp_path, mode="standalone") as (coordinator, *_):
            await coordinator.async_create_task("Contended Todo")
            tasks = await coordinator.api.async_request("GET", "/api/tasks", read_json=True)
            task_id = tasks["tasks"][0]["id"]
            path = f"/api/tasks/{task_id}"
            todo = MeithealTodoListEntity(coordinator, SimpleNamespace(entry_id="event-todo"))
            request = coordinator.api.async_request
            both_read = asyncio.Event()
            snapshots = []

            async def hold_same_snapshot(method, request_path, **kwargs):
                result = await request(method, request_path, **kwargs)
                if method == "GET" and request_path == path:
                    snapshots.append(result)
                    if len(snapshots) == 2:
                        both_read.set()
                    await both_read.wait()
                return result

            with patch.object(coordinator.api, "async_request", side_effect=hold_same_snapshot):
                async with asyncio.timeout(5):
                    results = await asyncio.gather(*(
                        todo.async_update_todo_item(TodoItem(uid=task_id, summary=title, status=TodoItemStatus.COMPLETED))
                        for title in ("First writer", "Second writer")
                    ), return_exceptions=True)
            assert len(snapshots) == 2 and snapshots[0] == snapshots[1]
            assert snapshots[0]["status"] == "pending"
            assert sum(result is None for result in results) == 1
            conflict = next(result for result in results if result is not None)
            assert isinstance(conflict, MeithealResponseError) and conflict.status == 409
            await settled(hass, lambda: any(kind == "meitheal_task_completed" for kind, _ in actions))
            assert [kind for kind, _ in actions if kind != "meitheal_task_created"] == ["meitheal_task_updated", "meitheal_task_completed"]
            saved = await request("GET", path, read_json=True)
            assert saved["title"] == ("First writer" if results[0] is None else "Second writer")
            assert saved["status"] == "complete"
    finally:
        for detach in detaches:
            detach()


async def test_todo_completion_rejects_an_unmatched_successful_receipt(hass, aiohttp_server):
    calls = []
    token = "mth_" + "a" * 64

    async def response(request):
        calls.append((request.method, request.headers.get("Authorization")))
        if request.method == "GET":
            return web.json_response({"id": "one", "status": "pending", "task_version": 10})
        return web.json_response({"id": "another", "status": "complete"})

    server_app = web.Application()
    server_app.router.add_route("*", "/api/tasks/one", response)
    server = await aiohttp_server(server_app)
    actions, detaches = await attach_actions(hass)
    try:
        async with ClientSession() as session:
            coordinator = MeithealCoordinator(hass, MeithealApi(session, server.make_url("").origin(), token))
            coordinator.async_request_refresh = AsyncMock()
            todo = MeithealTodoListEntity(coordinator, SimpleNamespace(entry_id="event-todo"))
            with pytest.raises(UpdateFailed, match="did not acknowledge task completion"):
                await todo.async_update_todo_item(TodoItem(uid="one", status=TodoItemStatus.COMPLETED))
            coordinator.async_request_refresh.assert_not_awaited()
            await hass.async_block_till_done()
            assert actions == []
        assert calls == [("GET", f"Bearer {token}"), ("PUT", f"Bearer {token}")]
    finally:
        for detach in detaches:
            detach()
