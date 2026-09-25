"""Mocked controller tests; these are not real model capability evidence."""

from __future__ import annotations

from typing import Any

import pytest
from test_visualization_and_tools import copper_snapshot

from chem_workbench import orchestrator
from chem_workbench.tool_gateway import invoke_tool


def _model() -> dict[str, Any]:
    return {"available": True, "model_id": "test-double-only", "key": "test-double-only"}


@pytest.fixture(autouse=True)
def typed_requirements_double(monkeypatch):
    """These dispatch tests isolate the controller after requirements extraction.

    The actual two-stage protocol and extraction failure tests live in test_intent.
    """

    def requirements(messages, model_id, start):
        import json

        objective = json.loads(messages[-1]["content"])["objective"]
        return {
            "operation": "copper_scale_scan" if objective == "Prepare a draft" else "inspect",
            "targets": ["fcc_copper"],
            "geometry_source": "supplied_periodic",
            "scale_factors": [],
            "method": "",
            "basis": "",
            "phase": "",
            "temperature_kelvin": None,
            "charge": None,
            "multiplicity": None,
            "execution_requested": False,
            "authority_override_requested": False,
            "missing_information": [],
            "unsupported_requirements": [],
            "disposition": "request_tool",
            "clarification": "",
            "request_summary": objective,
        }, 0

    monkeypatch.setattr(orchestrator, "request_requirements", requirements)


def test_model_and_direct_proposal_have_identical_semantics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(orchestrator, "model_status", _model)
    actions = iter(
        [
            {
                "action": "plan_cu_lattice_scan",
                "object_id": "fcc_copper",
                "scale_factors": [0.98, 1.0, 1.02],
                "message": "Draft a bounded batch.",
            },
            {"action": "final", "object_id": "", "scale_factors": [], "message": "Draft prepared."},
        ]
    )
    monkeypatch.setattr(orchestrator, "request_action", lambda *args: next(actions))
    snapshot = copper_snapshot()
    record = orchestrator.orchestrate("Prepare a draft", snapshot)
    direct = invoke_tool(
        "plan_cu_lattice_scan",
        {"object_id": "fcc_copper", "scale_factors": [0.98, 1.0, 1.02]},
        snapshot,
    )
    assert record["trace"][0]["output"]["data"] == direct["data"]
    assert record["state"] == "REPORTED"
    assert record["execution_authorized"] is False
    assert record["interpretation_verified"] is False


def test_unavailable_model_does_not_fall_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        orchestrator, "model_status", lambda: {"available": False, "message": "Offline"}
    )
    with pytest.raises(ValueError, match="MODEL_UNAVAILABLE"):
        orchestrator.orchestrate("Prepare a draft", copper_snapshot())


def test_repeated_invalid_calls_are_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(orchestrator, "model_status", _model)
    monkeypatch.setattr(
        orchestrator,
        "request_action",
        lambda *args: {
            "action": "object_inspect",
            "object_id": "another-project",
            "scale_factors": [],
            "message": "Invalid reference test double",
        },
    )
    record = orchestrator.orchestrate("Inspect", copper_snapshot())
    assert record["state"] == "NEEDS_INPUT"
    assert record["trace"] == []
    assert record["stop_origin"] == "host_validation"
    assert record["model_action"]["object_id"] == "another-project"


