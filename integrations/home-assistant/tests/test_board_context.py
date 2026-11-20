"""Native Board source/protocol proof; no Supervisor or physical HA claim."""
import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.const import CONF_HOST, CONF_PORT, CONF_SSL
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import UpdateFailed
from yarl import URL

from custom_components.meitheal.api import MeithealApi, MeithealResponseError, async_credential_context
from custom_components.meitheal.config_flow import MeithealConfigFlow
from custom_components.meitheal.const import CONF_API_TOKEN, CONF_BOARD_ID
from custom_components.meitheal.coordinator import MeithealCoordinator
from custom_components.meitheal.sensor import MeithealActiveTasksSensor
from custom_components.meitheal.todo import MeithealTodoListEntity

TOKEN = "mth_" + "a" * 64
ORIGIN = "https://native.example.test"
BOARD = "work"
META = {"boards": [{"id": BOARD, "name": "Work", "sharedEntityDelivery": True}], "enrollmentBoardId": BOARD}
PRIVATE = {"boards": [{"id": BOARD, "name": "Work", "sharedEntityDelivery": False}], "enrollmentBoardId": BOARD}
STATS = {"stats": {"currentStreak": 2, "totalPoints": 9, "todayCompleted": 1}}


def api(session, token=TOKEN, board=BOARD):
    return MeithealApi(session, URL(ORIGIN), token, board)


async def test_tokenless_or_unselected_client_health_only(aioclient_mock):
    aioclient_mock.get(ORIGIN + "/api/health", json={"status": "ok"})
    async with aioclient_mock.create_session(asyncio.get_running_loop()) as session:
        for client in [api(session, None, None), api(session, TOKEN, None)]:
            assert await client.async_request("GET", "/api/health", read_json=True) == {"status": "ok"}
            for method in ["GET", "POST", "PUT", "DELETE"]:
                with pytest.raises(MeithealResponseError):
                    await client.async_request(method, "/api/tasks")
    assert len(aioclient_mock.mock_calls) == 2
    assert all("Authorization" not in call[3] and "Origin" not in call[3] for call in aioclient_mock.mock_calls)


async def test_fixed_board_headers_and_credential_cache_partition(aioclient_mock):
    aioclient_mock.get(ORIGIN + "/api/tasks", json={"tasks": []})
    async with aioclient_mock.create_session(asyncio.get_running_loop()) as session:
        client = api(session)
        await client.async_request("GET", "/api/tasks", read_json=True)
        headers = aioclient_mock.mock_calls[-1][3]
        assert headers["X-Meitheal-Board-Id"] == BOARD and headers["Authorization"] == f"Bearer {TOKEN}"
        with pytest.raises(MeithealResponseError):
            await client.async_request("GET", "/api/tasks", params={"board_id": "home"})
        with pytest.raises(MeithealResponseError):
            await client.async_request("POST", "/api/tasks", payload={"title": "Wrong Board", "board_id": "home"})
        assert len({client.cache_key, api(session, board="home").cache_key, api(session, "mth_" + "b" * 64).cache_key}) == 3
    assert len(aioclient_mock.mock_calls) == 1


async def test_metadata_never_infers_ambiguous_board(aioclient_mock):
    aioclient_mock.get(ORIGIN + "/api/agent-context", json={"boards": [*META["boards"], {"id": "home", "name": "Home", "sharedEntityDelivery": True}], "enrollmentBoardId": None})
    async with aioclient_mock.create_session(asyncio.get_running_loop()) as session:
        metadata = await async_credential_context(api(session, board=None))
        assert metadata["enrollmentBoardId"] is None and len(metadata["boards"]) == 2
        assert aioclient_mock.mock_calls[0][3]["Authorization"] == f"Bearer {TOKEN}"
        assert "X-Meitheal-Board-Id" not in aioclient_mock.mock_calls[0][3]


async def test_private_board_never_fetches_or_publishes_global_cache(hass, aioclient_mock):
    aioclient_mock.get(ORIGIN + "/api/agent-context", json=PRIVATE)
    async with aioclient_mock.create_session(asyncio.get_running_loop()) as session:
        coordinator = MeithealCoordinator(hass, api(session))
        data = await coordinator._async_update_data()
        coordinator.async_set_updated_data(data)
        assert data.tasks == [] and not coordinator.shared_entity_delivery
        entry = type("Entry", (), {"entry_id": "test-entry"})()
        todo = MeithealTodoListEntity(coordinator, entry)
        sensor = MeithealActiveTasksSensor(coordinator, entry)
        assert not todo.available and todo.todo_items is None
        assert not sensor.available and sensor.native_value is None and sensor.extra_state_attributes is None
        events = []
        remove = hass.bus.async_listen("meitheal_task_created", events.append)
        try:
            await coordinator.fire_event("meitheal_task_created", {"title": "Private work"})
            await hass.async_block_till_done()
            assert events == []
        finally:
            remove()
    assert all(str(call[1]).startswith(ORIGIN + "/api/agent-context") for call in aioclient_mock.mock_calls)


