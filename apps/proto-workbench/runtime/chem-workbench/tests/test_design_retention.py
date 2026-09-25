"""Failure provenance keeps sampled mistakes separate from host rejection and tool failure."""

from __future__ import annotations

import copy

import pytest

from chem_workbench import design_studio as design
from chem_workbench import orchestrator
from chem_workbench.visualization import content_hash


def request(decision=None, mode="model"):
    return {
        "prompt": "Development fixture",
        "study": design.default_study(),
        "mode": mode,
        "decision": decision,
    }


def sampled(monkeypatch, decision):
    monkeypatch.setattr(
        orchestrator,
        "model_status",
        lambda: {"available": True, "model_id": "test-model", "key": "test-key"},
    )

    def action(*args):
        value = decision
        if orchestrator.MODEL_METRICS.stage == "requirements":
            value = {
                "requested_workflow": decision["workflow"] or "unclear",
                "requested_properties": [],
                "missing_inputs": decision["missing_inputs"],
                "unsupported_requests": decision["unsupported_requests"],
                "disposition": "needs_input" if decision["action"] == "needs_input" else "admitted",
                "message": decision["message"],
            }
        orchestrator.MODEL_METRICS.calls.append(
            {
                "stage": orchestrator.MODEL_METRICS.stage,
                "schema_valid": True,
                "proposed_action": copy.deepcopy(value),
            }
        )
        return copy.deepcopy(value)

    monkeypatch.setattr(orchestrator, "request_action", action)


def test_terminal_retry_failure_persists_both_provider_attempts_and_no_stale_calls(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(
        orchestrator, "model_status", lambda: {"available": True, "model_id": "test-model"}
    )
    orchestrator.MODEL_METRICS.calls = [{"stale": True}]

    def fail(*args):
        orchestrator.MODEL_METRICS.calls.append(
            {
                "stage": orchestrator.MODEL_METRICS.stage,
                "schema_valid": False,
                "error": "INVALID_MODEL_OUTPUT",
            }
        )
        raise ValueError("INVALID_MODEL_OUTPUT: development fixture")

    monkeypatch.setattr(orchestrator, "request_action", fail)
    studio = design.DesignStudio(tmp_path)
    with pytest.raises(design.DesignRunError) as caught:
        studio.run(request())
    record = caught.value.record
    assert record["state"] == "failed" and record["error"]["phase"] == "routing"
    assert len(record["orchestration"]["provider_calls"]) == 2
    assert record["orchestration"]["repairs"] == 1
    assert record["orchestration"]["model_action"] is None
    assert not record["trace"]
    assert studio.read(record["record_hash"]) == record
    assert not orchestrator.MODEL_LOCK.locked() and not design.DESIGN_LOCK.locked()


def test_host_rejection_retains_schema_valid_sample_without_claiming_model_abstention(
    tmp_path, monkeypatch
):
    decision = design.empty_decision("organic_design")
    decision["interfaces"] = ["solid_liquid"]
    sampled(monkeypatch, decision)
    with pytest.raises(design.DesignRunError) as caught:
        design.DesignStudio(tmp_path).run(request())
    record = caught.value.record
    assert record["state"] == "rejected" and record["error"]["phase"] == "host_validation"
    assert record["sampled_decision"] == decision
    assert record["orchestration"]["model_action"]["action"] == "run_workflow"
    assert record["decision"] is None and not record["trace"]


def test_later_module_failure_retains_real_completed_candidate_output(tmp_path, monkeypatch):
    from chem_workbench import design_candidates

    def fail(_spec):
        raise ValueError("DECLARED_TOOL_FAILURE")

    monkeypatch.setattr(design_candidates, "inorganic_candidates", fail)
    decision = design.empty_decision("interface_design")
    decision["interfaces"] = []
    decision["max_candidates"] = 1
    studio = design.DesignStudio(tmp_path)
    with pytest.raises(design.DesignRunError) as caught:
        studio.run(request(decision, mode="direct"))
    record = caught.value.record
    assert record["state"] == "failed" and record["error"]["phase"] == "workflow"
    assert record["organic"]["candidates"] and record["inorganic"] is None
    assert [trace["module"] for trace in record["trace"]] == ["organic_design", "inorganic_design"]
    assert [trace["status"] for trace in record["trace"]] == ["succeeded", "failed"]
    assert record["trace"][1]["seconds"] >= 0
    assert record["record_hash"] == content_hash(
        {k: v for k, v in record.items() if k != "record_hash"}
    )
    assert studio.read(record["record_hash"]) == record


def test_sampled_needs_input_preserves_decision_and_runs_no_modules(tmp_path, monkeypatch):
    decision = design.empty_decision("organic_design")
    decision.update(
        action="needs_input",
        workflow="",
        interfaces=[],
        missing_inputs=["Development missing input"],
    )
    sampled(monkeypatch, decision)
    result = design.DesignStudio(tmp_path).run(request())
    assert result["state"] == "needs_input"
    assert result["decision"] == decision == result["sampled_decision"]
    assert not result["trace"] and result["organic"] is None


def test_explicit_custom_scaffold_replaces_catalog_selector_and_uses_supplied_graph(tmp_path):
    decision = design.empty_decision("organic_design")
    decision.update(scaffold_id="custom", max_candidates=1)
    value = request(decision, mode="direct")
    value["study"]["organic"]["scaffold_smiles"] = "O=C(N[*:1])c1ccc(O)c(O)c1"
    result = design.DesignStudio(tmp_path).run(value)
    assert result["state"] == "completed"
    assert result["plan"]["organic"]["scaffold_id"] == "custom"
    assert result["organic"]["candidates"]
