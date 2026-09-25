"""Injected native objects and explicit synthetic host authority only.

These tests run the product recorder/transport/optimizer orchestration.
Their approvals, values and retained parameter observations are synthetic; no
native runtime, model, supervisor, server or scientific job is invoked.
"""

from __future__ import annotations

import copy
import hashlib
import json
import sys
from types import SimpleNamespace

import pytest
from test_refinement_backend import Array
from test_refinement_backend import mocked_runtime as mocked_runtime
from test_refinement_execution_optimizer_loop import environment as environment
from test_refinement_execution_pipeline import SyntheticPipeline
from test_refinement_execution_recorder import AtomicInput, JsonEnvelope, Molecule

from chem_workbench import molecular_refinement as records
from chem_workbench.refinement_execution import execution_contract
from chem_workbench.refinement_execution import worker_lifecycle as lifecycle
from chem_workbench.visualization import content_hash


class Harness:
    def __init__(self, tmp_path):
        self.pipeline = SyntheticPipeline(tmp_path)
        self.root = tmp_path
        self.run = self.pipeline.run
        self.request = execution_contract.build_worker_request(
            self.pipeline.spec, self.pipeline.contract
        )
        self.context = SimpleNamespace(
            root=self.root,
            run_id=self.pipeline.run_id,
            run_nonce=self.pipeline.run_nonce,
            run_directory=self.run.relative_to(self.root).as_posix(),
            worker_identity=self.pipeline.worker,
            source_identity=self.pipeline.source,
            plan_context=object(),
            resolved_plan_hash="sha256:" + "c" * 64,
            prepared_input_hash=content_hash(self.request),
            input_artifact=self.prepared_input(),
            resource_policy={
                key: self.pipeline.spec["resources"][key] for key in lifecycle.RESOURCE_FIELDS
            },
            native_task_config=copy.deepcopy(self.pipeline.config),
            trusted_subject_admission_ref={"path": "synthetic-admission.json", "sha256": "d" * 64},
        )
        self.verifications = []
        self.imports = []
        self.modules = {
            "qcelemental": SimpleNamespace(
                models=SimpleNamespace(
                    Molecule=Molecule, AtomicInput=AtomicInput, AtomicResult=JsonEnvelope
                )
            ),
            "qcengine": self.pipeline.qce,
            "psi4": self.pipeline.psi4,
            "dftd3.qcschema": self.pipeline.dftd3,
            "numpy": SimpleNamespace(
                asarray=Array, array_equal=lambda a, b: Array(a).tolist() == Array(b).tolist()
            ),
            "qcelemental.util.serialization": SimpleNamespace(
                json_dumps=lambda value: json.dumps(
                    value,
                    default=lambda obj: obj.tolist() if isinstance(obj, Array) else None,
                    allow_nan=False,
                )
            ),
        }

    def prepared_input(self):
        number = len(list(self.root.glob("prepared-input-*.json")))
        path = self.root / f"prepared-input-{number}.json"
        raw = json.dumps(self.request, allow_nan=False, sort_keys=True).encode()
        path.write_bytes(raw)
        return {
            "path": path.relative_to(self.root).as_posix(),
            "sha256": hashlib.sha256(raw).hexdigest(),
        }

    def authorize(self, request, context):
        assert context is self.context
        assert request == self.request
        assert self.imports == []
        self.verifications.append("host")

    def subject(self, spec, context):
        assert spec == self.request["spec"] and context is self.context
        assert context.trusted_subject_admission_ref["path"] == "synthetic-admission.json"
        self.verifications.append("subject")

    def runtime(self, spec, context):
        assert spec == self.request["spec"] and context is self.context
        self.verifications.append("runtime")

    def loader(self, name):
        assert self.verifications[:3] == ["host", "subject", "runtime"]
        self.imports.append(name)
        return self.modules[name]

    def kwargs(self):
        return {
            "context": self.context,
            "verify_host_admission": self.authorize,
            "verify_subject": self.subject,
            "verify_runtime": self.runtime,
            "import_module": self.loader,
        }

    def execute(self, **overrides):
        self.report = lifecycle.run_worker_lifecycle(self.request, **(self.kwargs() | overrides))
        assert self.pipeline.qce.compute is self.pipeline.original_compute
        assert self.pipeline.dftd3.run_qcschema is self.pipeline.original_inner
        assert not {"psi4", "qcengine", "qcelemental", "optking", "dftd3"} & sys.modules.keys()
        assert self.report["execution_evidence_state"] == "unassessed"
        if self.report["scientific_result"] is not None:
            assert (
                records.validate_refinement_result(
                    self.request["spec"], self.report["scientific_result"]
                )
                == self.report["scientific_result"]
            )
        return self.report


