"""Run the staged loop with the real staged recorder and wholly mocked native APIs.

No installed runtime is imported. The existing loop fixture's synthetic result
version is adjusted to its bound spec to exercise complete envelope admission.
This verifies integration mechanics, not native API or scientific accuracy.
"""

from __future__ import annotations

import hashlib
import json

import pytest
from test_refinement_backend import mocked_runtime as mocked_runtime
from test_refinement_backend import successful_gradient
from test_refinement_execution_optimizer_loop import environment as environment

from chem_workbench import molecular_refinement as records
from chem_workbench.refinement_execution.refinement_recorder import StagedGradientRecorder


@pytest.fixture
def integrated(environment):
    state = environment

    def synthetic_bound_result(*args, **kwargs):
        result = successful_gradient(*args, **kwargs)
        result.payload["provenance"]["version"] = state.spec["runtime_binding"]["versions"]["psi4"]
        result.payload["extras"]["synthetic_test_only"] = True
        return result

    state.synthetic_bound_result = synthetic_bound_result
    state.runtime.engine.compute.side_effect = synthetic_bound_result
    state.recorder = StagedGradientRecorder(
        state.spec,
        state.root / "output.json",
        state.root,
        import_module=state.runtime.modules.__getitem__,
    )
    return state


def checked_result(state, reported, error):
    result = state.recorder.result(reported, error)
    assert records.validate_refinement_result(state.spec, result) == result
    for artifact in result["raw_artifacts"]:
        raw = (state.root / artifact["path"]).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == artifact["sha256"]
    return result


def test_real_staged_loop_and_recorder_seal_accepted_pair_and_final_gradient(integrated):
    reported = integrated.run()
    result = checked_result(integrated, reported, None)
    assert result["state"] == "succeeded"
    assert [frame["step_status"] for frame in result["trajectory"]] == [
        "initial",
        "accepted",
        "reevaluation",
    ]
    assert result["trajectory"][-1]["geometry"] == result["trajectory"][-2]["geometry"]
    assert integrated.recorder.last_native_report is True
    assert result["timing"]["backend_attempts_observed"] == 3


def test_rejected_last_point_selects_older_accepted_raw_input(integrated):
    integrated.converge_at = 3
    integrated.reject_at = 3
    integrated.shift = 1e-7
    reported = integrated.run()
    result = checked_result(integrated, reported, None)
    frames = result["trajectory"]
    assert result["state"] == "succeeded"
    assert [frame["step_status"] for frame in frames] == [
        "initial",
        "accepted",
        "rejected",
        "reevaluation",
    ]
    assert frames[-1]["reevaluates_frame_hash"] == frames[1]["frame_hash"]
    assert frames[-1]["geometry"] == frames[1]["geometry"] != frames[2]["geometry"]
    assert (
        json.loads(frames[-1]["raw_input_json"])["molecule"]
        == json.loads(frames[1]["raw_input_json"])["molecule"]
    )


def test_native_true_at_first_point_still_gets_two_accepted_frames(integrated):
    integrated.converge_at = 1
    result = checked_result(integrated, integrated.run(), None)
    assert result["state"] == "succeeded"
    assert len(result["trajectory"]) == 3


def test_final_dispatch_exception_seals_failure_with_observed_native_true(integrated):
    calls = 0

    def fail_final(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 3:
            raise RuntimeError("synthetic final dispatch failed")
        return integrated.synthetic_bound_result(*args, **kwargs)

    integrated.runtime.engine.compute.side_effect = fail_final
    with pytest.raises(RuntimeError) as raised:
        integrated.run()
    result = checked_result(integrated, None, raised.value)
    assert result["state"] == "failed"
    assert result["convergence"]["optimizer_reported_converged"] is True
    assert result["convergence"]["geometry_status"] == "satisfied"
    assert len(result["trajectory"]) == 2
    assert result["timing"]["backend_attempts_observed"] == 3


@pytest.mark.parametrize("failure", ["fail_at", "drift_at", "history_clear_at"])
def test_native_step_failures_keep_partial_raw_history_and_sealable_result(integrated, failure):
    setattr(integrated, failure, 2)
    with pytest.raises((RuntimeError, ValueError)) as raised:
        integrated.run()
    result = checked_result(integrated, None, raised.value)
    assert result["state"] == "failed"
    assert [frame["step_status"] for frame in result["trajectory"]] == ["initial", "unknown"]
    assert result["convergence"]["geometry_status"] == "not_checked"
    assert any(
        "optimizer-0001-native-step" in ref["artifact_id"] for ref in result["raw_artifacts"]
    )


def test_initial_drift_retains_zero_dispatch_failure(integrated):
    integrated.initial_drift = True
    with pytest.raises(ValueError) as raised:
        integrated.run()
    result = checked_result(integrated, None, raised.value)
    assert result["state"] == "failed"
    assert result["trajectory"] == []
    assert result["timing"]["backend_attempts_observed"] == 0


def test_fresh_final_gradient_outside_product_threshold_cannot_succeed(integrated):
    calls = 0

    def high_final_force(*args, **kwargs):
        nonlocal calls
        calls += 1
        result = integrated.synthetic_bound_result(*args, **kwargs)
        if calls == 3:
            result.payload["return_result"][0][0] = 0.001
        return result

    integrated.runtime.engine.compute.side_effect = high_final_force
    result = checked_result(integrated, integrated.run(), None)
    assert result["state"] == "incomplete"
    assert result["convergence"]["geometry_status"] == "not_satisfied"
    assert result["convergence"]["optimizer_reported_converged"] is True


def test_shifted_final_native_result_never_reaches_final_attribution(integrated):
    calls = 0

    def shifted_final(*args, **kwargs):
        nonlocal calls
        calls += 1
        result = integrated.synthetic_bound_result(*args, **kwargs)
        if calls == 3:
            result.payload["molecule"]["geometry"][0] += 0.05
        return result

    integrated.runtime.engine.compute.side_effect = shifted_final
    with pytest.raises(ValueError, match="coordinate mismatch") as raised:
        integrated.run()
    result = checked_result(integrated, None, raised.value)
    assert result["state"] == "failed"
    assert len(result["trajectory"]) == 2
    assert result["convergence"]["optimizer_reported_converged"] is True
    assert not any(
        ref["artifact_id"] == "optimizer-final-reevaluation" for ref in result["raw_artifacts"]
    )
