"""Exercise config entry, transport and entity behavior on Home Assistant Core."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from aiohttp import ClientSession, web
from homeassistant import config_entries
from homeassistant.const import CONF_HOST, CONF_PORT, CONF_SSL
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import entity_registry as er, translation
from homeassistant.helpers.service_info.hassio import HassioServiceInfo

try:
    from pytest_homeassistant.common import MockConfigEntry
    from pytest_homeassistant.test_util.aiohttp import AiohttpClientMocker
except ModuleNotFoundError as error:
    if error.name != "pytest_homeassistant":
        raise
    from pytest_homeassistant_custom_component.common import MockConfigEntry
    from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from custom_components.meitheal.api import (
    MeithealApi,
    MeithealResponseError,
    connection_origin,
)
from custom_components.meitheal.const import CONF_API_TOKEN, DOMAIN
from custom_components.meitheal.diagnostics import async_get_config_entry_diagnostics

TOKEN = "mth_" + "a" * 64
REPLACEMENT = "mth_" + "b" * 64
HOST = "tasks.example.test"
ORIGIN = f"https://{HOST}"
CONNECTION = {CONF_HOST: HOST, CONF_PORT: 443, CONF_SSL: True}
PROBE = f"{ORIGIN}/api/tasks?limit=1"
TASKS = f"{ORIGIN}/api/tasks"


def mock_entry(
    hass: HomeAssistant, data: dict[str, object], *, source: str = config_entries.SOURCE_USER
) -> MockConfigEntry:
    """Create an existing Meitheal entry."""
    entry = MockConfigEntry(domain=DOMAIN, title="Meitheal", data=data, unique_id=DOMAIN, source=source)
    entry.add_to_hass(hass)
    return entry


async def test_runtime_translations_supply_token_form_labels(hass: HomeAssistant) -> None:
    """Standalone Home Assistant loads the custom integration's English strings."""
    strings = await translation.async_get_translations(hass, "en", "config", [DOMAIN])
    assert strings[f"component.{DOMAIN}.config.step.reauth_confirm.data.api_token"] == "Meitheal API token"


async def test_existing_entry_keeps_entity_after_enrollment(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """Legacy use, credential enrollment, and authenticated polling share one entry."""
    entry = mock_entry(hass, CONNECTION)
    aioclient_mock.get(TASKS, json={"tasks": [{"id": "one", "status": "complete"}]})
    aioclient_mock.get(PROBE, json={"tasks": []})
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert "Authorization" not in aioclient_mock.mock_calls[0][3]
    registry = er.async_get(hass)
    entity_id = registry.async_get_entity_id("todo", DOMAIN, f"{entry.entry_id}_todo")
    assert entity_id is not None
    assert entry.runtime_data.data.active_count == 0

    flow = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_RECONFIGURE, "entry_id": entry.entry_id}
    )
    assert flow["type"] is FlowResultType.FORM
    result = await hass.config_entries.flow.async_configure(
        flow["flow_id"], {**CONNECTION, CONF_API_TOKEN: f" {TOKEN} "}
    )
    await hass.async_block_till_done()
    assert result["reason"] == "reconfigure_successful"
    assert entry.data[CONF_API_TOKEN] == TOKEN
    assert registry.async_get_entity_id("todo", DOMAIN, f"{entry.entry_id}_todo") == entity_id
    assert aioclient_mock.mock_calls[-1][3]["Authorization"] == f"Bearer {TOKEN}"
    assert aioclient_mock.mock_calls[-1][3]["Origin"] == ORIGIN
    assert TOKEN not in str(await async_get_config_entry_diagnostics(hass, entry))