@pytest.fixture
def harness(tmp_path):
    return Harness(tmp_path)


@pytest.fixture
def optimization(environment):
    state = environment
    harness = Harness(state.root)
    harness.pipeline.spec = state.spec
    harness.request = execution_contract.build_worker_request(
        state.spec,
        execution_contract.seal_execution_contract(state.spec, "optimization", state.binding),
    )
    harness.context.prepared_input_hash = content_hash(harness.request)
    harness.context.input_artifact = harness.prepared_input()
    harness.modules.update(
        {key: value for key, value in state.runtime.modules.items() if key.startswith("optking.")}
    )
    harness.optimizer = state
    return harness


@pytest.mark.parametrize(
    "missing",
    ["context", "verify_host_admission", "verify_subject", "verify_runtime", "import_module"],
)
def test_missing_trusted_dependency_rejects_before_imports_or_files(harness, missing):
    report = harness.execute(**{missing: None})
    assert report["runner_outcome"] == "rejected" and report["host_admitted"] is False
    assert report["scientific_result"] is None and report["backend_attempts_observed"] == 0
    assert harness.imports == harness.verifications == []
    assert list(harness.run.iterdir()) == []


def test_request_v1_and_request_self_attestation_cannot_grant_authority(harness):
    for request in (
        {
            "version": "refinement-worker-request/v1",
            "mode": "gradient",
            "spec": harness.pipeline.spec,
        },
        {**harness.request, "host_approved": True},
    ):
        report = lifecycle.run_worker_lifecycle(request, **harness.kwargs())
        assert report["runner_outcome"] == "rejected"
    assert harness.imports == [] and list(harness.run.iterdir()) == []


def test_boolean_admission_is_rejected_before_imports(harness):
    report = harness.execute(verify_host_admission=lambda request, context: True)
    assert report["runner_outcome"] == "rejected" and harness.imports == []
    assert any("return None or raise" in error["message"] for error in report["errors"])


def test_independent_prepared_input_binding_is_required(harness):
    harness.context.prepared_input_hash = "sha256:" + "e" * 64
    report = harness.execute()
    assert report["runner_outcome"] == "rejected" and harness.imports == []
    assert harness.verifications == []


def test_raw_prepared_input_is_not_inferred_from_canonical_request_hash(harness):
    path = harness.root / harness.context.input_artifact["path"]
    path.write_bytes(path.read_bytes() + b"\n")
    report = harness.execute()
    assert report["runner_outcome"] == "failed" and harness.imports == []
    assert report["scientific_result"] is None
    assert any("artifact bytes changed" in error["message"] for error in report["errors"])


def test_host_rejection_and_callback_mutation_are_fail_closed(harness):
    def reject(request, context):
        raise ValueError("synthetic approval unavailable")

    assert harness.execute(verify_host_admission=reject)["runner_outcome"] == "rejected"

    def mutate(request, context):
        request["mode"] = "optimization"

    assert harness.execute(verify_host_admission=mutate)["runner_outcome"] == "rejected"
    assert harness.request["mode"] == "gradient"
    assert harness.imports == [] and list(harness.run.iterdir()) == []


