"""Meitheal custom intents for HA Assist voice control.

Registers custom intents that work with HA's built-in conversation agent
WITHOUT needing an LLM. These use sentence triggers — short, accent-friendly
phrases designed to work across English dialects (Irish, American, British,
Indian, Australian, etc.).

Design principles for accent-friendly triggers:
- Short words: "add", "done", "show", "list", "due", "late"
- Avoid words that sound different across accents
- "tasks" and "task list" are universally clear
- Multiple trigger variants for the same intent
- No complex multi-syllable technical terms

Intents:
- MeithealAddTask: "add {item} to my tasks"
- MeithealDoneTask: "done with {item}" / "mark {item} done"
- MeithealShowTasks: "show my tasks" / "what's on my list"
- MeithealOverdue: "what's late" / "what's overdue"
- MeithealToday: "today's tasks" / "what's due today"
- MeithealSummary: "task count" / "how many tasks"

@see https://developers.home-assistant.io/docs/intent_builtin
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import intent
import voluptuous as vol

from .coordinator import MeithealCoordinator

_LOGGER = logging.getLogger(__name__)

# ── Intent names ──
INTENT_ADD_TASK = "MeithealAddTask"
INTENT_ADD_TASK_PROMPT = "MeithealAddTaskPrompt"
INTENT_DONE_TASK = "MeithealDoneTask"
INTENT_SHOW_TASKS = "MeithealShowTasks"
INTENT_OVERDUE = "MeithealOverdue"
INTENT_TODAY = "MeithealToday"
INTENT_SUMMARY = "MeithealSummary"


def _get_coordinator(hass: HomeAssistant) -> MeithealCoordinator | None:
    """Get the first active Meitheal coordinator.

    Uses config_entries + runtime_data (IQS: runtime-data pattern).
    """
    from .const import DOMAIN

    for entry in hass.config_entries.async_entries(DOMAIN):
        if hasattr(entry, "runtime_data") and isinstance(
            entry.runtime_data, MeithealCoordinator
        ):
            return entry.runtime_data
    return None


class MeithealAddTaskHandler(intent.IntentHandler):
    """Handle 'add X to my tasks' intent."""

    intent_type = INTENT_ADD_TASK
    slot_schema = {
        vol.Required("item"): str,
    }
    platforms = set()

    async def async_handle(self, intent_obj: intent.Intent) -> intent.IntentResponse:
        """Create a task from voice command."""
        hass = intent_obj.hass
        item = intent_obj.slots["item"]["value"]

        coordinator = _get_coordinator(hass)
        if not coordinator:
            response = intent_obj.create_response()
            response.async_set_speech("Sorry, Meitheal is not available right now.")
            return response

        try:
            await coordinator.async_create_task(title=item)
            response = intent_obj.create_response()
            response.async_set_speech(f"Added '{item}' to your tasks.")
            return response
        except Exception as err:
            _LOGGER.error("Failed to create task via intent: %s", err)
            response = intent_obj.create_response()
            response.async_set_speech(f"Sorry, I couldn't add that task. {err}")
            return response


class MeithealDoneTaskHandler(intent.IntentHandler):
    """Handle 'mark X done' / 'done with X' intent."""

    intent_type = INTENT_DONE_TASK
    slot_schema = {
        vol.Required("item"): str,
    }
    platforms = set()

    async def async_handle(self, intent_obj: intent.Intent) -> intent.IntentResponse:
        """Complete a task from voice command."""
        hass = intent_obj.hass
        item = intent_obj.slots["item"]["value"]

        coordinator = _get_coordinator(hass)
        if not coordinator:
            response = intent_obj.create_response()
            response.async_set_speech("Sorry, Meitheal is not available right now.")
            return response

        try:
            await coordinator.async_complete_task(title=item)
            response = intent_obj.create_response()
            response.async_set_speech(f"Done! Marked '{item}' as complete.")
            return response
        except Exception as err:
            _LOGGER.error("Failed to complete task via intent: %s", err)
            response = intent_obj.create_response()
            response.async_set_speech(f"Sorry, I couldn't find a task called '{item}'.")
            return response


class MeithealShowTasksHandler(intent.IntentHandler):
    """Handle 'show my tasks' / 'what's on my list' intent."""

    intent_type = INTENT_SHOW_TASKS
    platforms = set()

    async def async_handle(self, intent_obj: intent.Intent) -> intent.IntentResponse:
        """List active tasks."""
        hass = intent_obj.hass
        coordinator = _get_coordinator(hass)

        if not coordinator or not coordinator.data:
            response = intent_obj.create_response()
            response.async_set_speech("No tasks found.")
            return response

        active = [t for t in coordinator.data.tasks if t.status != "done"]
        if not active:
            response = intent_obj.create_response()
            response.async_set_speech("You're all caught up! No active tasks.")
            return response

        # Limit to 5 for voice readability
        shown = active[:5]
        task_list = ", ".join(t.title for t in shown)
        extra = f" and {len(active) - 5} more" if len(active) > 5 else ""

        response = intent_obj.create_response()
        response.async_set_speech(
            f"You have {len(active)} active tasks. Top ones: {task_list}{extra}."
        )
        return response


