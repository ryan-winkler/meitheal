"""Meitheal REST transport for the configured origin."""

import re
from hashlib import sha256
from collections.abc import AsyncIterator, Iterator, Mapping
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from ipaddress import IPv6Address
from typing import Any
from urllib.parse import quote

import aiohttp
from homeassistant.const import CONF_HOST, CONF_PORT, CONF_SSL
from homeassistant.core import Context, HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from yarl import URL

from .const import DEFAULT_HOST, DEFAULT_PORT

_APP_HOST = re.compile(r"(local|[a-f0-9]{8})-(meitheal(?:-canary|-hub)?)")
_TOKEN = re.compile(r"mth_[a-f0-9]{64}")
_TIMEOUT = aiohttp.ClientTimeout(total=10, connect=4, sock_read=8)
_ORIGIN_KINDS = frozenset({
    "conversation_agent",
    "ha_automation",
    "ha_script",
    "webhook",
    "mcp",
    "agent_token",
})
_ORIGIN_HEADER_KEYS = frozenset({
    "X-Meitheal-Origin-Kind",
    "X-Meitheal-Origin-Name",
    "X-Meitheal-Origin-Target",
})
_CURRENT_ORIGIN: ContextVar[dict[str, str] | None] = ContextVar("_CURRENT_ORIGIN", default=None)


@dataclass(repr=False)
class _HumanTransport:
    hass: HomeAssistant
    user_id: str
    cache_key: str
    origin: URL
    prefix: str
    cookie: str
    proof: str | None = None
    active: bool = True

    async def validate(self, api: "MeithealApi") -> None:
        user = await self.hass.auth.async_get_user(self.user_id)
        if not self.active or api.cache_key != self.cache_key or not user or not user.is_active:
            raise MeithealResponseError(403)


_CURRENT_HUMAN: ContextVar[_HumanTransport | None] = ContextVar("_CURRENT_HUMAN", default=None)


# Invisible and bidi formatting characters could reorder the token name shown beside the origin.
_INVISIBLE_FORMAT_CHARS = re.compile("[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]")
_ORIGIN_NAME_SAFE = "".join(chr(code) for code in range(0x20, 0x7F) if chr(code) != "%")


def build_origin_headers(
    origin_kind: str | None = None,
    origin_name: str | None = None,
    origin_target: str | None = None,
) -> dict[str, str]:
    """Build sanitized X-Meitheal-Origin-* headers when provenance is present."""
    headers: dict[str, str] = {}
    if isinstance(origin_kind, str):
        kind = origin_kind.strip().lower()
        if kind in _ORIGIN_KINDS:
            headers["X-Meitheal-Origin-Kind"] = kind
    if isinstance(origin_name, str):
        visible = _INVISIBLE_FORMAT_CHARS.sub("", origin_name)
        clean_name = re.sub(
            r"\s+", " ", re.sub(r"[\r\n\t\x00-\x1f\x7f-\x9f\u2028\u2029]+", " ", visible)
        ).strip()[:120].strip()
        if clean_name:
            # HTTP header values are Latin-1 on the Meitheal side, so percent-encode
            # UTF-8 names. Printable ASCII other than "%" stays readable.
            headers["X-Meitheal-Origin-Name"] = quote(clean_name, safe=_ORIGIN_NAME_SAFE)
    if isinstance(origin_target, str):
        clean_target = origin_target.strip()
        if (
            clean_target
            and len(clean_target) <= 512
            and clean_target.startswith("/")
            and not clean_target.startswith("//")
            and not clean_target.startswith("/\\")
            and not re.search(r"[\r\n\x00-\x1f\x7f\\]", clean_target)
            and not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", clean_target)
        ):
            headers["X-Meitheal-Origin-Target"] = clean_target
    return headers


def resolve_origin_headers(
    origin_kind: str | None = None,
    origin_name: str | None = None,
    origin_target: str | None = None,
) -> dict[str, str]:
    """Return explicit origin headers, or fall back to the active origin context."""
    if origin_kind is not None or origin_name is not None or origin_target is not None:
        return build_origin_headers(origin_kind, origin_name, origin_target)
    current = _CURRENT_ORIGIN.get()
    return dict(current) if current else {}


@contextmanager
def origin_scope(
    origin_kind: str | None = None,
    origin_name: str | None = None,
    origin_target: str | None = None,
) -> Iterator[None]:
    """Bind verified provenance headers for mutations within the current async task."""
    headers = build_origin_headers(origin_kind, origin_name, origin_target)
    token = _CURRENT_ORIGIN.set(headers or None)
    try:
        yield
    finally:
        _CURRENT_ORIGIN.reset(token)


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


