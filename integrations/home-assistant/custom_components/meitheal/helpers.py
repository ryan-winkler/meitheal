"""Meitheal Home Assistant integration — shared helpers.

Common patterns extracted per IQS rule `common-modules`.
"""

from __future__ import annotations

import re

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers.device_registry import DeviceEntryType
from homeassistant.helpers.entity import DeviceInfo

from .const import DOMAIN

# IQS rule: parallel-updates — serialise platform updates to avoid
# concurrent REST calls to the single-threaded Meitheal addon.
PARALLEL_UPDATES = 1


def device_info(entry: ConfigEntry) -> DeviceInfo:
    """Return shared device info for all Meitheal entities.

    Identifier MUST match the device registered in __init__.py
    (DOMAIN, "meitheal_hub") so entities group under the same device.
    """
    return DeviceInfo(
        identifiers={(DOMAIN, "meitheal_hub")},
        name="Meitheal",
        manufacturer="Coolock Village",
        model="Task Engine",
        entry_type=DeviceEntryType.SERVICE,
        configuration_url="https://github.com/ryan-winkler/meitheal",
    )


# Meitheal names an assignee "ha_<Home Assistant user ID>" for a person with a
# Home Assistant account, or "custom_<id>" for a custom user or an AI agent.
ASSIGNEE_ID = re.compile(r"^(?:ha|custom)_[A-Za-z0-9_-]{1,128}$")


def assignee_for_user(user_id: str) -> str:
    """Return the Meitheal assignee ID of a Home Assistant user."""
    return f"ha_{user_id}"


def resolve_assignee(
    hass: HomeAssistant, person: str | None, assignee_id: str | None
) -> str | None:
    """Turn the create_task assignee fields into a Meitheal assignee ID.

    Returns None when neither field is set, so Meitheal applies the
    household's default assignee.
    """
    if assignee_id is not None:
        if not ASSIGNEE_ID.fullmatch(assignee_id):
            raise ServiceValidationError(
                translation_domain=DOMAIN, translation_key="invalid_assignee_id"
            )
        return assignee_id
    if person is None:
        return None
    state = hass.states.get(person)
    user_id = state.attributes.get("user_id") if state else None
    if not isinstance(user_id, str) or not user_id:
        # A person without a Home Assistant account has no Meitheal assignee.
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="person_without_user",
            translation_placeholders={"person": person},
        )
    return assignee_for_user(user_id)
