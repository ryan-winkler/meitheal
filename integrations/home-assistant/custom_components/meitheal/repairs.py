"""Meitheal repairs platform — IQS Gold rule: repair-issues.

Creates repair issues when the Meitheal addon is unreachable,
guiding users to check addon status and network configuration.

@see https://developers.home-assistant.io/docs/core/platform/repairs
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


def async_create_addon_unreachable_issue(
    hass: HomeAssistant,
    entry: ConfigEntry,
    error: str | None = None,
) -> None:
    """Create a repair issue when the Meitheal addon cannot be reached.

    The issue links to the addon page and provides troubleshooting steps.
    """
    ir.async_create_issue(
        hass,
        DOMAIN,
        "addon_unreachable",
        is_fixable=False,
        is_persistent=False,
        severity=ir.IssueSeverity.ERROR,
        translation_key="addon_unreachable",
        translation_placeholders={
            "error": error or "Connection refused",
        },
    )
    _LOGGER.debug("Created repair issue: addon_unreachable")


def async_delete_addon_unreachable_issue(hass: HomeAssistant) -> None:
    """Remove the addon_unreachable issue when connectivity is restored."""
    ir.async_delete_issue(hass, DOMAIN, "addon_unreachable")
    _LOGGER.debug("Cleared repair issue: addon_unreachable")
