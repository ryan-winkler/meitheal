"""Native mutations through built App + loopback Core protocol + real Core triggers.

Requires the same checkout's App build and Node on PATH. CI and explicit
MEITHEAL_REQUIRE_APP_PROTOCOL=1 qualification fail if these are absent; ordinary
Python-only local runs may skip App cases. No installed HA, Supervisor,
physical device or registry is accessed by this fixture.
"""
import asyncio
from contextlib import AsyncExitStack, asynccontextmanager, closing
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
async def loopback_app(log_path, env):
    """Run one disposable App process against the fixture database."""
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
            raise AssertionError("Loopback App exited before listening")

        async def drain():
            while line := await process.stdout.readline():
                log.write(line)

        try:
            port = await asyncio.wait_for(port_line(), 15)
            reader = asyncio.create_task(drain())
            try:
                yield URL(f"http://127.0.0.1:{port}")
            finally:
                reader.cancel()
                await asyncio.gather(reader, return_exceptions=True)
        finally:
            if process.returncode is None:
                process.terminate()
                await asyncio.wait_for(process.wait(), 5)


async def event_board_operator_headers(session, origin):
    async with session.get(origin / "api/boards") as response:
        assert response.status == 200
        proof = response.headers["X-Meitheal-Board-Session"]
        [board] = (await response.json())["boards"]
    return {
        "Origin": str(origin),
        "X-Meitheal-Board-Id": board["id"],
        "X-Meitheal-Board-Session": proof,
    }


async def configure_event_binding(session, origin, headers, *, enabled):
    destinations = origin / "api/integrations/work-destinations"
    async with session.get(destinations, headers=headers) as response:
        assert response.status == 200
        configuration = await response.json()
    # The Household migration seeds this binding. Update it in place so
    # revocation leaves no second approval for the same shared receiver.
    [binding] = [item for item in configuration["bindings"]
                 if item["integration"] == "ha_events" and item["sourceId"] == "meitheal"]
    async with session.put(destinations, headers=headers, json={
        "revision": configuration["revision"], "binding": {**binding, "enabled": enabled},
    }) as response:
        assert response.status == 200
        current = (await response.json())["binding"]
        assert current["id"] == binding["id"] and current["generation"] > binding["generation"]


