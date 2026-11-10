"""Meitheal Home Assistant integration — TodoListEntity."""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.todo import (
    TodoItem,
    TodoItemStatus,
    TodoListEntity,
    TodoListEntityFeature,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import MeithealCoordinator, MeithealTask
from .helpers import PARALLEL_UPDATES as PARALLEL_UPDATES, device_info

_LOGGER = logging.getLogger(__name__)


def _status_to_ha(status: str) -> TodoItemStatus:
    """Map Meitheal status to HA TodoItemStatus."""
    if status == "done":
        return TodoItemStatus.COMPLETED
    return TodoItemStatus.NEEDS_ACTION


def _status_from_ha(status: TodoItemStatus) -> str:
    """Map HA TodoItemStatus to Meitheal status."""
    if status == TodoItemStatus.COMPLETED:
        return "done"
    return "todo"


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up Meitheal todo list from config entry."""
    coordinator: MeithealCoordinator = entry.runtime_data
    async_add_entities([MeithealTodoListEntity(coordinator, entry)], True)


class MeithealTodoListEntity(CoordinatorEntity[MeithealCoordinator], TodoListEntity):
    """Meitheal task list exposed as HA todo entity.

    Exposed to HA Assist/Voice by default so users can manage tasks via
    voice commands (e.g. "add buy groceries to Meitheal tasks").
    The built-in HassListAddItem / HassListCompleteItem intents route
    to this entity when it is exposed.
    """

    _attr_has_entity_name = True
    _attr_translation_key = "task_list"
    _attr_entity_registry_enabled_default = True
    _attr_entity_registry_visible_default = True
    _attr_supported_features = (
        TodoListEntityFeature.CREATE_TODO_ITEM
        | TodoListEntityFeature.DELETE_TODO_ITEM
        | TodoListEntityFeature.UPDATE_TODO_ITEM
        | TodoListEntityFeature.MOVE_TODO_ITEM
        | TodoListEntityFeature.SET_DUE_DATE_ON_ITEM
        | TodoListEntityFeature.SET_DESCRIPTION_ON_ITEM
    )

    def __init__(
        self,
        coordinator: MeithealCoordinator,
        entry: ConfigEntry,
    ) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_todo"
        self._attr_device_info = device_info(entry)
        # Predictable entity ID so voice commands can target "Meitheal tasks"
        self._attr_suggested_object_id = "meitheal_tasks"

    @property
    def todo_items(self) -> list[TodoItem] | None:
        """Return todo items from coordinator data."""
        if not self.coordinator.data:
            return None
        return [self._task_to_item(t) for t in self.coordinator.data.tasks]

    @staticmethod
    def _task_to_item(task: MeithealTask) -> TodoItem:
        """Convert MeithealTask to HA TodoItem."""
        return TodoItem(
            uid=task.id,
            summary=task.title,
            status=_status_to_ha(task.status),
            due=task.due_date,
            description=task.description,
        )

    async def async_create_todo_item(self, item: TodoItem) -> None:
        """Create a new task in Meitheal."""
        await self.coordinator.async_create_task(
            title=item.summary or "Untitled",
            description=item.description,
        )

    async def async_update_todo_item(self, item: TodoItem) -> None:
        """Update an existing task."""
        if not item.uid:
            return
        updates: dict[str, Any] = {}
        if item.summary is not None:
            updates["title"] = item.summary
        if item.status is not None:
            updates["status"] = _status_from_ha(item.status)
        if item.description is not None:
            updates["description"] = item.description
        if item.due is not None:
            updates["due_date"] = str(item.due)
        if updates:
            await self.coordinator.async_update_task(item.uid, updates)

    async def async_delete_todo_items(self, uids: list[str]) -> None:
        """Delete tasks by UID."""
        for uid in uids:
            await self.coordinator.async_delete_task(uid)

    async def async_move_todo_item(
        self, uid: str, previous_uid: str | None = None
    ) -> None:
        """Reorder a task in the list."""
        # Calculate new position based on previous_uid
        if not self.coordinator.data:
            return
        tasks = self.coordinator.data.tasks
        target_pos = 0
        if previous_uid:
            for i, t in enumerate(tasks):
                if t.id == previous_uid:
                    target_pos = i + 1
                    break
        await self.coordinator.async_update_task(uid, {"position": target_pos})