def test_single_gradient_finishes_runner_without_scientific_or_execution_completion(harness):
    assert set(harness.context.resource_policy) == {
        "wall_seconds",
        "memory_bytes",
        "cpu_seconds",
        "threads",
        "max_output_bytes",
    }
    report = harness.execute()
    assert report["runner_outcome"] == "completed", report["errors"]
    assert report["scientific_state"] == "incomplete"
    assert report["last_native_report"] is None
    assert report["backend_attempts_observed"] == 1
    assert harness.pipeline.state.inner_drivers == ["energy", "gradient"]
    assert len(report["dispatch_observations"]) == 1
    assert harness.verifications == ["host", "subject", "runtime", "subject", "runtime"]
    assert len(harness.imports) == len(set(harness.imports))
    raw = (harness.root / report["result_reference"]["path"]).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == report["result_reference"]["sha256"]
    assert json.loads(raw) == report["scientific_result"]
    assert json.loads((harness.run / lifecycle.LIFECYCLE_FILE).read_bytes()) == report
    assert len((harness.run / lifecycle.EVENTS_FILE).read_text().splitlines()) >= 4
    for line in (harness.run / lifecycle.EVENTS_FILE).read_text().splitlines():
        assert isinstance(json.loads(line), dict)


@pytest.mark.parametrize("callback", ["verify_subject", "verify_runtime"])
def test_failed_preflight_is_retained_without_native_initialization(harness, callback):
    def reject(spec, context):
        raise ValueError("synthetic retained subject/runtime closure failure")

    report = harness.execute(**{callback: reject})
    assert report["runner_outcome"] == "failed" and report["host_admitted"] is True
    assert report["scientific_result"] is None and harness.imports == []
    assert (harness.run / lifecycle.LIFECYCLE_FILE).exists()
    assert report["errors"] and report["backend_attempts_observed"] == 0


@pytest.mark.parametrize("name", ["qcengine", "qcelemental", "numpy"])
def test_initialization_failure_has_terminal_diagnostic_and_no_fabricated_result(harness, name):
    def missing(requested):
        if requested == name:
            raise ImportError("synthetic missing module " + name)
        return harness.loader(requested)

    report = harness.execute(import_module=missing)
    assert report["runner_outcome"] == "failed"
    assert report["scientific_result"] is None and report["result_reference"] is None
    assert report["backend_attempts_observed"] == 0
    assert any(error["type"] == "ImportError" for error in report["errors"])
    assert (harness.run / lifecycle.LIFECYCLE_FILE).exists()
    assert not (harness.run / lifecycle.RESULT_FILE).exists()


def test_native_failure_and_terminal_runtime_failure_are_both_retained(harness):
    harness.pipeline.fault = "native_failure"
    count = 0

    def runtime(spec, context):
        nonlocal count
        count += 1
        harness.runtime(spec, context)
        if count == 2:
            raise ValueError("synthetic terminal runtime drift")

    report = harness.execute(verify_runtime=runtime)
    assert report["runner_outcome"] == "failed" and report["scientific_state"] == "failed"
    assert report["backend_attempts_observed"] == 1
    assert {error["stage"] for error in report["errors"]} >= {
        "native_execution",
        "terminal_runtime_verification",
    }
    assert (harness.run / "evaluation-0000-dispatch/outer-result.json").is_file()
    assert report["recorder_artifacts"] and report["result_reference"]


def test_existing_output_is_never_overwritten_or_dispatched(harness):
    path = harness.run / lifecycle.RESULT_FILE
    path.write_bytes(b"preserved historical bytes")
    report = harness.execute()
    assert report["runner_outcome"] == "failed"
    assert path.read_bytes() == b"preserved historical bytes" and harness.imports == []


def test_resource_mismatch_fails_before_native_imports(harness):
    harness.context.native_task_config["retries"] = False
    report = harness.execute()
    assert report["runner_outcome"] == "failed" and harness.imports == []


@pytest.mark.parametrize("fault", ["bytes", "hardlink"])
def test_event_file_mutation_is_detected_before_dispatch(harness, fault):
    def change_event(spec, context):
        harness.runtime(spec, context)
        path = harness.run / lifecycle.EVENTS_FILE
        if fault == "bytes":
            with path.open("ab") as stream:
                stream.write(b"synthetic unexpected mutation")
        else:
            (harness.run / "synthetic-extra-hardlink").hardlink_to(path)

    report = harness.execute(verify_runtime=change_event)
    assert report["runner_outcome"] == "failed" and report["backend_attempts_observed"] == 0
    assert harness.imports == []
    assert any("event file" in error["message"] for error in report["errors"])


