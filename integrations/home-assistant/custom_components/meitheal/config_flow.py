"""Meitheal Home Assistant integration configuration."""

from collections.abc import Mapping
from http import HTTPStatus
from typing import Any

from aiohttp import DummyCookieJar
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.const import CONF_HOST, CONF_PORT, CONF_SSL
from homeassistant.helpers.aiohttp_client import async_create_clientsession
from homeassistant.helpers.selector import (
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)
from homeassistant.helpers.service_info.hassio import HassioServiceInfo
import voluptuous as vol

from .api import (
    MeithealApi,
    MeithealConnectionError,
    MeithealResponseError,
    async_validate_transport,
    connection_origin,
)
from .const import CONF_API_TOKEN, DEFAULT_HOST, DEFAULT_PORT, DOMAIN

_TOKEN_SELECTOR = TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD))
_TOKEN_FORM = vol.Schema({vol.Required(CONF_API_TOKEN): _TOKEN_SELECTOR})


class MeithealConfigFlow(ConfigFlow, domain=DOMAIN):
    """Configure a single Meitheal connection."""

    VERSION = 1

    async def async_step_hassio(
        self, discovery_info: HassioServiceInfo
    ) -> ConfigFlowResult:
        """Offer setup after Supervisor discovers the App."""
        self._discovered = {
            CONF_HOST: discovery_info.config.get(CONF_HOST, DEFAULT_HOST),
            CONF_PORT: discovery_info.config.get(CONF_PORT, DEFAULT_PORT),
            CONF_SSL: False,
        }
        try:
            origin = connection_origin(self._discovered)
        except ValueError:
            return self.async_abort(reason="cannot_connect")
        self._discovered[CONF_HOST] = origin.raw_host
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        return await self.async_step_hassio_confirm()

    async def async_step_hassio_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Validate a token for the discovered App before saving it."""
        errors = {}
        if user_input is not None:
            data = {**self._discovered, CONF_API_TOKEN: user_input[CONF_API_TOKEN]}
            if error := await self._async_test_connection(data):
                errors["base"] = error
            else:
                return self.async_create_entry(title="Meitheal", data=data)
        return self.async_show_form(
            step_id="hassio_confirm",
            data_schema=_TOKEN_FORM,
            description_placeholders={
                "host": self._discovered[CONF_HOST],
                "port": str(self._discovered[CONF_PORT]),
            },
            errors=errors,
        )

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Connect manually to a Meitheal server."""
        errors = {}
        if user_input is not None:
            if error := await self._async_test_connection(user_input):
                errors["base"] = error
            else:
                await self.async_set_unique_id(DOMAIN)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(title="Meitheal", data=user_input)
        return self.async_show_form(
            step_id="user",
            data_schema=_connection_form(require_token=True),
            errors=errors,
        )

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Change connection settings or add a token to the same entry."""
        entry = self._get_reconfigure_entry()
        errors = {}
        if user_input is not None:
            previous_data = entry.data
            candidate = dict(user_input)
            if not candidate.get(CONF_API_TOKEN):
                candidate.pop(CONF_API_TOKEN, None)
                if previous_token := previous_data.get(CONF_API_TOKEN):
                    try:
                        same_origin = connection_origin(candidate) == connection_origin(previous_data)
                    except ValueError:
                        same_origin = False
                    if not same_origin:
                        errors["base"] = "token_required_for_origin"
                    else:
                        candidate[CONF_API_TOKEN] = previous_token
            if not errors:
                if error := await self._async_test_connection(candidate, require_token=False):
                    errors["base"] = error
                elif entry.data is not previous_data:
                    return self.async_abort(reason="configuration_changed")
                else:
                    return self.async_update_reload_and_abort(entry, data_updates=candidate)

        return self.async_show_form(
            step_id="reconfigure",
            data_schema=self.add_suggested_values_to_schema(
                _connection_form(require_token=False),
                {
                    CONF_HOST: entry.data.get(CONF_HOST, DEFAULT_HOST),
                    CONF_PORT: entry.data.get(CONF_PORT, DEFAULT_PORT),
                    CONF_SSL: entry.data.get(CONF_SSL, False),
                },
            ),
            errors=errors,
        )

    async def async_step_reauth(
        self, entry_data: Mapping[str, Any]
    ) -> ConfigFlowResult:
        """Start credential recovery after an API rejection."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Validate a replacement token against the existing origin."""
        entry = self._get_reauth_entry()
        errors = {}
        if user_input is not None:
            previous_data = entry.data
            data = {**previous_data, CONF_API_TOKEN: user_input[CONF_API_TOKEN]}
            if error := await self._async_test_connection(data):
                errors["base"] = error
            elif entry.data is not previous_data:
                return self.async_abort(reason="configuration_changed")
            else:
                return self.async_update_reload_and_abort(
                    entry, data_updates={CONF_API_TOKEN: data[CONF_API_TOKEN]}
                )
        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=_TOKEN_FORM,
            errors=errors,
        )

    async def _async_test_connection(
        self, data: dict[str, Any], *, require_token: bool = True
    ) -> str | None:
        """Validate the exact origin and test protected task access."""
        token = data.get(CONF_API_TOKEN, "").strip()
        if require_token and not token:
            return "invalid_auth"
        try:
            origin = connection_origin(data)
        except ValueError:
            return "invalid_host"
        try:
            await async_validate_transport(self.hass, origin, token)
        except ValueError:
            return "invalid_auth"
        except MeithealConnectionError:
            return "insecure_connection"

        session = async_create_clientsession(
            self.hass, auto_cleanup=False, cookie_jar=DummyCookieJar()
        )
        try:
            response = await MeithealApi(session, origin, token).async_request(
                "GET", "/api/tasks", params={"limit": "1"}, read_json=True
            )
        except MeithealResponseError as err:
            if err.status in (HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN):
                return "invalid_auth"
            return "cannot_connect"
        except MeithealConnectionError:
            return "cannot_connect"
        finally:
            session.detach()

        if not isinstance(response, list) and not (
            isinstance(response, dict) and isinstance(response.get("tasks"), list)
        ):
            return "cannot_connect"
        data[CONF_HOST] = origin.raw_host
        if token:
            data[CONF_API_TOKEN] = token
        return None


def _connection_form(*, require_token: bool) -> vol.Schema:
    """Build a connection form with a masked, never prefilled token."""
    if require_token:
        return vol.Schema({
            vol.Required(CONF_HOST): str,
            vol.Required(CONF_PORT, default=443): int,
            vol.Required(CONF_SSL, default=True): bool,
            vol.Required(CONF_API_TOKEN): _TOKEN_SELECTOR,
        })
    return vol.Schema({
        vol.Required(CONF_HOST): str,
        vol.Required(CONF_PORT): int,
        vol.Required(CONF_SSL): bool,
        vol.Optional(CONF_API_TOKEN): _TOKEN_SELECTOR,
    })
