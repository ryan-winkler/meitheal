"""Meitheal Home Assistant integration — constants."""

from datetime import timedelta

from homeassistant.const import Platform

DOMAIN = "meitheal"
PLATFORMS = [Platform.TODO, Platform.SENSOR, Platform.BINARY_SENSOR]

# Addon network defaults (internal Docker DNS)
# Supervisor names containers as {REPO}_{SLUG}, but for DNS resolution
# underscores must be replaced with hyphens. The actual hostname is
# dynamically discovered via /addons/self/info at boot and passed
# through Supervisor discovery. These are fallbacks for manual setup.
DEFAULT_HOST = "local-meitheal"
DEFAULT_HOST_STANDALONE = "localhost"
LEGACY_HOST = "local-meitheal-hub"
# Full list of hostnames to try during connection test (manual setup only).
# Ordered by likelihood: local install first, then common repo-hash patterns.
HOSTNAME_CANDIDATES = [
    "local-meitheal",        # Local addon (hyphenated DNS form)
    "local_meitheal",        # Local addon (underscore form, some Supervisor versions)
    "local-meitheal-hub",    # Legacy slug
    "local_meitheal_hub",    # Legacy slug (underscore form)
    "868b2fee-meitheal",     # GitHub repo hash for Coolock-Village/meitheal
    "868b2fee_meitheal",     # GitHub repo hash (underscore form)
    "meitheal",              # Short name (some custom setups)
]
DEFAULT_PORT = 3000

CONF_HOST = "host"
CONF_PORT = "port"

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
