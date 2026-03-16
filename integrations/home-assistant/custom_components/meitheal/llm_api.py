"""Meitheal LLM API — Exposes task management tools to HA conversation agents.

Registers Meitheal as an LLM API provider, making task management tools
available to any HA conversation agent (Google Generative AI, OpenAI, Ollama).

Phase 60: HA Assist & Voice Integration.

Tools:
- SearchTasks: Search tasks by keyword, status, or priority
- GetTaskDetails: Get full task details by ID
- CreateTask: Create a new task
- CompleteTask: Mark a task as done
- UpdateTask: Update task fields (priority, due date, description, status)
- GetOverdueTasks: List overdue tasks
- GetTodaysTasks: List tasks due today
- GetTaskSummary: Get summary counts (active, overdue, total)
- GetCalendarEvents: Get events synced from HA calendar
- GetUpcomingEvents: Get upcoming events for today/this week

@see https://developers.home-assistant.io/docs/core/llm/
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import voluptuous as vol

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import llm
from homeassistant.helpers.llm import (
    API,
    APIInstance,
    LLMContext,
    Tool,
    ToolInput,
)
from homeassistant.util.json import JsonObjectType

from .const import DOMAIN
from .coordinator import MeithealCoordinator

_LOGGER = logging.getLogger(__name__)


def _get_coordinator(hass: HomeAssistant) -> MeithealCoordinator | None:
    """Get the first active Meitheal coordinator.

    Uses config_entries + runtime_data (IQS: runtime-data pattern).
    """
    for entry in hass.config_entries.async_entries(DOMAIN):
        if hasattr(entry, "runtime_data") and isinstance(
            entry.runtime_data, MeithealCoordinator
        ):
            return entry.runtime_data
    return None


# ── LLM Tools ──


class SearchTasksTool(Tool):
    """Search Meitheal tasks by keyword, status, priority, and richer task fields."""

    name = "meitheal_search_tasks"
    description = (
        "Search tasks in Meitheal, the household task manager. "
        "You can filter by keyword (matches title, description, labels, custom fields, comments, and task IDs), "
        "status (backlog, todo, in_progress, or done), or priority (1=urgent, 5=low). "
        "Use this when the user asks about their tasks, to-do list, or task list."
    )
    parameters = vol.Schema(
        {
            vol.Optional("query", description="Keyword to search in title and description"): str,
            vol.Optional(
                "status",
                description="Filter by status: backlog, todo, in_progress, or done",
            ): vol.In(["backlog", "todo", "in_progress", "done"]),
            vol.Optional(
                "priority",
                description="Filter by priority (1 = highest/urgent, 5 = lowest)",
            ): vol.All(int, vol.Range(min=1, max=5)),
            vol.Optional(
                "include_completed",
                description="Include completed tasks in the results",
            ): bool,
        }
    )

    async def async_call(
        self,
        hass: HomeAssistant,
        tool_input: ToolInput,
        llm_context: LLMContext,
    ) -> JsonObjectType:
        """Execute task search."""
        coordinator = _get_coordinator(hass)
        if not coordinator:
            return {"tasks": [], "count": 0, "message": "No tasks available"}

        return await coordinator.async_search_tasks(
            query=tool_input.tool_args.get("query", ""),
            status=tool_input.tool_args.get("status"),
            priority=tool_input.tool_args.get("priority"),
            include_completed=tool_input.tool_args.get("include_completed", False),
        )


class GetTaskDetailsTool(Tool):
    """Get full details for a specific Meitheal task."""

    name = "meitheal_get_task"
    description = (
        "Get detailed information about a specific task including "
        "its title, status, description, priority, due date, and labels. "
        "You need the task ID — use meitheal_search_tasks first to find it."
    )
    parameters = vol.Schema(
        {
            vol.Required("task_id", description="The task ID to look up"): str,
        }
    )

    async def async_call(
        self,
        hass: HomeAssistant,
        tool_input: ToolInput,
        llm_context: LLMContext,
    ) -> JsonObjectType:
        """Fetch task details."""
        coordinator = _get_coordinator(hass)
        if not coordinator or not coordinator.data:
            raise HomeAssistantError("Meitheal is not available")

        task_id = tool_input.tool_args["task_id"]
        for task in coordinator.data.tasks:
            if task.id == task_id:
                return {
                    "id": task.id,
                    "title": task.title,
                    "status": task.status,
                    "description": task.description or "",
                    "priority": task.priority,
                    "due_date": task.due_date,
                    "labels": task.labels,
                    "is_overdue": task.is_overdue,
                    "created_at": task.created_at,
                    "updated_at": task.updated_at,
                }

        raise HomeAssistantError(f"Task {task_id} not found")


class CreateTaskTool(Tool):
    """Create a new task in Meitheal."""

    name = "meitheal_create_task"
    description = (
        "Create a new task in Meitheal, the household task manager. "
        "Provide at minimum a title. Optionally include a description. "
        "Use this when the user says things like 'add a task', 'remind me to', "
        "'create a todo', or 'I need to'."
    )
    parameters = vol.Schema(
        {
            vol.Required("title", description="Task title"): str,
            vol.Optional("description", description="Task description or notes"): str,
        }
    )

    async def async_call(
        self,
        hass: HomeAssistant,
        tool_input: ToolInput,
        llm_context: LLMContext,
    ) -> JsonObjectType:
        """Create a task."""
        coordinator = _get_coordinator(hass)
        if not coordinator:
            raise HomeAssistantError("Meitheal is not available")

        try:
            await coordinator.async_create_task(
                title=tool_input.tool_args["title"],
                description=tool_input.tool_args.get("description"),
            )
        except Exception as err:
            raise HomeAssistantError(f"Failed to create task: {err}") from err

        return {
            "success": True,
            "message": f"Task '{tool_input.tool_args['title']}' created",
        }


class CompleteTaskTool(Tool):
    """Mark a Meitheal task as done."""

    name = "meitheal_complete_task"
    description = (
        "Mark a task as done/completed in Meitheal. "
        "You can specify the task by ID or by title. "
        "Use this when the user says 'done', 'complete', 'finished', or 'mark as done'."
    )
    parameters = vol.Schema(
        {
            vol.Optional("task_id", description="Task ID to complete"): str,
            vol.Optional("title", description="Task title to find and complete"): str,
        }
    )

    async def async_call(
        self,
        hass: HomeAssistant,
        tool_input: ToolInput,
        llm_context: LLMContext,
    ) -> JsonObjectType:
        """Complete a task."""
        coordinator = _get_coordinator(hass)
        if not coordinator:
            raise HomeAssistantError("Meitheal is not available")

        task_id = tool_input.tool_args.get("task_id")
        title = tool_input.tool_args.get("title")

        if not task_id and not title:
            raise HomeAssistantError("Provide either task_id or title")

        try:
            await coordinator.async_complete_task(task_id=task_id, title=title)
        except Exception as err:
            raise HomeAssistantError(f"Failed to complete task: {err}") from err

        return {"success": True, "message": "Task marked as done"}


class UpdateTaskTool(Tool):
    """Update a Meitheal task's fields."""

    name = "meitheal_update_task"
    description = (
        "Update a task in Meitheal. You can change the priority, due date, "
        "description, status, or title. You need the task ID — use "
        "meitheal_search_tasks first to find it. "
        "Use this when the user says 'change', 'update', 'set priority', "
        "'reschedule', or 'modify'."
    )
    parameters = vol.Schema(
        {
            vol.Required("task_id", description="Task ID to update"): str,
            vol.Optional("title", description="New title"): str,
            vol.Optional("description", description="New description"): str,
            vol.Optional(
                "priority",
                description="New priority (1=urgent, 2=high, 3=medium, 4=low, 5=lowest)",
            ): vol.All(int, vol.Range(min=1, max=5)),
            vol.Optional(
                "status",
                description="New status: backlog, todo, in_progress, or done",
            ): vol.In(["backlog", "todo", "in_progress", "done"]),
            vol.Optional("due_date", description="New due date in ISO 8601 format (YYYY-MM-DD)"): str,
        }
    )

    async def async_call(
        self,
        hass: HomeAssistant,
        tool_input: ToolInput,
        llm_context: LLMContext,
    ) -> JsonObjectType:
        """Update task fields."""
        coordinator = _get_coordinator(hass)
        if not coordinator:
            raise HomeAssistantError("Meitheal is not available")

        task_id = tool_input.tool_args["task_id"]
        updates: dict[str, Any] = {}
        for field in ("title", "description", "priority", "status", "due_date"):
            if field in tool_input.tool_args:
                updates[field] = tool_input.tool_args[field]

        if not updates:
            raise HomeAssistantError("No fields to update — provide at least one field")

        try:
            await coordinator.async_update_task(task_id, updates)
        except Exception as err:
            raise HomeAssistantError(f"Failed to update task: {err}") from err

        return {
            "success": True,
            "message": f"Task {task_id} updated",
            "updated_fields": list(updates.keys()),
        }


