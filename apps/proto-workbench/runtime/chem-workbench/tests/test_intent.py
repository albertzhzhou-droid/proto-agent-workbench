"""Host contract tests with explicit model doubles, not model capability evidence."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from chem_workbench import orchestrator
from chem_workbench.intent import requirement_issues, validate_intent_action
from chem_workbench.model_context import request_context
from chem_workbench.visualization import compile_snapshot

ROOT = Path(__file__).resolve().parents[1]


def intent(**updates):
    value = {
        "operation": "molecular_single_point",
        "targets": ["caffeine"],
        "geometry_source": "source_generated_conformer",
        "scale_factors": [],
        "method": "HF",
        "basis": "STO-3G",
        "phase": "gas",
        "temperature_kelvin": 0,
        "charge": 0,
        "multiplicity": 1,
        "execution_requested": False,
        "authority_override_requested": False,
        "missing_information": [],
        "unsupported_requirements": [],
        "disposition": "request_tool",
        "clarification": "",
        "request_summary": "Prepare source-generated caffeine HF/STO-3G conformer for review.",
    }
    return {**value, **updates}


def snapshot():
    return compile_snapshot((ROOT / "examples/molecules/caffeine.chem").read_text())


@pytest.mark.parametrize(
    "updates",
    [
        {"method": "B3LYP"},
        {"basis": "6-31G*"},
        {"phase": "liquid"},
        {"temperature_kelvin": 298},
        {"geometry_source": "measured_or_external"},
        {"charge": 1},
        {"multiplicity": 3},
        {"targets": ["caffeine", "aspirin"]},
        {"execution_requested": True},
        {"authority_override_requested": True},
        {"missing_information": ["Measured geometry has not been supplied"]},
    ],
)
def test_typed_requirements_cannot_silently_change_science(updates):
    brief, _ = request_context(snapshot())
    requirements = intent(**updates)
    assert requirement_issues(requirements, brief)
    with pytest.raises(ValueError, match="INTENT_CONFLICT"):
        validate_intent_action(
            requirements,
            {
                "action": "plan_molecular_single_point",
                "object_id": "caffeine",
                "scale_factors": [],
                "message": "Draft",
            },
            brief,
        )


def test_full_scale_membership_survives_extraction_and_is_rejected():
    requirements = intent(
        operation="copper_scale_scan",
        targets=["cell"],
        method="EMT",
        basis="",
        phase="solid",
        charge=None,
        multiplicity=None,
        geometry_source="supplied_periodic",
        scale_factors=[0.95 + i / 100 for i in range(10)],
    )
    brief = [{"object_id": "cell", "admitted_tools": ["plan_cu_lattice_scan"]}]
    before = copy.deepcopy(requirements)
    assert requirement_issues(requirements, brief)
    assert requirements == before
    with pytest.raises(ValueError, match="INTENT_CONFLICT"):
        validate_intent_action(
            requirements,
            {
                "action": "plan_cu_lattice_scan",
                "object_id": "cell",
                "scale_factors": requirements["scale_factors"][:9],
                "message": "Draft",
            },
            brief,
        )


@pytest.mark.parametrize("abstain", [False, True])
def test_two_stages_preserve_sampled_action_and_host_rejection(monkeypatch, abstain):
    monkeypatch.setattr(
        orchestrator, "model_status", lambda: {"available": True, "model_id": "test-double"}
    )
    requirements = intent(geometry_source="measured_or_external")
    action = {
        "action": "needs_input" if abstain else "plan_molecular_single_point",
        "object_id": "" if abstain else "caffeine",
        "scale_factors": [],
        "message": "Missing measured coordinates.",
    }
    replies = iter([requirements, action])

    def response(*args, **kwargs):
        return {
            "model": "test-double",
            "choices": [
                {"finish_reason": "stop", "message": {"content": json.dumps(next(replies))}}
            ],
        }

    monkeypatch.setattr(orchestrator, "local_request", response)
    record = orchestrator.orchestrate(
        "Prepare caffeine using missing measured coordinates.", snapshot()
    )
    assert record["requirements"] == requirements
    assert record["model_action"] == action
    assert record["trace"] == []
    assert record["execution_authorized"] is False
    assert record["stop_origin"] == ("model_abstention" if abstain else "host_validation")
    assert [call["stage"] for call in record["provider_calls"]] == ["requirements", "action"]


def test_requirements_failure_has_one_shared_repair_and_no_dispatch(monkeypatch):
    monkeypatch.setattr(
        orchestrator, "model_status", lambda: {"available": True, "model_id": "test-double"}
    )
    monkeypatch.setattr(
        orchestrator,
        "local_request",
        lambda *a, **kw: {"choices": [{"finish_reason": "stop", "message": {"content": "{"}}]},
    )
    with pytest.raises(ValueError, match="INVALID_MODEL_OUTPUT"):
        orchestrator.orchestrate("Inspect caffeine.", snapshot())
    assert len(orchestrator.MODEL_METRICS.calls) == 2
    assert all(call["stage"] == "requirements" for call in orchestrator.MODEL_METRICS.calls)


def test_explicit_model_clarification_stops_without_an_action_request(monkeypatch):
    monkeypatch.setattr(
        orchestrator, "model_status", lambda: {"available": True, "model_id": "test-double"}
    )
    requirements = intent(
        disposition="needs_input",
        clarification="Supply the measured coordinates.",
        geometry_source="measured_or_external",
        missing_information=["Measured coordinates"],
    )
    calls = []

    def response(*args, **kwargs):
        calls.append(args)
        return {
            "model": "test-double",
            "choices": [
                {"finish_reason": "stop", "message": {"content": json.dumps(requirements)}}
            ],
        }

    monkeypatch.setattr(orchestrator, "local_request", response)
    record = orchestrator.orchestrate(
        "Prepare caffeine using missing measured coordinates.", snapshot()
    )
    assert len(calls) == 1
    assert record["decision_source"] == "requirements"
    assert record["model_action"] == {
        "action": "needs_input",
        "object_id": "",
        "scale_factors": [],
        "message": requirements["clarification"],
    }
    assert record["requirements"] == record["provider_calls"][0]["proposed_action"]
    assert record["trace"] == []
    assert record["stop_origin"] == "model_abstention"
