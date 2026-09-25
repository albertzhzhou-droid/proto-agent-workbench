"""Synthetic loop checks on the retained complex geometry; no native computation.

The recorder subclass models the required checked geometry hook. It does not
change the frozen product class, and these tests do not certify result() integration.
"""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from test_refinement_backend import Array, JsonEnvelope
from test_refinement_backend import mocked_runtime as mocked_runtime

from chem_workbench import molecular_refinement as refinement
from chem_workbench import refinement_backend as backend
from chem_workbench.refinement_execution import optimizer_loop as loop
from chem_workbench.refinement_execution import optimizer_policy as policy
from chem_workbench.visualization import content_hash

ROOT = Path(__file__).resolve().parents[1]


class HookRecorder(backend.GradientRecorder):
    """Test-only model of the geometry-preserving, validated reevaluation hook."""

    bound_expected = None
    fail_final = False
    bad_final_output = False

    def evaluated_geometry(self, molecule):
        if self.bound_expected is not None:
            return copy.deepcopy(self.bound_expected)
        return super().evaluated_geometry(molecule)

    def evaluate(self, molecule, *, expected_geometry=None):
        if expected_geometry is not None and self.fail_final:
            raise RuntimeError("synthetic final evaluation failure")
        self.bound_expected = expected_geometry
        try:
            result = super().evaluate(molecule)
        finally:
            self.bound_expected = None
        if expected_geometry is not None and self.bad_final_output:
            self.frames[-1]["geometry"] = {"geometry_hash": "unexpected"}
        return result


class RoundedMolecule(JsonEnvelope):
    def __init__(self, **payload):
        if "geometry" in payload:
            payload["geometry"] = [round(c, 8) for c in payload["geometry"]]
        super().__init__(**payload)


@pytest.fixture
def environment(mocked_runtime, tmp_path):
    original = json.loads(
        (ROOT / "tests/fixtures/refinement_evidence_product/input.json").read_text()
    )["spec"]
    body = {k: copy.deepcopy(v) for k, v in original.items() if k != "spec_hash"}
    body["optimizer_settings"]["maximum_iterations"] = 3
    body["optimizer_settings"]["max_gradient_evaluations"] = 4
    spec = refinement.seal_refinement_spec(body)
    receipt = json.loads(
        (ROOT / "tests/fixtures/refinement_execution/synthetic_optimizer_receipt.json").read_text()
    )["native_parameters"][0]
    observed = {**receipt["effective"], **receipt["active_criteria"]}
    requested = policy.requested_options(spec["optimizer_settings"])
    for key, value in requested.items():
        native = next(
            (target for request, target in policy._CRITERIA.values() if request == key), key
        )
        observed[native] = value.upper() if isinstance(value, str) and key != "program" else value
    binding = policy.seal_binding(
        spec["optimizer_settings"],
        observed,
        runtime_binding_hash=spec["runtime_binding"]["binding_hash"],
        observation_artifact={"path": "observation.json", "sha256": "0" * 64},
    )
    raw = json.dumps(loop.observation_body(spec, binding), sort_keys=True)
    (tmp_path / "observation.json").write_text(raw)
    binding["observation_artifact"]["sha256"] = hashlib.sha256(raw.encode()).hexdigest()
    binding = policy.seal_binding(
        spec["optimizer_settings"],
        observed,
        runtime_binding_hash=spec["runtime_binding"]["binding_hash"],
        observation_artifact=binding["observation_artifact"],
    )
    mocked_runtime.modules["qcelemental"].models.Molecule = RoundedMolecule
    # Native Step.to_dict contains arrays; the injected equivalent must serialize them.
    mocked_runtime.modules["qcelemental.util.serialization"].json_dumps = lambda value: json.dumps(
        value, default=lambda obj: obj.tolist() if isinstance(obj, Array) else None, allow_nan=False
    )
    params = SimpleNamespace(**{key: observed[key] for key in policy._FLAGS})
    params.to_dict = lambda *, by_alias: copy.deepcopy(observed)
    runtime = mocked_runtime
    state = SimpleNamespace(
        runtime=runtime,
        spec=spec,
        binding=binding,
        observed=observed,
        params=params,
        root=tmp_path,
        converge_at=2,
        reject_at=None,
        fail_at=None,
        drift_at=None,
        initial_drift=False,
        history_clear_at=None,
        shift=0.0,
        proposed_shift=0.3,
    )

    class Computer:
        def __init__(self, molecule, *unused):
            self.molecule = molecule

    class Step:
        def __init__(self, geometry):
            self.geom = Array(geometry).reshape((-1, 3))

        def to_dict(self):
            return {"geom": self.geom, "synthetic": True}

    class Manager:
        def __init__(self, system, history, params, computer):
            self.system, self.history, self.computer = system, history, computer
            self.iteration = 0

        def start_step(self, hessian):
            self.iteration += 1
            if self.iteration > 1:
                self.computer.molecule["geometry"][0] += state.shift
            self.computer._compute("gradient")
            return hessian, [0.0], -100.0

        def take_step(self, *unused, **kwargs):
            if state.history_clear_at == self.iteration:
                self.history.steps.clear()
            elif state.reject_at != self.iteration:
                self.history.steps.append(Step(self.computer.molecule["geometry"]))
            proposed = copy.deepcopy(self.computer.molecule["geometry"])
            proposed[0] += state.proposed_shift
            self.system.geom = Array(proposed).reshape((-1, 3))
            if state.drift_at == self.iteration:
                observed["hess_update"] = "BOFILL"
            if state.fail_at == self.iteration:
                raise RuntimeError("synthetic native step failure after history mutation")
            return [0.0]

        def converged(self, *unused):
            return state.converge_at is not None and self.iteration >= state.converge_at

    def initialize(options, **kwargs):
        assert options == requested
        if state.initial_drift:
            observed["hess_update"] = "BOFILL"
        return params

    runtime.modules.update(
        {
            "optking.optimize": SimpleNamespace(
                make_internal_coords=lambda *args: None,
                OptimizationManager=Manager,
            ),
            "optking.compute_wrappers": SimpleNamespace(ComputeWrapper=Computer),
            "optking.optwrapper": SimpleNamespace(initialize_options=initialize),
            "optking.history": SimpleNamespace(History=lambda params: SimpleNamespace(steps=[])),
            "optking.molsys": SimpleNamespace(
                Molsys=SimpleNamespace(
                    from_schema=lambda molecule: SimpleNamespace(
                        geom=Array(molecule["geometry"]).reshape((-1, 3)),
                    ),
                )
            ),
        }
    )
    state.recorder = HookRecorder(spec, tmp_path / "output.json", tmp_path)
    state.run = lambda: loop.run_bound_optimization(
        state.recorder,
        binding,
        import_module=runtime.modules.__getitem__,
    )
    return state