async def test_protected_actions_share_bearer_and_never_log_error_body(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, caplog: pytest.LogCaptureFixture
) -> None:
    """All action requests use the configured origin and sanitize failures."""
    entry = mock_entry(hass, {**CONNECTION, CONF_API_TOKEN: TOKEN})
    aioclient_mock.get(TASKS, json={"tasks": []})
    aioclient_mock.post(f"{TASKS}/create", json={"id": "one"}, status=201)
    aioclient_mock.put(f"{TASKS}/one", json={"id": "one"})
    aioclient_mock.get(
        f"{ORIGIN}/api/search",
        json={"sections": [{"id": "tasks", "items": [{"id": "one"}]}]},
    )
    aioclient_mock.delete(f"{TASKS}/one/links", json={"ok": True})
    aioclient_mock.delete(f"{TASKS}/one", status=403, text=TOKEN)
    assert await hass.config_entries.async_setup(entry.entry_id)
    coordinator = entry.runtime_data

    await coordinator.async_create_task("Try release")
    await coordinator.async_complete_task(task_id="one")
    assert (await coordinator.async_search_tasks("Try release"))["count"] == 1
    assert await coordinator.async_unlink_task("one", "rel-1") == {"ok": True}
    with pytest.raises(MeithealResponseError, match="HTTP 403") as caught:
        await coordinator.async_delete_task("one")

    assert TOKEN not in str(caught.value)
    assert TOKEN not in caplog.text
    assert all(
        url.origin() == connection_origin(CONNECTION)
        and headers["Authorization"] == f"Bearer {TOKEN}"
        and headers["Origin"] == ORIGIN
        for _, url, _, headers in aioclient_mock.mock_calls
    )


async def test_reconfigure_cannot_reuse_token_at_another_origin(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """Changing the destination requires explicit credentials for that origin."""
    entry = mock_entry(hass, {**CONNECTION, CONF_API_TOKEN: TOKEN})
    flow = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_RECONFIGURE, "entry_id": entry.entry_id}
    )
    assert TOKEN not in str(flow)
    result = await hass.config_entries.flow.async_configure(
        flow["flow_id"], {**CONNECTION, CONF_HOST: "other.example.test"}
    )
    assert result["errors"] == {"base": "token_required_for_origin"}
    assert aioclient_mock.call_count == 0
    assert entry.data[CONF_HOST] == HOST


async def test_rejected_poll_opens_reauth_on_existing_entry(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """HA opens a recovery flow and saves a working replacement token in place."""
    entry = mock_entry(hass, CONNECTION)
    aioclient_mock.get(TASKS, status=401, text=TOKEN)
    assert not await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    aioclient_mock.clear_requests()
    aioclient_mock.get(PROBE, json={"tasks": []})
    aioclient_mock.get(TASKS, json={"tasks": []})
    (flow,) = hass.config_entries.flow.async_progress_by_handler(DOMAIN)
    assert flow["context"]["source"] == config_entries.SOURCE_REAUTH
    assert flow["step_id"] == "reauth_confirm"
    assert TOKEN not in str(flow)
    result = await hass.config_entries.flow.async_configure(
        flow["flow_id"], {CONF_API_TOKEN: REPLACEMENT}
    )
    assert result["reason"] == "reauth_successful"
    await hass.async_block_till_done()
    assert entry.data[CONF_API_TOKEN] == REPLACEMENT
    assert entry.data[CONF_HOST] == HOST
    assert aioclient_mock.mock_calls[-1][3]["Authorization"] == f"Bearer {REPLACEMENT}"


async def test_reauth_cannot_save_token_after_concurrent_origin_change(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """A successful probe of a stale origin cannot attach a token to a new one."""
    entry = mock_entry(hass, {**CONNECTION, CONF_API_TOKEN: TOKEN})

    async def change_origin(*_args, **_kwargs):
        hass.config_entries.async_update_entry(
            entry, data={**CONNECTION, CONF_HOST: "other.example.test"}
        )
        return None

    flow = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_REAUTH, "entry_id": entry.entry_id},
        data=entry.data,
    )
    with patch(
        "custom_components.meitheal.config_flow.MeithealConfigFlow._async_test_connection",
        side_effect=change_origin,
    ):
        result = await hass.config_entries.flow.async_configure(
            flow["flow_id"], {CONF_API_TOKEN: REPLACEMENT}
        )
    assert result["reason"] == "configuration_changed"
    assert CONF_API_TOKEN not in entry.data
    assert aioclient_mock.call_count == 0


