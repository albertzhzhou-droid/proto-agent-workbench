"""Mocked recorder regressions: no chemistry runtimes or calculations are used.

The JSON envelopes, energies, gradients and optimizer histories are deliberately
synthetic. These tests exercise failure retention and attribution, not installed
QCSchema/Psi4/OptKing compatibility or scientific accuracy.
"""

from __future__ import annotations

import copy
import hashlib
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from test_molecular_refinement import _spec, _without

from chem_workbench import molecular_refinement as refinement
from chem_workbench import refinement_backend as backend


class JsonEnvelope:
    def __init__(self, **payload):
        self.payload = {
            key: value.payload if isinstance(value, JsonEnvelope) else copy.deepcopy(value)
            for key, value in payload.items()
        }
        self.success = payload.get("success")
        self.provenance = SimpleNamespace(**payload.get("provenance", {}))

    def json(self):
        return json.dumps(self.payload)

    @classmethod
    def parse_raw(cls, text):
        return cls(**json.loads(text))


class AtomicInput(JsonEnvelope):
    def __init__(self, **payload):
        super().__init__(schema_name="qcschema_input", schema_version=1, **payload)


class Array:
    """Only the list operations used by the recorder; not a numerical backend."""

    def __init__(self, values):
        self.values = copy.deepcopy(values.values if isinstance(values, Array) else values)

    def reshape(self, shape):
        assert shape == (-1, 3)
        flat = (
            [v for row in self.values for v in row]
            if self.values and isinstance(self.values[0], list)
            else self.values
        )
        assert len(flat) % 3 == 0
        return Array([flat[i : i + 3] for i in range(0, len(flat), 3)])

    def tolist(self):
        return copy.deepcopy(self.values)

    def copy(self):
        return Array(self.values)


def successful_gradient(atomic_input, program, *, raise_error, task_config):
    assert program == "psi4" and raise_error is False
    assert task_config["retries"] == 0
    body = copy.deepcopy(atomic_input.payload)
    body.update(
        schema_name="qcschema_output",
        success=True,
        properties={"return_energy": -100.0},
        return_result=[[0.0, 0.0, 0.0] for _ in body["molecule"]["symbols"]],
        provenance={"creator": "Psi4", "version": "synthetic-not-a-runtime"},
    )
    return JsonEnvelope(**body)


@pytest.fixture
def mocked_runtime(monkeypatch):
    engine = SimpleNamespace(compute=Mock(side_effect=successful_gradient))
    modules = {
        "qcelemental": SimpleNamespace(
            models=SimpleNamespace(
                Molecule=JsonEnvelope, AtomicInput=AtomicInput, AtomicResult=JsonEnvelope
            )
        ),
        "qcengine": engine,
        "psi4": SimpleNamespace(),
        "psi4.driver.driver_util": SimpleNamespace(
            negotiate_derivative_type=Mock(return_value=(1, 1))
        ),
        "numpy": SimpleNamespace(
            asarray=Array, array_equal=lambda a, b: Array(a).tolist() == Array(b).tolist()
        ),
        "qcelemental.util.serialization": SimpleNamespace(json_dumps=json.dumps),
    }

    def fake_import(name):
        assert name in modules, f"Unexpected runtime import: {name}"
        return modules[name]

    # Replace only the backend module's reference, not process-wide importlib.
    monkeypatch.setattr(backend, "importlib", SimpleNamespace(import_module=fake_import))
    monkeypatch.setattr(backend.GradientRecorder, "settings", lambda self: {"mock": True})
    verify = Mock(return_value=None)
    monkeypatch.setattr(backend, "verify_spec_artifacts", verify)
    return SimpleNamespace(engine=engine, modules=modules, verify=verify)


def request(mode="gradient", *, iterations=2):
    body = _without(_spec(), "spec_hash")
    body["resources"]["backend_retry_policy"]["effective_retries"] = 0
    body["electronic_settings"]["native_keywords"]["function_kwargs"] = {"dertype": 1}
    body["optimizer_settings"]["maximum_iterations"] = iterations
    return {
        "version": "refinement-worker-request/v1",
        "mode": mode,
        "spec": refinement.seal_refinement_spec(body),
    }


