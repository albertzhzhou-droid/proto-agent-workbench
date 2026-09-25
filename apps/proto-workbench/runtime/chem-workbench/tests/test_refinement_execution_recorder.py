"""Mocked mechanics on the retained complex geometry; no scientific acceptance.

All energies, gradients, runtime objects and optimizer events here are synthetic.
The envelopes deliberately carry the bound version to test admission mechanics,
not to assert that Psi4 ran. The actual 34-atom source geometry is retained.
"""

from __future__ import annotations

import copy
import hashlib
import inspect
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from chem_workbench import molecular_refinement as records
from chem_workbench.refinement_backend import GradientRecorder
from chem_workbench.refinement_execution.refinement_recorder import StagedGradientRecorder

ROOT = Path(__file__).resolve().parents[1]
INPUT = ROOT / "tests/fixtures/refinement_evidence_product/input.json"
INPUT_HASH = "d6620a22961dde59508be55acaaaf8123d69852b41cdb2673ce65840fbaa733b"


class JsonEnvelope:
    def __init__(self, **payload):
        self.payload = {
            key: copy.deepcopy(value.payload if isinstance(value, JsonEnvelope) else value)
            for key, value in payload.items()
        }
        self.success = payload.get("success")
        self.provenance = SimpleNamespace(**payload.get("provenance", {}))
        self.error = payload.get("error")

    def json(self):
        return json.dumps(self.payload, allow_nan=False)

    @classmethod
    def parse_raw(cls, text):
        return cls(**json.loads(text))


class Molecule(JsonEnvelope):
    """Explicitly mocked eight-decimal native geometry rounding."""

    def __init__(self, **payload):
        payload["geometry"] = [round(float(c), 8) for c in payload["geometry"]]
        super().__init__(**payload)


class AtomicInput(JsonEnvelope):
    def __init__(self, **payload):
        super().__init__(schema_name="qcschema_input", schema_version=1, **payload)


class Array:
    """List-only implementation of the recorder's reshape operations."""

    def __init__(self, values):
        self.values = copy.deepcopy(values.values if isinstance(values, Array) else values)

    def reshape(self, shape):
        assert shape == (-1, 3)
        flat = (
            [v for row in self.values for v in row]
            if isinstance(self.values[0], list)
            else self.values
        )
        assert len(flat) % 3 == 0
        return Array([flat[index : index + 3] for index in range(0, len(flat), 3)])

    def tolist(self):
        return copy.deepcopy(self.values)


@pytest.fixture
def state(tmp_path):
    raw = INPUT.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == INPUT_HASH
    spec = json.loads(raw)["spec"]
    assert len(spec["geometry"]["atoms"]) == 34
    assert sum(atom["element"] != "H" for atom in spec["geometry"]["atoms"]) == 19
    original_geometry = copy.deepcopy(spec["geometry"])
    spec["optimizer_settings"]["maximum_iterations"] = 6
    spec["optimizer_settings"]["max_gradient_evaluations"] = 8
    del spec["spec_hash"]
    spec = records.seal_refinement_spec(spec)
    state = SimpleNamespace(spec=spec, root=tmp_path, gradient=0.0)

    def compute(atomic_input, program, *, raise_error, task_config):
        assert program == "psi4" and raise_error is False and task_config["retries"] == 0
        body = copy.deepcopy(atomic_input.payload)
        body.update(
            schema_name="qcschema_output",
            success=True,
            properties={"return_energy": -100.0},
            return_result=[[state.gradient, 0.0, 0.0] for _ in body["molecule"]["symbols"]],
            provenance={"creator": "Psi4", "version": spec["runtime_binding"]["versions"]["psi4"]},
        )
        body["extras"]["synthetic_test_only"] = True
        return JsonEnvelope(**body)

    state.successful = compute
    state.engine = SimpleNamespace(compute=Mock(side_effect=compute))
    modules = {
        "qcelemental": SimpleNamespace(
            models=SimpleNamespace(
                Molecule=Molecule, AtomicInput=AtomicInput, AtomicResult=JsonEnvelope
            )
        ),
        "qcengine": state.engine,
        "psi4": SimpleNamespace(),
        "numpy": SimpleNamespace(asarray=Array),
        "qcelemental.util.serialization": SimpleNamespace(json_dumps=json.dumps),
    }
    state.modules = modules
    state.recorder = StagedGradientRecorder(
        spec, tmp_path / "output.json", tmp_path, import_module=modules.__getitem__
    )
    assert state.recorder.spec["geometry"] == original_geometry
    return state