class MeithealOverdueHandler(intent.IntentHandler):
    """Handle 'what's overdue' / 'what's late' intent."""

    intent_type = INTENT_OVERDUE
    platforms = set()

    async def async_handle(self, intent_obj: intent.Intent) -> intent.IntentResponse:
        """List overdue tasks."""
        hass = intent_obj.hass
        coordinator = _get_coordinator(hass)

        if not coordinator or not coordinator.data:
            response = intent_obj.create_response()
            response.async_set_speech("No tasks found.")
            return response

        overdue = [t for t in coordinator.data.tasks if t.is_overdue]
        if not overdue:
            response = intent_obj.create_response()
            response.async_set_speech("Nothing overdue. You're on track!")
            return response

        shown = overdue[:5]
        task_list = ", ".join(t.title for t in shown)
        extra = f" and {len(overdue) - 5} more" if len(overdue) > 5 else ""

        response = intent_obj.create_response()
        response.async_set_speech(
            f"You have {len(overdue)} overdue tasks: {task_list}{extra}."
        )
        return response


class MeithealTodayHandler(intent.IntentHandler):
    """Handle 'today's tasks' / 'what's due today' intent."""

    intent_type = INTENT_TODAY
    platforms = set()

    async def async_handle(self, intent_obj: intent.Intent) -> intent.IntentResponse:
        """List today's tasks."""
        from datetime import datetime, timezone

        hass = intent_obj.hass
        coordinator = _get_coordinator(hass)

        if not coordinator or not coordinator.data:
            response = intent_obj.create_response()
            response.async_set_speech("No tasks found.")
            return response

        today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        today_tasks = []
        overdue = []

        for t in coordinator.data.tasks:
            if t.status == "done":
                continue
            if t.is_overdue:
                overdue.append(t)
            elif t.due_date and t.due_date.startswith(today_str):
                today_tasks.append(t)

        parts = []
        if overdue:
            parts.append(f"{len(overdue)} overdue")
        if today_tasks:
            parts.append(f"{len(today_tasks)} due today")

        if not parts:
            response = intent_obj.create_response()
            response.async_set_speech("Nothing due today. Enjoy your day!")
            return response

        all_tasks = overdue + today_tasks
        shown = all_tasks[:5]
        task_list = ", ".join(t.title for t in shown)

        response = intent_obj.create_response()
        response.async_set_speech(
            f"You have {' and '.join(parts)}: {task_list}."
        )
        return response


class MeithealSummaryHandler(intent.IntentHandler):
    """Handle 'how many tasks' / 'task count' intent."""

    intent_type = INTENT_SUMMARY
    platforms = set()

    async def async_handle(self, intent_obj: intent.Intent) -> intent.IntentResponse:
        """Return task summary counts."""
        hass = intent_obj.hass
        coordinator = _get_coordinator(hass)

        if not coordinator or not coordinator.data:
            response = intent_obj.create_response()
            response.async_set_speech("Meitheal has no tasks right now.")
            return response

        data = coordinator.data
        parts = [f"{data.active_count} active"]
        if data.overdue_count:
            parts.append(f"{data.overdue_count} overdue")
        done = data.total_count - data.active_count
        if done:
            parts.append(f"{done} done")

        response = intent_obj.create_response()
        response.async_set_speech(
            f"Task summary: {', '.join(parts)}. {data.total_count} total."
        )
        return response


INTENT_DELETE_TASK = "MeithealDeleteTask"
INTENT_BRIEFING = "MeithealBriefing"