class GetOverdueTasksTool(Tool):
    """List overdue tasks from Meitheal."""

    name = "meitheal_get_overdue"
    description = (
        "Get a list of all overdue tasks — tasks with a due date "
        "in the past that haven't been completed yet. "
        "Use this when the user asks 'what's overdue?', 'any late tasks?', "
        "or 'what did I miss?'."
    )
    parameters = vol.Schema({})

    async def async_call(
        self,
        hass: HomeAssistant,
        tool_input: ToolInput,
        llm_context: LLMContext,
    ) -> JsonObjectType:
        """Fetch overdue tasks."""
        coordinator = _get_coordinator(hass)
        if not coordinator or not coordinator.data:
            return {"tasks": [], "count": 0}

        overdue = [
            {
                "id": t.id,
                "title": t.title,
                "due_date": t.due_date,
                "priority": t.priority,
            }
            for t in coordinator.data.tasks
            if t.is_overdue
        ]
        return {"tasks": overdue, "count": len(overdue)}


class GetTodaysTasksTool(Tool):
    """Get tasks due today from Meitheal."""

    name = "meitheal_get_todays_tasks"
    description = (
        "Get a list of tasks due today — what's on the agenda right now. "
        "Also includes any overdue tasks. "
        "Use this when the user asks 'what's on my plate?', 'what do I need to do today?', "
        "'today's tasks', or 'what's due today?'."
    )
    parameters = vol.Schema({})

    async def async_call(
        self,
        hass: HomeAssistant,
        tool_input: ToolInput,
        llm_context: LLMContext,
    ) -> JsonObjectType:
        """Fetch today's tasks."""
        coordinator = _get_coordinator(hass)
        if not coordinator or not coordinator.data:
            return {"tasks": [], "count": 0, "overdue_count": 0}

        today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        todays = []
        overdue = []
        for t in coordinator.data.tasks:
            if t.status == "done":
                continue
            if t.is_overdue:
                overdue.append({
                    "id": t.id,
                    "title": t.title,
                    "due_date": t.due_date,
                    "priority": t.priority,
                    "is_overdue": True,
                })
            elif t.due_date and t.due_date.startswith(today_str):
                todays.append({
                    "id": t.id,
                    "title": t.title,
                    "due_date": t.due_date,
                    "priority": t.priority,
                    "is_overdue": False,
                })

        combined = overdue + todays
        return {
            "tasks": combined,
            "count": len(combined),
            "overdue_count": len(overdue),
            "today_count": len(todays),
        }


