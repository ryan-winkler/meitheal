"""Meitheal Home Assistant integration — DataUpdateCoordinator."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import DOMAIN, SCAN_INTERVAL
from .repairs import (
    async_create_addon_unreachable_issue,
    async_delete_addon_unreachable_issue,
)

_LOGGER = logging.getLogger(__name__)


def _normalize_status(status: str) -> str:
    """Translate the native API status into the established HA tool vocabulary."""
    return {"pending": "todo", "active": "in_progress", "complete": "done"}.get(status, status)


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
        # Keep the integration's established voice vocabulary at its boundary.
        self.status = _normalize_status(data.get("status") or "pending")
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
            due = datetime.fromisoformat(self.due_date)
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
        # Missing/disabled stats are unknown, never a fabricated measured zero.
        self.streak: int | None = None
        self.total_points: int | None = None
        self.completed_today: int | None = None
        self.gamification_error: str | None = None


class MeithealCoordinator(DataUpdateCoordinator[MeithealCoordinatorData]):
    """Coordinator to poll Meitheal addon REST API for tasks."""

    def __init__(self, hass: HomeAssistant, host: str, port: int) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=SCAN_INTERVAL,
        )
        self._base_url = f"http://{host}:{port}"
        # Use HA's shared aiohttp session — managed by HA lifecycle,
        # handles SSL, and doesn't leak on error paths.
        self._session: aiohttp.ClientSession = async_get_clientsession(hass)
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

    async def _ensure_session(self) -> aiohttp.ClientSession:
        """Return the HA shared aiohttp session."""
        return self._session

    async def _async_request(
        self, method: str, path: str, **kwargs: Any
    ) -> Any:
        """Use the add-on's native network API and reject failed responses."""
        session = await self._ensure_session()
        try:
            async with session.request(
                method,
                f"{self._base_url}{path}",
                headers={
                    "content-type": "application/json",
                    "X-Automation-Source": "ha",
                    "X-Agent-Id": "meitheal.home-assistant",
                },
                timeout=aiohttp.ClientTimeout(total=15),
                **kwargs,
            ) as response:
                if response.status >= 300:
                    raise UpdateFailed(f"Meitheal {method} {path} returned {response.status}")
                # DELETE returns 204; these statuses intentionally have no JSON.
                if response.status in (204, 205):
                    return None
                try:
                    return await response.json()
                except (ValueError, aiohttp.ContentTypeError) as err:
                    raise UpdateFailed(f"Meitheal {path} returned invalid JSON") from err
        except (aiohttp.ClientError, TimeoutError) as err:
            raise UpdateFailed(f"Cannot reach Meitheal {path}: {err}") from err

    async def _async_fetch_tasks(self) -> list[MeithealTask]:
        """Read all pages; never publish a silently truncated board."""
        tasks: list[MeithealTask] = []
        seen: set[str] = set()
        offset = 0
        while True:
            data = await self._async_request("GET", "/api/tasks", params={
                "limit": "100", "offset": str(offset),
                "sort": "kanban_position", "order": "asc",
            })
            if not isinstance(data, (dict, list)):
                raise UpdateFailed("Meitheal returned an invalid task response")
            raw_tasks = data if isinstance(data, list) else data.get("tasks")
            if not isinstance(raw_tasks, list):
                raise UpdateFailed("Meitheal task response has no task list")
            for raw in raw_tasks:
                task = MeithealTask(raw)
                if not task.id or task.id in seen:
                    raise UpdateFailed("Task pagination changed during refresh; retry required")
                seen.add(task.id)
                tasks.append(task)
            offset += len(raw_tasks)
            total = data.get("total") if isinstance(data, dict) else None
            if total is None or offset >= total:
                return tasks
            if not raw_tasks:
                raise UpdateFailed("Meitheal returned an incomplete task page")

    async def _async_fetch_gamification(self, data: MeithealCoordinatorData) -> None:
        """Optional stats must not make the task list unavailable."""
        try:
            payload = await self._async_request("GET", "/api/gamification")
            stats = payload["stats"]
            values = [stats["currentStreak"], stats["totalPoints"], stats["todayCompleted"]]
            if any(type(value) is not int or value < 0 for value in values):
                raise ValueError("invalid gamification counts")
            data.streak, data.total_points, data.completed_today = values
        except (UpdateFailed, aiohttp.ClientError, TimeoutError, KeyError, TypeError, ValueError) as err:
            data.gamification_error = str(err)
            _LOGGER.debug("Gamification unavailable: %s", err)

    async def _async_update_data(self) -> MeithealCoordinatorData:
        """Fetch tasks from Meitheal REST API."""
        try:
            tasks = await self._async_fetch_tasks()
            new_data = MeithealCoordinatorData(tasks)
            await self._async_fetch_gamification(new_data)

            # IQS: log-when-unavailable — log reconnection once
            if not self._was_available:
                _LOGGER.info("Meitheal addon is available again at %s", self._base_url)
                self._was_available = True
                async_delete_addon_unreachable_issue(self.hass)

            if self._previous_data is not None:
                prev = self._previous_data
                if (
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

        except (aiohttp.ClientError, TimeoutError, UpdateFailed) as err:
            # IQS: log-when-unavailable — log unavailability once
            if self._was_available:
                _LOGGER.warning(
                    "Meitheal addon is unavailable at %s: %s",
                    self._base_url, err,
                )
                self._was_available = False
                if hasattr(self, "config_entry") and self.config_entry:
                    async_create_addon_unreachable_issue(
                        self.hass, self.config_entry, str(err)
                    )
            raise UpdateFailed(f"Cannot reach Meitheal: {err}") from err

    async def async_create_task(
        self, title: str, description: str | None = None, *,
        priority: int | None = None, due_date: str | None = None,
        urgency: int | None = None, importance: int | None = None,
    ) -> None:
        """Create a task via Meitheal REST API."""
        payload: dict[str, Any] = {"title": title}
        for key, value in {
            "description": description, "priority": priority, "due_date": due_date,
            "urgency": urgency, "importance": importance,
        }.items():
            if value is not None:
                payload[key] = value
        await self._async_request("POST", "/api/tasks", json=payload)

        self._fire_event("meitheal_task_created", {"title": title})
        self._fire_logbook("Meitheal", f"created task: {title}")
        await self.async_request_refresh()

    async def async_complete_task(
        self, task_id: str | None = None, title: str | None = None
    ) -> None:
        """Mark a task as done."""
        resolved_title = title
        if not task_id and title:
            task_id = self.resolve_task_title(title)
        if not task_id:
            raise UpdateFailed("Task not found")

        await self._async_request("PUT", f"/api/tasks/{task_id}", json={"status": "complete"})

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
        result = await self._async_request("POST", "/api/nfc/complete", json={"tag_id": tag_id})
        if not isinstance(result, dict) or not result.get("task_id"):
            raise UpdateFailed("NFC completion returned no task ID")
        task_id = result["task_id"]
        if not result.get("already_complete"):
            self._fire_event("meitheal_task_completed", {
                "task_id": task_id, "trigger": "nfc", "tag_id": tag_id,
            })
            self._fire_logbook("Meitheal", f"completed task via NFC tag: {tag_id}")
        await self.async_request_refresh()
        return result

    def resolve_task_title(self, title: str) -> str:
        """Require one exact title match before a destructive voice action."""
        if not self.data:
            raise UpdateFailed("No task data available")
        matches = [task for task in self.data.tasks if task.title.casefold() == title.strip().casefold()]
        if not matches:
            raise UpdateFailed("Task not found; search tasks and provide a task ID")
        if len(matches) != 1:
            raise UpdateFailed("Multiple tasks have that title; provide a task ID")
        return matches[0].id

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

        payload = await self._async_request("GET", "/api/search", params=params)

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
                    "status": _normalize_status(meta.get("status") or ""),
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

        await self._async_request("DELETE", f"/api/tasks/{task_id}")

        self._fire_event("meitheal_task_deleted", {
            "task_id": task_id, "title": task_title,
        })
        self._fire_logbook("Meitheal", f"deleted task: {task_title}")
        await self.async_request_refresh()

    async def async_update_task(self, task_id: str, updates: dict[str, Any]) -> None:
        """Update task fields."""
        await self._async_request("PUT", f"/api/tasks/{task_id}", json=updates)

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
        """Persist the full displayed order through the native reorder API."""
        await self._async_request("POST", "/api/tasks/reorder", json={"ordered_ids": ordered_ids})
        await self.async_request_refresh()

    async def async_list_areas(self) -> list[dict[str, Any]]:
        """Read areas from the add-on hierarchy API."""
        result = await self._async_request("GET", "/api/areas")
        return result["areas"]

    async def async_list_goals(self, area_id: str | None = None) -> list[dict[str, Any]]:
        """Read goals and their progress, optionally scoped to an area."""
        params = {"area_id": area_id} if area_id else {}
        result = await self._async_request("GET", "/api/goals", params=params)
        return result["goals"]

    async def async_set_goal_progress(self, goal_id: str, progress: int) -> None:
        """Update manual goal progress through the hierarchy API."""
        await self._async_request("PUT", f"/api/goals/{goal_id}", json={"progress": progress})

    async def async_check_health(self) -> bool:
        """Check if Meitheal addon is reachable."""
        try:
            session = await self._ensure_session()
            async with session.get(f"{self._base_url}/api/health") as response:
                return response.status == 200
        except aiohttp.ClientError:
            return False

    async def async_link_task(
        self, source_task_id: str, target_task_id: str, link_type: str
    ) -> dict[str, Any]:
        """Create a Jira-style link between two tasks."""
        return await self._async_request(
            "POST", f"/api/tasks/{source_task_id}/links",
            json={"target_task_id": target_task_id, "link_type": link_type},
        )

    async def async_unlink_task(
        self, task_id: str, link_id: str
    ) -> dict[str, Any]:
        """Remove a link between two tasks."""
        return await self._async_request(
            "DELETE", f"/api/tasks/{task_id}/links", params={"link_id": link_id},
        )

    async def async_get_task_links(self, task_id: str) -> dict[str, Any]:
        """Get all outbound and inbound links for a task."""
        return await self._async_request("GET", f"/api/tasks/{task_id}/links")

    async def async_shutdown(self) -> None:
        """Clean up coordinator state.

        Session is managed by HA's shared client — no need to close it.
        """
        await super().async_shutdown()
        self._previous_data = None