def read_artifact(environment, identity):
    item = next(r for r in environment.recorder.artifacts if r["artifact_id"] == identity)
    data = (environment.root / item["path"]).read_bytes()
    assert hashlib.sha256(data).hexdigest() == item["sha256"]
    return json.loads(data)


def test_actual_observation_bytes_are_authenticated_before_initialization(environment):
    (environment.root / "observation.json").write_text("{}")
    with pytest.raises(ValueError, match="APPROVAL_STALE"):
        environment.run()
    assert environment.recorder.attempts == 0


def test_rehashed_observation_with_changed_context_is_rejected(environment):
    path = environment.root / "observation.json"
    value = json.loads(path.read_text())
    value["runtime_binding_hash"] = "sha256:" + "1" * 64
    raw = json.dumps(value)
    path.write_text(raw)
    reference = {"path": path.name, "sha256": hashlib.sha256(raw.encode()).hexdigest()}
    new_binding = policy.seal_binding(
        environment.spec["optimizer_settings"],
        environment.observed,
        runtime_binding_hash=environment.spec["runtime_binding"]["binding_hash"],
        observation_artifact=reference,
    )
    with pytest.raises(ValueError, match="differs from bound parameters"):
        loop.verify_bound_optimizer_artifact(environment.spec, new_binding, environment.root)


def test_initial_parameter_drift_is_retained_with_zero_dispatch(environment):
    environment.initial_drift = True
    with pytest.raises(ValueError, match="initialized optimizer differs"):
        environment.run()
    assert environment.recorder.attempts == 0
    assert (
        read_artifact(environment, "optimizer-effective-initial")["effective"]["hess_update"]
        == "BOFILL"
    )


