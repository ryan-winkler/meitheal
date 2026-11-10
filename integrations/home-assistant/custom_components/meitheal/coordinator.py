"""Meitheal Home Assistant integration — DataUpdateCoordinator."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
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


def _timestamp(value: Any) -> str | None:
    """Normalize SQLite millisecond timestamps for calendar/voice consumers."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            return datetime.fromtimestamp(value / 1000, UTC).isoformat()
        except (ValueError, OverflowError, OSError):
            return None
    return value if isinstance(value, str) else None


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
        labels = data.get("labels", [])
        if isinstance(labels, str):
            try:
                labels = json.loads(labels)
            except (ValueError, TypeError):
                labels = []
        self.labels: list[str] = (
            [label for label in labels if isinstance(label, str)]
            if isinstance(labels, list) else []
        )
        self.position: int | None = data.get("kanban_position", data.get("position"))
        self.calendar_sync_state: str | None = data.get("calendar_sync_state")
        self.urgency: int = data.get("urgency", 0)
        self.importance: int = data.get("importance", 0)
        self.eisenhower_quadrant: str | None = data.get("eisenhower_quadrant")
        self.created_at = _timestamp(data.get("created_at") or data.get("createdAt"))
        self.updated_at = _timestamp(data.get("updated_at") or data.get("updatedAt"))

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
        self.streak: int | None = None
        self.total_points: int | None = None
        self.completed_today: int | None = None
        self.gamification_error: str | None = None


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

    async def _async_fetch_tasks(self) -> list[MeithealTask]:
        """Read the complete board or fail without publishing partial counts."""
        tasks: list[MeithealTask] = []
        seen: set[str] = set()
        offset = 0
        expected_total: int | None = None
        while True:
            data = await self.api.async_request("GET", "/api/tasks", params={
                "limit": "100", "offset": str(offset),
                "sort": "kanban_position", "order": "asc",
            }, read_json=True)
            raw = data if isinstance(data, list) else data.get("tasks") if isinstance(data, dict) else None
            if not isinstance(raw, list):
                raise UpdateFailed("Meitheal returned an invalid task list")
            total = data.get("total") if isinstance(data, dict) else None
            if isinstance(data, dict):
                if "total" in data and (type(total) is not int or total < 0):
                    raise UpdateFailed("Meitheal returned an invalid task total")
                if "offset" in data and (type(data["offset"]) is not int or data["offset"] != offset):
                    raise UpdateFailed("Meitheal returned an unexpected task page")
                if "limit" in data and (type(data["limit"]) is not int or not 0 < data["limit"] <= 100):
                    raise UpdateFailed("Meitheal returned an invalid task page limit")
                if total is None and ("offset" in data or "limit" in data):
                    raise UpdateFailed("Meitheal task page is missing its total")
                if total is not None and len(raw) > data.get("limit", 100):
                    raise UpdateFailed("Meitheal returned an oversized task page")
            if expected_total is not None and total != expected_total:
                raise UpdateFailed("Task pagination changed during refresh; retry required")
            for item in raw:
                if (not isinstance(item, dict) or not isinstance(item.get("id"), str)
                    or not item["id"] or not isinstance(item.get("title", ""), str)
                    or not isinstance(item.get("status", STATUS_TODO), str)):
                    raise UpdateFailed("Meitheal returned an invalid task")
                task = MeithealTask(item)
                if task.id in seen:
                    raise UpdateFailed("Task pagination repeated an item; retry required")
                seen.add(task.id)
                tasks.append(task)
            offset += len(raw)
            # Older responses omit pagination metadata and contain the whole list.
            if total is None:
                return tasks
            if offset > total or (not raw and offset < total):
                raise UpdateFailed("Meitheal returned an incomplete task page")
            if offset == total:
                return tasks
            expected_total = total

    async def _async_fetch_gamification(self, data: MeithealCoordinatorData) -> None:
        """Optional or unauthorized statistics remain unknown, not measured zero."""
        try:
            payload = await self.api.async_request("GET", "/api/gamification", read_json=True)
            stats = payload["stats"]
            values = [stats["currentStreak"], stats["totalPoints"], stats["todayCompleted"]]
            if any(type(value) is not int or value < 0 for value in values):
                raise ValueError("Invalid gamification counts")
            data.streak, data.total_points, data.completed_today = values
        except (MeithealConnectionError, MeithealResponseError, KeyError, TypeError, ValueError):
            data.gamification_error = "Statistics unavailable"

    async def _async_update_data(self) -> MeithealCoordinatorData:
        """Fetch tasks from Meitheal REST API."""
        try:
            tasks = await self._async_fetch_tasks()
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

        new_data = MeithealCoordinatorData(tasks)
        await self._async_fetch_gamification(new_data)

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
        self, title: str, description: str | None = None, *,
        priority: int | None = None, due_date: str | None = None,
        urgency: int | None = None, importance: int | None = None,
    ) -> None:
        """Create a task through the authenticated native flat-response API."""
        payload: dict[str, Any] = {"title": title}
        for key, value in {"description": description, "priority": priority,
                           "due_date": due_date, "urgency": urgency, "importance": importance}.items():
            if value is not None:
                payload[key] = value
        result = await self.api.async_request("POST", "/api/tasks", payload=payload, read_json=True)
        if not isinstance(result, dict) or not isinstance(result.get("id"), str) or not result["id"] or result.get("error"):
            raise UpdateFailed("Meitheal did not acknowledge the created task")
        self._fire_event("meitheal_task_created", {"task_id": result["id"], "title": title})
        self._fire_logbook("Meitheal", f"created task: {title}")
        await self.async_request_refresh()

    def resolve_task_title(self, title: str) -> str:
        """Require one exact case-insensitive match before destructive actions."""
        if not self.data:
            raise UpdateFailed("No task data available")
        matches = [task for task in self.data.tasks if task.title.casefold() == title.strip().casefold()]
        if not matches:
            raise UpdateFailed("Task not found; provide a task ID")
        if len(matches) != 1:
            raise UpdateFailed("Multiple tasks have that title; provide a task ID")
        return matches[0].id

    async def async_complete_task(
        self, task_id: str | None = None, title: str | None = None
    ) -> None:
        """Mark a task as done."""
        resolved_title = title
        if not task_id and title:
            task_id = self.resolve_task_title(title)
        if not task_id:
            raise UpdateFailed("Task not found")
        if self.data:
            task = next((task for task in self.data.tasks if task.id == task_id), None)
            if task and task.status == STATUS_DONE:
                # A cached completion may have been reopened or access revoked.
                current = await self.api.async_request("GET", task_path(task_id), read_json=True)
                if (not isinstance(current, dict) or current.get("id") != task_id
                    or not isinstance(current.get("status"), str) or current.get("error")):
                    raise UpdateFailed("Meitheal did not confirm the task status")
                if _TASK_STATUS_ALIASES.get(current["status"], current["status"]) == STATUS_DONE:
                    return
            if task:
                resolved_title = task.title

        result = await self.api.async_request(
            "PUT", task_path(task_id), payload={"status": "done"}, read_json=True
        )
        if (not isinstance(result, dict) or result.get("id") != task_id
            or result.get("status") not in (STATUS_DONE, "complete") or result.get("error")):
            raise UpdateFailed("Meitheal did not acknowledge task completion")

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

        if (not isinstance(result, dict) or result.get("ok") is not True
            or not isinstance(result.get("task_id"), str) or not result["task_id"]
            or ("already_complete" in result and type(result["already_complete"]) is not bool)):
            raise UpdateFailed("Meitheal did not acknowledge NFC completion")
        task_id = result["task_id"]
        if not result.get("already_complete"):
            task = result.get("task")
            if (not isinstance(task, dict) or task.get("id") != task_id
                or task.get("status") not in (STATUS_DONE, "complete")):
                raise UpdateFailed("Meitheal did not confirm NFC task completion")
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
                    "status": _TASK_STATUS_ALIASES.get(meta.get("status"), meta.get("status") or ""),
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

    async def async_reorder_tasks(self, ordered_ids: list[str]) -> None:
        """Persist the full displayed task order through the native API."""
        result = await self.api.async_request("POST", "/api/tasks/reorder",
                                              payload={"ordered_ids": ordered_ids}, read_json=True)
        if not isinstance(result, dict) or result.get("ok") is not True:
            raise UpdateFailed("Meitheal did not acknowledge task ordering")
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