def raw_molecule(recorder, frame=None):
    if frame is None:
        return json.loads(recorder.molecule(recorder.spec["geometry"]).json())
    return json.loads(frame["raw_input_json"])["molecule"]


def evaluate(recorder, *, status="unknown", iteration=None, shift=0.0):
    molecule = (
        raw_molecule(recorder, recorder.frames[-1]) if recorder.frames else raw_molecule(recorder)
    )
    molecule["geometry"][0] += shift
    recorder.evaluate(molecule)
    if status != "unknown":
        recorder.attribute(iteration, status)
        recorder.optimizer_events.append(
            {
                "iteration": iteration,
                "synthetic_test_only": True,
                "reported_converged": None,
            }
        )
    return recorder.frames[-1]


def accepted_pair(recorder):
    evaluate(recorder, status="initial", iteration=0)
    evaluate(recorder, status="accepted", iteration=1, shift=0.000001)
    recorder.last_native_report = True
    recorder.optimizer_events[-1]["reported_converged"] = True


def reevaluate(recorder):
    target = [f for f in recorder.frames if f["step_status"] in {"initial", "accepted"}][-1]
    recorder.evaluate(
        raw_molecule(recorder, target), expected_geometry=copy.deepcopy(target["geometry"])
    )
    body = {key: value for key, value in recorder.frames[-1].items() if key != "frame_hash"}
    body.update(
        optimizer_iteration=target["optimizer_iteration"],
        step_status="reevaluation",
        reevaluates_frame_hash=target["frame_hash"],
    )
    recorder.frames[-1] = records.seal_refinement_frame(body)
    return target, recorder.frames[-1]


def read_artifact(state, identity):
    reference = next(r for r in state.recorder.artifacts if r["artifact_id"] == identity)
    raw = (state.root / reference["path"]).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == reference["sha256"]
    return json.loads(raw)


def check_result(state, result):
    assert records.validate_refinement_result(state.spec, result) == result
    for reference in result["raw_artifacts"]:
        raw = (state.root / reference["path"]).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == reference["sha256"]
    assert result["convergence"]["minimum_status"] == "not_evaluated"
    assert result["timing"]["physical_duration_seconds"] is None


def test_initial_gradient_preserves_exact_supplied_geometry_and_new_extras(state):
    recorder = state.recorder
    original = copy.deepcopy(state.spec)
    evaluate(recorder)
    assert recorder.frames[0]["geometry"] == state.spec["geometry"]
    assert read_artifact(state, "evaluation-0000-input")["extras"] == {"psiapi": True}
    assert read_artifact(state, "evaluation-0000-result")["extras"]["synthetic_test_only"] is True
    result = recorder.result(None, None)
    check_result(state, result)
    assert result["state"] == "incomplete" and state.spec == original


def test_accepted_pair_and_fresh_reevaluation_produce_valid_success_envelope(state):
    recorder = state.recorder
    accepted_pair(recorder)
    accepted, final = reevaluate(recorder)
    assert accepted["geometry"] == final["geometry"]
    assert final["raw_input_artifact_id"] != accepted["raw_input_artifact_id"]
    assert final["raw_result_artifact_id"] != accepted["raw_result_artifact_id"]
    result = recorder.result(True, None)
    check_result(state, result)
    assert result["state"] == "succeeded"
    assert result["convergence"]["geometry_status"] == "satisfied"
    assert recorder.attempts == state.engine.compute.call_count == 3


def test_first_frame_reevaluation_preserves_original_hash_but_is_not_a_second_move(state):
    recorder = state.recorder
    first = evaluate(recorder, status="initial", iteration=0)
    recorder.last_native_report = True
    _, final = reevaluate(recorder)
    assert final["geometry"] == first["geometry"] == state.spec["geometry"]
    result = recorder.result(True, None)
    check_result(state, result)
    assert result["state"] == "incomplete"
    assert result["convergence"]["geometry_status"] == "not_checked"


def test_failed_final_dispatch_retains_native_true_accepted_frames_and_attempt(state):
    recorder = state.recorder
    accepted_pair(recorder)
    state.engine.compute.side_effect = RuntimeError("synthetic final gradient failure")
    with pytest.raises(RuntimeError) as raised:
        reevaluate(recorder)
    result = recorder.result(None, raised.value)
    check_result(state, result)
    assert result["state"] == "failed"
    assert result["convergence"]["optimizer_reported_converged"] is True
    assert result["convergence"]["geometry_status"] == "satisfied"
    assert len(result["trajectory"]) == 2 and recorder.attempts == 3
    attempt = read_artifact(state, "evaluation-0002-attempt")
    assert attempt["result_artifact_id"] is None and attempt["success"] is False
    observation = json.loads(result["convergence"]["optimizer_observation_json"])
    assert observation["reported_converged"] is True


