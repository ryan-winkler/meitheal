"""Shared fixtures for the Meitheal custom integration tests."""

from collections.abc import Iterator
from pathlib import Path
import shutil

import pytest


@pytest.fixture(autouse=True)
def enable_legacy_custom_integrations(request: pytest.FixtureRequest) -> Iterator[None]:
    """Enable custom integrations explicitly on the 2026.10 harness and clean test artifacts."""
    if request.config.pluginmanager.has_plugin("homeassistant"):
        request.getfixturevalue("enable_custom_integrations")
    yield
    shutil.rmtree(Path(__file__).parent / "testing_config" / "custom_sentences", ignore_errors=True)