def artifact(result, root, identity):
    reference = next(r for r in result["raw_artifacts"] if r["artifact_id"] == identity)
    data = (root / reference["path"]).read_bytes()
    assert hashlib.sha256(data).hexdigest() == reference["sha256"]
    return json.loads(data)


def check_failed_envelope(result, req, root):
    assert refinement.validate_refinement_result(req["spec"], result) == result
    assert result["state"] == "failed"
    assert result["convergence"]["minimum_status"] == "not_evaluated"
    assert result["timing"]["physical_duration_seconds"] is None
    assert result["failure"]["last_evaluated_frame_hash"] == result["final_frame_hash"]
    for reference in result["raw_artifacts"]:
        assert (
            hashlib.sha256((root / reference["path"]).read_bytes()).hexdigest()
            == reference["sha256"]
        )


def test_compute_exception_retains_attempt_and_failure_without_inventing_result(
    mocked_runtime, tmp_path
):
    mocked_runtime.engine.compute.side_effect = RuntimeError("synthetic engine crash")
    req = request()
    before = copy.deepcopy(req)
    result = backend.run(req, tmp_path / "output.json", tmp_path)

    check_failed_envelope(result, req, tmp_path)
    assert req == before
    assert mocked_runtime.engine.compute.call_count == 1
    assert result["trajectory"] == [] and result["final_frame_hash"] is None
    assert result["timing"]["backend_attempts_observed"] == 1
    attempt = artifact(result, tmp_path, "evaluation-0000-attempt")
    assert attempt["success"] is False
    assert attempt["exception_type"] == "RuntimeError"
    assert attempt["result_artifact_id"] is None
    assert attempt["observed_qcengine_retries"] is None
    assert attempt["task_config"]["retries"] == 0
    assert not any(r["role"] == "atomic_result" for r in result["raw_artifacts"])
    actual_input = artifact(result, tmp_path, "evaluation-0000-input")
    assert actual_input["molecule"]["atom_labels"] == [
        a["id"] for a in req["spec"]["geometry"]["atoms"]
    ]
    assert actual_input["keywords"]["function_kwargs"] == {"dertype": 1}


@pytest.mark.parametrize("strategy", [(1, 0), (True, True), [1, 1], None])
def test_nonanalytic_or_invalid_native_route_stops_before_backend(
    mocked_runtime, tmp_path, strategy
):
    mocked_runtime.modules[
        "psi4.driver.driver_util"
    ].negotiate_derivative_type.return_value = strategy
    req = request()
    result = backend.run(req, tmp_path / "output.json", tmp_path)
    check_failed_envelope(result, req, tmp_path)
    assert not mocked_runtime.engine.compute.called
    assert result["timing"]["backend_attempts_observed"] == 0
    assert result["failure"]["phase"] == "preflight"
    assert (
        artifact(result, tmp_path, "derivative-preflight")["analytic_gradient_available"] is False
    )


def test_unavailable_analytic_gradient_preserves_reason_without_dispatch(mocked_runtime, tmp_path):
    mocked_runtime.modules[
        "psi4.driver.driver_util"
    ].negotiate_derivative_type.side_effect = RuntimeError(
        "synthetic native method has no analytic derivative"
    )
    req = request()
    result = backend.run(req, tmp_path / "output.json", tmp_path)
    check_failed_envelope(result, req, tmp_path)
    assert not mocked_runtime.engine.compute.called
    assert result["timing"]["backend_attempts_observed"] == 0
    assert (
        "synthetic native" in artifact(result, tmp_path, "derivative-preflight")["error"]["message"]
    )


