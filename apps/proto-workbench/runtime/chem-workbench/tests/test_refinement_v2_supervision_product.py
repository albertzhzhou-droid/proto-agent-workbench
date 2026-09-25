"""Actual retained complex Design data; fake processes and runtime callbacks only."""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from test_refinement_governed_plan_product import case as case
from test_refinement_governed_plan_product import retained_case as retained_case
from test_refinement_supervision import fake_runner

from chem_workbench import execution
from chem_workbench.refinement_execution import governed_plan, launch_context, worker_entry
from chem_workbench.refinement_execution.disk_budget import DiskBudget
from chem_workbench.refinement_execution.host_subject_admission import build_host_admission


@pytest.fixture
def prepared(case, monkeypatch):
    root = case["root"]
    runtime, run = root / "runtime", root / "job-run"
    runtime.mkdir()
    run.mkdir()
    case["observed_worker_identity"]["environment"] = {"prefix": str(runtime)}
    case["disk_budget"] = DiskBudget(
        max_run_bytes=16 * 1024**2,
        max_entries=1000,
        minimum_free_bytes=0,
        scan_timeout_seconds=2.0,
        interval_seconds=5.0,
    )
    plan = governed_plan.prepare(**case)
    context = governed_plan.context_from_artifacts(
        **{key: value for key, value in case.items() if key != "disk_budget"}
    )

    def write(path, value):
        raw = value if isinstance(value, bytes) else json.dumps(value, allow_nan=False).encode()
        path.write_bytes(raw)
        return {
            "path": path.relative_to(root).as_posix(),
            "sha256": hashlib.sha256(raw).hexdigest(),
        }

    input_ref = write(run / "input.json", plan["prepared_input"])
    admitted = write(
        root / "admission.json", build_host_admission(root=root, spec_ref=case["spec_ref"])
    )
    source = write(root / "synthetic-worker.py", b"# synthetic source identity for pure tests\n")
    limits = execution.WorkerResourceLimits(**plan["resource_ceilings"])

    def authority(value, launch):
        assert value == plan["prepared_input"]
        assert launch.approval_id == "sha256:" + "a" * 64

    sideband = launch_context.create_launch_context(
        root=root,
        code_root=root,
        runtime_root=runtime,
        job_id="job-test",
        approval_id="sha256:" + "a" * 64,
        run_id="run-test",
        run_directory="job-run",
        plan=plan,
        plan_context=context,
        input_artifact=input_ref,
        trusted_subject_admission_ref=admitted,
        source_identity={source["path"]: source["sha256"]},
        native_task_config={
            "ncores": limits.threads,
            "memory": limits.memory_bytes / 1024**3 * 0.6,
            "retries": 0,
            "scratch_directory": str(run / "scratch"),
        },
        validate_host_plan=lambda value, _: governed_plan.validate_plan(
            value, root, case["observed_worker_identity"]
        ),
        verify_host_admission=authority,
    )

    def forbidden(*_args, **_kwargs):
        raise AssertionError("Pure v2 wiring test cannot import or launch native science")

    monkeypatch.setattr(execution.subprocess, "Popen", forbidden)
    monkeypatch.setattr(execution, "resume_suspended_process", forbidden)
    monkeypatch.setattr(execution, "refinement_environment_identity", forbidden)
    monkeypatch.setattr(execution, "REPOSITORY_ROOT", root)
    monkeypatch.setattr(execution, "psi4_prefix", lambda _: runtime)
    monkeypatch.setattr(execution, "_worker_argv", lambda *_: ["synthetic-worker"])
    monkeypatch.setattr(worker_entry, "psi4_prefix", lambda _: runtime)
    monkeypatch.setattr(worker_entry.importlib, "import_module", forbidden)
    return SimpleNamespace(
        root=root,
        run=run,
        runtime=runtime,
        plan=plan,
        sideband=sideband,
        limits=limits,
        budget=case["disk_budget"],
        input=run / "input.json",
        output=run / "worker-result.json",
    )


def invoke(state, **changes):
    values = {
        "deadline_seconds": state.limits.wall_seconds,
        "max_output_bytes": state.limits.max_output_bytes,
        "resources": state.limits,
        "disk_budget": state.budget,
        "launch_sideband": state.sideband,
    }
    return execution.run_worker(
        execution.WORKERS["psi4_refinement"], state.input, state.output, **(values | changes)
    )


def test_v2_supervisor_forwards_only_controlled_sideband_and_retains_journal(prepared, monkeypatch):
    monkeypatch.setenv("CHEM_REFINEMENT_CONTEXT_NONCE", "untrusted ambient value")
    monkeypatch.setenv("CHEM_REFINEMENT_CONTEXT_EXTRA", "must not reach worker")
    state = fake_runner(monkeypatch)
    parent_cwd = Path.cwd()
    monkeypatch.setattr(execution, "_worker_argv", lambda _, inp, out: [str(inp), str(out)])
    result = invoke(prepared)
    assert result["status"] == "succeeded"
    assert result["process_tree_empty_verified"] is True
    assert result["resource_limits"] == prepared.limits.as_dict()
    assert state["popen"]["cwd"] == prepared.run / "scratch" / "worker-cwd"
    assert state["argv"] == [str(prepared.input.resolve()), str(prepared.output.resolve())]
    assert Path.cwd() == parent_cwd
    environment = state["popen"]["env"]
    assert {
        key: value
        for key, value in environment.items()
        if key.startswith("CHEM_REFINEMENT_CONTEXT_")
    } == prepared.sideband.environment
    assert environment["PSI_SCRATCH"] == str(prepared.run / "scratch")
    assert (prepared.run / "supervisor-disk-observations.jsonl").is_file()
    assert not prepared.output.exists()  # Fake process emitted no scientific record.


