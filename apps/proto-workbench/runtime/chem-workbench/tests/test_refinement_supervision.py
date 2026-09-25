"""Pure refinement supervisor checks; every process and backend probe is replaced."""

from __future__ import annotations

import hashlib
import io
import json
import re
from dataclasses import FrozenInstanceError, replace
from pathlib import Path
from threading import Event, Lock
from types import SimpleNamespace

import pytest
from test_molecular_refinement import _spec, _without

import chem_workbench.execution as execution
from chem_workbench.molecular_refinement import seal_refinement_spec


@pytest.fixture(autouse=True)
def prohibit_real_workloads(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("This test must not launch a process or probe a real backend")

    monkeypatch.setattr(execution.subprocess, "Popen", forbidden)
    monkeypatch.setattr(execution, "resume_suspended_process", forbidden)
    monkeypatch.setattr(execution, "environment_identity", forbidden)
    monkeypatch.setattr(execution, "refinement_environment_identity", forbidden)


@pytest.fixture
def limits():
    return execution.WorkerResourceLimits(
        wall_seconds=1200,
        memory_bytes=4 * 1024**3,
        cpu_seconds=1800,
        threads=2,
        max_output_bytes=1024,
    )


def request_file(tmp_path, limits, **resource_changes):
    body = _without(_spec(), "spec_hash")
    body["resources"].update(limits.as_dict())
    body["resources"].update(resource_changes)
    path = tmp_path / "input.json"
    path.write_text(
        json.dumps(
            {
                "version": "refinement-worker-request/v1",
                "mode": "gradient",
                "spec": seal_refinement_spec(body),
            }
        ),
        encoding="utf-8",
    )
    return path


def invoke(tmp_path, limits, **kwargs):
    return execution.run_worker(
        execution.WORKERS["psi4_refinement"],
        tmp_path / "input.json",
        tmp_path / "output.json",
        deadline_seconds=limits.wall_seconds,
        max_output_bytes=limits.max_output_bytes,
        resources=limits,
        **kwargs,
    )


@pytest.mark.parametrize(
    "field,maximum",
    [
        ("wall_seconds", 86400),
        ("memory_bytes", 16 * 1024**3),
        ("cpu_seconds", 86400),
        ("threads", 8),
        ("max_output_bytes", 20 * 1024**2),
    ],
)
@pytest.mark.parametrize("invalid_kind", ["true", "false", "zero", "negative", "over", "float"])
def test_explicit_resources_reject_invalid_types_and_bounds(limits, field, maximum, invalid_kind):
    invalid = {
        "true": True,
        "false": False,
        "zero": 0,
        "negative": -1,
        "over": maximum + 1,
        "float": 1.0,
    }[invalid_kind]
    with pytest.raises(ValueError, match="invalid refinement resource"):
        replace(limits, **{field: invalid})


def test_resources_are_required_frozen_and_maxima_are_inclusive(limits):
    with pytest.raises(TypeError):
        execution.WorkerResourceLimits()
    with pytest.raises(FrozenInstanceError):
        limits.threads = 4
    maximum = execution.WorkerResourceLimits(
        wall_seconds=86400,
        memory_bytes=16 * 1024**3,
        cpu_seconds=86400,
        threads=8,
        max_output_bytes=20 * 1024**2,
    )
    assert maximum.as_dict()["max_output_bytes"] == 20 * 1024**2


@pytest.mark.parametrize("resources", [None, {}, True])
def test_refinement_requires_typed_explicit_resources_before_launch(tmp_path, resources):
    with pytest.raises(ValueError, match="explicit WorkerResourceLimits"):
        execution.run_worker(
            execution.WORKERS["psi4_refinement"],
            tmp_path / "input.json",
            tmp_path / "output.json",
            deadline_seconds=600,
            max_output_bytes=1024,
            resources=resources,
        )


@pytest.mark.parametrize("field", ["wall_seconds", "max_output_bytes"])
def test_legacy_argument_and_explicit_limit_mismatch_precedes_launch(tmp_path, limits, field):
    arguments = {
        "deadline_seconds": limits.wall_seconds,
        "max_output_bytes": limits.max_output_bytes,
    }
    arguments["deadline_seconds" if field == "wall_seconds" else field] += 1
    with pytest.raises(ValueError, match="runner resource ceilings differ"):
        execution.run_worker(
            execution.WORKERS["psi4_refinement"],
            tmp_path / "input.json",
            tmp_path / "output.json",
            resources=limits,
            **arguments,
        )


@pytest.mark.parametrize(
    "field", ["wall_seconds", "memory_bytes", "cpu_seconds", "threads", "max_output_bytes"]
)
def test_bound_spec_must_match_every_supervisor_limit(tmp_path, limits, field):
    request_file(tmp_path, limits, **{field: getattr(limits, field) + 1})
    with pytest.raises(ValueError, match="spec and supervisor resource ceilings differ"):
        invoke(tmp_path, limits)


def test_mutated_resource_object_is_revalidated_before_launch(tmp_path, limits):
    object.__setattr__(limits, "threads", True)
    with pytest.raises(ValueError, match="invalid refinement resource threads"):
        invoke(tmp_path, limits)


@pytest.mark.parametrize("kind", ["mock", "ase_emt", "psi4_water", "psi4_molecular"])
def test_old_workers_cannot_opt_into_refinement_limits(tmp_path, limits, kind):
    with pytest.raises(ValueError, match="extended resources require the refinement worker"):
        execution.run_worker(
            execution.WORKERS[kind],
            tmp_path / "input.json",
            tmp_path / "output.json",
            deadline_seconds=600,
            max_output_bytes=1024,
            resources=limits,
        )
    with pytest.raises(ValueError, match="invalid worker resource ceilings"):
        execution.run_worker(
            execution.WORKERS[kind],
            tmp_path / "input.json",
            tmp_path / "output.json",
            deadline_seconds=601,
            max_output_bytes=1024,
        )


def fake_runner(monkeypatch, *, stdout=b"ok", stderr=b"", assignment_failure=False, finish=True):
    events = []
    state = {"events": events}

    class Process:
        pid = 123
        returncode = None

        def __init__(self):
            self.stdout, self.stderr = io.BytesIO(stdout), io.BytesIO(stderr)

        def poll(self):
            return self.returncode

        def kill(self):
            events.append("process.kill")
            self.returncode = -1

        def wait(self, timeout):
            events.append("process.wait")
            return self.returncode

    process = Process()

    class Job:
        def __init__(self, **kwargs):
            state["job"] = kwargs

        def __enter__(self):
            events.append("job.enter")
            return self

        def assign(self, child):
            assert child is process
            events.append("job.assign")
            if assignment_failure:
                raise OSError("assignment failed")

        def terminate(self):
            events.append("job.terminate")

        def wait_until_empty(self):
            events.append("job.empty")

        def __exit__(self, *args):
            events.append("job.close")

    class ImmediateThread:
        def __init__(self, *, target, args, daemon):
            self.target, self.args = target, args

        def start(self):
            self.target(*self.args)

        def join(self, timeout):
            events.append("capture.join")

        def is_alive(self):
            return False

    def popen(argv, **kwargs):
        events.append("process.create")
        state["argv"], state["popen"] = argv, kwargs
        return process

    def resume(pid):
        assert pid == process.pid
        events.append("process.resume")
        if finish:
            process.returncode = 0

    monkeypatch.setattr(execution, "_JobObject", Job)
    monkeypatch.setattr(execution, "_worker_argv", lambda *args: ["first-party-worker-placeholder"])
    monkeypatch.setattr(execution.subprocess, "Popen", popen)
    monkeypatch.setattr(execution, "resume_suspended_process", resume)
    monkeypatch.setattr(execution, "Thread", ImmediateThread)
    return state


def test_refinement_applies_limits_and_assigns_before_resume(tmp_path, monkeypatch, limits):
    request_file(tmp_path, limits)
    state = fake_runner(monkeypatch)
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    (scratch / "owned.tmp").write_text("fixture", encoding="utf-8")
    result = invoke(tmp_path, limits)
    assert result["status"] == "succeeded"
    assert result["resource_limits"] == limits.as_dict()
    assert state["job"] == {
        "job_memory_bytes": limits.memory_bytes,
        "job_cpu_seconds": limits.cpu_seconds,
    }
    assert state["popen"]["creationflags"] == 0x00000004 | 0x08000000
    for key in ["OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"]:
        assert state["popen"]["env"][key] == "2"
    assert state["events"][:4] == ["job.enter", "process.create", "job.assign", "process.resume"]
    assert "job.terminate" in state["events"] and state["events"][-1] == "job.close"
    assert not scratch.exists()


def test_assignment_failure_kills_suspended_process_without_resume(tmp_path, monkeypatch, limits):
    request_file(tmp_path, limits)
    state = fake_runner(monkeypatch, assignment_failure=True)
    with pytest.raises(OSError, match="assignment failed"):
        invoke(tmp_path, limits)
    assert state["events"] == [
        "job.enter",
        "process.create",
        "job.assign",
        "job.terminate",
        "process.kill",
        "process.wait",
        "job.close",
    ]


def test_capture_budget_is_shared_and_marks_refinement_output_limit(tmp_path, monkeypatch, limits):
    request_file(tmp_path, limits)
    fake_runner(monkeypatch, stdout=b"a" * 700, stderr=b"b" * 700)
    result = invoke(tmp_path, limits)
    assert result["status"] == "output_limit"
    assert result["stdout_bytes"] + result["stderr_bytes"] == limits.max_output_bytes


def test_cancelled_refinement_terminates_process_and_closes_job(tmp_path, monkeypatch, limits):
    request_file(tmp_path, limits)
    state = fake_runner(monkeypatch, finish=False)
    cancellation = tmp_path / "cancel.request"
    cancellation.touch()
    result = invoke(tmp_path, limits, cancel_path=cancellation)
    assert result["status"] == "cancelled"
    assert "process.kill" in state["events"] and state["events"][-1] == "job.close"


def test_refinement_wall_deadline_uses_explicit_limit_and_kills_process(
    tmp_path, monkeypatch, limits
):
    request_file(tmp_path, limits)
    state = fake_runner(monkeypatch, finish=False)
    clock = iter([0.0, float(limits.wall_seconds), float(limits.wall_seconds)])
    monkeypatch.setattr(execution.time, "monotonic", lambda: next(clock))
    result = invoke(tmp_path, limits)
    assert result["status"] == "timeout"
    assert "process.kill" in state["events"] and state["events"][-1] == "job.close"


def test_old_worker_keeps_original_job_threads_and_capture_behavior(tmp_path, monkeypatch):
    state = fake_runner(monkeypatch, stdout=b"a" * 700, stderr=b"b" * 700)
    result = execution.run_worker(
        execution.WORKERS["mock"],
        tmp_path / "input.json",
        tmp_path / "output.json",
        deadline_seconds=600,
        max_output_bytes=1024,
    )
    assert state["job"] == {"job_memory_bytes": 3 * 1024**3, "job_cpu_seconds": 600}
    assert result["status"] == "succeeded" and "resource_limits" not in result
    assert result["stdout_bytes"] + result["stderr_bytes"] == 1400
    for key in ["OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"]:
        assert state["popen"]["env"][key] == "1"


@pytest.mark.parametrize("set_succeeds", [True, False])
def test_job_object_writes_requested_kernel_limits_and_preserves_kill_on_close(
    monkeypatch, set_succeeds
):
    seen = {}

    class Function:
        def __init__(self, call):
            self.call = call

        def __call__(self, *args):
            return self.call(*args)

    def set_information(handle, info_class, pointer, size):
        info = pointer._obj
        seen.update(
            memory=info.JobMemoryLimit,
            cpu=info.BasicLimitInformation.PerJobUserTimeLimit,
            flags=info.BasicLimitInformation.LimitFlags,
        )
        return int(set_succeeds)

    kernel = SimpleNamespace(
        CreateJobObjectW=Function(lambda *args: 123),
        SetInformationJobObject=Function(set_information),
        AssignProcessToJobObject=Function(lambda *args: 1),
        TerminateJobObject=Function(lambda *args: 1),
        CloseHandle=Function(lambda handle: seen.update(closed=handle)),
    )
    monkeypatch.setattr(execution.ctypes, "windll", SimpleNamespace(kernel32=kernel))
    if set_succeeds:
        with execution._JobObject(job_memory_bytes=16 * 1024**3, job_cpu_seconds=86400):
            assert "closed" not in seen
    else:
        with (
            pytest.raises(OSError, match="SetInformationJobObject failed"),
            execution._JobObject(job_memory_bytes=16 * 1024**3, job_cpu_seconds=86400),
        ):
            raise AssertionError("Cannot enter a job whose resource limits were not applied")
    assert seen["memory"] == 16 * 1024**3 and seen["cpu"] == 86400 * 10_000_000
    assert seen["flags"] == 0x2000 | 0x200 | 0x4
    assert seen["closed"] == 123


def test_capture_helper_closes_pipes_at_shared_boundary():
    budget, lock, exceeded = [4], Lock(), Event()
    first, second = io.BytesIO(b"abc"), io.BytesIO(b"de")
    buffers = [bytearray(), bytearray()]
    execution._capture_refinement_pipe(first, buffers[0], budget, lock, exceeded)
    execution._capture_refinement_pipe(second, buffers[1], budget, lock, exceeded)
    assert buffers == [b"abc", b"d"] and budget == [0] and exceeded.is_set()
    assert first.closed and second.closed


def test_refinement_identity_uses_new_environment_and_binds_product_modules(tmp_path, monkeypatch):
    for relative in [
        "scripts/worker_refinement_psi4.py",
        "scripts/worker_water_psi4.py",
        "scripts/run_psi4_python.ps1",
        "backend/python.exe",
        "uv.lock",
    ]:
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("identity fixture only", encoding="utf-8")
    monkeypatch.setattr(execution, "REPOSITORY_ROOT", tmp_path)
    monkeypatch.setattr(execution, "psi4_prefix", lambda root: root / "backend")
    calls = []
    monkeypatch.setattr(
        execution,
        "refinement_environment_identity",
        lambda root, profile_id: calls.append((root, profile_id)) or {"refinement": True},
    )
    result = execution.worker_identity(execution.WORKERS["psi4_refinement"])
    assert result["environment"] == {"refinement": True}
    assert calls == [(tmp_path, "psi4.wb97x_v.def2_tzvppd.optimize.v1")]
    package = Path(execution.__file__).resolve().parent
    for name in [
        "refinement_backend.py",
        "method_profiles.py",
        "molecular_refinement.py",
        "chemir/constraints.py",
        "runtime_identity.py",
        "execution.py",
        "__init__.py",
    ]:
        assert (
            result["product_module_sha256"][name]
            == hashlib.sha256((package / name).read_bytes()).hexdigest()
        )
    assert len(result["product_module_sha256"]) >= len(list(package.rglob("*.py")))
    monkeypatch.setattr(execution, "environment_identity", lambda *args: {"legacy": True})
    legacy = execution.worker_identity(execution.WORKERS["psi4_water"])
    assert legacy["environment"] == {"legacy": True} and "product_module_sha256" not in legacy
    assert len(calls) == 1


def test_launcher_preserves_supplied_thread_environment_and_finally_restores_it():
    launcher = Path(execution.__file__).resolve().parents[2] / "scripts/run_psi4_python.ps1"
    source = launcher.read_text(encoding="utf-8")
    guarded_default = re.compile(
        r"if\s*\(\s*-not\s+\$env:OMP_NUM_THREADS\s*\)\s*"
        r"\{\s*\$env:OMP_NUM_THREADS\s*=\s*'1'\s*\}",
        re.IGNORECASE,
    )
    assert len(guarded_default.findall(source)) == 1
    remaining = guarded_default.sub("", source)
    assert re.findall(r"\$env:OMP_NUM_THREADS\s*=\s*([^\r\n]+)", remaining) == ["$previousThreads"]
    assert "$previousThreads = $env:OMP_NUM_THREADS" in source
    assert "$env:OMP_NUM_THREADS = $previousThreads" in source.split("finally", 1)[1]