def test_host_never_reports_rejected_tools_as_success(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(orchestrator, "model_status", _model)
    actions = iter(
        [
            {
                "action": "object_inspect",
                "object_id": "foreign",
                "scale_factors": [],
                "message": "",
            },
            {"action": "final", "object_id": "", "scale_factors": [], "message": "I succeeded"},
        ]
    )
    monkeypatch.setattr(orchestrator, "request_action", lambda *args: next(actions))
    assert orchestrator.orchestrate("Inspect", copper_snapshot())["state"] == "NEEDS_INPUT"


def test_busy_model_has_no_second_invocation() -> None:
    orchestrator.MODEL_LOCK.acquire()
    try:
        with pytest.raises(ValueError, match="BUDGET_EXCEEDED"):
            orchestrator.orchestrate("Inspect", copper_snapshot())
    finally:
        orchestrator.MODEL_LOCK.release()


def test_schema_repair_has_an_independent_one_attempt_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(orchestrator, "model_status", _model)
    calls = []

    def invalid(*args):
        calls.append(args)
        raise ValueError("INVALID_MODEL_OUTPUT: malformed syntax")

    monkeypatch.setattr(orchestrator, "request_action", invalid)
    with pytest.raises(ValueError, match="INVALID_MODEL_OUTPUT"):
        orchestrator.orchestrate("Inspect the structure", copper_snapshot())
    assert len(calls) == 2


def test_sampling_schema_keeps_all_inspectable_declarations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(orchestrator, "model_status", _model)
    schemas = []

    def reply(messages, model_id, timeout, schema):
        schemas.append(schema)
        return {
            "action": "needs_input",
            "object_id": "",
            "scale_factors": [],
            "message": "Test stop",
        }

    monkeypatch.setattr(orchestrator, "request_action", reply)
    orchestrator.orchestrate("Inspect", copper_snapshot())
    declared = {o["id"] for o in copper_snapshot().document["objects"]}
    inspect = next(
        b for b in schemas[0]["anyOf"] if b["properties"]["action"]["const"] == "object_inspect"
    )
    assert set(inspect["properties"]["object_id"]["enum"]) == declared


def test_truncated_response_uses_only_one_repair(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(orchestrator, "model_status", _model)
    calls = []

    def truncated(*args):
        calls.append(args)
        raise ValueError("MODEL_OUTPUT_LIMIT: action was truncated")

    monkeypatch.setattr(orchestrator, "request_action", truncated)
    with pytest.raises(ValueError, match="MODEL_OUTPUT_LIMIT"):
        orchestrator.orchestrate("Inspect fcc_copper", copper_snapshot())
    assert len(calls) == 2


def test_provider_failure_remains_an_observed_attempt(monkeypatch: pytest.MonkeyPatch) -> None:
    def offline(*args, **kwargs):
        raise ValueError("MODEL_UNAVAILABLE: disconnected")

    monkeypatch.setattr(orchestrator, "local_request", offline)
    orchestrator.MODEL_METRICS.calls = []
    with pytest.raises(ValueError, match="MODEL_UNAVAILABLE"):
        orchestrator.request_action([], "test", 1)
    attempt = orchestrator.MODEL_METRICS.calls[0]
    assert attempt["schema_valid"] is None
    assert attempt["outcome"] == "request_failed"
    assert "disconnected" in attempt["error"]


@pytest.mark.parametrize(
    "error, code",
    [
        (TimeoutError("timed out"), "MODEL_TIMEOUT"),
        (ConnectionRefusedError("refused"), "MODEL_UNAVAILABLE"),
    ],
)
def test_transport_timeout_is_distinct_from_unavailable_provider_and_closes_connection(
    monkeypatch, error, code
):
    class Connection:
        closed = False

        def request(self, *args):
            pass

        def getresponse(self):
            raise error

        def close(self):
            self.closed = True

    connection = Connection()
    monkeypatch.setattr(orchestrator.http.client, "HTTPConnection", lambda *a, **kw: connection)
    orchestrator.MODEL_METRICS.calls = []
    with pytest.raises(ValueError, match=code):
        orchestrator.request_action([], "test", 1)
    assert connection.closed
    assert len(orchestrator.MODEL_METRICS.calls) == 1
    assert orchestrator.MODEL_METRICS.calls[0]["error"].startswith(code)


@pytest.mark.parametrize(
    "response",
    [
        {"choices": [None]},
        {"choices": [], "usage": ["unexpected"]},
        {"choices": [{"message": {}}], "usage": {"completion_tokens_details": [0]}},
    ],
)
def test_malformed_provider_shapes_preserve_failure_telemetry(monkeypatch, response):
    monkeypatch.setattr(orchestrator, "local_request", lambda *a, **kw: response)
    orchestrator.MODEL_METRICS.calls = []
    with pytest.raises(ValueError, match="INVALID_MODEL_OUTPUT"):
        orchestrator.request_action([], "test", 1)
    call = orchestrator.MODEL_METRICS.calls[0]
    assert call["schema_valid"] is False
    assert call["outcome"] == "request_failed"
    assert call["error"]


@pytest.mark.parametrize(
    "inventory",
    [
        {"models": None},
        {"models": [{"key": orchestrator.MODEL_KEY, "loaded_instances": [None]}]},
    ],
)
def test_malformed_model_inventory_is_unavailable(monkeypatch, inventory):
    monkeypatch.delenv("CHEM_MODEL_KEY", raising=False)
    monkeypatch.setattr(orchestrator, "local_request", lambda *a: inventory)
    status = orchestrator.model_status()
    assert status["available"] is False
    assert "INVALID_MODEL_INVENTORY" in status["message"]


def test_late_model_response_cannot_dispatch_a_tool(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(orchestrator.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(orchestrator, "model_status", _model)

    def late(*args):
        clock[0] = 101
        return {
            "action": "object_inspect",
            "object_id": "fcc_copper",
            "scale_factors": [],
            "message": "Inspect",
        }

    monkeypatch.setattr(orchestrator, "request_action", late)
    record = orchestrator.orchestrate("Inspect fcc_copper", copper_snapshot())
    assert record["state"] == "BUDGET_EXCEEDED"
    assert record["trace"] == []
    assert record["model_action"]["action"] == "object_inspect"
    assert record["stop_origin"] == "host_budget"
