"""Shared fixtures for the Meitheal custom integration tests."""

from collections.abc import Iterator
from pathlib import Path
import shutil

import pytest


@pytest.fixture(autouse=True)
def enable_legacy_custom_integrations(request: pytest.FixtureRequest) -> Iterator[None]:
    """Enable custom integrations explicitly on the 2026.10 harness and clean test artifacts."""
    if request.config.pluginmanager.has_plugin("homeassistant"):
        request.getfixturevalue("enable_custom_integrations")
    yield
    shutil.rmtree(Path(__file__).parent / "testing_config" / "custom_sentences", ignore_errors=True)


@pytest.fixture
async def native_human_transport(hass, aioclient_mock):
    """Use production human transport with an official-Supervisor protocol double.

    This replaces only Supervisor discovery/session responses and the Core proxy
    HTTP boundary. It does not replace human_request_scope or Core auth checks.
    """
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, patch
    from aiohttp import DummyCookieJar
    from homeassistant.helpers.aiohttp_client import async_create_clientsession
    from yarl import URL
    from custom_components.meitheal.api import MeithealApi

    origin = "http://local-meitheal:3000"
    proxy = "https://core.native.test/api/hassio_ingress/native-fixture"
    metadata = {"boards": [{"id": "work", "name": "Work", "sharedEntityDelivery": True}], "enrollmentBoardId": "work"}
    hass.config.components.add("hassio")
    hass.config.internal_url = "https://core.native.test"
    supervisor = SimpleNamespace(
        addons=SimpleNamespace(addon_info=AsyncMock(return_value=SimpleNamespace(hostname="local-meitheal", ingress_url="/api/hassio_ingress/native-fixture"))),
        ingress=SimpleNamespace(panels=AsyncMock(return_value={"local_meitheal": SimpleNamespace(admin=False)}), create_session=AsyncMock(return_value="c" * 128)),
    )
    aioclient_mock.get(origin + "/api/agent-context", json=metadata)
    aioclient_mock.get(proxy + "/api/agent-context", json=metadata, headers={"X-Meitheal-Board-Session": "d" * 64})
    with patch("homeassistant.components.hassio.get_supervisor_client", return_value=supervisor):
        session = async_create_clientsession(hass, auto_cleanup=False, cookie_jar=DummyCookieJar())
        try:
            def make_api(token="mth_" + "a" * 64, board_id="work"):
                return MeithealApi(session, URL(origin), token, board_id)
            yield SimpleNamespace(api=make_api(), make_api=make_api, origin=origin, proxy=proxy, supervisor=supervisor, metadata=metadata)
        finally:
            await session.close()
