"""Meitheal Home Assistant integration — config flow."""

from __future__ import annotations

import logging
from typing import Any

import aiohttp
import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.helpers.service_info.hassio import HassioServiceInfo

from .const import DEFAULT_HOST, DEFAULT_PORT, DOMAIN, HOSTNAME_CANDIDATES

_LOGGER = logging.getLogger(__name__)


def _hyphenate(hostname: str) -> str:
    """Convert underscores to hyphens for Docker DNS resolution.

    Supervisor names addon containers as {REPO}_{SLUG} (with underscores),
    but the internal Docker DNS only resolves hyphenated hostnames.
    """
    return hostname.replace("_", "-")


class MeithealConfigFlow(ConfigFlow, domain=DOMAIN):
    """Config flow for Meitheal integration."""

    VERSION = 1

    def __init__(self) -> None:
        """Initialise flow state."""
        self._discovered_host: str = DEFAULT_HOST
        self._discovered_port: int = DEFAULT_PORT

    # ── Supervisor addon discovery (zero-touch) ──────────────────────────

    async def async_step_hassio(
        self, discovery_info: HassioServiceInfo | dict[str, Any]
    ) -> ConfigFlowResult:
        """Handle Supervisor addon discovery.

        Triggered automatically when the addon calls POST /discovery
        on the Supervisor API at boot. The discovery payload includes
        the dynamically-discovered addon hostname from /addons/self/info.

        IMPORTANT: We intentionally do NOT test the connection here.
        The addon may still be starting up when HA Core processes the
        discovery message. We always show the "Discovered" card and
        defer the connection test to async_step_hassio_confirm (when
        the user clicks Submit) and async_setup_entry.
        """
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        payload = (
            discovery_info.config
            if hasattr(discovery_info, "config")
            else (discovery_info if isinstance(discovery_info, dict) else {})
        )
        host = payload.get(CONF_HOST, DEFAULT_HOST)
        port = int(payload.get(CONF_PORT, DEFAULT_PORT))

        # Normalize hostname — Supervisor uses underscores, DNS uses hyphens
        self._discovered_host = _hyphenate(host)
        self._discovered_port = port

        _LOGGER.info(
            "Meitheal addon discovered via Supervisor: %s:%s",
            self._discovered_host,
            self._discovered_port,
        )

        return self.async_show_form(
            step_id="hassio_confirm",
            description_placeholders={
                "addon": "Meitheal",
                "host": self._discovered_host,
                "port": str(self._discovered_port),
            },
        )

    async def async_step_hassio_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Confirm Supervisor addon discovery.

        When the user clicks Submit, we test the connection. If it fails,
        we try fallback hostnames. If all fail, we still allow setup
        (the coordinator will retry on its polling interval).
        """
        errors: dict[str, str] = {}

        if user_input is not None:
            host = self._discovered_host
            port = self._discovered_port

            # Test with the discovered host first
            if not await self._test_connection(host, port):
                _LOGGER.warning(
                    "Cannot connect to Meitheal at %s:%s — trying fallback hostnames",
                    host,
                    port,
                )
                working_host = await self._find_working_host(port)
                if working_host:
                    host = working_host
                    _LOGGER.info(
                        "Connected to Meitheal via fallback hostname: %s:%s",
                        working_host,
                        port,
                    )
                else:
                    # Allow setup anyway — coordinator will retry
                    _LOGGER.warning(
                        "Cannot reach Meitheal at any hostname — "
                        "proceeding with discovered host %s:%s "
                        "(coordinator will retry on polling interval)",
                        host,
                        port,
                    )

            return self.async_create_entry(
                title="Meitheal",
                data={
                    CONF_HOST: host,
                    CONF_PORT: port,
                },
            )

        return self.async_show_form(
            step_id="hassio_confirm",
            description_placeholders={
                "addon": "Meitheal",
                "host": self._discovered_host,
                "port": str(self._discovered_port),
            },
            errors=errors,
        )

    # ── Manual user setup (fallback) ─────────────────────────────────────

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle manual user setup step."""
        errors: dict[str, str] = {}

        if user_input is not None:
            host = user_input[CONF_HOST]
            port = user_input[CONF_PORT]

            # Normalize hostname
            host = _hyphenate(host)

            # Validate connection — try exact host first, then fallbacks
            if await self._test_connection(host, port):
                await self.async_set_unique_id(DOMAIN)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title="Meitheal",
                    data={CONF_HOST: host, CONF_PORT: port},
                )

            # If the user-provided host fails, try auto-discovery
            working_host = await self._find_working_host(port)
            if working_host:
                await self.async_set_unique_id(DOMAIN)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title="Meitheal",
                    data={CONF_HOST: working_host, CONF_PORT: port},
                )

            errors["base"] = "cannot_connect"

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_HOST, default=DEFAULT_HOST): str,
                    vol.Required(CONF_PORT, default=DEFAULT_PORT): int,
                }
            ),
            errors=errors,
        )

    # ── Reconfiguration flow (IQS Gold: reconfiguration-flow) ─────────

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle reconfiguration of the integration.

        Allows users to update host/port from Settings → Integrations →
        Meitheal → Configure without removing and re-adding the entry.
        """
        errors: dict[str, str] = {}
        entry = self.hass.config_entries.async_get_entry(self.context["entry_id"])
        assert entry is not None

        if user_input is not None:
            host = _hyphenate(user_input[CONF_HOST])
            port = user_input[CONF_PORT]

            if await self._test_connection(host, port):
                return self.async_update_reload_and_abort(
                    entry,
                    data={CONF_HOST: host, CONF_PORT: port},
                )
            errors["base"] = "cannot_connect"

        return self.async_show_form(
            step_id="reconfigure",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_HOST,
                        default=entry.data.get(CONF_HOST, DEFAULT_HOST),
                    ): str,
                    vol.Required(
                        CONF_PORT,
                        default=entry.data.get(CONF_PORT, DEFAULT_PORT),
                    ): int,
                }
            ),
            errors=errors,
        )

    # ── Connection test ──────────────────────────────────────────────────

    @staticmethod
    async def _test_connection(host: str, port: int) -> bool:
        """Test connection to Meitheal addon at a specific host."""
        try:
            timeout = aiohttp.ClientTimeout(total=5)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                url = f"http://{host}:{port}/api/health"
                try:
                    async with session.get(url) as response:
                        if response.status == 200:
                            return True
                except (aiohttp.ClientError, TimeoutError):
                    _LOGGER.debug(
                        "Cannot connect to Meitheal at %s:%s",
                        host,
                        port,
                    )
        except (aiohttp.ClientError, TimeoutError):
            _LOGGER.debug("Cannot connect to Meitheal at %s:%s", host, port)
        return False

    @staticmethod
    async def _find_working_host(port: int) -> str | None:
        """Try multiple hostname candidates to find a working one.

        Supervisor names addon containers as {REPO}_{SLUG}. The REPO prefix
        is 'local' for locally-installed addons, or a hash of the GitHub
        repo URL for GitHub-installed addons. DNS requires hyphens instead
        of underscores.

        We try several common patterns to find the right one.
        """
        timeout = aiohttp.ClientTimeout(total=3)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            for candidate in HOSTNAME_CANDIDATES:
                url = f"http://{candidate}:{port}/api/health"
                try:
                    async with session.get(url) as response:
                        if response.status == 200:
                            _LOGGER.info(
                                "Found Meitheal at fallback hostname: %s",
                                candidate,
                            )
                            return candidate
                except (aiohttp.ClientError, TimeoutError):
                    continue
        return None
