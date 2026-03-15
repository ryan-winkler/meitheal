"""Meitheal Home Assistant integration — DataUpdateCoordinator."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import DOMAIN, SCAN_INTERVAL
from .repairs import async_create_addon_unreachable_issue, async_delete_addon_unreachable_issue

_LOGGER = logging.getLogger(__name__)


class MeithealTask:
    """Representation of a Meitheal task."""

    def __init__(self, data: dict[str, Any]) -> None:
        self.id: str = str(data.get("id", ""))
        self.title: str = data.get("title", "")
        self.status: str = data.get("status", "todo")
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

    async def _async_update_data(self) -> MeithealCoordinatorData:
        """Fetch tasks from Meitheal REST API."""
        try:
            session = await self._ensure_session()
            async with session.get(
                f"{self._base_url}/api/tasks",
                headers={"content-type": "application/json"},
            ) as response:
                if response.status >= 400:
                    raise UpdateFailed(
                        f"Meitheal API returned {response.status}"
                    )
                data = await response.json()

                # API may return { tasks: [...] } or [...] directly
                raw_tasks = data if isinstance(data, list) else data.get("tasks", [])
                tasks = [MeithealTask(t) for t in raw_tasks]
                new_data = MeithealCoordinatorData(tasks)

                # IQS: log-when-unavailable — log reconnection once
                if not self._was_available:
                    _LOGGER.info("Meitheal addon is available again at %s", self._base_url)
                    self._was_available = True
                    async_delete_addon_unreachable_issue(self.hass)

                # Fire event on data change (count or overdue difference)
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

        except aiohttp.ClientError as err:
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
        self, title: str, description: str | None = None
    ) -> None:
        """Create a task via Meitheal REST API."""
        session = await self._ensure_session()
        payload: dict[str, Any] = {"title": title}
        if description:
            payload["frameworkPayload"] = {"description": description}
        async with session.post(
            f"{self._base_url}/api/tasks/create",
            json=payload,
            headers={"content-type": "application/json"},
        ) as response:
            if response.status >= 300:
                text = await response.text()
                raise UpdateFailed(f"Create task failed ({response.status}): {text}")

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

        session = await self._ensure_session()
        async with session.put(
            f"{self._base_url}/api/tasks/{task_id}",
            json={"status": "done"},
            headers={"content-type": "application/json"},
        ) as response:
            if response.status >= 300:
                text = await response.text()
                raise UpdateFailed(f"Complete task failed ({response.status}): {text}")

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
        session = await self._ensure_session()
        async with session.post(
            f"{self._base_url}/api/nfc/complete",
            json={"tag_id": tag_id},
            headers={"content-type": "application/json"},
        ) as response:
            result = await response.json()
            if response.status >= 300:
                text = await response.text()
                raise UpdateFailed(f"NFC complete failed ({response.status}): {text}")

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
        session = await self._ensure_session()
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

        async with session.get(
            f"{self._base_url}/api/search",
            params=params,
            headers={"content-type": "application/json"},
        ) as response:
            if response.status >= 300:
                text = await response.text()
                raise UpdateFailed(f"Search task failed ({response.status}): {text}")
            payload = await response.json()

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

        session = await self._ensure_session()
        async with session.delete(
            f"{self._base_url}/api/tasks/{task_id}",
            headers={"content-type": "application/json"},
        ) as response:
            if response.status >= 300:
                text = await response.text()
                raise UpdateFailed(f"Delete task failed ({response.status}): {text}")

        self._fire_event("meitheal_task_deleted", {
            "task_id": task_id, "title": task_title,
        })
        self._fire_logbook("Meitheal", f"deleted task: {task_title}")
        await self.async_request_refresh()

    async def async_update_task(self, task_id: str, updates: dict[str, Any]) -> None:
        """Update task fields."""
        session = await self._ensure_session()
        async with session.put(
            f"{self._base_url}/api/tasks/{task_id}",
            json=updates,
            headers={"content-type": "application/json"},
        ) as response:
            if response.status >= 300:
                text = await response.text()
                raise UpdateFailed(f"Update task failed ({response.status}): {text}")

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
            session = await self._ensure_session()
            async with session.get(f"{self._base_url}/api/health") as response:
                return response.status == 200
        except aiohttp.ClientError:
            return False

    async def async_link_task(
        self, source_task_id: str, target_task_id: str, link_type: str
    ) -> dict[str, Any]:
        """Create a Jira-style link between two tasks."""
        session = await self._ensure_session()
        async with session.post(
            f"{self._base_url}/api/tasks/{source_task_id}/links",
            json={"target_task_id": target_task_id, "link_type": link_type},
        ) as response:
            result = await response.json()
            _LOGGER.info(
                "Linked tasks: %s --%s--> %s",
                source_task_id, link_type, target_task_id,
            )
            return result

    async def async_unlink_task(
        self, task_id: str, link_id: str
    ) -> dict[str, Any]:
        """Remove a link between two tasks."""
        session = await self._ensure_session()
        async with session.delete(
            f"{self._base_url}/api/tasks/{task_id}/links",
            params={"link_id": link_id},
        ) as response:
            result = await response.json()
            _LOGGER.info("Unlinked: link=%s from task=%s", link_id, task_id)
            return result

    async def async_get_task_links(self, task_id: str) -> dict[str, Any]:
        """Get all outbound and inbound links for a task."""
        session = await self._ensure_session()
        async with session.get(
            f"{self._base_url}/api/tasks/{task_id}/links",
        ) as response:
            return await response.json()

    async def async_shutdown(self) -> None:
        """Clean up coordinator state.

        Session is managed by HA's shared client — no need to close it.
        """
        await super().async_shutdown()
        self._previous_data = None