def test_converged_accepted_pair_gets_fresh_exact_final_gradient(environment):
    assert environment.run() is True
    frames = environment.recorder.frames
    assert len(frames) == environment.recorder.attempts == 3
    assert len(frames[0]["geometry"]["atoms"]) == 34
    assert [f["step_status"] for f in frames] == ["initial", "accepted", "reevaluation"]
    assert frames[-1]["geometry"] == frames[-2]["geometry"]
    assert frames[-1]["reevaluates_frame_hash"] == frames[-2]["frame_hash"]
    assert frames[-1]["raw_result_artifact_id"] != frames[-2]["raw_result_artifact_id"]
    assert (
        read_artifact(environment, "optimizer-final-reevaluation")["native_optimizer_step"] is False
    )


def test_native_true_on_first_point_continues_to_two_accepted_evaluations(environment):
    environment.converge_at = 1
    assert environment.run() is True
    assert environment.recorder.attempts == 3
    first = read_artifact(environment, "optimizer-0000-convergence")
    assert first["reported_converged"] is True


def test_nonconverged_loop_does_not_invent_final_reevaluation(environment):
    environment.converge_at = None
    assert environment.run() is False
    assert environment.recorder.attempts == 3
    assert all(f["step_status"] != "reevaluation" for f in environment.recorder.frames)


def test_rejected_last_point_reevaluates_older_accepted_geometry(environment):
    environment.converge_at = 3
    environment.reject_at = 3
    environment.shift = 1e-7
    assert environment.run() is True
    frames = environment.recorder.frames
    assert [f["step_status"] for f in frames] == ["initial", "accepted", "rejected", "reevaluation"]
    assert frames[-1]["reevaluates_frame_hash"] == frames[1]["frame_hash"]
    assert frames[-1]["geometry"] == frames[1]["geometry"] != frames[2]["geometry"]
    assert (
        json.loads(frames[-1]["raw_input_json"])["molecule"]
        == json.loads(frames[1]["raw_input_json"])["molecule"]
    )


def test_requested_and_submitted_rounded_coordinates_are_separate(environment):
    environment.shift = 1.234567891234e-7
    assert environment.run() is True
    step = read_artifact(environment, "optimizer-0001-native-step-returned")
    assert step["requested_geometry_bohr"][0][0] != step["submitted_geometry_bohr"][0]
    assert step["history"][-1]["geom"] == step["requested_geometry_bohr"]


@pytest.mark.parametrize("failure", ["fail_at", "drift_at", "history_clear_at"])
def test_failed_or_invalid_native_step_retains_raw_history_before_admission(environment, failure):
    setattr(environment, failure, 2)
    with pytest.raises((RuntimeError, ValueError)):
        environment.run()
    assert [f["step_status"] for f in environment.recorder.frames] == ["initial", "unknown"]
    stage = "exception" if failure == "fail_at" else "returned"
    native = read_artifact(environment, f"optimizer-0001-native-step-{stage}")
    assert native["stage"] == stage
    if failure != "history_clear_at":
        assert len(native["history"]) == 2
    assert len(environment.recorder.optimizer_events) == 1


def test_final_failure_retains_accepted_frames_and_native_convergence(environment):
    environment.recorder.fail_final = True
    with pytest.raises(RuntimeError, match="final evaluation failure"):
        environment.run()
    assert [f["step_status"] for f in environment.recorder.frames] == ["initial", "accepted"]
    assert read_artifact(environment, "optimizer-0001-convergence")["reported_converged"] is True


def test_geometry_mismatch_is_not_sealed_as_final_reevaluation(environment):
    environment.recorder.bad_final_output = True
    with pytest.raises(ValueError, match="changed accepted geometry"):
        environment.run()
    assert environment.recorder.frames[-1]["step_status"] == "unknown"
    assert not any(
        a["artifact_id"] == "optimizer-final-reevaluation" for a in environment.recorder.artifacts
    )


def test_final_gradient_budget_is_reserved_before_a_new_native_step(environment):
    environment.recorder.attempts = (
        environment.spec["optimizer_settings"]["max_gradient_evaluations"] - 1
    )
    with pytest.raises(ValueError, match="final gradient reserve"):
        environment.run()
    assert not environment.runtime.engine.compute.called


def test_native_convergence_with_large_accepted_move_remains_incomplete(environment):
    environment.shift = 0.01
    assert environment.run() is False
    assert environment.recorder.attempts == 3
    assert environment.recorder.frames[-1]["step_status"] == "accepted"
    assert content_hash(environment.spec["geometry"]) == content_hash(
        environment.recorder.frames[0]["geometry"]
    )