async def test_manual_http_refuses_token_before_request(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """Even a plausible App name cannot authorize plaintext on standalone Core."""
    flow = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    result = await hass.config_entries.flow.async_configure(
        flow["flow_id"],
        {
            CONF_HOST: "local-meitheal",
            CONF_PORT: 3000,
            CONF_SSL: False,
            CONF_API_TOKEN: TOKEN,
        },
    )
    assert result["errors"] == {"base": "insecure_connection"}
    assert aioclient_mock.call_count == 0


async def test_supervisor_discovery_only_uses_operator_token_for_installed_app(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """The actual Supervisor app hostname controls the sole plaintext exception."""
    reported_host = "2e8c4a3f_meitheal_canary"
    origin = "http://2e8c4a3f-meitheal-canary:3000"
    aioclient_mock.get(f"{origin}/api/tasks?limit=1", json={"tasks": []})
    aioclient_mock.get(f"{origin}/api/tasks", json={"tasks": []})
    addon_info = AsyncMock(return_value=SimpleNamespace(hostname="other-meitheal"))
    hass.config.components.add("hassio")
    flow = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={"source": config_entries.SOURCE_HASSIO},
        data=HassioServiceInfo(
            config={CONF_HOST: reported_host, CONF_PORT: 3000, CONF_API_TOKEN: TOKEN},
            name="Meitheal Canary",
            slug=reported_host,
            uuid="b2638156d652414abef44aa62a972cdc",
        ),
    )
    assert flow["step_id"] == "hassio_confirm"
    assert TOKEN not in str(flow)
    with patch(
        "homeassistant.components.hassio.get_supervisor_client",
        return_value=SimpleNamespace(addons=SimpleNamespace(addon_info=addon_info)),
    ):
        result = await hass.config_entries.flow.async_configure(
            flow["flow_id"], {CONF_API_TOKEN: REPLACEMENT}
        )
        assert result["errors"] == {"base": "insecure_connection"}
        assert aioclient_mock.call_count == 0
        addon_info.return_value = SimpleNamespace(hostname=reported_host)
        result = await hass.config_entries.flow.async_configure(
            flow["flow_id"], {CONF_API_TOKEN: REPLACEMENT}
        )
        await hass.async_block_till_done()
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"][CONF_HOST] == "2e8c4a3f-meitheal-canary"
    assert result["data"][CONF_API_TOKEN] == REPLACEMENT
    assert addon_info.await_args.args == (reported_host,)
    assert aioclient_mock.mock_calls[0][3]["Authorization"] == f"Bearer {REPLACEMENT}"


@pytest.mark.usefixtures("socket_enabled")
async def test_transport_blocks_redirects_and_omits_token_from_health(aiohttp_server) -> None:
    """Check actual HTTP requests instead of mocking redirect behavior."""
    requests = []

    async def collect(request):
        requests.append((request.path, request.headers.get("Authorization")))
        if request.path == "/api/tasks":
            raise web.HTTPFound("/api/redirect-target")
        return web.json_response({"ok": True})

    app = web.Application()
    app.router.add_get("/api/{resource}", collect)
    server = await aiohttp_server(app)
    async with ClientSession() as session:
        api = MeithealApi(session, server.make_url("").origin(), TOKEN)
        await api.async_request("GET", "/api/health")
        with pytest.raises(MeithealResponseError, match="HTTP 302"):
            await api.async_request("GET", "/api/tasks")

    assert requests == [("/api/health", None), ("/api/tasks", f"Bearer {TOKEN}")]


@pytest.mark.parametrize("host", [
    "https://tasks.example.test",
    "user@tasks.example.test",
    "tasks.example.test/alt",
    "tasks.example.test:8080",
    "tasks.example.test?anything",
    "fe80::1%eth0",
])
def test_origin_rejects_url_fragments_in_host(host: str) -> None:
    """A host may not modify credentials, scheme, port, or path."""
    with pytest.raises(ValueError):
        connection_origin({**CONNECTION, CONF_HOST: host})
