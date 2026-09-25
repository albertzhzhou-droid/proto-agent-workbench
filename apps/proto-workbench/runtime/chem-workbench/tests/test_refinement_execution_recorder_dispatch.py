"""Actual staged components with injected synthetic runtimes, not scientific results."""

import json
from types import SimpleNamespace

import pytest
from test_refinement_execution_dispatch import Model
from test_refinement_execution_dispatch import harness as harness
from test_refinement_execution_recorder import Array, AtomicInput, JsonEnvelope, Molecule

from chem_workbench import molecular_refinement as records
from chem_workbench.refinement_execution.refinement_recorder import StagedGradientRecorder


@pytest.fixture
def combined(harness):
    state = harness
    original = state.original_compute
    state.shift_returned = False

    def compute(atomic_input, program, **kwargs):
        if program != "psi4":
            return original(atomic_input, program, **kwargs)
        result = original(Model(json.loads(atomic_input.json())), program, **kwargs)
        result.body["properties"] = {"return_energy": -100.0}
        result.body["provenance"] = {
            "creator": "Psi4",
            "version": state.spec["runtime_binding"]["versions"]["psi4"],
        }
        result.body["extras"]["synthetic_test_only"] = True
        if state.shift_returned:
            result.body["molecule"]["geometry"][0] += 0.05
        state.returned = JsonEnvelope(**result.body)
        return state.returned

    state.qce.compute = compute
    modules = {
        "qcelemental": SimpleNamespace(
            models=SimpleNamespace(
                Molecule=Molecule,
                AtomicInput=AtomicInput,
                AtomicResult=JsonEnvelope,
            )
        ),
        "qcengine": state.qce,
        "psi4": state.dispatch.psi4,
        "numpy": SimpleNamespace(asarray=Array),
        "qcelemental.util.serialization": SimpleNamespace(json_dumps=json.dumps),
    }
    state.recorder = StagedGradientRecorder(
        state.spec,
        state.root / "output.json",
        state.root,
        import_module=modules.__getitem__,
        dispatch=state.dispatch,
    )
    state.evaluate = lambda: state.recorder.evaluate(
        json.loads(state.recorder.molecule(state.spec["geometry"]).json()),
    )
    return state


def test_recorder_dispatcher_preserve_identical_genuine_input_and_result_bytes(combined):
    combined.evaluate()
    result = combined.recorder.result(None, None)
    assert records.validate_refinement_result(combined.spec, result) == result
    assert result["state"] == "incomplete"
    assert len(result["trajectory"]) == 1
    frame = result["trajectory"][0]
    directory = combined.root / "evaluation-0000-dispatch"
    assert (directory / "outer-input.json").read_text() == frame["raw_input_json"]
    assert (directory / "outer-result.json").read_text() == frame["raw_result_json"]
    assert frame["geometry"] == combined.spec["geometry"]
    assert len(frame["geometry"]["atoms"]) == 34
    assert combined.inner_calls == 2 and result["timing"]["backend_attempts_observed"] == 1


@pytest.mark.parametrize("cause", ["fail_inner", "shift_returned", "drift"])
def test_nested_output_or_resource_failure_retains_sealable_failed_envelope(combined, cause):
    setattr(combined, cause, True)
    with pytest.raises((ValueError, RuntimeError)) as caught:
        combined.evaluate()
    result = combined.recorder.result(None, caught.value)
    assert records.validate_refinement_result(combined.spec, result) == result
    assert result["state"] == "failed" and result["trajectory"] == []
    assert result["timing"]["backend_attempts_observed"] == 1
    directory = combined.root / "evaluation-0000-dispatch"
    assert (directory / "outer-input.json").is_file()
    assert (directory / "nested/summary.json").is_file()
    assert (directory / "outer-result.json").is_file() is (cause != "fail_inner")
    assert combined.scratch.endswith("original-scratch")