class GetTaskSummaryTool(Tool):
    """Get a summary of Meitheal task counts."""

    name = "meitheal_task_summary"
    description = (
        "Get a summary of task counts: total tasks, active (not done), "
        "overdue, and completed. "
        "Use this when the user asks 'how many tasks?', 'task status', "
        "'give me an overview', or 'how am I doing?'."
    )
    parameters = vol.Schema({})

    async def async_call(
        self,
        hass: HomeAssistant,
        tool_input: ToolInput,
        llm_context: LLMContext,
    ) -> JsonObjectType:
        """Return task summary."""
        coordinator = _get_coordinator(hass)
        if not coordinator or not coordinator.data:
            return {
                "total": 0,
                "active": 0,
                "overdue": 0,
                "done": 0,
            }

        data = coordinator.data
        done = sum(1 for t in data.tasks if t.status == "done")
        return {
            "total": data.total_count,
            "active": data.active_count,
            "overdue": data.overdue_count,
            "done": done,
        }


class GetCalendarEventsTool(Tool):
    """Get events synced from HA calendar into Meitheal."""

    name = "meitheal_get_calendar_events"
    description = (
        "Get events from the user's Home Assistant calendar that have been "
        "synced into Meitheal. These are calendar appointments and events, "
        "not tasks. Use this when the user asks 'what's on my calendar?', "
        "'any events this week?', or 'show my calendar events'."
    )
    parameters = vol.Schema(
        {
            vol.Optional(
                "days_ahead",
                description="How many days ahead to look (default: 7, max: 30)",
            ): vol.All(int, vol.Range(min=1, max=30)),
        }
    )

    async def async_call(
        self,
        hass: HomeAssistant,
        tool_input: ToolInput,
        llm_context: LLMContext,
    ) -> JsonObjectType:
        """Fetch calendar events."""
        coordinator = _get_coordinator(hass)
        if not coordinator or not coordinator.data:
            return {"events": [], "count": 0, "message": "No calendar data available"}

        days_ahead = tool_input.tool_args.get("days_ahead", 7)
        now = datetime.now(timezone.utc)
        cutoff = now + timedelta(days=days_ahead)
        today_str = now.strftime("%Y-%m-%d")
        cutoff_str = cutoff.strftime("%Y-%m-%d")

        events = []
        for t in coordinator.data.tasks:
            if not getattr(t, "calendar_sync_state", None):
                continue
            if t.calendar_sync_state not in ("synced", "confirmed"):
                continue
            if t.due_date and today_str <= t.due_date[:10] <= cutoff_str:
                events.append(
                    {
                        "title": t.title,
                        "date": t.due_date,
                        "description": t.description or "",
                        "source": "ha_calendar",
                    }
                )

        events.sort(key=lambda e: e["date"])
        return {"events": events, "count": len(events)}


