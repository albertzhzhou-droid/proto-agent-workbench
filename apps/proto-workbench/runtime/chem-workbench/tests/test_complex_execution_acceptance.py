"""Execution acceptance scope checks using visible development inputs, no held-out model data."""

from __future__ import annotations

import copy
import runpy
from pathlib import Path
from typing import Any

import pytest

from chem_workbench.tool_gateway import invoke_tool
from chem_workbench.visualization import compile_snapshot, content_hash

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def harness() -> dict[str, Any]:
    return runpy.run_path(str(ROOT / "scripts/verify_complex_model_execution.py"))


def development_read_case() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    source = 'chem 0.1\nmolecule development_aspirin { structure smiles "CC(=O)Oc1ccccc1C(=O)O" }\n'
    snapshot = compile_snapshot(source)
    case = {
        "id": "development-read",
        "family": "admitted_complete",
        "category": "admitted",
        "source": source,
        "attachments": {},
        "expected": {
            "action": "object_inspect",
            "object_id": "development_aspirin",
            "scale_factors": [],
        },
    }
    output = invoke_tool("object_inspect", {"object_id": "development_aspirin"}, snapshot)
    record = {
        "source_hash": snapshot.source_sha256,
        "source_semantic_hash": snapshot.semantic_hash,
        "execution_authorized": False,
        "trace": [{"output": output}],
    }
    record["record_hash"] = content_hash(record)
    row = {"record": record, "score": {"reviewed_model_success": True}}
    row["row_hash"] = content_hash(row)
    return case, row, copy.deepcopy(output["data"])


def test_failed_model_case_never_launches_host_recovery(
    harness: dict[str, Any], tmp_path: Path
) -> None:
    case, row, oracle = development_read_case()
    row["score"]["reviewed_model_success"] = False
    result = harness["complete_case"](case, row, oracle, tmp_path / "failed")
    assert result["passed"] is False
    assert result["job_submission_requested"] is False
    assert "MODEL_CASE_FAILED" in result["failure"]
    assert not (tmp_path / "failed").exists()


@pytest.mark.parametrize(
    "tool", ["plan_water_single_point", "plan_cu_lattice_scan", "capabilities_list"]
)
def test_unrelated_tools_do_not_inflate_complex_completion(
    harness: dict[str, Any], tmp_path: Path, tool: str
) -> None:
    case, row, oracle = development_read_case()
    case["expected"]["action"] = tool
    result = harness["complete_case"](case, row, oracle, tmp_path / "excluded")
    assert result["passed"] is False
    assert "DENOMINATOR_SCOPE" in result["failure"]
    assert result["real_job_launched"] is False


def test_read_completion_is_explicitly_read_scope(harness: dict[str, Any], tmp_path: Path) -> None:
    case, row, oracle = development_read_case()
    result = harness["complete_case"](case, row, oracle, tmp_path / "read")
    assert result["passed"] is True
    assert result["completion_scope"] == "source-bound inspection or coordinate preview"
    assert result["real_job_launched"] is False
    assert result["host_approval_actor"] is None
    assert result["direct_data_hash"] == content_hash(oracle)


def test_changed_oracle_never_counts_as_read_success(
    harness: dict[str, Any], tmp_path: Path
) -> None:
    case, row, oracle = development_read_case()
    oracle["subject_hash"] = "sha256:" + "0" * 64
    result = harness["complete_case"](case, row, oracle, tmp_path / "tampered")
    assert result["passed"] is False
    assert "PARITY_FAILED" in result["failure"]


def test_evidence_comparison_cases_are_outside_completion_denominator(
    harness: dict[str, Any], tmp_path: Path
) -> None:
    case, row, oracle = development_read_case()
    case["family"] = "evidence_comparison"
    result = harness["complete_case"](case, row, oracle, tmp_path / "comparison")
    assert result["passed"] is False
    assert "DENOMINATOR_SCOPE" in result["failure"]


