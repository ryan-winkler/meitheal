"""Meitheal device triggers for HA automations.

Allows users to create automations in the HA UI that trigger on
Meitheal events: task created, completed, deleted, updated, overdue,
and board changes.

Example automation:
    trigger:
      platform: device
      device_id: <meitheal_device>
      domain: meitheal
      type: task_completed
    action:
      service: notify.mobile_app
      data:
        message: "Task completed!"

@see https://developers.home-assistant.io/docs/device_automation_trigger
"""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components.device_automation import DEVICE_TRIGGER_BASE_SCHEMA
from homeassistant.const import CONF_DEVICE_ID, CONF_DOMAIN, CONF_PLATFORM, CONF_TYPE
from homeassistant.core import CALLBACK_TYPE, HomeAssistant
from homeassistant.helpers.trigger import TriggerActionType, TriggerInfo
from homeassistant.helpers.typing import ConfigType

from .const import DOMAIN

# Trigger types that appear in the HA automation UI
TRIGGER_TYPES = {
    "task_created",
    "task_completed",
    "task_updated",
    "task_deleted",
    "task_overdue",
    "board_updated",
}

# Map trigger types to event types on hass.bus
TRIGGER_TO_EVENT = {
    "task_created": "meitheal_task_created",
    "task_completed": "meitheal_task_completed",
    "task_updated": "meitheal_task_updated",
    "task_deleted": "meitheal_task_deleted",
    "task_overdue": "meitheal_task_overdue",
    "board_updated": "meitheal_board_updated",
}

TRIGGER_SCHEMA = DEVICE_TRIGGER_BASE_SCHEMA.extend(
    {
        vol.Required(CONF_TYPE): vol.In(TRIGGER_TYPES),
    }
)


async def async_get_triggers(
    hass: HomeAssistant, device_id: str
) -> list[dict[str, Any]]:
    """List available triggers for Meitheal devices."""
    triggers = []
    for trigger_type in TRIGGER_TYPES:
        triggers.append(
            {
                CONF_PLATFORM: "device",
                CONF_DEVICE_ID: device_id,
                CONF_DOMAIN: DOMAIN,
                CONF_TYPE: trigger_type,
            }
        )
    return triggers


async def async_attach_trigger(
    hass: HomeAssistant,
    config: ConfigType,
    action: TriggerActionType,
    trigger_info: TriggerInfo,
) -> CALLBACK_TYPE:
    """Attach a trigger by subscribing to the corresponding hass.bus event."""
    trigger_type = config[CONF_TYPE]
    event_type = TRIGGER_TO_EVENT.get(trigger_type, f"meitheal_{trigger_type}")

    event_config = {
        CONF_PLATFORM: "event",
        "event_type": event_type,
        "event_data": {"domain": DOMAIN},
    }

    from homeassistant.components.homeassistant.triggers.event import (
        async_attach_trigger as async_attach_event_trigger,
    )

    return await async_attach_event_trigger(
        hass, event_config, action, trigger_info, platform_type="device"
    )
