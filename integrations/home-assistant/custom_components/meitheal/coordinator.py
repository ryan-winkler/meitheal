"""Meitheal Home Assistant integration — DataUpdateCoordinator."""

from __future__ import annotations

import logging
from datetime import datetime
from http import HTTPStatus
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import MeithealApi, MeithealConnectionError, MeithealResponseError, task_path
from .const import DOMAIN, SCAN_INTERVAL, STATUS_DONE, STATUS_IN_PROGRESS, STATUS_TODO
from .repairs import async_create_addon_unreachable_issue, async_delete_addon_unreachable_issue

_LOGGER = logging.getLogger(__name__)

# Home Assistant's service and agent contracts use the legacy aliases.
_TASK_STATUS_ALIASES = {
    "pending": STATUS_TODO,
    "active": STATUS_IN_PROGRESS,
    "complete": STATUS_DONE,
}


class MeithealTask:
    """Representation of a Meitheal task."""

    def __init__(self, data: dict[str, Any]) -> None:
        self.id: str = str(data.get("id", ""))
        self.title: str = data.get("title", "")
        status = data.get("status", STATUS_TODO)
        self.status: str = _TASK_STATUS_ALIASES.get(status, status)
        self.description: str | None = data.get("description")
        self.priority: int = data.get("priority", 3)
        self.due_date: str | None = data.get("due_date") or data.get("dueDate")
        self.labels: list[str] = data.get("labels", [])
        self.position: int = data.get("position", 0)
        self.created_at: str | None = data.get("created_at") or data.get("createdAt")
        self.updated_at: str | None = data.get("updated_at") or data.get("updatedAt")

    @property
    def is_overdue(self) -> bool:
        """Check if task is overdue."""
        if not self.due_date or self.status == "done":
            return False
        try:
            due = datetime.fromisoformat(self.due_date.replace("Z", "+00:00"))
            return due < datetime.now(due.tzinfo)
        except (ValueError, TypeError):
            return False


class MeithealCoordinatorData:
    """Structured data from coordinator update."""

    def __init__(self, tasks: list[MeithealTask]) -> None:
        self.tasks = tasks
        self.active_count = sum(1 for t in tasks if t.status != "done")
        self.overdue_count = sum(1 for t in tasks if t.is_overdue)
        self.total_count = len(tasks)
        # Phase 8: additional computed stats
        today_str = datetime.now().strftime("%Y-%m-%d")
        self.due_today_count = sum(
            1 for t in tasks
            if t.due_date and t.due_date.startswith(today_str) and t.status != "done"
        )
        # Streak and XP — populated by coordinator from gamification API
        self.streak: int = 0
        self.total_points: int = 0


