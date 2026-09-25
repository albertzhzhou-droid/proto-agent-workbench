"""Actual store/approval/refinement admission with explicit synthetic execution.

The Design subject is the retained complex 34-atom candidate. Installed worker
identity, native packages and process outcome are injected fixtures. The actual
registry validator, approval store, launch sideband, lifecycle, observed-call
records, host inventory, scientific validator and result admission run unchanged.
No OS worker process, native scientific computation or model is started.
"""

from __future__ import annotations

import copy
import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from refinement_evidence_fixtures import materialize_bound_artifacts
from test_refinement_backend import mocked_runtime as mocked_runtime
from test_refinement_execution_lifecycle import Harness
from test_refinement_execution_optimizer_loop import environment as environment
from test_refinement_governed_plan_product import case as case
from test_refinement_governed_plan_product import retained_case as retained_case

from chem_workbench import execution, molecular_refinement, refinement_backend
from chem_workbench.adapters import governed_compute, registry
from chem_workbench.adapters.validation import validate_adapter_registry
from chem_workbench.chemir import canonical_bytes
from chem_workbench.refinement_execution import governed_execution as route
from chem_workbench.refinement_execution import governed_plan, launch_context, worker_entry
from chem_workbench.refinement_execution.execution_contract import seal_execution_contract
from chem_workbench.refinement_execution.host_evidence import HostEvidenceSession
from chem_workbench.visualization import content_hash

ROOT = Path(__file__).resolve().parents[1]
REAL_RECORDER_SETTINGS = refinement_backend.GradientRecorder.settings


