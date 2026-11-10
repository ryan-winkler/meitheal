"""Check the shipped notification blueprints with the Core automation schema."""

from pathlib import Path

import pytest
from homeassistant.components.automation.config import (
    AUTOMATION_BLUEPRINT_SCHEMA,
    PLATFORM_SCHEMA,
)
from homeassistant.components.blueprint.models import Blueprint, BlueprintInputs
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.template import render_complex
from homeassistant.util.yaml import load_yaml_dict

from custom_components.meitheal import COMPLETE_TASK_SCHEMA

BLUEPRINTS = Path(__file__).resolve().parents[1] / "blueprints"
SENDER = "meitheal_task_notification"
RECEIVER = "meitheal_complete_from_notification"
TASK_ID = "5a74e1f7-d412-4a51-a6fb-c10f51cfe221"
INGRESS_PATH = "/api/hassio_ingress/test/"


def expand_automation(name: str, **inputs: str) -> dict:
    """Resolve required inputs and defaults exactly as Core does on import."""
    path = BLUEPRINTS / f"{name}.yaml"
    blueprint = Blueprint(
        load_yaml_dict(path), expected_domain="automation", schema=AUTOMATION_BLUEPRINT_SCHEMA
    )
    instance = BlueprintInputs(
        blueprint,
        {"use_blueprint": {"path": path.name, "input": {"notify_device": "d" * 32, **inputs}}},
    )
    instance.validate()
    return PLATFORM_SCHEMA(instance.async_substitute())


@pytest.mark.parametrize(("name", "max_runs"), [(SENDER, 5), (RECEIVER, 3)])
async def test_notification_blueprints_are_valid_queued_automations(
    hass: HomeAssistant, name: str, max_runs: int
) -> None:
    config = expand_automation(name)
    assert config["mode"] == "queued"
    assert config["max"] == max_runs


def event_variables(hass: HomeAssistant, config: dict, event_type: str, data: dict) -> dict:
    event = {"event_type": event_type, "data": data}
    return config["variables"].async_render(hass, {"trigger": {"event": event}})


async def test_notification_action_carries_task_id_and_uses_task_permalink(hass: HomeAssistant) -> None:
    sender = expand_automation(SENDER, ingress_path=INGRESS_PATH)
    receiver = expand_automation(RECEIVER)
    assert sender["triggers"][0]["event_type"] == "meitheal_task_created"
    assert receiver["triggers"][0]["event_type"] == "mobile_app_notification_action"
    sender_condition = sender["conditions"][0]["value_template"]
    receiver_condition = receiver["conditions"][0]["value_template"]
    # Core's Mobile App device action converts and renders its notification data this way.
    notification_data = cv.template_complex(sender["actions"][0]["data"])

    web = event_variables(hass, sender, "meitheal_task_created", {
        "source": "meitheal", "task_id": TASK_ID, "title": "Water plants",
    })
    assert sender_condition.async_render(web) is True
    notification = render_complex(notification_data, web)
    assert notification["actions"][0]["uri"] == f"{INGRESS_PATH}tasks?open={TASK_ID}"
    action = notification["actions"][1]["action"]
    assert action == f"MEITHEAL_COMPLETE_{TASK_ID}"

    tap = event_variables(hass, receiver, "mobile_app_notification_action", {"action": action})
    assert receiver_condition.async_render(tap) is True
    completion = receiver["actions"][0]
    assert completion["action"] == "meitheal.complete_task"
    assert COMPLETE_TASK_SCHEMA(render_complex(completion["data"], tap)) == {"task_id": TASK_ID}

    component = event_variables(hass, sender, "meitheal_task_created", {
        "source": "component", "domain": "meitheal", "title": "Water plants",
    })
    assert sender_condition.async_render(component) is True
    assert render_complex(notification_data, component)["actions"] == [
        {"action": "URI", "title": "📊 Dashboard", "uri": INGRESS_PATH},
    ]
    unrelated = event_variables(
        hass, sender, "meitheal_task_created", {"source": "other", "task_id": TASK_ID}
    )
    assert sender_condition.async_render(unrelated) is False

    for invalid in ("MEITHEAL_COMPLETE_", f"MEITHEAL_TASK_DONE_{TASK_ID}", None):
        tap = event_variables(hass, receiver, "mobile_app_notification_action", {"action": invalid})
        assert receiver_condition.async_render(tap) is False
