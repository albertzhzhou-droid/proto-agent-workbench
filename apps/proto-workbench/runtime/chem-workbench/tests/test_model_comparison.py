"""Supplemental comparisons preserve failed retries and immutable source evidence."""

from __future__ import annotations

import copy
import json
import runpy
from pathlib import Path

import pytest

from chem_workbench import orchestrator
from chem_workbench.visualization import content_hash

ROOT = Path(__file__).resolve().parents[1]
COMPARISON = runpy.run_path(str(ROOT / "scripts/summarize_model_comparison.py"))


def row(identifier, calls, *, record=None, native=False, attempted=True, outcome="error"):
    return {
        "id": identifier,
        "provider_calls": calls,
        "record": record,
        "attempted": attempted,
        "outcome": outcome,
        "score": {"native_model_success": native, "passed": native is True},
        "error": None if outcome == "completed" else "failed" if attempted else "not_run",
    }


def test_failed_retry_without_record_stays_in_observed_denominator():
    calls = [{"schema_valid": False, "outcome": "request_failed"}] * 2
    result = COMPARISON["summarize_retry_observations"]([row("failed", calls)])
    assert result["native_success_after_observed_retry"] == {"passed": 0, "total": 1, "rate": 0}
    assert result["retry_calls_observed"] == 1
    assert result["retry_cases_without_final_record"] == 1
    assert result["observation_coverage"]["provider_calls"] == 2


def test_missing_observations_and_unattempted_cases_are_not_invented_retries():
    rows = [
        row("none", [], native=None),
        row("not-run", [], native=None, attempted=False, outcome="not_run"),
        row("intent-only", [{"schema_valid": False}], record={"repairs": 1}),
        row("unknown-schema", [{"schema_valid": None}]),
    ]
    result = COMPARISON["summarize_retry_observations"](rows)
    assert result["native_success_after_observed_retry"]["total"] == 0
    assert result["native_success_after_observed_retry"]["rate"] is None
    coverage = result["observation_coverage"]
    assert coverage["attempted_cases_without_provider_observations"] == 1
    assert coverage["unattempted_cases"] == 1
    assert coverage["cases_with_unknown_first_schema"] == 1
    assert coverage["repair_intent_without_observed_retry"] == 1


def test_successful_repair_and_failed_repair_share_the_same_cohort():
    rows = [
        row(
            "pass",
            [{"schema_valid": False}, {"schema_valid": True}],
            record={"repairs": 1},
            native=True,
            outcome="completed",
        ),
        row("fail", [{"schema_valid": False}, {"schema_valid": False}]),
        row(
            "first",
            [{"schema_valid": True}],
            record={"repairs": 0},
            native=True,
            outcome="completed",
        ),
    ]
    result = COMPARISON["summarize_retry_observations"](rows)
    assert result["native_success_after_observed_retry"] == {"passed": 1, "total": 2, "rate": 0.5}
    assert result["retry_calls_observed"] == 2


@pytest.fixture
def comparison_bundles(monkeypatch, tmp_path):
    runner = runpy.run_path(str(ROOT / "scripts/run_model_evaluation.py"))["run_suite"]
    monkeypatch.setitem(
        runner.__globals__,
        "code_snapshot",
        lambda root, scoring_version=3: {
            "src/chem_workbench/evaluation.py": (
                root / "src/chem_workbench/evaluation.py"
            ).read_text()
        },
    )
    suite = {
        "version": "model-evaluation-suite/v1",
        "name": "comparison-unit-test",
        "review_status": "pending_independent_review",
        "scope": "Fake provider test only",
        "cases": [
            {
                "id": "reject-01",
                "category": "unsupported",
                "objective": "Missing measurement",
                "source": 'chem 0.1\nmolecule water { structure smiles "O" }',
                "attachments": {},
                "expected": {"action": "needs_input", "object_id": "", "scale_factors": []},
            }
        ],
    }
    suite["suite_hash"] = content_hash(suite)

    def fail(*args):
        orchestrator.MODEL_METRICS.calls = [
            {"schema_valid": False, "usage": None, "outcome": "request_failed"},
            {"schema_valid": False, "usage": None, "outcome": "request_failed"},
        ]
        raise ValueError("INVALID_MODEL_OUTPUT: test fake")

    monkeypatch.setattr(orchestrator, "orchestrate", fail)
    for name, key in [("left", "google/gemma-4-e4b"), ("right", "google/gemma-4-e2b")]:
        monkeypatch.setattr(
            orchestrator,
            "model_status",
            lambda key=key: {
                "available": True,
                "key": key,
                "model_id": key,
            },
        )
        runner(copy.deepcopy(suite), tmp_path / name, root=ROOT, scoring_version=3)
    return tmp_path / "left", tmp_path / "right"


def test_comparison_reopens_bundles_keeps_legacy_metrics_and_never_overwrites(
    comparison_bundles, tmp_path
):
    left, right = comparison_bundles
    files = list(left.glob("*.json")) + list(right.glob("*.json"))
    original = {path: path.read_bytes() for path in files}
    result = COMPARISON["compare"](left, right)
    assert result["comparable_inputs_verified"]
    assert not result["promotion_approved"]
    for run in result["runs"]:
        assert run["verification"]["scores_recomputed"]
        assert run["original_v3_metrics"]["repaired_success"]["total"] == 0
        assert (
            run["supplemental_retry_metrics"]["native_success_after_observed_retry"]["total"] == 1
        )
    assert {path: path.read_bytes() for path in files} == original
    output = tmp_path / "supplement.json"
    COMPARISON["write_comparison"](output, result)
    value = json.loads(output.read_text())
    assert value.pop("comparison_hash") == content_hash(value)
    with pytest.raises(FileExistsError):
        COMPARISON["write_comparison"](output, result)
    with pytest.raises(ValueError, match="OUTPUT_INSIDE_IMMUTABLE_BUNDLE"):
        COMPARISON["write_comparison"](left / "supplement.json", result)


def test_comparison_rejects_rehashed_but_different_code_identity(comparison_bundles):
    left, right = comparison_bundles
    source_path = right / "code-snapshot.json"
    sources = json.loads(source_path.read_text())
    sources["changed.py"] = "# different controller snapshot"
    source_path.write_text(json.dumps(sources))
    frozen_path = right / "frozen.json"
    frozen = json.loads(frozen_path.read_text())
    frozen["code_identity"] = {key: content_hash(value) for key, value in sources.items()}
    frozen["freeze_hash"] = content_hash({k: v for k, v in frozen.items() if k != "freeze_hash"})
    frozen_path.write_text(json.dumps(frozen))
    report_path = right / "report.json"
    report = json.loads(report_path.read_text())
    report["freeze_hash"] = frozen["freeze_hash"]
    report["final_code_identity"] = frozen["code_identity"]
    report["report_hash"] = content_hash({k: v for k, v in report.items() if k != "report_hash"})
    report_path.write_text(json.dumps(report))
    with pytest.raises(ValueError, match="COMPARISON_MISMATCH: code_identity"):
        COMPARISON["compare"](left, right)


def test_comparison_rejects_tampered_original_row(comparison_bundles):
    left, right = comparison_bundles
    path = left / "reject-01.json"
    row_data = json.loads(path.read_text())
    row_data["provider_calls"].pop()
    path.write_text(json.dumps(row_data))
    with pytest.raises(ValueError, match="INTEGRITY_MISMATCH"):
        COMPARISON["compare"](left, right)
