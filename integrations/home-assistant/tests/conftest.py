"""Shared fixtures for the Meitheal custom integration tests."""

import pytest


@pytest.fixture(autouse=True)
def enable_legacy_custom_integrations(request: pytest.FixtureRequest) -> None:
    """Enable custom integrations explicitly on the 2026.10 harness."""
    if request.config.pluginmanager.has_plugin("homeassistant"):
        request.getfixturevalue("enable_custom_integrations")
