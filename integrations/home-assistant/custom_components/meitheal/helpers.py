"""Meitheal Home Assistant integration — shared helpers.

Common patterns extracted per IQS rule `common-modules`.
"""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.device_registry import DeviceEntryType
from homeassistant.helpers.entity import DeviceInfo

from .const import DOMAIN

# IQS rule: parallel-updates — serialise platform updates to avoid
# concurrent REST calls to the single-threaded Meitheal addon.
PARALLEL_UPDATES = 1


def device_info(entry: ConfigEntry) -> DeviceInfo:
    """Return shared device info for all Meitheal entities.

    Identifier MUST match the device registered in __init__.py
    (DOMAIN, "meitheal_hub") so entities group under the same device.
    """
    return DeviceInfo(
        identifiers={(DOMAIN, "meitheal_hub")},
        name="Meitheal",
        manufacturer="Coolock Village",
        model="Task Engine",
        entry_type=DeviceEntryType.SERVICE,
        configuration_url="https://github.com/ryan-winkler/meitheal",
    )