async def test_shared_snapshot_rechecks_disclosure_after_reads(hass, aioclient_mock):
    aioclient_mock.get(ORIGIN + "/api/agent-context", json=META)
    aioclient_mock.get(ORIGIN + "/api/tasks", json={"tasks": [{"id": "private", "board_id": BOARD, "title": "Do not publish", "status": "pending"}]})
    aioclient_mock.get(ORIGIN + "/api/gamification", json=STATS)
    async with aioclient_mock.create_session(asyncio.get_running_loop()) as session:
        coordinator = MeithealCoordinator(hass, api(session))
        with patch("custom_components.meitheal.coordinator.async_credential_context", side_effect=[META, PRIVATE]):
            data = await coordinator._async_update_data()
        assert data.tasks == [] and not coordinator.shared_entity_delivery


async def test_selected_board_rejects_foreign_rows(hass, aioclient_mock):
    aioclient_mock.get(ORIGIN + "/api/agent-context", json=META)
    aioclient_mock.get(ORIGIN + "/api/tasks", json={"tasks": [{"id": "foreign", "board_id": "home", "title": "Keep hidden"}]})
    async with aioclient_mock.create_session(asyncio.get_running_loop()) as session:
        coordinator = MeithealCoordinator(hass, api(session))
        with pytest.raises(UpdateFailed):
            await coordinator._async_update_data()
        assert not coordinator.shared_entity_delivery


async def test_revoked_metadata_cannot_use_cached_permission(hass, aioclient_mock):
    aioclient_mock.get(ORIGIN + "/api/agent-context", status=403)
    async with aioclient_mock.create_session(asyncio.get_running_loop()) as session:
        coordinator = MeithealCoordinator(hass, api(session))
        with pytest.raises(ConfigEntryAuthFailed):
            await coordinator._async_update_data()
        assert not coordinator.shared_entity_delivery


async def test_config_requires_explicit_current_credential_board(hass, aioclient_mock):
    aioclient_mock.get(ORIGIN + "/api/agent-context", json=PRIVATE)
    aioclient_mock.get(ORIGIN + "/api/tasks?limit=1", json={"tasks": []})
    flow = MeithealConfigFlow()
    flow.hass = hass
    data = {CONF_HOST: "native.example.test", CONF_PORT: 443, CONF_SSL: True, CONF_API_TOKEN: TOKEN}
    assert await flow._async_test_connection(dict(data)) == "board_required"
    assert await flow._async_test_connection({**data, CONF_BOARD_ID: "home"}) == "invalid_board"
    assert await flow._async_test_connection({**data, CONF_BOARD_ID: BOARD}) is None
    assert all(call[3]["X-Meitheal-Board-Id"] == BOARD for call in aioclient_mock.mock_calls if str(call[1]).startswith(ORIGIN + "/api/tasks"))


async def test_mutation_ack_never_authorizes_private_fallback(hass, aioclient_mock):
    aioclient_mock.post(ORIGIN + "/api/tasks", json={"id": "created", "ticket_key": "WK-1"})
    aioclient_mock.get(ORIGIN + "/api/agent-context", json=PRIVATE)
    async with aioclient_mock.create_session(asyncio.get_running_loop()) as session:
        coordinator = MeithealCoordinator(hass, api(session))
        coordinator.async_request_refresh = AsyncMock()
        events = []
        remove = hass.bus.async_listen("meitheal_task_created", events.append)
        remove_log = hass.bus.async_listen("logbook_entry", events.append)
        try:
            await coordinator.async_create_task("Private work")
            await hass.async_block_till_done()
            assert events == []
            coordinator.async_request_refresh.assert_awaited_once()
        finally:
            remove()
            remove_log()