@pytest.mark.parametrize("occupied", ["scratch_file", "cwd_file", "cwd_directory"])
def test_v2_rejects_occupied_scratch_cwd_before_process_creation(prepared, occupied):
    scratch = prepared.run / "scratch"
    if occupied == "scratch_file":
        scratch.write_text("must remain")
    else:
        scratch.mkdir()
        target = scratch / "worker-cwd"
        if occupied == "cwd_file":
            target.write_text("must remain")
        else:
            target.mkdir()
            (target / "owned.txt").write_text("must remain")
    with pytest.raises((ValueError, FileExistsError)):
        invoke(prepared)
    assert not (prepared.run / "supervisor-disk-observations.jsonl").exists()
    assert not prepared.output.exists()


@pytest.mark.parametrize("missing", ["launch_sideband", "disk_budget"])
def test_v2_requires_both_host_launch_and_disk_before_process_creation(prepared, missing):
    with pytest.raises(ValueError, match="HOST_CONTEXT_REQUIRED"):
        invoke(prepared, **{missing: None})
    assert not (prepared.run / "supervisor-disk-observations.jsonl").exists()


@pytest.mark.parametrize("fault", ["untyped", "nonce", "disk", "claimed", "input"])
def test_v2_independent_launch_revalidation_rejects_drift_before_popen(prepared, fault):
    changes = {}
    if fault == "untyped":
        changes["launch_sideband"] = {}
    elif fault == "nonce":
        changes["launch_sideband"] = replace(
            prepared.sideband,
            environment={**prepared.sideband.environment, launch_context.ENV_NONCE: "b" * 64},
        )
    elif fault == "disk":
        changes["disk_budget"] = replace(prepared.budget, max_entries=999)
    elif fault == "claimed":
        (prepared.root / ".job-run-refinement-launch.claimed.json").write_bytes(b"{}")
    else:
        prepared.input.write_bytes(prepared.input.read_bytes() + b" ")
    with pytest.raises(ValueError):
        invoke(prepared, **changes)
    assert not (prepared.run / "supervisor-disk-observations.jsonl").exists()


def test_v2_duplicate_raw_request_keys_rejected_before_sideband_or_process(prepared):
    raw = prepared.input.read_text()
    prepared.input.write_text('{"version":"refinement-worker-request/v2",' + raw[1:])
    with pytest.raises(ValueError, match="malformed refinement"):
        invoke(prepared)


@pytest.mark.parametrize("kind", ["mock", "ase_emt", "psi4_water", "psi4_molecular"])
def test_other_workers_cannot_receive_v2_context(prepared, kind):
    with pytest.raises(ValueError, match="host launch context requires"):
        execution.run_worker(
            execution.WORKERS[kind],
            prepared.input,
            prepared.output,
            deadline_seconds=10,
            max_output_bytes=1000,
            launch_sideband=prepared.sideband,
        )


def test_worker_entry_admits_real_subject_before_runtime_failure_and_retains_it(
    prepared, monkeypatch
):
    for key in list(worker_entry.os.environ):
        if key.startswith("CHEM_REFINEMENT_CONTEXT_"):
            monkeypatch.delenv(key)
    for key, value in prepared.sideband.environment.items():
        monkeypatch.setenv(key, value)
    observed = []

    def factory(*, import_module):
        def fail(spec, context):
            assert len(spec["geometry"]["atoms"]) == 34
            observed.append(context.run_nonce)
            raise ValueError("synthetic unavailable runtime; native imports forbidden")

        return fail

    monkeypatch.setattr(worker_entry, "make_runtime_verifier", factory)
    report = worker_entry.run_v2(
        prepared.plan["prepared_input"],
        input_path=prepared.input,
        output_path=prepared.output,
        root=prepared.root,
    )
    assert report["runner_outcome"] == "failed" and report["scientific_result"] is None
    assert observed == [prepared.sideband.context.run_nonce] * 2
    assert (prepared.run / "worker-lifecycle.json").is_file()
    assert (prepared.run / "worker-lifecycle-events.jsonl").is_file()
    assert not prepared.output.exists()
    with pytest.raises(FileExistsError):
        worker_entry.run_v2(
            prepared.plan["prepared_input"],
            input_path=prepared.input,
            output_path=prepared.output,
            root=prepared.root,
        )


def test_worker_entry_cannot_bootstrap_host_context_from_request(prepared, monkeypatch):
    for key in list(worker_entry.os.environ):
        if key.startswith("CHEM_REFINEMENT_CONTEXT_"):
            monkeypatch.delenv(key)
    with pytest.raises(ValueError, match="controlled sideband environment"):
        worker_entry.run_v2(
            prepared.plan["prepared_input"],
            input_path=prepared.input,
            output_path=prepared.output,
            root=prepared.root,
        )
    assert not prepared.output.exists()