class GetUpcomingEventsTool(Tool):
    """Get upcoming events and tasks for today or this week."""

    name = "meitheal_get_upcoming"
    description = (
        "Get everything coming up — both calendar events and tasks with due dates. "
        "Combines calendar events synced from Home Assistant with Meitheal tasks. "
        "Use this when the user asks 'what's coming up?', 'what's on my schedule?', "
        "'what do I have this week?', or 'any appointments?'."
    )
    parameters = vol.Schema(
        {
            vol.Optional(
                "days_ahead",
                description="How many days ahead to look (default: 7, max: 30)",
            ): vol.All(int, vol.Range(min=1, max=30)),
        }
    )

    async def async_call(
        self,
        hass: HomeAssistant,
        tool_input: ToolInput,
        llm_context: LLMContext,
    ) -> JsonObjectType:
        """Fetch upcoming events and tasks."""
        coordinator = _get_coordinator(hass)
        if not coordinator or not coordinator.data:
            return {"items": [], "count": 0}

        days_ahead = tool_input.tool_args.get("days_ahead", 7)
        now = datetime.now(timezone.utc)
        cutoff = now + timedelta(days=days_ahead)
        today_str = now.strftime("%Y-%m-%d")
        cutoff_str = cutoff.strftime("%Y-%m-%d")

        items = []
        for t in coordinator.data.tasks:
            if t.status == "done":
                continue
            if not t.due_date:
                continue
            due_date_str = t.due_date[:10]
            if due_date_str < today_str or due_date_str > cutoff_str:
                continue

            sync_state = getattr(t, "calendar_sync_state", None)
            is_calendar = sync_state in ("synced", "confirmed")
            items.append(
                {
                    "title": t.title,
                    "date": t.due_date,
                    "type": "calendar_event" if is_calendar else "task",
                    "priority": t.priority,
                    "is_overdue": t.is_overdue,
                }
            )

        items.sort(key=lambda e: e["date"])
        return {
            "items": items,
            "count": len(items),
            "calendar_events": sum(1 for i in items if i["type"] == "calendar_event"),
            "tasks": sum(1 for i in items if i["type"] == "task"),
        }


