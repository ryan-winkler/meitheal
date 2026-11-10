"""Meitheal backup platform — pre/post-backup hooks for HA Core.

Implements the Home Assistant backup platform so the HA Core backup
system can coordinate with Meitheal before and after creating backups.

Pre-backup: calls the addon's /api/backup/prepare endpoint to flush
the SQLite WAL to disk, ensuring data consistency in the snapshot.

Post-backup: calls the addon's /api/backup/complete endpoint to acknowledge
completion. Preparation checkpoints committed frames but never pauses writes.

@see https://developers.home-assistant.io/docs/core/platform/backup/#adding-support
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import DEFAULT_HOST, DEFAULT_PORT, DOMAIN

if TYPE_CHECKING:
    from .coordinator import MeithealCoordinator

_LOGGER = logging.getLogger(__name__)


def _get_base_url(hass: HomeAssistant) -> str | None:
    """Resolve the Meitheal addon base URL from loaded config entries."""
    entries = hass.config_entries.async_loaded_entries(DOMAIN)
    if not entries:
        return None
    entry = entries[0]
    host = entry.data.get("host", DEFAULT_HOST)
    port = entry.data.get("port", DEFAULT_PORT)
    return f"http://{host}:{port}"


async def async_pre_backup(hass: HomeAssistant) -> None:
    """Prepare Meitheal for backup — flush SQLite WAL to ensure consistency.

    Called by HA Core before creating a backup. Sends a request to the
    Meitheal addon to run PRAGMA wal_checkpoint(TRUNCATE), ensuring the
    on-disk database file is fully consistent for the Supervisor snapshot.
    """
    base_url = _get_base_url(hass)
    if not base_url:
        _LOGGER.debug("No Meitheal config entry loaded — skipping pre-backup")
        return

    session = async_get_clientsession(hass)
    url = f"{base_url}/api/backup/prepare"

    try:
        async with session.post(url, timeout=30) as resp:
            if resp.status == 200:
                _LOGGER.info("Meitheal pre-backup: WAL checkpoint complete")
            else:
                body = await resp.text()
                _LOGGER.warning(
                    "Meitheal pre-backup returned %s: %s", resp.status, body
                )
    except Exception:
        _LOGGER.warning(
            "Meitheal pre-backup: could not reach addon at %s — "
            "backup will proceed with cold snapshot fallback",
            url,
            exc_info=True,
        )


async def async_post_backup(hass: HomeAssistant) -> None:
    """Acknowledge backup completion.

    Called by HA Core after a backup finishes. No write lock is held by
    preparation; this hook is an idempotent completion signal.
    """
    base_url = _get_base_url(hass)
    if not base_url:
        _LOGGER.debug("No Meitheal config entry loaded — skipping post-backup")
        return

    session = async_get_clientsession(hass)
    url = f"{base_url}/api/backup/complete"

    try:
        async with session.post(url, timeout=10) as resp:
            if resp.status == 200:
                _LOGGER.info("Meitheal post-backup: acknowledged")
            else:
                _LOGGER.debug(
                    "Meitheal post-backup returned %s", resp.status
                )
    except Exception:
        _LOGGER.debug(
            "Meitheal post-backup: could not reach addon — non-critical",
            exc_info=True,
        )
