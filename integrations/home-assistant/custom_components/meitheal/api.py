"""Meitheal REST transport for the configured origin."""

from collections.abc import Mapping
from ipaddress import IPv6Address
import re
from typing import Any
from urllib.parse import quote

import aiohttp
from homeassistant.const import CONF_HOST, CONF_PORT, CONF_SSL
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from yarl import URL

from .const import CONF_API_TOKEN, DEFAULT_HOST, DEFAULT_PORT

_APP_HOST = re.compile(r"(local|[a-f0-9]{8})-(meitheal(?:-canary|-hub)?)")
_TOKEN = re.compile(r"mth_[a-f0-9]{64}")
_TIMEOUT = aiohttp.ClientTimeout(total=10)


class MeithealConnectionError(HomeAssistantError):
    """An invalid connection configuration or unavailable server."""


class MeithealResponseError(HomeAssistantError):
    """A failed API response with no response content or request headers."""

    def __init__(self, status: int) -> None:
        self.status = status
        super().__init__(f"Meitheal API returned HTTP {status}")


def connection_origin(data: Mapping[str, Any]) -> URL:
    """Build a canonical origin from host, port, and HTTPS configuration."""
    host = data.get(CONF_HOST, DEFAULT_HOST)
    port = data.get(CONF_PORT, DEFAULT_PORT)
    if not isinstance(host, str) or type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("Invalid Meitheal host or port")
    host = host.strip().lower()
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    normalized = host.replace("_", "-")
    if _APP_HOST.fullmatch(normalized):
        host = normalized
    if ":" in host and "%" not in host:
        host = str(IPv6Address(host))
    elif not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.?", host):
        raise ValueError("Invalid Meitheal host")
    return URL.build(scheme="https" if data.get(CONF_SSL) else "http", host=host, port=port)


def task_path(task_id: str) -> str:
    """Keep caller-provided task identifiers in a single API path segment."""
    if task_id in ("", ".", ".."):
        raise ValueError("Invalid Meitheal task identifier")
    return f"/api/tasks/{quote(task_id, safe='')}"


async def async_validate_transport(
    hass: HomeAssistant, origin: URL, token: str | None
) -> None:
    """Allow plaintext credentials only for an installed Supervisor App."""
    if not token:
        return
    if not _TOKEN.fullmatch(token):
        raise ValueError("Invalid Meitheal API token")
    if origin.scheme == "https":
        return
    match = _APP_HOST.fullmatch(origin.raw_host or "")
    if not match or origin.port != DEFAULT_PORT or "hassio" not in hass.config.components:
        raise MeithealConnectionError("Meitheal API credentials require HTTPS")

    # Ask Supervisor about the installed App. A hostname that merely looks
    # like a Docker service name is not sufficient to send a bearer over HTTP.
    from aiohasupervisor import SupervisorError
    from homeassistant.components.hassio import get_supervisor_client

    slug = f"{match[1]}_{match[2].replace('-', '_')}"
    try:
        app = await get_supervisor_client(hass).addons.addon_info(slug)
    except (SupervisorError, TimeoutError):
        raise MeithealConnectionError("Supervisor could not verify the Meitheal App") from None
    if not app.hostname or app.hostname.replace("_", "-").lower() != origin.raw_host:
        raise MeithealConnectionError("Supervisor did not verify the Meitheal App hostname")


class MeithealApi:
    """Send requests on a certificate-verifying, cookie-free HA session."""

    def __init__(
        self, session: aiohttp.ClientSession, origin: URL, token: str | None
    ) -> None:
        self.session = session
        self.origin = origin
        # Bodyless DELETE is still a JSON API request, not an HTML form.
        self._headers = {"Accept": "application/json", "Content-Type": "application/json"}
        # Tokenless standalone writes use the existing same-origin proof.
        if not token:
            self._headers["Origin"] = str(origin)
        self._authorization = f"Bearer {token}" if token else None

    async def async_request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, str] | None = None,
        payload: dict[str, Any] | None = None,
        read_json: bool = False,
        event_authority: set[str] | None = None,
    ) -> Any:
        """Request a fixed API path without following redirects or exposing errors."""
        url = self.origin.with_path(path, encoded=True)
        headers = self._headers
        if self._authorization and path != "/api/health":
            headers = {**headers, "Authorization": self._authorization}
        try:
            async with self.session.request(
                method,
                url,
                params=params,
                json=payload,
                headers=headers,
                timeout=_TIMEOUT,
                allow_redirects=False,
            ) as response:
                if not 200 <= response.status < 300:
                    raise MeithealResponseError(response.status)
                if event_authority is not None:
                    # Response-local authority, not an acknowledgement of bus delivery.
                    # Never store this on the shared API client: mutations can overlap.
                    event_authority.update(
                        event.strip() for event in response.headers.get(
                            "X-Meitheal-HA-Event-Authority", ""
                        ).split(",") if event.strip() in {
                            "meitheal_task_created", "meitheal_task_updated",
                            "meitheal_task_completed", "meitheal_task_deleted",
                        }
                    )
                if read_json:
                    return await response.json()
        except (aiohttp.ClientError, TimeoutError, ValueError):
            raise MeithealConnectionError("Cannot read a response from Meitheal") from None
        return None
