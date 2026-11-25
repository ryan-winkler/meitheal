"""Meitheal Home Assistant integration — DataUpdateCoordinator."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import UTC, date, datetime, timedelta
from http import HTTPStatus
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import CoordinatorEntity, DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util

from .api import (
    MeithealApi,
    MeithealConnectionError,
    MeithealResponseError,
    async_credential_context,
    async_renew_token,
    resolve_origin_headers,
    task_matches_identifier,
    task_path,
)
from .const import DOMAIN, SCAN_INTERVAL, STATUS_DONE, STATUS_IN_PROGRESS, STATUS_TODO
from .repairs import (
    async_create_addon_unreachable_issue,
    async_delete_addon_unreachable_issue,
)

_LOGGER = logging.getLogger(__name__)

# Home Assistant's service and agent contracts use the legacy aliases.
_TASK_STATUS_ALIASES = {
    "pending": STATUS_TODO,
    "active": STATUS_IN_PROGRESS,
    "complete": STATUS_DONE,
}
TASK_KINDS = (
    "standard_action",
    "shopping_item",
    "checklist",
    "routine_instance",
    "calendar_event",
    "quick_capture",
)
CREATABLE_TASK_KINDS = tuple(kind for kind in TASK_KINDS if kind != "routine_instance")
CLOSED_STATUSES = frozenset({
    STATUS_DONE,
    "complete",
    "completed",
    "archived",
    "cancelled",
    "canceled",
})
SHOPPING_CATEGORIES = (
    "produce",
    "dairy",
    "meat",
    "pantry",
    "frozen",
    "beverages",
    "household",
    "other",
)


def _non_empty_str(value: Any) -> str | None:
    """Return stripped non-empty strings, otherwise None."""
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def _parse_local_date(
    raw: str | None,
    local_now: datetime,
    *,
    exclusive_end: bool = False,
) -> date | None:
    """Parse a YYYY-MM-DD or ISO timestamp string into a local calendar date."""
    value = _non_empty_str(raw)
    if value is None:
        return None
    try:
        if len(value) == 10:
            parsed_day = date.fromisoformat(value)
            return parsed_day - timedelta(days=1) if exclusive_end else parsed_day
        parsed_dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed_dt.tzinfo is not None and local_now.tzinfo is not None:
            parsed_dt = parsed_dt.astimezone(local_now.tzinfo)
        if (
            exclusive_end
            and parsed_dt.hour == 0
            and parsed_dt.minute == 0
            and parsed_dt.second == 0
            and parsed_dt.microsecond == 0
        ):
            parsed_dt -= timedelta(microseconds=1)
        return parsed_dt.date()
    except (ValueError, TypeError, OverflowError):
        return None


def _parse_json_list(raw: Any) -> list[dict[str, Any]]:
    """Parse JSON-encoded or list checklist payloads into a list of dicts."""
    value = raw
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            return []
    if not isinstance(value, list):
        return []
    return [dict(item) for item in value if isinstance(item, dict)]


def _parse_json_dict(raw: Any) -> dict[str, Any]:
    """Parse JSON-encoded or dict custom_fields payloads safely."""
    value = raw
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            return {}
    return dict(value) if isinstance(value, dict) else {}


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
        """Initialize a Meitheal task from raw API payload data."""
        self.id: str = str(data.get("id", ""))
        self.board_id: str | None = data.get("board_id")
        self.ticket_key: str | None = data.get("ticket_key")
        self.title: str = data.get("title", "")
        status = data.get("status", STATUS_TODO)
        self.status: str = _TASK_STATUS_ALIASES.get(status, status)
        self.description: str | None = data.get("description")
        self.priority: int = data.get("priority", 3)
        self.due_date: str | None = data.get("due_date") or data.get("dueDate")
        self.start_date: str | None = (
            data.get("start_date") if isinstance(data.get("start_date"), str) else None
        )
        self.end_date: str | None = (
            data.get("end_date") if isinstance(data.get("end_date"), str) else None
        )
        raw_kind = data.get("task_kind")
        self.task_kind: str = (
            raw_kind.strip().lower()
            if isinstance(raw_kind, str) and raw_kind.strip()
            else "standard_action"
        )
        self.checklists: list[dict[str, Any]] = _parse_json_list(data.get("checklists"))
        self.custom_fields: dict[str, Any] = _parse_json_dict(data.get("custom_fields"))
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
        # Preserve native nullness: reorder permits only deferred_at IS NULL.
        self.deferred_at: Any = data.get("deferred_at")
        self.deferral_revision: str | None = data.get("deferral_revision")
        self.position: int | None = data.get("kanban_position", data.get("position"))
        self.calendar_sync_state: str | None = data.get("calendar_sync_state")
        self.urgency: int = data.get("urgency", 0)
        self.importance: int = data.get("importance", 0)
        self.eisenhower_quadrant: str | None = data.get("eisenhower_quadrant")
        self.created_at = _timestamp(data.get("created_at") or data.get("createdAt"))
        self.updated_at = _timestamp(data.get("updated_at") or data.get("updatedAt"))

    @property
    def effective_scheduled_date(self) -> str | None:
        """Return primary scheduled date/timestamp across tasks and calendar events."""
        if self.task_kind == "calendar_event":
            return (
                _non_empty_str(self.start_date)
                or _non_empty_str(self.due_date)
                or _non_empty_str(self.end_date)
            )
        return _non_empty_str(self.due_date)

    def scheduled_local_date(self, local_now: datetime) -> date | None:
        """Resolve the local calendar date for a task or event relative to local_now."""
        return _parse_local_date(self.effective_scheduled_date, local_now)

    def end_local_date(self, local_now: datetime) -> date | None:
        """Resolve the inclusive local end calendar date for an event."""
        start_day = self.scheduled_local_date(local_now)
        sync_state = getattr(self, "calendar_sync_state", None)
        if self.task_kind != "calendar_event" and sync_state not in ("synced", "confirmed"):
            return start_day
        end_raw = _non_empty_str(self.end_date)
        if not end_raw:
            return start_day
        exclusive_end = sync_state == "synced" or len(end_raw) > 10
        end_day = _parse_local_date(end_raw, local_now, exclusive_end=exclusive_end)
        if end_day is None or (start_day is not None and end_day < start_day):
            return start_day
        return end_day

    def covers_local_date(self, local_now: datetime, target_day: date | None = None) -> bool:
        """Return whether this item falls on or spans target_day."""
        check_day = target_day if target_day is not None else local_now.date()
        start_day = self.scheduled_local_date(local_now)
        if start_day is None:
            return False
        end_day = self.end_local_date(local_now)
        if end_day is not None and end_day > start_day:
            return start_day <= check_day <= end_day
        return start_day == check_day

    def is_due_on(self, local_now: datetime) -> bool:
        """Check whether this open task is due on Home Assistant's local date."""
        if self.status in CLOSED_STATUSES:
            return False
        sync_state = getattr(self, "calendar_sync_state", None)
        if self.task_kind == "calendar_event" or sync_state in ("synced", "confirmed"):
            return self.covers_local_date(local_now)
        local_date = self.scheduled_local_date(local_now)
        return local_date == local_now.date() if local_date is not None else False

    def is_overdue_at(self, local_now: datetime) -> bool:
        """Check if task is overdue relative to a supplied local timestamp."""
        if self.status in CLOSED_STATUSES:
            return False
        end_raw = _non_empty_str(self.end_date)
        if self.task_kind == "calendar_event" and end_raw is not None:
            scheduled = end_raw
            if (
                len(end_raw) == 10
                and getattr(self, "calendar_sync_state", None) in ("synced", "confirmed")
            ):
                end_day = _parse_local_date(end_raw, local_now, exclusive_end=True)
                return end_day is not None and end_day < local_now.date()
        else:
            scheduled = self.effective_scheduled_date
        if not scheduled:
            return False
        try:
            if len(scheduled) == 10:
                return date.fromisoformat(scheduled) < local_now.date()
            due = datetime.fromisoformat(scheduled.replace("Z", "+00:00"))
            if due.tzinfo is not None:
                if local_now.tzinfo is None:
                    return due.astimezone().replace(tzinfo=None) < local_now
                return due < local_now
            local_cmp = (
                local_now.replace(tzinfo=None)
                if local_now.tzinfo is not None
                else local_now
            )
            return due < local_cmp
        except (ValueError, TypeError, OverflowError):
            return False

    @property
    def is_overdue(self) -> bool:
        """Check if task is overdue relative to Home Assistant's local clock."""
        return self.is_overdue_at(dt_util.now())