@pytest.mark.parametrize("during_final", [False, True])
def test_shifted_native_output_is_retained_but_rejected_before_append(state, during_final):
    recorder = state.recorder
    if during_final:
        accepted_pair(recorder)
    else:
        evaluate(recorder, status="initial", iteration=0)
    before = len(recorder.frames)

    def shifted(*args, **kwargs):
        result = state.successful(*args, **kwargs)
        result.payload["molecule"]["geometry"][0] += 0.05
        return result

    state.engine.compute.side_effect = shifted
    with pytest.raises(ValueError, match="coordinate mismatch") as raised:
        reevaluate(recorder) if during_final else evaluate(recorder)
    assert len(recorder.frames) == before
    result = recorder.result(None, raised.value)
    check_result(state, result)
    assert result["state"] == "failed"
    assert read_artifact(state, f"evaluation-{before:04d}-attempt")["success"] is True
    assert read_artifact(state, f"evaluation-{before:04d}-result")["success"] is True


@pytest.mark.parametrize(
    "change",
    [
        "no_accepted",
        "wrong_geometry",
        "stale_accepted",
        "raw_shift",
        "raw_mass",
        "broken_frame_hash",
    ],
)
def test_untrusted_override_is_rejected_before_dispatch(state, change):
    recorder = state.recorder
    if change != "no_accepted":
        accepted_pair(recorder)
        target = recorder.frames[-1]
    else:
        target = {"geometry": state.spec["geometry"]}
    expected = copy.deepcopy(target["geometry"])
    molecule = raw_molecule(recorder, target) if recorder.frames else raw_molecule(recorder)
    if change == "wrong_geometry":
        expected["atoms"][0]["position"][0] = "50"
        del expected["geometry_hash"]
        expected = records.seal_refinement_geometry(expected)
    elif change == "stale_accepted":
        target = recorder.frames[0]
        expected = copy.deepcopy(target["geometry"])
        molecule = raw_molecule(recorder, target)
    elif change == "raw_shift":
        molecule["geometry"][0] += 1e-10  # Even an offset within display tolerance is not reuse.
    elif change == "raw_mass":
        molecule["mass_numbers"][0] += 1
    elif change == "broken_frame_hash":
        recorder.frames[-1]["frame_hash"] = "sha256:" + "0" * 64
    before = state.engine.compute.call_count
    with pytest.raises(ValueError):
        recorder.evaluate(molecule, expected_geometry=expected)
    assert state.engine.compute.call_count == recorder.attempts == before


def test_unknown_intermediate_excludes_metrics_even_with_final_reevaluation(state):
    recorder = state.recorder
    evaluate(recorder, status="initial", iteration=0)
    evaluate(recorder)
    evaluate(recorder, status="accepted", iteration=2)
    recorder.last_native_report = True
    reevaluate(recorder)
    result = recorder.result(True, None)
    check_result(state, result)
    assert result["state"] == "incomplete"
    assert result["convergence"]["geometry_status"] == "not_checked"


def test_final_fresh_gradient_outside_criteria_remains_incomplete(state):
    recorder = state.recorder
    accepted_pair(recorder)
    state.gradient = 0.001
    reevaluate(recorder)
    result = recorder.result(True, None)
    check_result(state, result)
    assert result["state"] == "incomplete"
    assert result["convergence"]["geometry_status"] == "not_satisfied"
    assert result["convergence"]["optimizer_reported_converged"] is True


def test_accepted_pair_without_required_final_evaluation_cannot_succeed(state):
    accepted_pair(state.recorder)
    result = state.recorder.result(True, None)
    check_result(state, result)
    assert result["convergence"]["geometry_status"] == "satisfied"
    assert result["state"] == "incomplete"


def test_failed_attempt_consumes_cap_even_without_a_frame(state):
    recorder = state.recorder
    recorder.spec["optimizer_settings"]["max_gradient_evaluations"] = 1
    del recorder.spec["spec_hash"]
    recorder.spec = records.seal_refinement_spec(recorder.spec)
    state.spec = recorder.spec
    state.engine.compute.side_effect = RuntimeError("synthetic failed attempt")
    with pytest.raises(RuntimeError):
        evaluate(recorder)
    with pytest.raises(ValueError, match="attempt budget") as raised:
        evaluate(recorder)
    assert recorder.attempts == state.engine.compute.call_count == 1
    assert not recorder.frames
    result = recorder.result(None, raised.value)
    check_result(state, result)


