"""Cost accounting rejects mismatched artifacts and never hides failed or unknown work."""

from __future__ import annotations

import hashlib
import json
import runpy
from pathlib import Path

import pytest

from chem_workbench.visualization import content_hash

ROOT = Path(__file__).resolve().parents[1]
ACCOUNTING = runpy.run_path(str(ROOT / "scripts/summarize_model_acceptance_costs.py"))


def sample_row(identifier, model_seconds=2):
    return {
        "id": identifier,
        "seconds": 3,
        "provider_calls": [
            {
                "seconds": model_seconds,
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            }
        ],
        "record": {"trace": [{"seconds": 1, "output": {"status": "succeeded"}}]},
        "score": {"observed_retry_calls": 0},
        "runtime_observations": {"resources": {"controller_cpu_seconds_delta": 0.2}},
    }


def test_failed_attempt_costs_stay_in_the_verified_completion_denominator():
    rows = [sample_row("completed"), sample_row("model-failed")]
    result = ACCOUNTING["phase_costs"](rows, {"completed"}, {"completed": 8}, {"completed"})
    assert result["attempted_tasks"] == 2 and result["verified_completed_tasks"] == 1
    assert result["observed_phase_work_seconds"] == 14
    assert result["phase_work_seconds_per_verified_completion"] == 14
    assert result["total_tokens_per_verified_completion"] == 30
    assert result["calculator_cpu_seconds"] is None
    assert result["completed_model_path_plus_calculator_phase_elapsed"]["p50_seconds"] == 11


def test_missing_calculator_duration_is_not_zero_or_a_complete_cost():
    result = ACCOUNTING["phase_costs"]([sample_row("case")], {"case"}, {"case": None}, {"case"})
    assert result["observed_phase_work_seconds"] == 3
    assert not result["phase_work_complete"]
    assert result["phase_work_seconds_per_verified_completion"] is None
    assert result["calculator_time"]["expected_observations"] == 1
    assert result["calculator_time"]["observations"] == 0


def test_no_completions_has_no_per_completion_cost():
    result = ACCOUNTING["phase_costs"]([sample_row("failed")], set(), {}, set())
    assert result["phase_work_seconds_per_verified_completion"] is None
    assert result["total_tokens_per_verified_completion"] is None


def test_foreign_calculator_or_completion_cannot_enter_a_denominator():
    with pytest.raises(ValueError, match="COST_DENOMINATOR_MISMATCH"):
        ACCOUNTING["phase_costs"]([sample_row("one")], {"other"}, {}, set())
    with pytest.raises(ValueError, match="COST_DENOMINATOR_MISMATCH"):
        ACCOUNTING["phase_costs"]([sample_row("one")], {"one"}, {"other": 1}, {"one"})


@pytest.mark.parametrize(
    "usage",
    [
        None,
        {"prompt_tokens": True, "completion_tokens": 1, "total_tokens": 2},
        {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 2},
    ],
)
def test_invalid_or_missing_usage_is_not_silently_complete(usage):
    result = ACCOUNTING["token_summary"]([{"usage": usage}])
    assert not result["complete"] and result["observed_calls"] == 0


def test_read_bound_verifies_byte_hash_and_root(tmp_path):
    path = tmp_path / "evidence.json"
    raw = b'{"value": 1}'
    path.write_bytes(raw)
    value, reference = ACCOUNTING["read_bound"](
        path, tmp_path, expected_sha256=hashlib.sha256(raw).hexdigest()
    )
    assert value == {"value": 1} and reference["path"] == str(path.resolve())
    with pytest.raises(ValueError, match="COST_EVIDENCE_FILE_HASH_MISMATCH"):
        ACCOUNTING["read_bound"](path, tmp_path, expected_sha256="0" * 64)
    with pytest.raises(ValueError, match="COST_EVIDENCE_PATH_ESCAPE"):
        ACCOUNTING["read_bound"](path, tmp_path / "different-root")


def test_calculator_duration_is_accepted_only_with_bound_result_and_raw_files(tmp_path):
    input_raw, output_raw = b'{"source": "bound"}', b'{"energy": "-1"}'
    (tmp_path / "input.json").write_bytes(input_raw)
    (tmp_path / "output.json").write_bytes(output_raw)
    result = {
        "job_id": "job",
        "resolved_plan_hash": "plan",
        "execution_status": "succeeded",
        "evidence_eligible": True,
        "execution": {"duration_ms": 1500},
        "input_sha256": hashlib.sha256(input_raw).hexdigest(),
        "output_sha256": hashlib.sha256(output_raw).hexdigest(),
    }
    path = tmp_path / "result.json"
    path.write_text(json.dumps(result), encoding="utf-8")
    completion = {**result, "result_file": str(path), "result_hash": content_hash(result)}
    refs = []
    assert ACCOUNTING["verify_calculator_result"](completion, tmp_path, refs) == 1.5
    assert len(refs) == 3
    (tmp_path / "output.json").write_bytes(b'{"energy": "-2"}')
    with pytest.raises(ValueError, match="COST_EVIDENCE_FILE_HASH_MISMATCH"):
        ACCOUNTING["verify_calculator_result"](completion, tmp_path, [])