class MeithealCoordinatorData:
    """Structured data from coordinator update with pre-computed entity indexes."""

    def __init__(self, tasks: list[MeithealTask]) -> None:
        """Compute active, overdue, daily, and sensor summaries in a single pass."""
        self.tasks = tasks
        self.total_count = len(tasks)
        local_now = dt_util.now()

        tasks_by_id: dict[str, MeithealTask] = {}
        todo_tasks: list[MeithealTask] = []
        active_tasks: list[MeithealTask] = []
        overdue_tasks: list[MeithealTask] = []
        due_today_tasks: list[MeithealTask] = []
        active_priorities: dict[str, int] = {}
        active_has_urgent = False
        active_with_due_date = 0
        oldest_overdue_due: str | None = None
        statuses: dict[str, int] = {}
        all_labels: dict[str, int] = {}

        for task in tasks:
            if task.id:
                tasks_by_id[task.id] = task
            if task.deferred_at is None:
                todo_tasks.append(task)
            statuses[task.status] = statuses.get(task.status, 0) + 1
            for label in task.labels:
                all_labels[label] = all_labels.get(label, 0) + 1
            if task.status not in CLOSED_STATUSES:
                active_tasks.append(task)
                prio_key = f"p{task.priority}"
                active_priorities[prio_key] = active_priorities.get(prio_key, 0) + 1
                if task.priority <= 2:
                    active_has_urgent = True
                if task.due_date:
                    active_with_due_date += 1
                if task.is_overdue_at(local_now):
                    overdue_tasks.append(task)
                    if task.due_date and (
                        oldest_overdue_due is None or task.due_date < oldest_overdue_due
                    ):
                        oldest_overdue_due = task.due_date
                if task.is_due_on(local_now):
                    due_today_tasks.append(task)

        self.tasks_by_id = tasks_by_id
        self.todo_tasks = todo_tasks
        self.active_tasks = active_tasks
        self.overdue_tasks = overdue_tasks
        self.due_today_tasks = due_today_tasks
        self.active_count = len(active_tasks)
        self.overdue_count = len(overdue_tasks)
        self.due_today_count = len(due_today_tasks)
        self.active_priority_breakdown = active_priorities
        self.active_has_urgent = active_has_urgent
        self.active_with_due_date = active_with_due_date
        self.oldest_overdue_due = oldest_overdue_due
        self.status_breakdown = statuses
        self.label_summary = dict(sorted(all_labels.items(), key=lambda x: -x[1])[:10])
        # Streak and XP — populated by coordinator from gamification API
        self.streak: int | None = None
        self.total_points: int | None = None
        self.completed_today: int | None = None
        self.gamification_error: str | None = None