class DailyBriefingTool(Tool):
    """Smart daily briefing — the 'Good morning' feature.

    Combines tasks, calendar, overdue, and HA context (weather, presence)
    into a single conversational summary. Beats Google/Siri/Alexa briefings
    because it includes Meitheal task data.
    """

    name = "meitheal_daily_briefing"
    description = (
        "Get a comprehensive daily briefing combining today's tasks, calendar events, "
        "overdue items, and Home Assistant context (weather, who's home). "
        "Use this when the user says 'good morning', 'brief me', 'what's my day look like?', "
        "'daily briefing', or 'start my day'."
    )
    parameters = vol.Schema({})

    async def async_call(
        self,
        hass: HomeAssistant,
        tool_input: ToolInput,
        llm_context: LLMContext,
    ) -> JsonObjectType:
        """Build a comprehensive daily briefing."""
        briefing: dict[str, Any] = {}
        now = datetime.now(timezone.utc)
        today_str = now.strftime("%Y-%m-%d")
        hour = now.hour

        # Time-aware greeting
        if hour < 12:
            briefing["greeting"] = "Good morning"
        elif hour < 17:
            briefing["greeting"] = "Good afternoon"
        else:
            briefing["greeting"] = "Good evening"

        briefing["date"] = now.strftime("%A, %B %d")

        # Tasks
        coordinator = _get_coordinator(hass)
        if coordinator and coordinator.data:
            data = coordinator.data
            briefing["tasks"] = {
                "active": data.active_count,
                "overdue": data.overdue_count,
                "total": data.total_count,
            }

            # Today's tasks
            today_tasks = [
                {"title": t.title, "priority": t.priority}
                for t in data.tasks
                if t.status != "done" and t.due_date
                and t.due_date.startswith(today_str)
            ]
            briefing["today_tasks"] = today_tasks[:5]

            # Overdue
            overdue = [
                {"title": t.title, "due_date": t.due_date}
                for t in data.tasks if t.is_overdue
            ]
            briefing["overdue_tasks"] = overdue[:5]

            # High priority items
            urgent = [
                {"title": t.title, "priority": t.priority}
                for t in data.tasks
                if t.status != "done" and t.priority <= 2
            ]
            briefing["urgent_items"] = urgent[:3]

        # HA context — weather
        weather_state = hass.states.get("weather.home")
        if not weather_state:
            # Try common weather entity names
            for entity_id in ("weather.forecast_home", "weather.openweathermap"):
                weather_state = hass.states.get(entity_id)
                if weather_state:
                    break

        if weather_state:
            briefing["weather"] = {
                "condition": weather_state.state,
                "temperature": weather_state.attributes.get("temperature"),
                "unit": weather_state.attributes.get("temperature_unit", "°C"),
            }

        # HA context — who's home (device_tracker/person)
        people_home = []
        for state in hass.states.async_all("person"):
            if state.state == "home":
                name = state.attributes.get("friendly_name", state.entity_id)
                people_home.append(name)
        if people_home:
            briefing["people_home"] = people_home

        return briefing