def task_matches_identifier(data: object, task_id: str | None = None) -> bool:
    """Return True when a task receipt has an ID matching the requested UUID or ticket key."""
    if not isinstance(data, dict) or data.get("error"):
        return False
    resolved_id = data.get("id")
    if not isinstance(resolved_id, str) or not resolved_id:
        return False
    if task_id is None:
        return True
    if not task_id:
        return False
    if resolved_id == task_id:
        return True
    ticket_key = data.get("ticket_key")
    return isinstance(ticket_key, str) and bool(ticket_key) and ticket_key.upper() == task_id.upper()


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
        self, session: aiohttp.ClientSession, origin: URL, token: str | None, board_id: str | None = None
    ) -> None:
        if board_id is not None and (not isinstance(board_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,149}", board_id)):
            raise ValueError("Invalid Meitheal Board identifier")
        self.session = session
        self.origin = origin
        self._board_id = board_id
        self._cache_key = sha256(f"{origin}\0{board_id or ''}\0{token or ''}".encode()).hexdigest()
        # Bodyless DELETE is still a JSON API request, not an HTML form.
        self._headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if board_id:
            self._headers["X-Meitheal-Board-Id"] = board_id
        self._authorization = f"Bearer {token}" if token else None

    @property
    def board_id(self) -> str | None:
        """The explicitly configured destination, fixed for this credential client."""
        return self._board_id

    @property
    def cache_key(self) -> str:
        """Opaque per-origin, credential and Board partition; never diagnostics data."""
        return self._cache_key

    @property
    def configured(self) -> bool:
        """Whether protected requests have both a credential and destination."""
        return bool(self._authorization and self._board_id)

    async def async_request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, str] | None = None,
        payload: dict[str, Any] | None = None,
        read_json: bool = False,
        event_authority: set[str] | None = None,
        extra_headers: Mapping[str, str] | None = None,
        session_proof: list[str] | None = None,
    ) -> Any:
        """Request a fixed API path without following redirects or exposing errors."""
        health = path == "/api/health" and method in ("GET", "HEAD")
        metadata = path == "/api/agent-context" and method == "GET"
        if not health and (not self._authorization or not metadata and not self._board_id):
            raise MeithealResponseError(401)
        if params and "board_id" in params and params["board_id"] != self._board_id:
            raise MeithealResponseError(404)
        if payload and any(key in payload for key in ("board_id", "boardId", "board")):
            raise MeithealResponseError(400)
        human = _CURRENT_HUMAN.get()
        if human is not None:
            await human.validate(self)
        url = (human.origin.with_path(human.prefix + path, encoded=True) if human else self.origin.with_path(path, encoded=True))
        headers = dict(self._headers)
        if human:
            headers["Cookie"] = f"ingress_session={human.cookie}"
            if human.proof:
                headers["X-Meitheal-Board-Session"] = human.proof
        origin_hdrs = (
            extra_headers
            if extra_headers is not None
            else (_CURRENT_ORIGIN.get() if method in ("POST", "PUT", "PATCH", "DELETE") else None)
        )
        if origin_hdrs:
            safe_origin = {
                k: v for k, v in origin_hdrs.items()
                if k in _ORIGIN_HEADER_KEYS and isinstance(v, str) and v
            }
            if safe_origin:
                headers = {**headers, **safe_origin}
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
                if human:
                    await human.validate(self)
                if not 200 <= response.status < 300:
                    raise MeithealResponseError(response.status)
                if session_proof is not None:
                    proof = response.headers.get("X-Meitheal-Board-Session", "")
                    if re.fullmatch(r"[a-f0-9]{64}", proof):
                        session_proof.append(proof)
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
                    result = await response.json()
                    if human:
                        await human.validate(self)
                    return result
        except (aiohttp.ClientError, TimeoutError, ValueError):
            raise MeithealConnectionError("Cannot read a response from Meitheal") from None
        return None


async def async_credential_context(api: MeithealApi) -> dict[str, Any]:
    """Read the current credential's server-proven Board metadata, never infer a default."""
    data = await api.async_request("GET", "/api/agent-context", read_json=True)
    if not isinstance(data, dict) or not isinstance(data.get("boards"), list):
        raise MeithealConnectionError("Meitheal did not verify the credential destination")
    boards = data["boards"]
    ids: set[str] = set()
    for board in boards:
        if (not isinstance(board, dict) or not isinstance(board.get("id"), str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,149}", board["id"])
            or board["id"] in ids or not isinstance(board.get("name"), str)
            or type(board.get("sharedEntityDelivery")) is not bool):
            raise MeithealConnectionError("Meitheal did not verify the credential destination")
        ids.add(board["id"])
    enrollment = data.get("enrollmentBoardId")
    if enrollment is not None and (len(ids) != 1 or enrollment not in ids):
        raise MeithealConnectionError("Meitheal did not verify the credential destination")
    expires_at = data.get("tokenExpiresAt")
    if expires_at is not None and not isinstance(expires_at, str):
        data["tokenExpiresAt"] = None
    return data