def test_postrun_binding_drift_returns_failed_envelope_with_exact_evaluated_frame(
    mocked_runtime, tmp_path
):
    mocked_runtime.verify.side_effect = [None, ValueError("APPROVAL_STALE: synthetic drift")]
    req = request()
    result = backend.run(req, tmp_path / "output.json", tmp_path)

    check_failed_envelope(result, req, tmp_path)
    assert mocked_runtime.verify.call_count == 2
    assert mocked_runtime.engine.compute.call_count == 1
    assert len(result["trajectory"]) == result["timing"]["backend_attempts_observed"] == 1
    frame = result["trajectory"][0]
    assert frame["geometry"] == req["spec"]["geometry"]
    assert frame["step_status"] == "unknown" and frame["optimizer_iteration"] is None
    assert result["final_frame_hash"] == frame["frame_hash"]
    assert result["convergence"]["geometry_status"] == "not_checked"
    assert "synthetic drift" in result["failure"]["message"]
    assert artifact(result, tmp_path, "post-run-binding-failure")["type"] == "ValueError"
    assert json.loads(frame["raw_result_json"]) == artifact(
        result, tmp_path, "evaluation-0000-result"
    )


def install_optimizer(runtime, *, second_step="append", convergence_error=False):
    class Computer:
        def __init__(self, molecule, *unused):
            self.molecule = molecule

    class Step:
        def __init__(self, geometry):
            self.geom = Array(geometry).reshape((-1, 3))

        def to_dict(self):
            return {"geom": self.geom.tolist(), "synthetic_history_entry": True}

    class Manager:
        def __init__(self, system, history, params, computer):
            self.history = history
            self.computer = computer
            self.iteration = 0

        def start_step(self, hessian):
            self.iteration += 1
            self.computer._compute("gradient")
            return hessian, [0.0], -100.0

        def take_step(self, *unused, **kwargs):
            if self.iteration == 1 or second_step == "append":
                self.history.steps.append(Step(self.computer.molecule["geometry"]))
            elif second_step == "unexplained_change":
                self.history.steps.clear()
            # same_history retains the previous identical-coordinate entry; the
            # just-evaluated point has no newly retained history entry.
            return [0.0]

        def converged(self, *unused):
            if convergence_error:
                raise RuntimeError("synthetic convergence check failure")
            return False

    runtime.modules.update(
        {
            "optking.optimize": SimpleNamespace(
                make_internal_coords=lambda *args: None, OptimizationManager=Manager
            ),
            "optking.compute_wrappers": SimpleNamespace(ComputeWrapper=Computer),
            "optking.optwrapper": SimpleNamespace(
                initialize_options=lambda options, **kwargs: options
            ),
            "optking.history": SimpleNamespace(History=lambda params: SimpleNamespace(steps=[])),
            "optking.molsys": SimpleNamespace(
                Molsys=SimpleNamespace(
                    from_schema=lambda molecule: SimpleNamespace(
                        geom=Array(molecule["geometry"]).reshape((-1, 3))
                    )
                )
            ),
        }
    )


def test_convergence_exception_keeps_attributed_frame_and_its_prior_history_event(
    mocked_runtime, tmp_path
):
    install_optimizer(mocked_runtime, convergence_error=True)
    req = request("optimization")
    result = backend.run(req, tmp_path / "output.json", tmp_path)

    check_failed_envelope(result, req, tmp_path)
    assert mocked_runtime.engine.compute.call_count == 1
    assert len(result["trajectory"]) == 1
    frame = result["trajectory"][0]
    assert frame["step_status"] == "initial" and frame["optimizer_iteration"] == 0
    events = artifact(result, tmp_path, "optimizer-events")["events"]
    assert len(events) == 1
    assert events[0]["new_evaluated_entry_retained"] is True
    assert events[0]["reported_converged"] is None
    observation = json.loads(result["convergence"]["optimizer_observation_json"])
    assert observation["attributions"][0]["frame_hash"] == frame["frame_hash"]
    assert observation["reported_converged"] is None
    assert "synthetic convergence check failure" in result["failure"]["message"]


def test_old_history_entry_at_same_coordinates_does_not_accept_new_evaluation(
    mocked_runtime, tmp_path
):
    install_optimizer(mocked_runtime, second_step="same_history")
    req = request("optimization")
    result = backend.run(req, tmp_path / "output.json", tmp_path)

    assert refinement.validate_refinement_result(req["spec"], result) == result
    assert mocked_runtime.engine.compute.call_count == 2
    assert [frame["step_status"] for frame in result["trajectory"]] == ["initial", "rejected"]
    assert result["state"] == "incomplete"
    assert result["convergence"]["geometry_status"] == "not_checked"
    events = artifact(result, tmp_path, "optimizer-events")["events"]
    assert events[0]["evaluated_geometry_bohr"] == events[1]["evaluated_geometry_bohr"]
    assert events[1]["prior_history_entry_count"] == len(events[1]["history"]) == 1
    assert events[1]["new_evaluated_entry_retained"] is False


