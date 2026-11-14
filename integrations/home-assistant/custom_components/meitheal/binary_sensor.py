"""Meitheal Home Assistant integration — binary sensor entities."""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .coordinator import MeithealCoordinator
from .helpers import PARALLEL_UPDATES as _PARALLEL_UPDATES, device_info

PARALLEL_UPDATES = _PARALLEL_UPDATES

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up Meitheal binary sensor entities from config entry."""
    coordinator: MeithealCoordinator = entry.runtime_data
    async_add_entities(
        [
            MeithealAllClearSensor(coordinator, entry),
        ],
        True,
    )


class MeithealAllClearSensor(
    CoordinatorEntity[MeithealCoordinator], BinarySensorEntity
):
    """Binary sensor: True when zero overdue tasks (all-clear state).

    KCS: When is_on is True, the user has no overdue tasks. This enables
    automations like "turn office light green when all-clear" or
    "show notification badge when not all-clear".
    """

    _attr_has_entity_name = True
    _attr_translation_key = "all_clear"
    _attr_device_class = BinarySensorDeviceClass.PROBLEM
    _attr_icon = "mdi:check-decagram"

    def __init__(self, coordinator: MeithealCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_all_clear"
        self._attr_device_info = device_info(entry)

    @property
    def is_on(self) -> bool | None:
        """Return True when there ARE overdue tasks (problem state).

        BinarySensorDeviceClass.PROBLEM semantics:
        - is_on = True means "there is a problem" (overdue tasks exist)
        - is_on = False means "all clear" (no overdue tasks)
        """
        if not self.coordinator.data:
            return None
        return self.coordinator.data.overdue_count > 0

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Expose overdue context for automations."""
        if not self.coordinator.data:
            return None
        return {
            "overdue_count": self.coordinator.data.overdue_count,
            "active_count": self.coordinator.data.active_count,
            "due_today_count": self.coordinator.data.due_today_count,
        }
