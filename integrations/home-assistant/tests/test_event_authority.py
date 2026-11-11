"""Native mutations through built App + loopback Core protocol + real Core triggers.

Requires `pnpm --filter @meitheal/web build` and Node on PATH. No installed HA,
Supervisor, physical device or registry is accessed by this fixture.
"""
import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import shutil
import sqlite3
from unittest.mock import AsyncMock

from aiohttp import ClientSession, WSMsgType, web
import pytest
from yarl import URL

from custom_components.meitheal.api import MeithealApi
from custom_components.meitheal.coordinator import MeithealCoordinator
from custom_components.meitheal.device_trigger import async_attach_trigger

ROOT = Path(__file__).resolve().parents[3]
HEADER = "X-Meitheal-HA-Event-Authority"
TYPES = ["created", "updated", "completed", "deleted", "overdue"]
pytestmark = pytest.mark.usefixtures("socket_enabled")


@asynccontextmanager
async def app_core(hass, aiohttp_server, tmp_path, *, mode="app", enabled=None):
    """Forward real App fire_event frames onto this test's actual Core bus."""
    entry = ROOT / "apps/web/dist/server/entry.mjs"
    if not entry.exists() or not shutil.which("node"):
        pytest.skip("Build the web App and put Node on PATH for App/Core protocol proof")
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
