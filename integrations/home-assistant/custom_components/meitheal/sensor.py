"""Meitheal Home Assistant integration — sensor entities."""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .coordinator import MeithealBoardEntity, MeithealCoordinator
from .helpers import PARALLEL_UPDATES as _PARALLEL_UPDATES
from .helpers import device_info

PARALLEL_UPDATES = _PARALLEL_UPDATES

_LOGGER = logging.getLogger(__name__)

async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up Meitheal sensor entities from config entry."""
    coordinator: MeithealCoordinator = entry.runtime_data
    async_add_entities(
        [
            MeithealActiveTasksSensor(coordinator, entry),
            MeithealOverdueTasksSensor(coordinator, entry),
            MeithealTotalTasksSensor(coordinator, entry),
            MeithealDueTodaySensor(coordinator, entry),
            MeithealCompletedTodaySensor(coordinator, entry),
            MeithealStreakSensor(coordinator, entry),
        ],
        True,
    )


class MeithealActiveTasksSensor(
    MeithealBoardEntity, SensorEntity
):
    """Sensor: count of active (non-done) tasks."""

    _attr_has_entity_name = True
    _attr_translation_key = "active_tasks"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "tasks"
    _attr_icon = "mdi:checkbox-marked-circle-outline"

    def __init__(self, coordinator: MeithealCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_active_tasks"
        self._attr_device_info = device_info(entry)

    @property
    def native_value(self) -> int | None:
        """Return active task count."""
        if not self.coordinator.data or not self.coordinator.shared_entity_delivery:
            return None
        return self.coordinator.data.active_count

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Expose active task details for AI agents and automations."""
        if not self.coordinator.data or not self.coordinator.shared_entity_delivery:
            return None
        data = self.coordinator.data
        return {
            "task_titles": [t.title for t in data.active_tasks[:10]],
            "priority_breakdown": data.active_priority_breakdown,
            "has_urgent": data.active_has_urgent,
            "with_due_date": data.active_with_due_date,
        }


class MeithealOverdueTasksSensor(
    MeithealBoardEntity, SensorEntity
):
    """Sensor: count of overdue tasks."""

    _attr_has_entity_name = True
    _attr_translation_key = "overdue_tasks"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "tasks"
    _attr_icon = "mdi:clock-alert-outline"

    def __init__(self, coordinator: MeithealCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_overdue_tasks"
        self._attr_device_info = device_info(entry)

    @property
    def native_value(self) -> int | None:
        """Return overdue task count."""
        if not self.coordinator.data or not self.coordinator.shared_entity_delivery:
            return None
        return self.coordinator.data.overdue_count

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Expose overdue task details for AI agents and automations."""
        if not self.coordinator.data or not self.coordinator.shared_entity_delivery:
            return None
        data = self.coordinator.data
        overdue = data.overdue_tasks
        return {
            "task_titles": [t.title for t in overdue[:10]],
            "due_dates": [t.due_date for t in overdue[:10] if t.due_date],
            "oldest_due": data.oldest_overdue_due,
        }


class MeithealTotalTasksSensor(
    MeithealBoardEntity, SensorEntity
):
    """Sensor: total task count."""

    _attr_has_entity_name = True
    _attr_translation_key = "total_tasks"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "tasks"
    _attr_icon = "mdi:format-list-checks"
    _attr_entity_registry_enabled_default = False  # IQS: entity-disabled-by-default

    def __init__(self, coordinator: MeithealCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_total_tasks"
        self._attr_device_info = device_info(entry)

    @property
    def native_value(self) -> int | None:
        """Return total task count."""
        if not self.coordinator.data or not self.coordinator.shared_entity_delivery:
            return None
        return self.coordinator.data.total_count

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Expose task summary for AI agents and automations."""
        if not self.coordinator.data or not self.coordinator.shared_entity_delivery:
            return None
        data = self.coordinator.data
        statuses = data.status_breakdown
        return {
            "status_breakdown": statuses,
            "label_summary": data.label_summary,
            "done_count": statuses.get("done", 0),
            "in_progress_count": statuses.get("in_progress", 0),
        }


class MeithealDueTodaySensor(
    MeithealBoardEntity, SensorEntity
):
    """Sensor: count of tasks due today."""

    _attr_has_entity_name = True
    _attr_translation_key = "due_today"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "tasks"
    _attr_icon = "mdi:calendar-today"

    def __init__(self, coordinator: MeithealCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_due_today"
        self._attr_device_info = device_info(entry)

    @property
    def native_value(self) -> int | None:
        """Return count of tasks due today."""
        if not self.coordinator.data or not self.coordinator.shared_entity_delivery:
            return None
        return self.coordinator.data.due_today_count

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Expose today's task details."""
        if not self.coordinator.data or not self.coordinator.shared_entity_delivery:
            return None
        due = self.coordinator.data.due_today_tasks[:10]
        return {
            "task_titles": [t.title for t in due],
            "priorities": [t.priority for t in due],
        }


class MeithealCompletedTodaySensor(
    MeithealBoardEntity, SensorEntity
):
    """Sensor: count of tasks completed today."""

    _attr_has_entity_name = True
    _attr_translation_key = "completed_today"
    _attr_state_class = SensorStateClass.TOTAL_INCREASING
    _attr_native_unit_of_measurement = "tasks"
    _attr_icon = "mdi:check-circle"

    def __init__(self, coordinator: MeithealCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_completed_today"
        self._attr_device_info = device_info(entry)

    @property
    def native_value(self) -> int | None:
        """Return count of tasks completed today."""
        if not self.coordinator.data or not self.coordinator.shared_entity_delivery:
            return None
        return self.coordinator.data.completed_today

    @property
    def available(self) -> bool:
        """Daily counts require authoritative optional statistics."""
        return super().available and self.coordinator.data.completed_today is not None


class MeithealStreakSensor(
    MeithealBoardEntity, SensorEntity
):
    """Sensor: current streak (consecutive days with task completions)."""

    _attr_has_entity_name = True
    _attr_translation_key = "streak"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "days"
    _attr_icon = "mdi:fire"

    def __init__(self, coordinator: MeithealCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_streak"
        self._attr_device_info = device_info(entry)

    @property
    def native_value(self) -> int | None:
        """Return current streak from gamification data."""
        if not self.coordinator.data or not self.coordinator.shared_entity_delivery:
            return None
        return self.coordinator.data.streak

    @property
    def available(self) -> bool:
        """Failed or disabled statistics are unavailable, not zero."""
        return super().available and self.coordinator.data.streak is not None

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Expose gamification details."""
        if not self.coordinator.data or not self.coordinator.shared_entity_delivery:
            return None
        return {
            "total_points": self.coordinator.data.total_points,
            "gamification_error": self.coordinator.data.gamification_error,
        }