class DeleteTaskTool(Tool):
    """Delete a task by ID or title (Todoist parity)."""

    name = "meitheal_delete_task"
    description = (
        "Delete a task permanently. Use when the user says 'delete', 'remove', "
        "'get rid of', or 'drop' a task. Search by title for a match if no ID given."
    )
    parameters = vol.Schema(
        {
            vol.Optional(
                "task_id", description="Task ID (if known)"
            ): str,
            vol.Optional(
                "title", description="Task title to find and delete"
            ): str,
        }
    )

    async def async_call(
        self,
        hass: HomeAssistant,
        tool_input: ToolInput,
        llm_context: LLMContext,
    ) -> JsonObjectType:
        """Delete a task."""
        coordinator = _get_coordinator(hass)
        if not coordinator:
            return {"error": "Meitheal is not available"}

        task_id = tool_input.tool_args.get("task_id")
        title = tool_input.tool_args.get("title")

        if not task_id and title and coordinator.data:
            for task in coordinator.data.tasks:
                if task.title.lower() == title.lower():
                    task_id = task.id
                    break

        if not task_id:
            return {"error": f"Could not find task '{title}'"}

        try:
            await coordinator.async_delete_task(task_id)
            return {"status": "deleted", "task_id": task_id, "title": title or ""}
        except Exception as err:
            return {"error": str(err)}


class BatchCompleteTasksTool(Tool):
    """Complete multiple tasks at once (batch operations)."""

    name = "meitheal_batch_complete"
    description = (
        "Complete multiple tasks at once. Use when the user says "
        "'clear all done', 'mark everything as done', 'I finished all my tasks', "
        "or 'complete all X tasks'. Can filter by label, priority, or status. "
        "Also responds to 'what did I finish today?' by listing completed tasks."
    )
    parameters = vol.Schema(
        {
            vol.Optional(
                "action",
                description="'complete' to mark tasks done, 'list_completed' to show what's done",
            ): vol.In(["complete", "list_completed"]),
            vol.Optional("label", description="Only affect tasks with this label"): str,
            vol.Optional("max_priority", description="Only affect tasks with priority <= this (1=urgent)"): int,
            vol.Optional("titles", description="List of specific task titles to complete"): [str],
        }
    )

    async def async_call(
        self,
        hass: HomeAssistant,
        tool_input: ToolInput,
        llm_context: LLMContext,
    ) -> JsonObjectType:
        """Batch complete tasks or list completed ones."""
        coordinator = _get_coordinator(hass)
        if not coordinator or not coordinator.data:
            return {"error": "No task data available"}

        action = tool_input.tool_args.get("action", "complete")
        label = tool_input.tool_args.get("label")
        max_priority = tool_input.tool_args.get("max_priority")
        titles = tool_input.tool_args.get("titles", [])

        if action == "list_completed":
            done = [
                {"title": t.title, "updated": t.updated_at}
                for t in coordinator.data.tasks if t.status == "done"
            ]
            return {"completed_tasks": done[:10], "total_done": len(done)}

        # Batch complete
        targets = []
        for t in coordinator.data.tasks:
            if t.status == "done":
                continue
            if titles and t.title.lower() not in [x.lower() for x in titles]:
                continue
            if label and label.lower() not in [l.lower() for l in t.labels]:
                continue
            if max_priority and t.priority > max_priority:
                continue
            if not titles and not label and not max_priority:
                continue  # Safety: require at least one filter for batch ops
            targets.append(t)

        completed = []
        for t in targets:
            try:
                await coordinator.async_complete_task(task_id=t.id)
                completed.append(t.title)
            except Exception:
                pass

        return {
            "completed": completed,
            "count": len(completed),
            "message": f"Completed {len(completed)} tasks",
        }


# ── LLM API Registration ──