def test_unexplained_history_change_keeps_last_evaluated_frame_with_unknown_attribution(
    mocked_runtime, tmp_path
):
    install_optimizer(mocked_runtime, second_step="unexplained_change")
    req = request("optimization")
    result = backend.run(req, tmp_path / "output.json", tmp_path)

    check_failed_envelope(result, req, tmp_path)
    assert mocked_runtime.engine.compute.call_count == 2
    assert len(result["trajectory"]) == result["timing"]["backend_attempts_observed"] == 2
    frame = result["trajectory"][-1]
    assert frame["step_status"] == "unknown" and frame["optimizer_iteration"] is None
    assert result["final_frame_hash"] == frame["frame_hash"]
    assert result["convergence"]["geometry_status"] == "not_checked"
    assert "unexplained optimizer history change" in result["failure"]["message"]
    assert len(artifact(result, tmp_path, "optimizer-events")["events"]) == 1


def test_shifted_second_result_stops_before_returning_gradient_and_seals_partial_failure(
    mocked_runtime, tmp_path, monkeypatch
):
    install_optimizer(mocked_runtime)
    req = request("optimization", iterations=3)
    returned_evaluations = []
    original_evaluate = backend.GradientRecorder.evaluate

    def record_returned_evaluation(recorder, molecule):
        evaluated = original_evaluate(recorder, molecule)
        returned_evaluations.append(copy.deepcopy(evaluated))
        return evaluated

    monkeypatch.setattr(backend.GradientRecorder, "evaluate", record_returned_evaluation)
    backend_calls = 0

    def shifted_second_output(atomic_input, *args, **kwargs):
        nonlocal backend_calls
        backend_calls += 1
        output = successful_gradient(atomic_input, *args, **kwargs)
        if backend_calls == 2:
            # The native envelope claims success, but its evaluated point no
            # longer belongs to the submitted geometry. Never feed it to OptKing.
            output.payload["molecule"]["geometry"][0] += 0.05
        return output

    mocked_runtime.engine.compute.side_effect = shifted_second_output
    result = backend.run(req, tmp_path / "output.json", tmp_path)

    check_failed_envelope(result, req, tmp_path)
    assert backend_calls == mocked_runtime.engine.compute.call_count == 2
    assert len(returned_evaluations) == 1
    assert len(result["trajectory"]) == 1
    first = result["trajectory"][0]
    assert first["geometry"] == req["spec"]["geometry"]
    assert first["step_status"] == "initial" and first["optimizer_iteration"] == 0
    assert result["final_frame_hash"] == first["frame_hash"]
    assert result["timing"]["backend_attempts_observed"] == 2
    assert result["failure"]["phase"] == "gradient"
    assert "evaluated coordinate mismatch" in result["failure"]["message"]
    assert result["convergence"]["geometry_status"] == "not_checked"
    assert len(artifact(result, tmp_path, "optimizer-events")["events"]) == 1

    raw_input = artifact(result, tmp_path, "evaluation-0001-input")
    raw_result = artifact(result, tmp_path, "evaluation-0001-result")
    assert raw_result["success"] is True  # Preserve the backend's actual claim.
    assert raw_input["molecule"]["geometry"][0] == 0.0
    assert raw_result["molecule"]["geometry"][0] == 0.05
    attempt = artifact(result, tmp_path, "evaluation-0001-attempt")
    assert attempt["input_artifact_id"] == "evaluation-0001-input"
    assert attempt["result_artifact_id"] == "evaluation-0001-result"
    assert attempt["success"] is True
    assert not any(
        item["artifact_id"] == "evaluation-0001-frame" for item in result["raw_artifacts"]
    )