class MeithealDeleteTaskHandler(intent.IntentHandler):
    """Handle 'delete X' / 'remove X from my list' intent."""

    intent_type = INTENT_DELETE_TASK
    slot_schema = {
        vol.Required("item"): str,
    }
    platforms = set()

    async def async_handle(self, intent_obj: intent.Intent) -> intent.IntentResponse:
        """Delete a task from voice command."""
        hass = intent_obj.hass
        item = intent_obj.slots["item"]["value"]

        coordinator = _get_coordinator(hass)
        if not coordinator:
            response = intent_obj.create_response()
            response.async_set_speech("Sorry, Meitheal is not available right now.")
            return response

        # Find by title
        task_id = None
        if coordinator.data:
            for task in coordinator.data.tasks:
                if task.title.lower() == item.lower():
                    task_id = task.id
                    break

        if not task_id:
            response = intent_obj.create_response()
            response.async_set_speech(f"Sorry, I couldn't find a task called '{item}'.")
            return response

        try:
            await coordinator.async_delete_task(task_id)
            response = intent_obj.create_response()
            response.async_set_speech(f"Deleted '{item}' from your tasks.")
            return response
        except Exception as err:
            _LOGGER.error("Failed to delete task via intent: %s", err)
            response = intent_obj.create_response()
            response.async_set_speech(f"Sorry, I couldn't delete that task. {err}")
            return response


class MeithealBriefingHandler(intent.IntentHandler):
    """Handle 'good morning' / 'brief me' / 'start my day' intent."""

    intent_type = INTENT_BRIEFING
    platforms = set()

    async def async_handle(self, intent_obj: intent.Intent) -> intent.IntentResponse:
        """Provide a daily briefing via voice."""
        from datetime import datetime, timezone

        hass = intent_obj.hass
        now = datetime.now(timezone.utc)
        today_str = now.strftime("%Y-%m-%d")
        hour = now.hour

        greeting = "Good morning" if hour < 12 else (
            "Good afternoon" if hour < 17 else "Good evening"
        )

        coordinator = _get_coordinator(hass)
        parts = [f"{greeting}!"]

        if coordinator and coordinator.data:
            data = coordinator.data
            parts.append(f"You have {data.active_count} active tasks")
            if data.overdue_count:
                parts.append(f"{data.overdue_count} overdue")

            # Today's tasks
            today_tasks = [
                t for t in data.tasks
                if t.status != "done" and t.due_date
                and t.due_date.startswith(today_str)
            ]
            if today_tasks:
                names = ", ".join(t.title for t in today_tasks[:3])
                parts.append(f"Due today: {names}")

            # Urgent items
            urgent = [
                t for t in data.tasks
                if t.status != "done" and t.priority <= 2
            ]
            if urgent:
                names = ", ".join(t.title for t in urgent[:2])
                parts.append(f"Urgent: {names}")

        # Weather
        weather = hass.states.get("weather.home") or hass.states.get("weather.forecast_home")
        if weather:
            temp = weather.attributes.get("temperature", "")
            unit = weather.attributes.get("temperature_unit", "°C")
            parts.append(f"Weather: {weather.state}, {temp}{unit}")

        response = intent_obj.create_response()
        response.async_set_speech(". ".join(parts) + ".")
        return response


# Need vol for slot_schema — imported at top of file


class MeithealAddTaskPromptHandler(intent.IntentHandler):
    """Handle bare 'add a task' / 'create a task' — no item slot.

    Responds asking what task to add, since user didn't specify one.
    This catches the common case where someone says 'add a task'
    without saying what the task is.
    """

    intent_type = INTENT_ADD_TASK_PROMPT
    platforms = set()

    async def async_handle(self, intent_obj: intent.Intent) -> intent.IntentResponse:
        """Prompt user for task name."""
        response = intent_obj.create_response()
        response.async_set_speech(
            "Sure! What task would you like to add?"
        )
        return response


def async_register_intents(hass: HomeAssistant) -> None:
    """Register all Meitheal custom intents with HA."""
    intent.async_register(hass, MeithealAddTaskHandler())
    intent.async_register(hass, MeithealAddTaskPromptHandler())
    intent.async_register(hass, MeithealDoneTaskHandler())
    intent.async_register(hass, MeithealShowTasksHandler())
    intent.async_register(hass, MeithealOverdueHandler())
    intent.async_register(hass, MeithealTodayHandler())
    intent.async_register(hass, MeithealSummaryHandler())
    intent.async_register(hass, MeithealDeleteTaskHandler())
    intent.async_register(hass, MeithealBriefingHandler())
    _LOGGER.info("Registered 9 Meitheal custom intents for voice control")