API_PROMPT = (
    "You have access to Meitheal, a cooperative task and life management engine "
    "running as a Home Assistant addon. Meitheal manages the household's tasks, "
    "to-do lists, projects, and calendar events synced from Home Assistant.\n\n"
    "## What You Can Do\n"
    "- **Search tasks** by keyword, status (backlog/todo/in_progress/done), or priority (1-5)\n"
    "- **Create tasks** with a title and optional description\n"
    "- **Complete tasks** by ID or title\n"
    "- **Delete tasks** permanently\n"
    "- **Update tasks** — change priority, due date, status, title, or description\n"
    "- **Batch complete** — mark multiple tasks done by label or priority\n"
    "- **Check overdue tasks** — what's past due\n"
    "- **Get today's tasks** — what's on the agenda right now\n"
    "- **Get a summary** — counts of active, overdue, and completed tasks\n"
    "- **View calendar events** — events synced from HA calendars\n"
    "- **See what's coming up** — combined view of tasks and calendar events\n"
    "- **Daily briefing** — full day overview with weather, tasks, calendar, who's home\n\n"
    "## How to Respond\n"
    "- When the user asks about their tasks, search first, then summarize results naturally.\n"
    "- When they say 'add', 'create', 'remind me to', or 'I need to' — create a task.\n"
    "- When they say 'done', 'complete', or 'finished' — complete the task.\n"
    "- When they say 'delete', 'remove', or 'get rid of' — delete the task.\n"
    "- When they say 'take off my list', 'remove from my shopping list', or 'clear from todo' "
    "— use remove_from_todo_list to delete the task and remove from HA todo lists.\n"
    "- When they ask 'what's overdue?' or 'what did I miss?' — check overdue tasks.\n"
    "- When they ask 'what's on my plate?' or 'today's tasks' — get today's tasks.\n"
    "- When they ask 'what's on my calendar?' or 'any events?' — get calendar events.\n"
    "- When they ask 'what's coming up?' or 'what's my schedule?' — get upcoming items.\n"
    "- When they say 'good morning', 'brief me', or 'start my day' — give a daily briefing.\n"
    "- When they ask 'what did I finish?' — list completed tasks.\n"
    "- Priority levels: 1=urgent, 2=high, 3=medium (default), 4=low, 5=lowest.\n"
    "- When a task title includes '#label', extract and set the label.\n"
    "- When a task mentions 'urgent' or 'important', set priority to 1.\n"
    "- Always confirm actions back to the user.\n"
    "- Keep responses concise and conversational.\n"
)


class LinkTaskTool(Tool):
    """Create a Jira-style link between two tasks."""

    name = "meitheal_link_task"
    description = (
        "Create a relationship link between two tasks. "
        "Link types: related_to, blocked_by, blocks, duplicates, duplicated_by. "
        "Use when the user says 'link X to Y', 'X is blocked by Y', or 'X duplicates Y'."
    )
    parameters = vol.Schema(
        {
            vol.Required("source_task_id"): str,
            vol.Required("target_task_id"): str,
            vol.Required("link_type"): vol.In(
                ["related_to", "blocked_by", "blocks", "duplicates", "duplicated_by"]
            ),
        }
    )

    async def async_call(
        self,
        hass: HomeAssistant,
        tool_input: ToolInput,
        llm_context: LLMContext,
    ) -> JsonObjectType:
        """Create a task link."""
        coordinator = _get_coordinator(hass)
        if not coordinator:
            return {"error": "Meitheal not available"}
        result = await coordinator.async_link_task(
            source_task_id=tool_input.tool_args["source_task_id"],
            target_task_id=tool_input.tool_args["target_task_id"],
            link_type=tool_input.tool_args["link_type"],
        )
        return result


class UnlinkTaskTool(Tool):
    """Remove a link between two tasks."""

    name = "meitheal_unlink_task"
    description = (
        "Remove a relationship link between tasks by link ID. "
        "Use when the user says 'remove link' or 'unlink tasks'."
    )
    parameters = vol.Schema(
        {
            vol.Required("task_id"): str,
            vol.Required("link_id"): str,
        }
    )

    async def async_call(
        self,
        hass: HomeAssistant,
        tool_input: ToolInput,
        llm_context: LLMContext,
    ) -> JsonObjectType:
        """Remove a task link."""
        coordinator = _get_coordinator(hass)
        if not coordinator:
            return {"error": "Meitheal not available"}
        result = await coordinator.async_unlink_task(
            task_id=tool_input.tool_args["task_id"],
            link_id=tool_input.tool_args["link_id"],
        )
        return result