class MeithealCoordinator(DataUpdateCoordinator[MeithealCoordinatorData]):
    """Coordinator to poll Meitheal addon REST API for tasks."""

    def __init__(self, hass: HomeAssistant, api: MeithealApi) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=SCAN_INTERVAL,
        )
        self.api = api
        self._previous_data: MeithealCoordinatorData | None = None
        # IQS rule: log-when-unavailable — log once on state transitions
        self._was_available: bool = True

    # ── Event Bus Helpers ─────────────────────────────────────────────

    def _fire_event(self, event_type: str, data: dict[str, Any]) -> None:
        """Fire a Meitheal event on the HA event bus.

        Source is 'component' to distinguish from addon-fired events
        (which use source='meitheal'). This prevents circular re-fires.
        """
        self.hass.bus.async_fire(
            event_type,
            {**data, "source": "component", "domain": DOMAIN},
        )

    def _fire_logbook(self, name: str, message: str, entity_id: str | None = None) -> None:
        """Fire a logbook entry so Meitheal actions appear in HA history."""
        logbook_data: dict[str, Any] = {
            "name": name,
            "message": message,
            "domain": DOMAIN,
        }
        if entity_id:
            logbook_data["entity_id"] = entity_id
        self.hass.bus.async_fire("logbook_entry", logbook_data)

    async def _async_update_data(self) -> MeithealCoordinatorData:
        """Fetch tasks from Meitheal REST API."""
        try:
            data = await self.api.async_request("GET", "/api/tasks", read_json=True)
        except MeithealResponseError as err:
            if err.status in (HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN):
                raise ConfigEntryAuthFailed("Meitheal rejected task access") from None
            raise UpdateFailed(str(err)) from None
        except MeithealConnectionError as err:
            if self._was_available:
                _LOGGER.warning("Cannot reach Meitheal at %s", self.api.origin)
                self._was_available = False
                if self.config_entry:
                    async_create_addon_unreachable_issue(
                        self.hass, self.config_entry, str(err)
                    )
            raise UpdateFailed(str(err)) from None

        raw_tasks = data if isinstance(data, list) else (
            data.get("tasks") if isinstance(data, dict) else None
        )
        if not isinstance(raw_tasks, list):
            raise UpdateFailed("Meitheal returned an invalid task list")
        new_data = MeithealCoordinatorData([MeithealTask(task) for task in raw_tasks])

        if not self._was_available:
            _LOGGER.info("Meitheal is available again at %s", self.api.origin)
            self._was_available = True
            async_delete_addon_unreachable_issue(self.hass)

        if (prev := self._previous_data) is not None and (
            prev.total_count != new_data.total_count
            or prev.overdue_count != new_data.overdue_count
            or prev.active_count != new_data.active_count
        ):
            self._fire_event("meitheal_board_updated", {
                "total": new_data.total_count,
                "active": new_data.active_count,
                "overdue": new_data.overdue_count,
                "previous_total": prev.total_count,
            })
        self._previous_data = new_data
        return new_data

    async def async_create_task(
        self, title: str, description: str | None = None
    ) -> None:
        """Create a task via Meitheal REST API."""
        payload: dict[str, Any] = {"title": title}
        if description:
            payload["frameworkPayload"] = {"description": description}
        await self.api.async_request("POST", "/api/tasks/create", payload=payload)

        self._fire_event("meitheal_task_created", {"title": title})
        self._fire_logbook("Meitheal", f"created task: {title}")
        await self.async_request_refresh()

    async def async_complete_task(
        self, task_id: str | None = None, title: str | None = None
    ) -> None:
        """Mark a task as done."""
        # Find task by ID or title
        resolved_title = title
        if not task_id and title and self.data:
            for task in self.data.tasks:
                if task.title.lower() == title.lower():
                    task_id = task.id
                    resolved_title = task.title
                    break
        if not task_id:
            raise UpdateFailed("Task not found")

        await self.api.async_request(
            "PUT", task_path(task_id), payload={"status": "done"}
        )

        label = resolved_title or task_id
        self._fire_event("meitheal_task_completed", {
            "task_id": task_id, "title": label,
        })
        self._fire_logbook("Meitheal", f"completed task: {label}")
        await self.async_request_refresh()

    async def async_complete_task_by_tag(
        self, tag_id: str
    ) -> dict[str, Any]:
        """Complete a task by NFC tag ID."""
        result = await self.api.async_request(
            "POST", "/api/nfc/complete", payload={"tag_id": tag_id}, read_json=True
        )

        task_id = result.get("task_id", "unknown")
        self._fire_event("meitheal_task_completed", {
            "task_id": task_id, "trigger": "nfc", "tag_id": tag_id,
        })
        self._fire_logbook("Meitheal", f"completed task via NFC tag: {tag_id}")
        await self.async_request_refresh()
        return result

    async def async_search_tasks(
        self,
        query: str = "",
        status: str | None = None,
        priority: int | None = None,
        include_completed: bool = False,
    ) -> dict[str, Any]:
        """Search tasks using Meitheal's universal search contract."""
        params: dict[str, str] = {
            "scope": "tasks",
            "limit": "20",
        }
        if query:
            params["q"] = query
        if status:
            params["status"] = status
        if priority is not None:
            params["priority"] = str(priority)
        if include_completed:
            params["include_completed"] = "1"

        payload = await self.api.async_request(
            "GET", "/api/search", params=params, read_json=True
        )

        task_section = next(
            (
                section
                for section in payload.get("sections", [])
                if section.get("id") == "tasks"
            ),
            {"items": []},
        )
        tasks = []
        for item in task_section.get("items", []):
            meta = item.get("meta", {}) or {}
            tasks.append(
                {
                    "id": item.get("taskId") or item.get("id"),
                    "title": item.get("title", ""),
                    "status": meta.get("status") or "",
                    "priority": meta.get("priority") or 3,
                    "description": item.get("description", ""),
                    "matched_fields": meta.get("matched_fields", []),
                }
            )

        return {"tasks": tasks, "count": len(tasks)}

    async def async_delete_task(self, task_id: str) -> None:
        """Delete a task."""
        # Try to resolve title before deletion for logbook
        task_title = task_id
        if self.data:
            for task in self.data.tasks:
                if task.id == task_id:
                    task_title = task.title
                    break

        await self.api.async_request("DELETE", task_path(task_id))

        self._fire_event("meitheal_task_deleted", {
            "task_id": task_id, "title": task_title,
        })
        self._fire_logbook("Meitheal", f"deleted task: {task_title}")
        await self.async_request_refresh()

    async def async_update_task(self, task_id: str, updates: dict[str, Any]) -> None:
        """Update task fields."""
        await self.api.async_request("PUT", task_path(task_id), payload=updates)

        # Resolve title for logbook
        task_title = task_id
        if self.data:
            for task in self.data.tasks:
                if task.id == task_id:
                    task_title = task.title
                    break

        changed_fields = ", ".join(updates.keys())
        self._fire_event("meitheal_task_updated", {
            "task_id": task_id, "title": task_title,
            "fields": changed_fields,
        })
        self._fire_logbook("Meitheal", f"updated task: {task_title} ({changed_fields})")
        await self.async_request_refresh()

    async def async_check_health(self) -> bool:
        """Check if Meitheal addon is reachable."""
        try:
            await self.api.async_request("GET", "/api/health")
        except (MeithealConnectionError, MeithealResponseError):
            return False
        return True

    async def async_link_task(
        self, source_task_id: str, target_task_id: str, link_type: str
    ) -> dict[str, Any]:
        """Create a Jira-style link between two tasks."""
        result = await self.api.async_request(
            "POST",
            f"{task_path(source_task_id)}/links",
            payload={"target_task_id": target_task_id, "link_type": link_type},
            read_json=True,
        )
        _LOGGER.info(
            "Linked tasks: %s --%s--> %s",
            source_task_id, link_type, target_task_id,
        )
        return result

    async def async_unlink_task(
        self, task_id: str, link_id: str
    ) -> dict[str, Any]:
        """Remove a link between two tasks."""
        result = await self.api.async_request(
            "DELETE", f"{task_path(task_id)}/links",
            params={"link_id": link_id}, read_json=True,
        )
        _LOGGER.info("Unlinked: link=%s from task=%s", link_id, task_id)
        return result

    async def async_get_task_links(self, task_id: str) -> dict[str, Any]:
        """Get all outbound and inbound links for a task."""
        return await self.api.async_request(
            "GET", f"{task_path(task_id)}/links", read_json=True
        )

    async def async_shutdown(self) -> None:
        """Clean up coordinator state.

        Home Assistant releases the HTTP session when the entry unloads.
        """
        await super().async_shutdown()
        self._previous_data = None