def test_optimizer_authenticates_existing_observation_before_loading_runtime(optimization):
    observation = optimization.root / "observation.json"
    original = observation.read_bytes()
    observation.write_bytes(original + b"\n")
    report = optimization.execute()
    assert report["runner_outcome"] == "failed" and optimization.imports == []
    assert report["scientific_result"] is None
    assert any(error["stage"] == "optimizer_observation_verification" for error in report["errors"])
    assert observation.read_bytes() == original + b"\n"


def test_optimizer_reobserves_initialized_parameters_and_retains_drift(optimization):
    optimization.optimizer.initial_drift = True
    report = optimization.execute()
    assert report["runner_outcome"] == "failed" and report["scientific_state"] == "failed"
    assert report["backend_attempts_observed"] == 0
    observed = json.loads((optimization.run / "optimizer-effective-initial.json").read_bytes())
    assert observed["effective"]["hess_update"] == "BOFILL"
    assert report["optimizer_artifacts"]


def test_optimizer_accepted_pair_and_final_reevaluation_keep_separate_states(optimization):
    report = optimization.execute()
    assert report["runner_outcome"] == "completed", report["errors"]
    assert report["scientific_state"] == "succeeded"
    assert report["last_native_report"] is True
    assert report["backend_attempts_observed"] == 3
    assert [frame["step_status"] for frame in report["scientific_result"]["trajectory"]] == [
        "initial",
        "accepted",
        "reevaluation",
    ]
    assert len(report["dispatch_directories"]) == 3
    assert report["optimizer_artifacts"]


def test_failed_final_gradient_keeps_last_observed_native_true_and_accepted_frames(optimization):
    original = optimization.pipeline.qce.compute

    def fail_final(request, program, **kwargs):
        if program == "psi4" and optimization.pipeline.state.outer_calls == 2:
            raise RuntimeError("synthetic final gradient failed")
        return original(request, program, **kwargs)

    optimization.pipeline.qce.compute = fail_final
    optimization.pipeline.original_compute = fail_final
    report = optimization.execute()
    assert report["runner_outcome"] == "failed" and report["scientific_state"] == "failed"
    assert report["last_native_report"] is True
    assert report["scientific_result"]["convergence"]["optimizer_reported_converged"] is True
    assert report["backend_attempts_observed"] == 3
    assert len(report["scientific_result"]["trajectory"]) == 2
    assert (optimization.run / "evaluation-0002-dispatch/outer-exception.json").is_file()


def test_final_gradient_outside_metrics_leaves_scientific_incomplete(optimization):
    original = optimization.pipeline.qce.compute

    def high_final_force(request, program, **kwargs):
        result = original(request, program, **kwargs)
        if program == "psi4" and optimization.pipeline.state.outer_calls == 3:
            result.payload["return_result"][0][0] = 0.001
        return result

    optimization.pipeline.qce.compute = high_final_force
    optimization.pipeline.original_compute = high_final_force
    report = optimization.execute()
    assert report["runner_outcome"] == "completed", report["errors"]
    assert report["scientific_state"] == "incomplete" and report["last_native_report"] is True
    assert report["scientific_result"]["convergence"]["geometry_status"] == "not_satisfied"


def test_keyboard_interrupt_retains_partial_terminal_report(harness):
    def interrupt(request, program, **kwargs):
        raise KeyboardInterrupt("synthetic interruption")

    harness.pipeline.qce.compute = interrupt
    harness.pipeline.original_compute = interrupt
    report = harness.execute()
    assert report["runner_outcome"] == "interrupted" and report["scientific_state"] == "failed"
    assert report["backend_attempts_observed"] == 1
    assert (harness.run / "evaluation-0000-dispatch/outer-exception.json").is_file()