async def approve_event_board(session, origin):
    """Approve shared event delivery and enroll a real Board-limited token."""
    headers = await event_board_operator_headers(session, origin)
    board_id = headers["X-Meitheal-Board-Id"]
    await configure_event_binding(session, origin, headers, enabled=True)
    async with session.post(origin / "api/agent-tokens", headers=headers, json={
        "name": "Native event authority fixture",
        "scopes": ["tasks:read", "tasks:write", "tasks:delete"],
    }) as response:
        assert response.status == 201
        credential = await response.json()
        assert credential["boardId"] == board_id
        return credential["token"], board_id


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
           "MEITHEAL_BOARD_GRANT_PATH": str(tmp_path / "meitheal-board-grants.json"),
           "MEITHEAL_EVENT_CORE_WS": str(core_server.make_url("/core")).replace("http:", "ws:"),
           "SUPERVISOR_TOKEN": "event-authority-fixture", "NODE_ENV": "production",
           "TZ": "Europe/Dublin"}
    if mode == "standalone":
        env.pop("SUPERVISOR_TOKEN", None)
    for key in ["HA_BASE_URL", "HA_TOKEN", "MEITHEAL_DEV_USER_ID"]:
        env.pop(key, None)
    migrate = await asyncio.create_subprocess_exec(
        "node", str(ROOT / "apps/web/scripts/migrate.mjs"),
        cwd=ROOT / "apps/web", env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    _, migrate_err = await asyncio.wait_for(migrate.communicate(), 15)
    assert migrate.returncode == 0, migrate_err.decode()
    if enabled is not None:
        with closing(sqlite3.connect(tmp_path / "tasks.db")) as db:
            db.execute("INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?,?,0)", ("n8n_events", json.dumps(enabled)))
            db.commit()
    # Enroll as a standalone local operator so Core's held-auth test can leave
    # the real event socket unauthenticated until the first mutation returns.
    setup_env = dict(env)
    setup_env.pop("SUPERVISOR_TOKEN", None)
    async with ClientSession() as session, AsyncExitStack() as apps:
        operator = await apps.enter_async_context(loopback_app(tmp_path / "setup-app.log", setup_env))
        token, board_id = await approve_event_board(session, operator)

        async def revoke_event_binding():
            headers = await event_board_operator_headers(session, operator)
            await configure_event_binding(session, operator, headers, enabled=False)

        origin = operator if mode == "standalone" else await apps.enter_async_context(loopback_app(tmp_path / "app.log", env))
        api = MeithealApi(session, origin, token, board_id)
        await api.async_request("GET", "/api/tasks", read_json=True)
        coordinator = MeithealCoordinator(hass, api)
        coordinator.async_request_refresh = AsyncMock()
        yield coordinator, frames, held, authenticated, revoke_event_binding


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
        api = MeithealApi(session, server.make_url("").origin(), "mth_" + "a" * 64, "work")
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
        async with app_core(hass, aiohttp_server, tmp_path, mode=mode) as (coordinator, frames, held, authenticated, _):
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


async def test_native_deletion_stays_private_after_event_binding_revocation(hass, aiohttp_server, tmp_path):
    actions, detaches = await attach_actions(hass)
    try:
        async with app_core(hass, aiohttp_server, tmp_path) as (coordinator, frames, _, _, revoke):
            await coordinator.async_create_task("Delete after revoking event delivery")
            tasks = await coordinator.api.async_request("GET", "/api/tasks", read_json=True)
            [task] = tasks["tasks"]
            await settled(hass, lambda: len(frames) == len(actions) == 1)
            assert frames[0]["event_type"] == actions[0][0] == "meitheal_task_created"

            await revoke()
            assert not await coordinator.async_can_publish_shared()
            await coordinator.async_delete_task(task["id"])
            assert (await coordinator.api.async_request("GET", "/api/tasks", read_json=True))["tasks"] == []
            await hass.async_block_till_done()
            assert len(frames) == len(actions) == 1
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


@pytest.mark.parametrize("mode,enabled,completion_source,update_source", [
    ("app", None, "meitheal", "meitheal"),
    ("app", ["task.created", "task.updated"], "component", "meitheal"),
    ("standalone", None, "component", "component"),
])
async def test_todo_recurrence_insert_failure_leaves_retry_and_event_authority_intact(
    hass, aiohttp_server, tmp_path, mode, enabled, completion_source, update_source,
):
    actions, detaches = await attach_actions(hass)
    try:
        async with app_core(hass, aiohttp_server, tmp_path, mode=mode, enabled=enabled) as (coordinator, frames, *_):
            await coordinator.async_create_task("Recurring Todo before completion", due_date="2031-02-13")
            tasks = await coordinator.api.async_request("GET", "/api/tasks", read_json=True)
            task_id = tasks["tasks"][0]["id"]
            path = f"/api/tasks/{task_id}"
            todo = MeithealTodoListEntity(coordinator, SimpleNamespace(entry_id="event-todo"))
            await settled(hass, lambda: len(actions) == 1)
            actions.clear()
            frames.clear()
            coordinator.async_request_refresh.reset_mock()

            rule = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"
            completed_title = "Recurring Todo after completion"
            with closing(sqlite3.connect(tmp_path / "tasks.db")) as db:
                with db:
                    db.execute("UPDATE tasks SET recurrence_rule = ? WHERE id = ?", (rule, task_id))
                    db.execute("""
                        CREATE TRIGGER reject_todo_recurrence BEFORE INSERT ON tasks
                        WHEN NEW.title = 'Recurring Todo after completion' AND NEW.due_date = '2031-02-17'
                        BEGIN SELECT RAISE(ABORT, 'fixture rejected next occurrence'); END
                    """)

                original = await coordinator.api.async_request("GET", path, read_json=True)
                item = TodoItem(uid=task_id, summary=completed_title, due=date(2031, 2, 14),
                                status=TodoItemStatus.COMPLETED)
                with patch.object(coordinator.api, "async_request", wraps=coordinator.api.async_request) as requests:
                    with pytest.raises(MeithealResponseError) as failure:
                        await todo.async_update_todo_item(item)
                    assert failure.value.status == 500
                    assert await coordinator.api.async_request("GET", path, read_json=True) == original
                    assert db.execute("SELECT COUNT(*) FROM tasks WHERE id <> ?", (task_id,)).fetchone() == (0,)
                    coordinator.async_request_refresh.assert_not_awaited()
                    await hass.async_block_till_done()
                    assert actions == frames == []

                    db.execute("DROP TRIGGER reject_todo_recurrence")
                    await todo.async_update_todo_item(item)
                    writes = [c.kwargs["payload"] for c in requests.await_args_list if c.args[0] == "PUT"]
                    expected_write = {"title": completed_title, "due_date": "2031-02-14",
                                      "status": "done", "updated_at": original["updated_at"]}
                    assert writes == [expected_write, expected_write]

                saved = await coordinator.api.async_request("GET", path, read_json=True)
                assert (saved["title"], saved["due_date"], saved["status"]) == (completed_title, "2031-02-14", "complete")
                assert saved["updated_at"] > original["updated_at"]
                successors = db.execute(
                    "SELECT id, title, due_date, status, recurrence_rule FROM tasks WHERE id <> ?", (task_id,),
                ).fetchall()
                assert len(successors) == 1
                successor_id, *successor_fields = successors[0]
                assert successor_fields == [completed_title, "2031-02-17", "pending", rule]

            expected_events = [
                ("meitheal_task_completed", task_id, completion_source),
                ("meitheal_task_updated", task_id, update_source),
            ]
            if mode == "app":
                expected_events.append(("meitheal_task_created", successor_id, "meitheal"))
            expected_frames = sorted((kind, event_task_id) for kind, event_task_id, source in expected_events
                                     if source == "meitheal")
            await settled(hass, lambda: len(actions) >= len(expected_events) and len(frames) >= len(expected_frames))
            assert sorted((kind, data["task_id"], data["source"]) for kind, data in actions) == sorted(expected_events)
            assert sorted((f["event_type"], f["event_data"]["task_id"]) for f in frames) == expected_frames
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
            coordinator = MeithealCoordinator(hass, MeithealApi(session, server.make_url("").origin(), token, "work"))
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