async def async_renew_token(api: MeithealApi, *, days: int = 90) -> str | None:
    """Proactively extend an expiring integration token before it expires."""
    data = await api.async_request(
        "POST",
        "/api/agent-tokens/renew",
        payload={"days": max(1, min(365, int(days)))},
        read_json=True,
    )
    if isinstance(data, dict) and isinstance(data.get("expiresAt"), str):
        return data["expiresAt"]
    return None


@asynccontextmanager
async def human_request_scope(hass: HomeAssistant, api: MeithealApi, context: Context | None) -> AsyncIterator[None]:
    """Use Supervisor's genuine per-user ingress for an actual HA call context.

    An automation without a user keeps only its configured credential ceiling.
    No caller identity header, OAuth credential or signing key is invented.
    """
    user_id = context.user_id if isinstance(context, Context) else None
    if not user_id:
        yield
        return
    user = await hass.auth.async_get_user(user_id)
    if not user or not user.is_active or not api.configured:
        raise MeithealResponseError(403)
    current = _CURRENT_HUMAN.get()
    if current:
        if current.user_id != user_id:
            raise MeithealResponseError(403)
        await current.validate(api)
        yield
        return

    from aiohasupervisor import SupervisorError
    from aiohasupervisor.models import CreateSessionOptions
    from homeassistant.components.hassio import get_supervisor_client
    from homeassistant.helpers.network import NoURLAvailableError, get_url

    match = _APP_HOST.fullmatch(api.origin.raw_host or "")
    if not match or api.origin.port != DEFAULT_PORT or "hassio" not in hass.config.components:
        raise MeithealConnectionError("Human Board access requires this instance's verified Supervisor ingress")
    slug = f"{match[1]}_{match[2].replace('-', '_')}"
    try:
        supervisor = get_supervisor_client(hass)
        addon = await supervisor.addons.addon_info(slug)
        if not addon.hostname or addon.hostname.replace("_", "-").lower() != api.origin.raw_host:
            raise MeithealConnectionError("Supervisor did not verify this Meitheal App")
        prefix = addon.ingress_url
        if not isinstance(prefix, str) or not re.fullmatch(r"/api/hassio_ingress/[A-Za-z0-9_-]+/?", prefix):
            raise MeithealConnectionError("Supervisor did not provide this App's ingress route")
        if not user.is_admin:
            panels = await supervisor.ingress.panels()
            panel = panels.get(slug)
            if panel is None or panel.admin:
                raise MeithealResponseError(403)
        core_url = URL(get_url(hass, allow_external=False, allow_cloud=False, prefer_external=False))
        if core_url.scheme not in ("http", "https") or core_url.user or core_url.password or core_url.path not in ("", "/") or core_url.query_string or core_url.fragment:
            raise MeithealConnectionError("Home Assistant did not provide a local ingress origin")
        # Recheck the actual caller after discovery and immediately before creating the official session.
        user = await hass.auth.async_get_user(user_id)
        if not user or not user.is_active:
            raise MeithealResponseError(403)
        cookie = await supervisor.ingress.create_session(CreateSessionOptions(user_id=user.id))
        if not isinstance(cookie, str) or not re.fullmatch(r"[a-f0-9]{128}", cookie):
            raise MeithealConnectionError("Supervisor did not confirm the caller session")
    except (SupervisorError, NoURLAvailableError, ValueError, TimeoutError):
        raise MeithealConnectionError("Cannot verify current Home Assistant Board access") from None

    transport = _HumanTransport(hass, user_id, api.cache_key, core_url.origin(), prefix.rstrip("/"), cookie)
    reset = _CURRENT_HUMAN.set(transport)
    try:
        proofs: list[str] = []
        metadata = await api.async_request("GET", "/api/agent-context", read_json=True, session_proof=proofs)
        if (not proofs or not isinstance(metadata, dict) or not isinstance(metadata.get("boards"), list)
            or not any(isinstance(board, dict) and board.get("id") == api.board_id for board in metadata["boards"])):
            raise MeithealResponseError(403)
        transport.proof = proofs[-1]
        await transport.validate(api)
        yield
    finally:
        transport.active = False
        transport.cookie = ""
        transport.proof = None
        _CURRENT_HUMAN.reset(reset)