def test_execution_acceptance_output_cannot_be_overwritten(
    harness: dict[str, Any], tmp_path: Path
) -> None:
    output = tmp_path / "existing.json"
    output.write_text('{"preserved": true}', encoding="utf-8")
    with pytest.raises(ValueError, match="OUTPUT_EXISTS"):
        harness["run"](tmp_path / "irrelevant-evaluation", output)
    assert output.read_text(encoding="utf-8") == '{"preserved": true}'


@pytest.mark.parametrize("observation_failure", [None, "read_error", "missing_terminal_result"])
def test_molecular_harness_approval_and_result_path_with_mock_worker(
    harness: dict[str, Any], tmp_path: Path, monkeypatch: Any, observation_failure: str | None
) -> None:
    """Exercise host orchestration only; mocked energy is never scientific evidence."""
    import json

    from chem_workbench import execution

    development = runpy.run_path(str(ROOT / "tests/test_molecular_compute.py"))
    source = development["source"]()
    snapshot = compile_snapshot(source)
    output = invoke_tool(
        "plan_molecular_single_point", {"object_id": "development_aspirin"}, snapshot
    )
    action = {
        "action": "plan_molecular_single_point",
        "object_id": "development_aspirin",
        "scale_factors": [],
    }
    record = {
        "state": "REPORTED",
        "source_hash": snapshot.source_sha256,
        "source_semantic_hash": snapshot.semantic_hash,
        "execution_authorized": False,
        "trace": [{"action": action, "output": output}],
    }
    record["record_hash"] = content_hash(record)
    case = {
        "id": "development-molecular",
        "family": "admitted_complete",
        "category": "admitted",
        "source": source,
        "attachments": {},
        "expected": action,
    }
    row = {"record": record, "score": {"reviewed_model_success": True}}
    row["row_hash"] = content_hash(row)
    monkeypatch.setattr(
        execution,
        "worker_identity",
        lambda worker: {
            "kind": worker.kind,
            "script": worker.script,
            "environment": {"manifest_hash": "mock-development"},
        },
    )
    plan = execution.build_molecular_resolved_plan(output["data"])

    def mock_worker(
        _spec: Any, input_path: Path, output_path: Path, **kwargs: Any
    ) -> dict[str, Any]:
        assert json.loads(input_path.read_text()) == plan["prepared_input"]
        output_path.write_text(json.dumps(development["qc_response"](plan)), encoding="utf-8")
        return {"status": "succeeded", "returncode": 0, "_stdout": b"", "_stderr": b""}

    monkeypatch.setattr(execution, "run_worker", mock_worker)
    if observation_failure:
        wait = harness["complete_case"].__globals__["_wait_for_job"]

        def failed_observation(
            service: Any, reference: str, timeout_seconds: int
        ) -> dict[str, Any]:
            completed = wait(service, reference, timeout_seconds)
            if observation_failure == "read_error":
                raise ValueError("DEVELOPMENT_RESULT_OBSERVATION_FAILED")
            return {"state": "failed", "job": {"job_id": completed["job"]["job_id"]}}

        monkeypatch.setitem(
            harness["complete_case"].__globals__, "_wait_for_job", failed_observation
        )
    result = harness["complete_case"](case, row, output["data"], tmp_path / "mock-molecular")
    if observation_failure:
        assert result["passed"] is False
        assert result["job_submission_requested"] is True
        assert result["real_job_launched"] is None
        expected_failure = (
            "DEVELOPMENT_RESULT_OBSERVATION_FAILED"
            if observation_failure == "read_error"
            else "COMPUTE_DID_NOT_CONVERGE_OR_PASS"
        )
        assert expected_failure in result["failure"]
        return
    assert result["passed"] is True, result.get("failure")
    assert result["logical_parity"] is True
    assert result["resolved_parity"] is True
    assert result["direct_approval_isolated"] is True
    assert result["model_execution_authorized"] is False
    assert result["numeric_provenance_complete"] is True