@pytest.mark.parametrize("field", ["model", "keywords", "provenance"])
def test_entire_raw_envelope_is_checked_before_returning_forces(state, field):
    def altered(*args, **kwargs):
        value = state.successful(*args, **kwargs)
        if field == "model":
            value.payload["model"]["basis"] = "different"
        elif field == "keywords":
            value.payload["keywords"]["function_kwargs"]["dertype"] = 0
        else:
            value.payload["provenance"]["version"] = "unbound"
        return value

    state.engine.compute.side_effect = altered
    with pytest.raises(ValueError) as raised:
        evaluate(state.recorder)
    assert not state.recorder.frames
    check_result(state, state.recorder.result(None, raised.value))


def test_unserializable_return_still_has_a_terminal_attempt_record(state):
    def unserializable(*args, **kwargs):
        result = state.successful(*args, **kwargs)
        result.json = Mock(side_effect=TypeError("synthetic serialization failure"))
        return result

    state.engine.compute.side_effect = unserializable
    with pytest.raises(TypeError) as raised:
        evaluate(state.recorder)
    result = state.recorder.result(None, raised.value)
    check_result(state, result)
    attempt = read_artifact(state, "evaluation-0000-attempt")
    assert attempt["returned_native_success"] is True
    assert attempt["result_artifact_id"] is None
    assert state.recorder.attempts == 1 and not result["trajectory"]


def test_missing_native_provenance_retains_attempt_before_rejection(state):
    def malformed(*args, **kwargs):
        result = state.successful(*args, **kwargs)
        del result.payload["provenance"]
        del result.provenance
        return result

    state.engine.compute.side_effect = malformed
    with pytest.raises(ValueError, match="provenance") as raised:
        evaluate(state.recorder)
    result = state.recorder.result(None, raised.value)
    check_result(state, result)
    assert result["state"] == "failed" and result["trajectory"] == []
    attempt = read_artifact(state, "evaluation-0000-attempt")
    assert attempt["success"] is True
    assert attempt["observed_qcengine_retries"] is None


def test_tolerated_raw_result_roundoff_does_not_redefine_checked_input_geometry(state):
    accepted_pair(state.recorder)
    target = copy.deepcopy(state.recorder.frames[-1])

    def tiny_roundoff(*args, **kwargs):
        result = state.successful(*args, **kwargs)
        result.payload["molecule"]["geometry"][0] += 1e-10
        return result

    state.engine.compute.side_effect = tiny_roundoff
    _, final = reevaluate(state.recorder)
    assert final["geometry"] == target["geometry"]
    assert (
        json.loads(final["raw_result_json"])["molecule"]["geometry"]
        != json.loads(final["raw_input_json"])["molecule"]["geometry"]
    )
    check_result(state, state.recorder.result(True, None))


def test_failure_after_final_frame_still_seals_metrics_and_keeps_exception_notes(state):
    recorder = state.recorder
    accepted_pair(recorder)
    reevaluate(recorder)
    failure = RuntimeError("synthetic post-reevaluation drift")
    failure.add_note("Original partial diagnostics are retained.")
    result = recorder.result(None, failure)
    check_result(state, result)
    assert result["state"] == "failed"
    assert result["convergence"]["geometry_status"] == "satisfied"
    assert result["convergence"]["optimizer_reported_converged"] is True
    assert read_artifact(state, "worker-failure")["notes"] == [
        "Original partial diagnostics are retained."
    ]


def test_dispatch_is_injected_and_legacy_method_signature_unchanged(state):
    assert "expected_geometry" not in inspect.signature(GradientRecorder.evaluate).parameters
    assert issubclass(StagedGradientRecorder, GradientRecorder)
    assert not {"psi4", "optking", "qcengine", "qcelemental"}.intersection(sys.modules)
    dispatch = Mock(side_effect=state.successful)
    directory = state.root / "dispatch"
    directory.mkdir()
    recorder = StagedGradientRecorder(
        state.spec,
        directory / "output.json",
        state.root,
        import_module=state.modules.__getitem__,
        dispatch=dispatch,
    )
    evaluate(recorder)
    assert dispatch.call_count == 1 and state.engine.compute.call_count == 0