class GetTaskLinksTool(Tool):
    """Get all links for a task."""

    name = "meitheal_get_task_links"
    description = (
        "Get all relationship links for a task — both outbound and inbound. "
        "Shows what tasks are related, blocked by, or duplicated. "
        "Use when the user asks 'what's linked to X' or 'show dependencies'."
    )
    parameters = vol.Schema(
        {
            vol.Required("task_id"): str,
        }
    )

    async def async_call(
        self,
        hass: HomeAssistant,
        tool_input: ToolInput,
        llm_context: LLMContext,
    ) -> JsonObjectType:
        """Get task links."""
        coordinator = _get_coordinator(hass)
        if not coordinator:
            return {"error": "Meitheal not available"}
        result = await coordinator.async_get_task_links(
            task_id=tool_input.tool_args["task_id"],
        )
        return result


class RemoveFromTodoListTool(Tool):
    """Remove a task from synced HA todo lists by deleting it.

    Deletes the task from Meitheal, which triggers outbound sync
    cleanup to remove the corresponding item from all synced HA
    todo entities.
    """

    name = "meitheal_remove_from_todo_list"
    description = (
        "Remove a task from synced Home Assistant todo lists. "
        "This deletes the task from Meitheal and removes it from all synced HA todo entities. "
        "Use when the user says 'take X off my list', 'remove X from the shopping list', "
        "'clear X from my todo', or 'take that off the list'. "
        "Provide task_id (UUID) or title (fuzzy match) to identify the task."
    )
    parameters = vol.Schema(
        {
            vol.Optional("task_id"): str,
            vol.Optional("title"): str,
        }
    )

    async def async_call(
        self,
        hass: HomeAssistant,
        tool_input: ToolInput,
        llm_context: LLMContext,
    ) -> JsonObjectType:
        """Remove task from Meitheal and all synced HA todo lists."""
        coordinator = _get_coordinator(hass)
        if not coordinator:
            return {"error": "Meitheal not available"}

        task_id = tool_input.tool_args.get("task_id")
        title = tool_input.tool_args.get("title")

        if not task_id and not title:
            return {"error": "Provide task_id or title"}

        # Resolve by title if no ID given
        if not task_id and title:
            tasks = await coordinator.async_search_tasks(title)
            if not tasks:
                return {"error": f"No task found matching '{title}'"}
            task_id = tasks[0].get("id")

        if not task_id:
            return {"error": "Could not resolve task"}

        result = await coordinator.async_delete_task(task_id)
        if isinstance(result, dict) and result.get("error"):
            return result

        return {
            "success": True,
            "message": f"Removed task from Meitheal and all synced todo lists",
            "task_id": task_id,
        }


class MeithealLLMAPI(API):
    """Meitheal LLM API — Exposes task tools to HA conversation agents."""

    async def async_get_api_instance(
        self, llm_context: LLMContext
    ) -> APIInstance:
        """Return API instance with all Meitheal tools."""
        return APIInstance(
            api=self,
            api_prompt=API_PROMPT,
            llm_context=llm_context,
            tools=[
                SearchTasksTool(),
                GetTaskDetailsTool(),
                CreateTaskTool(),
                CompleteTaskTool(),
                UpdateTaskTool(),
                DeleteTaskTool(),
                BatchCompleteTasksTool(),
                GetOverdueTasksTool(),
                GetTodaysTasksTool(),
                GetTaskSummaryTool(),
                GetCalendarEventsTool(),
                GetUpcomingEventsTool(),
                DailyBriefingTool(),
                LinkTaskTool(),
                UnlinkTaskTool(),
                GetTaskLinksTool(),
                RemoveFromTodoListTool(),
            ],
        )


def async_register_llm_api(hass: HomeAssistant, entry_id: str) -> callable:
    """Register Meitheal LLM API with HA Core.

    Returns an unregister callable for cleanup on unload.
    """
    api = MeithealLLMAPI(
        hass=hass,
        api_id=f"meitheal_tasks-{entry_id}",
        name="Meitheal Tasks",
    )
    unreg = llm.async_register_api(hass, api)
    _LOGGER.info("Registered Meitheal LLM API (entry: %s)", entry_id)
    return unreg