class MeithealCoordinator(DataUpdateCoordinator[MeithealCoordinatorData]):
    """Coordinator to poll Meitheal addon REST API for tasks."""

    def __init__(self, hass: HomeAssistant, api: MeithealApi) -> None:
        """Initialize the coordinator with Home Assistant and a Meitheal API client."""
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
        self._cache_key = api.cache_key
        self._shared_entity_delivery = False
        self._last_renew_attempt: datetime | None = None
        self._assignee_directory_cache: tuple[str, float, list[dict[str, Any]]] | None = None

    # ── Event Bus Helpers ─────────────────────────────────────────────

    async def fire_event(self, event_type: str, data: dict[str, Any]) -> None:
        """Fire a Meitheal event on the HA event bus."""
        await self._fire_event(event_type, data)

    async def fire_logbook(self, name: str, message: str, entity_id: str | None = None) -> None:
        """Fire a logbook entry so Meitheal actions appear in HA history."""
        await self._fire_logbook(name, message, entity_id)

    async def _fire_event(self, event_type: str, data: dict[str, Any]) -> None:
        """Fire a Meitheal event on the HA event bus.

        Source identifies the standalone/App-disabled fallback producer.
        Mutation responses decide authority before calling this helper.
        """
        if not await self.async_can_publish_shared():
            return
        self.hass.bus.async_fire(
            event_type,
            {**data, "board_id": self.api.board_id, "source": "component", "domain": DOMAIN},
        )

    async def _fire_logbook(self, name: str, message: str, entity_id: str | None = None) -> None:
        """Fire a logbook entry so Meitheal actions appear in HA history."""
        if not await self.async_can_publish_shared():
            return
        logbook_data: dict[str, Any] = {
            "name": name,
            "message": message,
            "domain": DOMAIN,
            "board_id": self.api.board_id,
        }
        if entity_id:
            logbook_data["entity_id"] = entity_id
        self.hass.bus.async_fire("logbook_entry", logbook_data)

    @property
    def shared_entity_delivery(self) -> bool:
        """Only a current approved shared sink may expose cached Board content in HA."""
        return self._shared_entity_delivery and self.api.configured and self.api.cache_key == self._cache_key

    async def _async_maybe_renew_token(self, metadata: dict[str, Any]) -> None:
        """Auto-extend expiring integration tokens when within 14 days of expiry."""
        expires_raw = metadata.get("tokenExpiresAt")
        if not isinstance(expires_raw, str) or not expires_raw.strip():
            return
        now = datetime.now(UTC)
        if self._last_renew_attempt and (now - self._last_renew_attempt) < timedelta(hours=1):
            return
        try:
            expires_dt = datetime.fromisoformat(expires_raw.replace("Z", "+00:00"))
            if expires_dt.tzinfo is None:
                expires_dt = expires_dt.replace(tzinfo=UTC)
        except ValueError:
            return
        if expires_dt - now > timedelta(days=14):
            return
        self._last_renew_attempt = now
        try:
            new_expiry = await async_renew_token(self.api, days=90)
            if new_expiry:
                _LOGGER.info("Renewed Meitheal integration token until %s", new_expiry)
        except (MeithealConnectionError, MeithealResponseError):
            _LOGGER.debug("Deferred proactive Meitheal token renewal; will retry later")

    async def _async_board_metadata(self) -> dict[str, Any]:
        if not self.api.configured or self.api.cache_key != self._cache_key:
            raise MeithealResponseError(401)
        key = self.api.cache_key
        metadata = await async_credential_context(self.api)
        await self._async_maybe_renew_token(metadata)
        board = next((board for board in metadata["boards"] if board["id"] == self.api.board_id), None)
        if board is None or self.api.cache_key != key:
            raise MeithealResponseError(403)
        return board

    async def async_can_publish_shared(self) -> bool:
        """Recheck server-approved global HA disclosure immediately before dispatch."""
        try:
            self._shared_entity_delivery = (await self._async_board_metadata())["sharedEntityDelivery"]
        except (MeithealConnectionError, MeithealResponseError):
            self._shared_entity_delivery = False
        return self.shared_entity_delivery

    def _parse_task_page(
        self,
        data: Any,
        offset: int,
        expected_total: int | None,
        seen: set[str],
        tasks: list[MeithealTask],
    ) -> tuple[int | None, int]:
        """Validate a single task page and append parsed tasks."""
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
            if item.get("board_id") != self.api.board_id:
                raise UpdateFailed("Meitheal returned work outside the configured Board")
            task = MeithealTask(item)
            if task.id in seen:
                raise UpdateFailed("Task pagination repeated an item; retry required")
            seen.add(task.id)
            tasks.append(task)
        return total, len(raw)

    async def _async_fetch_tasks(self) -> list[MeithealTask]:
        """Read the complete board (parallelizing pages 1..N) or fail without partial counts."""
        tasks: list[MeithealTask] = []
        seen: set[str] = set()
        first_page = await self.api.async_request("GET", "/api/tasks", params={
            "limit": "100", "offset": "0",
            "sort": "kanban_position", "order": "asc",
        }, read_json=True)
        total, first_count = self._parse_task_page(first_page, 0, None, seen, tasks)
        # Older responses omit pagination metadata and contain the whole list.
        if total is None:
            return tasks
        if first_count > total or (first_count == 0 and total > 0):
            raise UpdateFailed("Meitheal returned an incomplete task page")
        if first_count == total:
            return tasks

        expected_total = total
        page_size = first_count
        remaining_offsets = list(range(first_count, total, page_size))
        semaphore = asyncio.Semaphore(4)

        async def _fetch_page(page_offset: int) -> Any:
            async with semaphore:
                return await self.api.async_request("GET", "/api/tasks", params={
                    "limit": "100", "offset": str(page_offset),
                    "sort": "kanban_position", "order": "asc",
                }, read_json=True)

        remaining_pages = await asyncio.gather(*(_fetch_page(off) for off in remaining_offsets))
        offset = first_count
        for page_offset, page_data in zip(remaining_offsets, remaining_pages, strict=True):
            _, count = self._parse_task_page(page_data, page_offset, expected_total, seen, tasks)
            offset += count
            if offset > expected_total or (count == 0 and offset < expected_total):
                raise UpdateFailed("Meitheal returned an incomplete task page")

        if offset != expected_total:
            raise UpdateFailed("Meitheal returned an incomplete task page")
        return tasks

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
            metadata = await self._async_board_metadata()
            self._shared_entity_delivery = metadata["sharedEntityDelivery"]
            if not self.shared_entity_delivery:
                self._previous_data = None
                return MeithealCoordinatorData([])
            tasks = await self._async_fetch_tasks()
        except MeithealResponseError as err:
            self._shared_entity_delivery = False
            self._previous_data = None
            if err.status in (HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN):
                raise ConfigEntryAuthFailed("Meitheal rejected task access") from None
            raise UpdateFailed(str(err)) from None
        except MeithealConnectionError as err:
            self._shared_entity_delivery = False
            self._previous_data = None
            if self._was_available:
                _LOGGER.warning("Cannot reach Meitheal at %s", self.api.origin)
                self._was_available = False
                if self.config_entry:
                    async_create_addon_unreachable_issue(
                        self.hass, self.config_entry, str(err)
                    )
            raise UpdateFailed(str(err)) from None
        except UpdateFailed:
            self._shared_entity_delivery = False
            raise

        new_data = MeithealCoordinatorData(tasks)
        await self._async_fetch_gamification(new_data)
        if not await self.async_can_publish_shared():
            self._previous_data = None
            return MeithealCoordinatorData([])

        if not self._was_available:
            _LOGGER.info("Meitheal is available again at %s", self.api.origin)
            self._was_available = True
            async_delete_addon_unreachable_issue(self.hass)

        if (prev := self._previous_data) is not None and (
            prev.total_count != new_data.total_count
            or prev.overdue_count != new_data.overdue_count
            or prev.active_count != new_data.active_count
        ):
            await self._fire_event("meitheal_board_updated", {
                "total": new_data.total_count,
                "active": new_data.active_count,
                "overdue": new_data.overdue_count,
                "previous_total": prev.total_count,
            })
        if not self.shared_entity_delivery:
            self._previous_data = None
            return MeithealCoordinatorData([])
        self._previous_data = new_data
        return new_data

    async def async_data_for_context(self) -> MeithealCoordinatorData:
        """Read fresh selected-Board work for the current caller without global caching."""
        if not self.api.configured or self.api.cache_key != self._cache_key:
            raise MeithealResponseError(401)
        data = MeithealCoordinatorData(await self._async_fetch_tasks())
        await self._async_fetch_gamification(data)
        return data

    async def _async_get_assignee_directory(self, *, force_refresh: bool = False) -> list[dict[str, Any]]:
        """Fetch /api/users with a short 60s per-credential TTL cache."""
        now = time.monotonic()
        cached = self._assignee_directory_cache
        if (
            not force_refresh
            and cached is not None
            and cached[0] == self.api.cache_key
            and (now - cached[1]) < 60.0
        ):
            return cached[2]
        payload = await self.api.async_request("GET", "/api/users", read_json=True)
        users = payload.get("users") if isinstance(payload, dict) else None
        if not isinstance(users, list):
            raise UpdateFailed("Meitheal did not return an assignee directory")
        self._assignee_directory_cache = (self.api.cache_key, now, users)
        return users

    @staticmethod
    def _match_assignee_in_directory(users: list[dict[str, Any]], cleaned: str) -> str | None:
        exact_id = [u for u in users if isinstance(u, dict) and u.get("id") == cleaned]
        if len(exact_id) == 1:
            return str(exact_id[0]["id"])
        needle = cleaned.casefold()
        matches = [
            str(u["id"])
            for u in users
            if isinstance(u, dict)
            and isinstance(u.get("id"), str)
            and isinstance(u.get("name"), str)
            and u["name"].strip().casefold() == needle
        ]
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise UpdateFailed(
                f"Multiple assignees match '{cleaned}'; provide an exact assignee ID"
            )
        return None

    async def async_resolve_assignee(self, candidate: str) -> str:
        """Resolve a user name or canonical ID to a single canonical assignee ID."""
        cleaned = candidate.strip()
        if not cleaned:
            raise UpdateFailed("Assignee identifier cannot be empty")
        if cleaned.startswith(("custom_", "ha_")):
            return cleaned

        used_cache = (
            self._assignee_directory_cache is not None
            and self._assignee_directory_cache[0] == self.api.cache_key
            and (time.monotonic() - self._assignee_directory_cache[1]) < 60.0
        )
        users = await self._async_get_assignee_directory(force_refresh=False)
        resolved = self._match_assignee_in_directory(users, cleaned)
        if resolved is not None:
            return resolved
        if used_cache:
            # Refresh live on miss so newly added household members resolve immediately.
            fresh_users = await self._async_get_assignee_directory(force_refresh=True)
            resolved = self._match_assignee_in_directory(fresh_users, cleaned)
            if resolved is not None:
                return resolved
        raise UpdateFailed(f"No assignee found matching '{cleaned}'")

    async def async_create_task(
        self, title: str, description: str | None = None, *,
        priority: int | None = None, due_date: str | None = None,
        urgency: int | None = None, importance: int | None = None,
        assigned_to: str | None = None,
        task_kind: str | None = None,
        start_date: str | None = None,
        end_date: str | None = None,
        checklists: list[dict[str, Any]] | str | None = None,
        custom_fields: dict[str, Any] | str | None = None,
        origin_kind: str | None = None, origin_name: str | None = None,
        origin_target: str | None = None,
    ) -> None:
        """Create a task through the authenticated native flat-response API.

        Without assigned_to, Meitheal applies the selected Board's default assignee.
        """
        resolved_assignee = (
            await self.async_resolve_assignee(assigned_to)
            if isinstance(assigned_to, str) and assigned_to.strip()
            else None
        )
        payload: dict[str, Any] = {"title": title}
        for key, value in {"description": description, "priority": priority,
                           "due_date": due_date, "urgency": urgency, "importance": importance,
                           "assigned_to": resolved_assignee, "task_kind": task_kind,
                           "start_date": start_date, "end_date": end_date,
                           "checklists": checklists, "custom_fields": custom_fields}.items():
            if value is not None:
                payload[key] = value
        authority: set[str] = set()
        origin_headers = resolve_origin_headers(origin_kind, origin_name, origin_target)
        request_kwargs: dict[str, Any] = {
            "payload": payload,
            "read_json": True,
            "event_authority": authority,
        }
        if origin_headers:
            request_kwargs["extra_headers"] = origin_headers
        result = await self.api.async_request("POST", "/api/tasks", **request_kwargs)
        if not isinstance(result, dict) or not isinstance(result.get("id"), str) or not result["id"] or result.get("error"):
            raise UpdateFailed("Meitheal did not acknowledge the created task")
        if "meitheal_task_created" not in authority:
            await self._fire_event("meitheal_task_created", {"task_id": result["id"], "title": title})
        await self._fire_logbook("Meitheal", f"created task: {title}")
        await self.async_request_refresh()

    def resolve_task_title(self, title: str, tasks: list[MeithealTask] | None = None) -> str:
        """Require one exact case-insensitive match before destructive actions."""
        if tasks is None:
            if not self.data:
                raise UpdateFailed("No task data available")
            tasks = self.data.tasks
        matches = [task for task in tasks if task.title.casefold() == title.strip().casefold()]
        if not matches:
            raise UpdateFailed("Task not found; provide a task ID")
        if len(matches) != 1:
            raise UpdateFailed("Multiple tasks have that title; provide a task ID")
        return matches[0].id

    async def async_complete_task(
        self, task_id: str | None = None, title: str | None = None, *,
        origin_kind: str | None = None, origin_name: str | None = None,
        origin_target: str | None = None,
    ) -> None:
        """Mark a task as done."""
        resolved_title = title
        if not task_id and title:
            data = await self.async_data_for_context()
            task_id = self.resolve_task_title(title, data.tasks)
        if not task_id:
            raise UpdateFailed("Task not found")
        if self.data:
            task = self.data.tasks_by_id.get(task_id)
            if task and task.status == STATUS_DONE:
                # A cached completion may have been reopened or access revoked.
                current = await self.api.async_request("GET", task_path(task_id), read_json=True)
                if (not isinstance(current, dict) or not task_matches_identifier(current, task_id)
                    or not isinstance(current.get("status"), str)):
                    raise UpdateFailed("Meitheal did not confirm the task status")
                if _TASK_STATUS_ALIASES.get(current["status"], current["status"]) == STATUS_DONE:
                    return
            if task:
                resolved_title = task.title

        authority: set[str] = set()
        origin_headers = resolve_origin_headers(origin_kind, origin_name, origin_target)
        request_kwargs: dict[str, Any] = {
            "payload": {"status": "done"},
            "read_json": True,
            "event_authority": authority,
        }
        if origin_headers:
            request_kwargs["extra_headers"] = origin_headers
        result = await self.api.async_request("PUT", task_path(task_id), **request_kwargs)
        if (
            not isinstance(result, dict)
            or not task_matches_identifier(result, task_id)
            or result.get("status") not in (STATUS_DONE, "complete")
            or result.get("error")
        ):
            raise UpdateFailed("Meitheal did not acknowledge task completion")

        label = resolved_title or task_id
        if "meitheal_task_completed" not in authority:
            await self._fire_event("meitheal_task_completed", {
                "task_id": task_id, "title": label,
            })
        await self._fire_logbook("Meitheal", f"completed task: {label}")
        await self.async_request_refresh()

    async def async_complete_task_by_tag(
        self, tag_id: str, *,
        origin_kind: str | None = None, origin_name: str | None = None,
        origin_target: str | None = None,
    ) -> dict[str, Any]:
        """Complete a task by NFC tag ID."""
        authority: set[str] = set()
        origin_headers = resolve_origin_headers(origin_kind, origin_name, origin_target)
        request_kwargs: dict[str, Any] = {
            "payload": {"tag_id": tag_id},
            "read_json": True,
            "event_authority": authority,
        }
        if origin_headers:
            request_kwargs["extra_headers"] = origin_headers
        result = await self.api.async_request("POST", "/api/nfc/complete", **request_kwargs)

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
            if "meitheal_task_completed" not in authority:
                await self._fire_event("meitheal_task_completed", {
                    "task_id": task_id, "trigger": "nfc", "tag_id": tag_id,
                })
            await self._fire_logbook("Meitheal", f"completed task via NFC tag: {tag_id}")
        await self.async_request_refresh()
        return result

    async def async_search_tasks(
        self,
        query: str = "",
        status: str | None = None,
        priority: int | None = None,
        include_completed: bool | None = None,
        task_kind: str | None = None,
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
        if task_kind:
            params["task_kind"] = task_kind
        if include_completed is True or (
            include_completed is None
            and status is not None
            and status.strip().lower() in (STATUS_DONE, "complete")
        ):
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
                    "task_kind": meta.get("task_kind") or "standard_action",
                    "description": item.get("description", ""),
                    "matched_fields": meta.get("matched_fields", []),
                }
            )

        return {"tasks": tasks, "count": len(tasks)}

    async def async_delete_task(
        self, task_id: str, *,
        origin_kind: str | None = None, origin_name: str | None = None,
        origin_target: str | None = None,
        refresh: bool = True,
    ) -> None:
        """Delete a task."""
        # Try to resolve title before deletion for logbook
        task_title = task_id
        if self.data and (cached_task := self.data.tasks_by_id.get(task_id)):
            task_title = cached_task.title

        authority: set[str] = set()
        origin_headers = resolve_origin_headers(origin_kind, origin_name, origin_target)
        request_kwargs: dict[str, Any] = {"event_authority": authority}
        if origin_headers:
            request_kwargs["extra_headers"] = origin_headers
        await self.api.async_request("DELETE", task_path(task_id), **request_kwargs)

        if "meitheal_task_deleted" not in authority:
            await self._fire_event("meitheal_task_deleted", {
                "task_id": task_id, "title": task_title,
            })
        await self._fire_logbook("Meitheal", f"deleted task: {task_title}")
        if refresh:
            await self.async_request_refresh()

    async def async_update_task(
        self, task_id: str, updates: dict[str, Any], *,
        origin_kind: str | None = None, origin_name: str | None = None,
        origin_target: str | None = None,
    ) -> None:
        """Update task fields."""
        path = task_path(task_id)
        completing = str(updates.get("status") or "").lower() in (STATUS_DONE, "complete")
        was_done = False
        payload = updates
        if completing:
            # Poll data may be stale. Bind the mixed-field write to the same
            # snapshot used for the native fallback's transition decision.
            current = await self.api.async_request("GET", path, read_json=True)
            if (not isinstance(current, dict) or not task_matches_identifier(current, task_id)
                or not isinstance(current.get("status"), str)):
                raise UpdateFailed("Meitheal did not confirm the task status")
            version = current.get("task_version", current.get("updated_at"))
            if type(version) is not int or not 0 <= version < 2**53:
                raise UpdateFailed("Meitheal did not confirm the task version")
            was_done = current["status"].lower() in (STATUS_DONE, "complete")
            payload = {**updates, "updated_at": version}

        authority: set[str] = set()
        origin_headers = resolve_origin_headers(origin_kind, origin_name, origin_target)
        request_kwargs: dict[str, Any] = {
            "payload": payload,
            "read_json": completing,
            "event_authority": authority,
        }
        if origin_headers:
            request_kwargs["extra_headers"] = origin_headers
        result = await self.api.async_request("PUT", path, **request_kwargs)
        if completing and (
            not isinstance(result, dict)
            or result.get("error")
            or not task_matches_identifier(result, task_id)
            or result.get("status") not in (STATUS_DONE, "complete")
        ):
            raise UpdateFailed("Meitheal did not acknowledge task completion")

        # Resolve title for logbook
        task_title = task_id
        if self.data and (cached_task := self.data.tasks_by_id.get(task_id)):
            task_title = cached_task.title

        changed_fields = ", ".join(updates.keys())
        if "meitheal_task_updated" not in authority:
            await self._fire_event("meitheal_task_updated", {
                "task_id": task_id, "title": task_title,
                "fields": changed_fields,
            })
        if completing and not was_done and "meitheal_task_completed" not in authority:
            await self._fire_event("meitheal_task_completed", {
                "task_id": task_id, "title": result.get("title") or task_title,
            })
        await self._fire_logbook("Meitheal", f"updated task: {task_title} ({changed_fields})")
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

    async def async_list_routines(
        self,
        area_id: str | None = None,
        project_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """List routine templates and streak stats from the active Board."""
        params: dict[str, str] = {}
        if area_id:
            params["area_id"] = area_id
        if project_id:
            params["project_id"] = project_id
        data = await self.api.async_request(
            "GET",
            "/api/habits",
            params=params or None,
            read_json=True,
        )
        routines = data.get("habits") if isinstance(data, dict) else None
        if not isinstance(routines, list):
            raise UpdateFailed("Meitheal returned an invalid routine list")
        return [dict(item) for item in routines if isinstance(item, dict)]

    async def async_complete_routine(
        self,
        template_id: str,
        *,
        origin_kind: str | None = None,
        origin_name: str | None = None,
        origin_target: str | None = None,
    ) -> dict[str, Any]:
        """Complete a routine occurrence for the current period."""
        authority: set[str] = set()
        origin_headers = resolve_origin_headers(origin_kind, origin_name, origin_target)
        request_kwargs: dict[str, Any] = {
            "payload": {"action": "complete", "templateId": template_id},
            "read_json": True,
            "event_authority": authority,
        }
        if origin_headers:
            request_kwargs["extra_headers"] = origin_headers
        result = await self.api.async_request("POST", "/api/habits", **request_kwargs)
        if (
            not isinstance(result, dict)
            or result.get("error")
            or not isinstance(result.get("taskId"), str)
            or not result["taskId"]
            or not result.get("completed")
        ):
            raise UpdateFailed("Meitheal did not acknowledge routine completion")
        if (
            bool(result.get("newlyCompleted", not result.get("alreadyExisted")))
            and "meitheal_task_completed" not in authority
        ):
            await self._fire_event(
                "meitheal_task_completed",
                {"task_id": result["taskId"], "title": template_id},
            )
        await self._fire_logbook("Meitheal", f"completed routine: {template_id}")
        await self.async_request_refresh()
        return {
            "taskId": result["taskId"],
            "completed": bool(result.get("completed")),
            "alreadyExisted": bool(result.get("alreadyExisted")),
            "newlyCompleted": bool(result.get("newlyCompleted")),
        }

    async def async_shutdown(self) -> None:
        """Clean up coordinator state.

        Home Assistant releases the HTTP session when the entry unloads.
        """
        await super().async_shutdown()
        self._previous_data = None


class MeithealBoardEntity(CoordinatorEntity[MeithealCoordinator]):
    """Shared availability boundary for native globally readable HA state."""

    @property
    def available(self) -> bool:
        return super().available and self.coordinator.shared_entity_delivery
