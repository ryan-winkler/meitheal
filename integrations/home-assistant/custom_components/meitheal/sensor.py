"""Meitheal Home Assistant integration — sensor entities."""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import MeithealCoordinator
from .helpers import PARALLEL_UPDATES as PARALLEL_UPDATES, device_info

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
    CoordinatorEntity[MeithealCoordinator], SensorEntity
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
        if not self.coordinator.data:
            return None
        return self.coordinator.data.active_count

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Expose active task details for AI agents and automations."""
        if not self.coordinator.data:
            return None
        active = [t for t in self.coordinator.data.tasks if t.status != "done"]
        # Priority breakdown for automations
        priorities: dict[str, int] = {}
        for t in active:
            key = f"p{t.priority}"
            priorities[key] = priorities.get(key, 0) + 1
        return {
            "task_titles": [t.title for t in active[:10]],
            "priority_breakdown": priorities,
            "has_urgent": any(t.priority <= 2 for t in active),
            "with_due_date": sum(1 for t in active if t.due_date),
        }


class MeithealOverdueTasksSensor(
    CoordinatorEntity[MeithealCoordinator], SensorEntity
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
        if not self.coordinator.data:
            return None
        return self.coordinator.data.overdue_count

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Expose overdue task details for AI agents and automations."""
        if not self.coordinator.data:
            return None
        overdue = [t for t in self.coordinator.data.tasks if t.is_overdue]
        return {
            "task_titles": [t.title for t in overdue[:10]],
            "due_dates": [t.due_date for t in overdue[:10] if t.due_date],
            "oldest_due": min((t.due_date for t in overdue if t.due_date), default=None),
        }


class MeithealTotalTasksSensor(
    CoordinatorEntity[MeithealCoordinator], SensorEntity
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
        if not self.coordinator.data:
            return None
        return self.coordinator.data.total_count

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Expose task summary for AI agents and automations."""
        if not self.coordinator.data:
            return None
        tasks = self.coordinator.data.tasks
        statuses: dict[str, int] = {}
        all_labels: dict[str, int] = {}
        for t in tasks:
            statuses[t.status] = statuses.get(t.status, 0) + 1
            for label in t.labels:
                all_labels[label] = all_labels.get(label, 0) + 1
        return {
            "status_breakdown": statuses,
            "label_summary": dict(sorted(all_labels.items(), key=lambda x: -x[1])[:10]),
            "done_count": statuses.get("done", 0),
            "in_progress_count": statuses.get("in_progress", 0),
        }


class MeithealDueTodaySensor(
    CoordinatorEntity[MeithealCoordinator], SensorEntity
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
        if not self.coordinator.data:
            return None
        return self.coordinator.data.due_today_count

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Expose today's task details."""
        if not self.coordinator.data:
            return None
        from datetime import datetime as dt
        today = dt.now().strftime("%Y-%m-%d")
        due = [
            t for t in self.coordinator.data.tasks
            if t.due_date and t.due_date.startswith(today) and t.status != "done"
        ]
        return {
            "task_titles": [t.title for t in due[:10]],
            "priorities": [t.priority for t in due[:10]],
        }


class MeithealCompletedTodaySensor(
    CoordinatorEntity[MeithealCoordinator], SensorEntity
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
        if not self.coordinator.data:
            return None
        # Count done tasks — coordinator refreshes every 30s
        return sum(1 for t in self.coordinator.data.tasks if t.status == "done")


class MeithealStreakSensor(
    CoordinatorEntity[MeithealCoordinator], SensorEntity
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
        if not self.coordinator.data:
            return None
        return self.coordinator.data.streak

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Expose gamification details."""
        if not self.coordinator.data:
            return None
        return {
            "total_points": self.coordinator.data.total_points,
        }