async def test_genuine_human_scope_uses_official_supervisor_session_and_fixed_credentials(hass, aioclient_mock, hass_owner_user):
    from types import SimpleNamespace
    from homeassistant.core import Context
    from custom_components.meitheal.api import human_request_scope

    user = await hass.auth.async_create_user("Actual context user")
    hass.config.components.add("hassio")
    hass.config.internal_url = "https://core.example.test"
    prefix = "/api/hassio_ingress/official-app-path"
    supervisor = SimpleNamespace(
        addons=SimpleNamespace(addon_info=AsyncMock(return_value=SimpleNamespace(hostname="local-meitheal", ingress_url=prefix))),
        ingress=SimpleNamespace(panels=AsyncMock(return_value={"local_meitheal": SimpleNamespace(admin=False)}), create_session=AsyncMock(return_value="c" * 128)),
    )
    aioclient_mock.get("https://core.example.test" + prefix + "/api/agent-context", json=META, headers={"X-Meitheal-Board-Session": "d" * 64})
    aioclient_mock.post("https://core.example.test" + prefix + "/api/tasks", json={"id": "scoped"})
    async with aioclient_mock.create_session(asyncio.get_running_loop()) as session:
        client = MeithealApi(session, URL("http://local-meitheal:3000"), TOKEN, BOARD)
        with patch("homeassistant.components.hassio.get_supervisor_client", return_value=supervisor):
            async with human_request_scope(hass, client, Context(user_id=user.id)):
                assert await client.async_request("POST", "/api/tasks", payload={"title": "Scoped"}, read_json=True) == {"id": "scoped"}
                await hass.auth.async_update_user(user, is_active=False)
                with pytest.raises(MeithealResponseError):
                    await client.async_request("POST", "/api/tasks", payload={"title": "Must not send"})
    assert supervisor.ingress.create_session.await_args.args[0].user_id == user.id
    assert len(aioclient_mock.mock_calls) == 2
    headers = aioclient_mock.mock_calls[-1][3]
    assert headers["Cookie"] == "ingress_session=" + "c" * 128
    assert headers["Authorization"] == f"Bearer {TOKEN}"
    assert headers["X-Meitheal-Board-Id"] == BOARD
    assert headers["X-Meitheal-Board-Session"] == "d" * 64
    assert not any(key.lower().startswith("x-remote-") or key.lower() == "x-ingress-path" for key in headers)


async def test_missing_human_browser_proof_or_manual_origin_cannot_fall_back_to_agent(hass, aioclient_mock):
    from types import SimpleNamespace
    from homeassistant.core import Context
    from custom_components.meitheal.api import human_request_scope, MeithealConnectionError

    user = await hass.auth.async_create_user("Scoped user")
    hass.config.components.add("hassio")
    hass.config.internal_url = "https://core.example.test"
    prefix = "/api/hassio_ingress/official-app-path"
    supervisor = SimpleNamespace(
        addons=SimpleNamespace(addon_info=AsyncMock(return_value=SimpleNamespace(hostname="local-meitheal", ingress_url=prefix))),
        ingress=SimpleNamespace(panels=AsyncMock(return_value={"local_meitheal": SimpleNamespace(admin=False)}), create_session=AsyncMock(return_value="c" * 128)),
    )
    aioclient_mock.get("https://core.example.test" + prefix + "/api/agent-context", json=META)
    async with aioclient_mock.create_session(asyncio.get_running_loop()) as session:
        with patch("homeassistant.components.hassio.get_supervisor_client", return_value=supervisor):
            with pytest.raises(MeithealResponseError):
                async with human_request_scope(hass, MeithealApi(session, URL("http://local-meitheal:3000"), TOKEN, BOARD), Context(user_id=user.id)):
                    pytest.fail("No proof must not admit a human action")
            with pytest.raises(MeithealConnectionError):
                async with human_request_scope(hass, api(session), Context(user_id=user.id)):
                    pytest.fail("A remote origin must not use this Supervisor's identity")
    assert len(aioclient_mock.mock_calls) == 1


async def test_fresh_context_data_keeps_private_progress_out_of_global_cache(hass, aioclient_mock):
    aioclient_mock.get(ORIGIN + "/api/tasks", json={"tasks": [{"id": "private", "board_id": BOARD, "title": "Scoped work", "status": "pending"}]})
    aioclient_mock.get(ORIGIN + "/api/gamification", json=STATS)
    async with aioclient_mock.create_session(asyncio.get_running_loop()) as session:
        coordinator = MeithealCoordinator(hass, api(session))
        data = await coordinator.async_data_for_context()
        assert data.active_count == 1 and data.tasks[0].title == "Scoped work"
        assert coordinator.data is None and not coordinator.shared_entity_delivery
