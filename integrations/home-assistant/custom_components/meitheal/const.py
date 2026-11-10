"""Meitheal Home Assistant integration — constants."""

from datetime import timedelta

from homeassistant.const import Platform

DOMAIN = "meitheal"
PLATFORMS = [Platform.TODO, Platform.SENSOR, Platform.BINARY_SENSOR]

# Supervisor App bridge defaults. Discovery provides the installed hostname.
DEFAULT_HOST = "local-meitheal"
DEFAULT_PORT = 3000
CONF_API_TOKEN = "api_token"

# Polling interval for DataUpdateCoordinator
SCAN_INTERVAL = timedelta(seconds=30)

# Service names
SERVICE_CREATE_TASK = "create_task"
SERVICE_COMPLETE_TASK = "complete_task"
SERVICE_SYNC_TODO = "sync_todo"
SERVICE_SEARCH_TASKS = "search_tasks"
SERVICE_GET_OVERDUE_TASKS = "get_overdue_tasks"
SERVICE_COMPLETE_TASK_BY_TAG = "complete_task_by_tag"

# Meitheal task statuses
STATUS_BACKLOG = "backlog"
STATUS_TODO = "todo"
STATUS_IN_PROGRESS = "in_progress"
STATUS_DONE = "done"
STATUS_CANCELLED = "cancelled"
