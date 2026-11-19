"""Meitheal diagnostics for HA support/debugging.

Provides debug information when users download diagnostics from the
HA Settings → Integrations → Meitheal → Download Diagnostics button.

@see https://developers.home-assistant.io/docs/core/integration-quality-scale/rules/diagnostics/
"""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.loader import async_get_integration

from .const import DOMAIN
from .coordinator import MeithealCoordinator


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: ConfigEntry
) -> dict[str, Any]:
    """Return diagnostics for a Meitheal config entry."""
    coordinator: MeithealCoordinator = entry.runtime_data

    # Task stats (no PII — just counts and metadata)
    task_stats: dict[str, Any] = {"available": False}
    if coordinator.data and coordinator.shared_entity_delivery and coordinator.last_update_success:
        data = coordinator.data
        statuses: dict[str, int] = {}
        priorities: dict[int, int] = {}
        with_due_date = 0
        with_description = 0
        with_labels = 0
        for t in data.tasks:
            statuses[t.status] = statuses.get(t.status, 0) + 1
            priorities[t.priority] = priorities.get(t.priority, 0) + 1
            if t.due_date:
                with_due_date += 1
            if t.description:
                with_description += 1
            if t.labels:
                with_labels += 1

        task_stats = {
            "available": True,
            "total": data.total_count,
            "active": data.active_count,
            "overdue": data.overdue_count,
            "status_breakdown": statuses,
            "priority_breakdown": priorities,
            "with_due_date": with_due_date,
            "with_description": with_description,
            "with_labels": with_labels,
        }

    # Connection info (redact host for privacy)
    connection_info = {
        "base_url_configured": bool(coordinator.api.origin),
        "session_open": not coordinator.api.session.closed,
        "last_update_success": coordinator.last_update_success,
        "board_configured": coordinator.api.board_id is not None,
        "shared_entity_delivery": coordinator.shared_entity_delivery,
        "update_interval_seconds": coordinator.update_interval.total_seconds()
        if coordinator.update_interval
        else None,
    }

    # Registered services
    services = list(hass.services.async_services_for_domain(DOMAIN))

    # Entity info
    entities = []
    if coordinator.shared_entity_delivery and coordinator.last_update_success:
        registry = er.async_get(hass)
        for entity in er.async_entries_for_config_entry(registry, entry.entry_id):
            state = hass.states.get(entity.entity_id)
            if state is not None:
                entities.append({
                    "entity_id": entity.entity_id,
                    "state": state.state,
                    "attributes_count": len(state.attributes),
                })

    return {
        "entry": {
            "title": entry.title,
            "version": entry.version,
        },
        "task_stats": task_stats,
        "connection": connection_info,
        "services": services,
        "entities": entities,
        "integration_version": str((await async_get_integration(hass, DOMAIN)).version),
    }