def write(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not isinstance(raw, bytes):
        raw = json.dumps(raw, allow_nan=False, sort_keys=True).encode()
    with path.open("xb") as stream:
        stream.write(raw)
    return hashlib.sha256(raw).hexdigest()


def isolated_current_registry(root, monkeypatch):
    """Real registration builder and verifier; only package-owned byte source is injected."""
    raw = (ROOT / "src/chem_workbench/adapters/builtin-registry.json").read_bytes()
    document = registry.load_descriptor_bytes(raw)
    document["adapters"] = [
        entry
        for entry in document["adapters"]
        if entry["manifest"]["adapter_id"]
        not in {"chem.compute.governed", "chem.compute.refinement"}
    ] + governed_compute.compute_registrations()
    data = canonical_bytes(validate_adapter_registry(document))
    path = root / "isolated-package-registry.json"
    write(path, data)

    def read_package_registry():
        return canonical_bytes(
            validate_adapter_registry(registry.load_descriptor_bytes(path.read_bytes()))
        )

    monkeypatch.setattr(registry, "_bundled_registry_canonical_bytes", read_package_registry)
    return path


@pytest.fixture
def governed(case, monkeypatch):
    root = case["root"]
    materialize_bound_artifacts(root)
    runtime = root / "synthetic-runtime"
    meta_name = "conda-meta/simple-dftd3-1.6.0-synthetic.json"
    meta_hash = write(
        runtime / meta_name,
        {
            "name": "simple-dftd3",
            "version": "1.6.0",
            "synthetic_test_only": True,
        },
    )
    # Snapshot real pure source bytes into an explicitly synthetic installed-code
    # tree. This lets the host's real source reader run with artifact_root == code_root.
    source_names = (
        "molecular_refinement.py",
        "method_profiles.py",
        "refinement_execution/launch_context.py",
        "refinement_execution/governed_execution.py",
    )
    modules = {
        relative: write(
            root / "src/chem_workbench" / relative,
            (ROOT / "src/chem_workbench" / relative).read_bytes(),
        )
        for relative in source_names
    }
    script_hash = write(
        root / "scripts/worker_refinement_psi4.py",
        (ROOT / "scripts/worker_refinement_psi4.py").read_bytes(),
    )
    launcher_hash = write(
        root / "scripts/run_psi4_python.ps1", (ROOT / "scripts/run_psi4_python.ps1").read_bytes()
    )
    lock_hash = write(root / "uv.lock", (ROOT / "uv.lock").read_bytes())
    worker = {
        "kind": "psi4_refinement",
        "script": "worker_refinement_psi4.py",
        "script_sha256": script_hash,
        "launcher_sha256": launcher_hash,
        "lock_sha256": lock_hash,
        "product_module_sha256": modules,
        "environment": {"prefix": str(runtime), "entries": {meta_name: meta_hash}},
        "synthetic_test_only": True,
        "native_process_started": False,
    }
    case["observed_worker_identity"] = worker
    events = []
    state = SimpleNamespace(
        root=root,
        case=case,
        worker=worker,
        events=events,
        calls=[],
        fault=None,
        quiescent=True,
        before_run=None,
        reports=[],
        clock=10000,
        expire_after_before=False,
        optimizer=None,
    )

    def observe_worker(spec, **kwargs):
        assert spec.kind == "psi4_refinement"
        assert kwargs["refinement_profile_id"] == state.plan["method_profile_id"]
        return copy.deepcopy(state.worker)

    monkeypatch.setattr(execution, "REPOSITORY_ROOT", root)
    monkeypatch.setattr(
        route,
        "__file__",
        str(root / "src/chem_workbench/refinement_execution/governed_execution.py"),
    )
    monkeypatch.setattr(execution, "worker_identity", observe_worker)
    monkeypatch.setattr(execution.time, "time", lambda: state.clock)
    state.plan = governed_plan.prepare(**case)
    state.registry = isolated_current_registry(root, monkeypatch)
    # This is the unchanged real registration gate, not an approving stub.
    governed_compute.require_registration(state.plan["method_profile_id"])
    state.store = execution.ExecutionStore(root / "store", artifact_root=root)
    state.store.save_plan(state.plan)

    class ObservedHostSession(HostEvidenceSession):
        def begin(self):
            value = super().begin()
            events.append("host.before")
            if state.expire_after_before:
                state.clock = state.latest_approval["expires_at"]
            return value

        def finalize(self, **kwargs):
            events.append("host.finalize.start")
            value = super().finalize(**kwargs)
            if value.after_reference is not None:
                events.append("host.after")
            return value

    monkeypatch.setattr(route, "HostEvidenceSession", ObservedHostSession)

    def runner(worker_spec, input_path, output_path, **kwargs):
        state.calls.append({"input": input_path, "output": output_path, **kwargs})
        events.append("run_worker")
        assert worker_spec == execution.WORKERS["psi4_refinement"]
        assert events[-2] == "host.before"
        assert (output_path.parent / "host-evidence/before.json").is_file()
        assert not (output_path.parent / "host-evidence/after.json").exists()
        request = json.loads(input_path.read_bytes())
        assert len(request["spec"]["geometry"]["atoms"]) == 34
        launch_context.verify_launch_sideband(
            kwargs["launch_sideband"],
            root=root,
            code_root=root,
            runtime_root=runtime,
            input_path=input_path,
            output_path=output_path,
            request=request,
            disk_budget=kwargs["disk_budget"],
        )
        if state.before_run is not None:
            state.before_run()
        if state.fault == "runner_exception":
            write(output_path.parent / "scratch/partial.bin", b"synthetic retained scratch")
            write(
                output_path.parent / "supervisor-failure.json",
                {
                    "synthetic_test_only": True,
                    "complete": False,
                    "error": "synthetic process wait failed",
                },
            )
            raise TimeoutError("synthetic process wait failed")
        if state.fault != "missing_result":
            seed = root / ("injected-native-" + str(len(state.calls)))
            seed.mkdir()
            harness = Harness(seed)
            harness.pipeline.fault = state.fault
            context = launch_context.load_launch_context(
                root=root,
                code_root=root,
                runtime_root=runtime,
                input_path=input_path,
                output_path=output_path,
                request=request,
                environment=kwargs["launch_sideband"].environment,
                verify_host_admission=lambda value, context: worker_entry.verify_subject(
                    value["spec"], context
                ),
            )
            harness.request = copy.deepcopy(request)
            harness.context = context
            harness.pipeline.spec = copy.deepcopy(request["spec"])
            harness.pipeline.contract = copy.deepcopy(request["execution_contract"])
            harness.pipeline.root = root
            harness.pipeline.run = output_path.parent
            harness.pipeline.config = copy.deepcopy(context.native_task_config)
            if state.optimizer is not None:
                harness.modules.update(
                    {
                        key: value
                        for key, value in state.optimizer.runtime.modules.items()
                        if key.startswith("optking.")
                    }
                )
                original_manager = harness.modules["optking.optimize"].OptimizationManager

                class CompleteSyntheticHistory(original_manager):
                    """Native-shaped fake history matching this fake engine's zero gradients."""

                    def take_step(self, *args, **options):
                        result = super().take_step(*args, **options)
                        for step in self.history.steps:
                            record = {
                                "geom": step.geom.tolist(),
                                "E": -100.0,
                                "forces": [0.0] * 102,
                                "cart_grad": [0.0] * 102,
                                "projectedDE": None,
                                "Dq": [0.0] * 102,
                                "followedUnitVector": [0.0] * 102,
                                "oneDgradient": None,
                                "oneDhessian": None,
                                "decent": True,
                            }
                            step.to_dict = lambda record=record: copy.deepcopy(record)
                        return result

                harness.modules["optking.optimize"].OptimizationManager = CompleteSyntheticHistory

            def runtime_verifier(spec, actual_context):
                assert spec == request["spec"] and actual_context is context
                events.append("synthetic.runtime.verification")

            report = harness.execute(
                verify_host_admission=launch_context.verify_launch_context,
                verify_subject=worker_entry.verify_subject,
                verify_runtime=runtime_verifier,
                import_module=harness.modules.__getitem__,
            )
            state.reports.append(report)
            assert report["execution_evidence_state"] == "unassessed"
            assert not {"psi4", "qcengine", "qcelemental", "optking", "dftd3"} & sys.modules.keys()
        events.append("run_worker.return")
        stdout, stderr = b"synthetic supervised stdout\n", b""
        return {
            "status": "succeeded",
            "returncode": 0,
            "duration_ms": 1,
            "resource_limits": kwargs["resources"].as_dict(),
            "process_tree_empty_verified": state.quiescent,
            "_stdout": stdout,
            "_stderr": stderr,
            "stdout_sha256": hashlib.sha256(stdout).hexdigest(),
            "stderr_sha256": hashlib.sha256(stderr).hexdigest(),
            "stdout_bytes": len(stdout),
            "stderr_bytes": 0,
            "synthetic_test_only": True,
            "native_process_started": False,
        }

    monkeypatch.setattr(execution, "run_worker", runner)

    def approve(**kwargs):
        state.latest_approval = execution.issue_approval(
            state.store,
            state.plan["resolved_plan_hash"],
            actor="Synthetic integration-test approval",
            **kwargs,
        )
        return state.latest_approval

    state.approve = approve
    state.submit = lambda approval, **kwargs: execution.submit_run(
        state.store, approval["token"], **kwargs
    )
    state.result = lambda job: json.loads(
        (state.store.runs / job["job_id"] / "result.json").read_bytes()
    )
    return state


def test_actual_store_roundtrip_approval_single_gradient_and_full_evidence(governed):
    state = governed
    assert state.store.load_plan(state.plan["resolved_plan_hash"]) == state.plan
    approval = state.approve()
    job = state.submit(approval)
    result = state.result(job)
    assert job["status"] == "succeeded", result
    assert result["evidence_eligible"] is True
    assert result["scientific_state"] == "incomplete"
    assert result["minimum_certified"] is result["scientific_accuracy_validated"] is False
    assert result["lifecycle_admission"]["mode_completed"] is True
    assert result["contract_assessment"]["complete"] is True
    assert len(result["scientific_result"]["trajectory"]) == 1
    assert len(result["scientific_result"]["trajectory"][0]["geometry"]["atoms"]) == 34
    assert len(state.calls) == 1
    assert state.events.index("host.before") < state.events.index("run_worker")
    assert state.events.index("run_worker.return") < state.events.index("host.after")
    run = state.store.runs / job["job_id"]
    before = json.loads((run / "host-evidence/before.json").read_bytes())
    after = json.loads((run / "host-evidence/after.json").read_bytes())
    start = json.loads((run / "evaluation-0000-dispatch/outer-start.json").read_bytes())
    assert before["monotonic_seconds"] <= start["monotonic_seconds"] <= after["monotonic_seconds"]
    assert before["run_nonce"] == start["run_nonce"] == after["run_nonce"]
    assert state.store.load_approval(approval["token"])["launches_used"] == 1
    assert state.store.load_job(job["job_id"]) == job
    assert job["result_hash"] == content_hash(result)
    assert (run / "stdout.txt").read_bytes() == b"synthetic supervised stdout\n"


def test_duplicate_submission_returns_original_job_without_new_run_or_budget(governed):
    approval = governed.approve()
    first = governed.submit(approval)
    second = governed.submit(approval)
    assert first == second and first["status"] == "succeeded"
    assert len(governed.calls) == 1
    assert governed.store.load_approval(approval["token"])["launches_used"] == 1
    with pytest.raises(ValueError, match="budget is exhausted"):
        governed.submit(approval, launch_intent="new-explicit-launch")
    assert len(governed.calls) == 1


def test_expired_approval_rejects_before_reservation_or_worker(governed):
    approval = governed.approve(ttl_seconds=1)
    governed.clock += 2
    with pytest.raises(ValueError, match="expired"):
        governed.submit(approval)
    assert governed.calls == [] and list(governed.store.jobs.iterdir()) == []
    assert governed.store.load_approval(approval["token"])["launches_used"] == 0


def test_worker_drift_after_approval_rejects_without_new_job(governed):
    approval = governed.approve()
    governed.worker["script_sha256"] = "f" * 64
    with pytest.raises(ValueError, match="worker or launch chain changed"):
        governed.submit(approval)
    assert governed.calls == [] and list(governed.store.jobs.iterdir()) == []


def test_expiry_at_final_launch_boundary_retains_before_without_dispatch(governed):
    approval = governed.approve(ttl_seconds=10)
    governed.expire_after_before = True
    job = governed.submit(approval)
    result = governed.result(job)
    assert job["status"] == "failed" and result["evidence_eligible"] is False
    assert "expired" in result["summary"]
    assert governed.calls == [] and governed.events == ["host.before"]
    run = governed.store.runs / job["job_id"]
    assert (run / "host-evidence/before.json").is_file()
    assert not (run / "host-evidence/after.json").exists()
    assert governed.store.load_approval(approval["token"])["launches_used"] == 1


def test_subject_changed_since_approval_is_rejected_before_worker(governed):
    approval = governed.approve()
    with pytest.raises(ValueError, match="current subject differs"):
        governed.submit(approval, current_subject_hash="sha256:" + "0" * 64)
    assert governed.calls == []


@pytest.mark.parametrize("fault", ["missing_result", "runner_exception", "missing_nested_return"])
def test_failures_keep_partial_artifacts_without_eligible_result(governed, fault):
    governed.fault = fault
    job = governed.submit(governed.approve())
    result = governed.result(job)
    assert job["status"] == "failed" and result["evidence_eligible"] is False, result
    assert result["minimum_certified"] is result["scientific_accuracy_validated"] is False
    assert result["scratch_retained"] is True
    run = governed.store.runs / job["job_id"]
    assert (run / "input.json").exists() and (run / "host-evidence/before.json").exists()
    if fault == "runner_exception":
        assert "synthetic process wait failed" in result["summary"]
        assert (run / "scratch/partial.bin").read_bytes() == b"synthetic retained scratch"
        assert (run / "supervisor-failure.json").exists()
        assert not (run / "host-evidence/after.json").exists()
    elif fault == "missing_result":
        assert not (run / "worker-result.json").exists()
        assert result["scientific_result"] is None
        assert result["execution_evidence"] is None
    else:
        assert result["contract_assessment"]["complete"] is False
        assert result["scientific_result"]["state"] == "failed"
        assert (run / "evaluation-0000-dispatch/nested/inner-0001-start.json").exists()
        assert not (run / "evaluation-0000-dispatch/nested/inner-0001-return.json").exists()


def test_unverified_process_quiescence_retains_science_but_no_after_or_admission(governed):
    governed.quiescent = False
    job = governed.submit(governed.approve())
    result = governed.result(job)
    assert job["status"] == "failed" and result["evidence_eligible"] is False
    assert "PROCESS_TREE_NOT_QUIESCENT" in result["summary"]
    run = governed.store.runs / job["job_id"]
    assert (run / "worker-result.json").is_file()
    assert (run / "evaluation-0000-dispatch/outer-result.json").is_file()
    assert not (run / "host-evidence/after.json").exists()
    assert "host.after" not in governed.events
    assert "contract_assessment" not in result


def test_actual_registration_bytes_are_not_bypassed(governed):
    document = json.loads(governed.registry.read_bytes())
    for entry in document["adapters"]:
        if entry["manifest"]["adapter_id"] == "chem.compute.refinement":
            entry["enabled"] = False
    governed.registry.write_bytes(canonical_bytes(validate_adapter_registry(document)))
    with pytest.raises(ValueError, match="COMPUTE_NOT_REGISTERED"):
        governed.approve()
    assert governed.calls == []


def test_optimization_store_to_observed_calls_to_actual_optimizer_admission(
    governed, environment, monkeypatch
):
    state = governed
    # Restore genuine product keyword construction. The older optimizer fixture
    # substitutes settings for its own isolated recorder tests; this integrated
    # path must retain the exact declared D3BJ request keywords.
    monkeypatch.setattr(refinement_backend.GradientRecorder, "settings", REAL_RECORDER_SETTINGS)
    spec = copy.deepcopy(state.plan["spec"])
    spec["optimizer_settings"] = copy.deepcopy(environment.spec["optimizer_settings"])
    spec = molecular_refinement.seal_refinement_spec(
        {key: value for key, value in spec.items() if key != "spec_hash"}
    )
    contract = seal_execution_contract(spec, "optimization", environment.binding)
    for filename, value, ref_key in (
        ("spec.json", spec, "spec_ref"),
        ("contract.json", contract, "execution_contract_ref"),
    ):
        # Rebind only this test's temporary fixture; historical evidence is untouched.
        raw = json.dumps(value, sort_keys=True, allow_nan=False).encode()
        (state.root / filename).write_bytes(raw)
        state.case[ref_key] = {"path": filename, "sha256": hashlib.sha256(raw).hexdigest()}
    state.case["mode"] = "optimization"
    state.optimizer = environment
    state.plan = governed_plan.prepare(**state.case)
    state.store.save_plan(state.plan)
    approval = state.approve()
    job = state.submit(approval)
    result = state.result(job)
    assert job["status"] == "succeeded", result
    assert result["evidence_eligible"] is True
    assert result["contract_assessment"]["complete"] is True
    assert result["lifecycle_admission"]["mode_completed"] is True
    assert result["scientific_state"] == "succeeded"
    science = result["scientific_result"]
    assert [frame["step_status"] for frame in science["trajectory"]] == [
        "initial",
        "accepted",
        "reevaluation",
    ]
    assert (
        science["trajectory"][-1]["reevaluates_frame_hash"]
        == science["trajectory"][1]["frame_hash"]
    )
    assert science["trajectory"][-1]["geometry"] == science["trajectory"][1]["geometry"]
    assert all(len(frame["geometry"]["atoms"]) == 34 for frame in science["trajectory"])
    assert science["timing"]["backend_attempts_observed"] == 3
    evaluations = result["contract_assessment"]["evaluations"]
    assert len(evaluations) == 3
    assert all(all(count == 2 for count in item["durable_counts"].values()) for item in evaluations)
    assert result["minimum_certified"] is result["scientific_accuracy_validated"] is False
    run = state.store.runs / job["job_id"]
    assert (run / "optimizer-final-reevaluation.json").exists()
    assert (run / "optimizer-0001-native-step-returned.json").exists()
    assert state.events.index("host.before") < state.events.index("run_worker")
    assert state.events.index("run_worker.return") < state.events.index("host.after")
