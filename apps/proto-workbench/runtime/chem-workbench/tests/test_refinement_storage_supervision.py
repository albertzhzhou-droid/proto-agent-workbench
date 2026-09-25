"""Process replacements plus real bounded filesystem observations; no chemistry."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from test_refinement_supervision import fake_runner, invoke, request_file

from chem_workbench import execution
from chem_workbench.refinement_execution.disk_budget import DiskBudget
from chem_workbench.refinement_supervision import RefinementStorageMonitor


@pytest.fixture
def limits():
    return execution.WorkerResourceLimits(
        wall_seconds=1200, memory_bytes=4 * 1024**3,
        cpu_seconds=1800, threads=2, max_output_bytes=1024,
    )


@pytest.fixture(autouse=True)
def forbid_native(monkeypatch, tmp_path):
    def forbidden(*args, **kwargs):
        raise AssertionError("Pure supervisor test must not launch or probe a backend")

    monkeypatch.setattr(execution.subprocess, "Popen", forbidden)
    monkeypatch.setattr(execution, "resume_suspended_process", forbidden)
    monkeypatch.setattr(execution, "refinement_environment_identity", forbidden)
    monkeypatch.setattr(execution, "environment_identity", forbidden)
    monkeypatch.setattr(execution, "_worker_argv", lambda *args: ["synthetic-worker"])
    monkeypatch.setattr(execution, "REPOSITORY_ROOT", tmp_path.parent)


def budget(**changes):
    return DiskBudget(**{
        "max_run_bytes": 1024**2, "max_entries": 1000, "minimum_free_bytes": 0,
        "scan_timeout_seconds": 1, "interval_seconds": 0.001, **changes,
    })


def journal(tmp_path):
    return [json.loads(line) for line in
            (tmp_path / "supervisor-disk-observations.jsonl").read_text().splitlines()]


def test_low_free_space_retains_admission_record_before_process_creation(tmp_path, limits):
    request_file(tmp_path, limits)
    with pytest.raises(ValueError, match="disk admission failed"):
        invoke(tmp_path, limits, disk_budget=budget(minimum_free_bytes=2**63))
    rows = journal(tmp_path)
    assert len(rows) == 1 and rows[0]["phase"] == "before_launch"
    assert rows[0]["observation"]["status"] == "limit_exceeded"
    assert not (tmp_path / "output.json").exists()


def test_monitored_runner_confirms_tree_exit_and_preserves_scratch(tmp_path, monkeypatch, limits):
    request_file(tmp_path, limits)
    state = fake_runner(monkeypatch)
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    artifact = scratch / "partial.log"
    artifact.write_bytes(b"synthetic native progress, not a scientific result")
    result = invoke(tmp_path, limits, disk_budget=budget())
    assert result["status"] == "succeeded" and result["process_tree_empty_verified"] is True
    assert artifact.is_file() and result["storage"]["scratch_retained"] is True
    assert result["storage_stop_reason"] is None
    assert result["storage"]["operating_system_disk_quota"] is False
    assert state["events"].index("job.empty") < state["events"].index("job.close")
    rows = journal(tmp_path)
    assert rows[0]["phase"] == "before_launch"
    assert rows[-1]["phase"] == "after_process_tree_exit"
    assert result["storage"]["observations"] == len(rows)


def test_midrun_disk_exhaustion_stops_owned_tree_and_keeps_failure(tmp_path, monkeypatch, limits):
    request_file(tmp_path, limits)
    state = fake_runner(monkeypatch, finish=False)
    original_resume = execution.resume_suspended_process

    def grow(pid):
        original_resume(pid)
        (tmp_path / "scratch").mkdir()
        (tmp_path / "scratch/partial.bin").write_bytes(b"x" * 2 * 1024**2)

    monkeypatch.setattr(execution, "resume_suspended_process", grow)
    result = invoke(tmp_path, limits, disk_budget=budget(interval_seconds=1e-9))
    assert result["status"] == "failed" and result["storage_stop_reason"]
    assert "process.kill" in state["events"] and "job.empty" in state["events"]
    assert (tmp_path / "scratch/partial.bin").stat().st_size == 2 * 1024**2
    assert any(row["observation"]["status"] == "limit_exceeded" for row in journal(tmp_path))


def test_journal_tamper_stops_tree_without_rewriting_history(tmp_path, monkeypatch, limits):
    request_file(tmp_path, limits)
    state = fake_runner(monkeypatch, finish=False)
    original_resume = execution.resume_suspended_process

    def tamper(pid):
        original_resume(pid)
        with (tmp_path / "supervisor-disk-observations.jsonl").open("r+b") as stream:
            stream.write(b"!")

    monkeypatch.setattr(execution, "resume_suspended_process", tamper)
    result = invoke(tmp_path, limits, disk_budget=budget(interval_seconds=1e-9))
    assert result["status"] == "failed"
    assert "journal bytes changed" in result["storage_stop_reason"]
    assert result["storage"]["journal_integrity_verified"] is False
    assert "process.kill" in state["events"]
    assert (tmp_path / "supervisor-disk-observations.jsonl").read_bytes().startswith(b"!")


def test_unverified_tree_exit_never_cleans_scratch(tmp_path, monkeypatch, limits):
    request_file(tmp_path, limits)
    fake_runner(monkeypatch)
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    (scratch / "partial.log").write_bytes(b"retained")

    def fail(self):
        raise TimeoutError("descendants did not exit")

    monkeypatch.setattr(execution._JobObject, "wait_until_empty", fail)
    with pytest.raises(TimeoutError, match="descendants did not exit"):
        invoke(tmp_path, limits, disk_budget=budget())
    assert (scratch / "partial.log").read_bytes() == b"retained"
    assert all(row["phase"] != "after_process_tree_exit" for row in journal(tmp_path))
    failure = json.loads((tmp_path / "supervisor-failure.json").read_bytes())
    assert failure["exception_type"] == "TimeoutError"
    assert failure["process_tree_empty_verified"] is False
    assert failure["captured_streams_complete"] is False
    assert (tmp_path / "supervisor-failure-stdout.bin").read_bytes() == b"ok"
    assert (tmp_path / "supervisor-failure-stderr.bin").read_bytes() == b""


@pytest.mark.parametrize("kind", ["mock", "ase_emt", "psi4_water", "psi4_molecular"])
def test_other_workers_cannot_enable_new_monitor(tmp_path, kind):
    with pytest.raises(ValueError, match="disk monitoring requires the refinement worker"):
        execution.run_worker(
            execution.WORKERS[kind], tmp_path / "in", tmp_path / "out",
            deadline_seconds=10, max_output_bytes=1000, disk_budget=budget(),
        )


@pytest.mark.parametrize("active,success", [(0, 1), (2, 1), (0, 0)])
def test_owned_job_query_reads_kernel_accounting(active, success):
    seen = []

    class Function:
        def __call__(self, handle, info_class, pointer, size, returned):
            seen.append((handle, info_class, size))
            pointer._obj.ActiveProcesses = active
            return success

    job = execution._JobObject()
    job.handle = 567
    job._kernel32 = SimpleNamespace(QueryInformationJobObject=Function())
    if success:
        assert job.active_processes() == active
    else:
        with pytest.raises(OSError, match="accounting failed"):
            job.active_processes()
    assert seen == [(567, 1, 48)]


def test_missing_job_handle_does_not_claim_quiescence():
    with pytest.raises(ValueError, match="no live job handle"):
        execution._JobObject().active_processes()


def test_monitored_run_rejects_distinct_input_output_directories(tmp_path, limits):
    request_file(tmp_path, limits)
    other = tmp_path / "other"
    other.mkdir()
    with pytest.raises(ValueError, match="run directories differ"):
        execution.run_worker(
            execution.WORKERS["psi4_refinement"], tmp_path / "input.json", other / "output.json",
            deadline_seconds=limits.wall_seconds, max_output_bytes=limits.max_output_bytes,
            resources=limits, disk_budget=budget(),
        )


def test_journal_growth_after_stat_has_a_strict_read_budget(tmp_path):
    with RefinementStorageMonitor(tmp_path.parent, tmp_path.name, budget()) as monitor:
        original = monitor.stream
        original_length = monitor.length
        reads = []

        class ConcurrentGrowth:
            def __getattr__(self, name):
                return getattr(original, name)

            def read(self, size):
                reads.append(size)
                with monitor.path.open("ab") as writer:
                    writer.write(b"x" * 4096)
                return original.read(size)

        monitor.stream = ConcurrentGrowth()
        with pytest.raises(ValueError, match="journal length changed"):
            monitor._verify_journal()
        assert sum(reads) <= original_length + 1
        assert monitor.journal_integrity_verified is False


@pytest.mark.parametrize("failure_mode", ["short_write", "fsync"])
def test_terminal_journal_write_failure_does_not_claim_integrity(
    tmp_path, failure_mode, monkeypatch
):
    with RefinementStorageMonitor(tmp_path.parent, tmp_path.name, budget()) as monitor:
        original = monitor.stream

        class ShortWrite:
            def __getattr__(self, name):
                return getattr(original, name)

            def write(self, raw):
                return original.write(raw[:1])

        if failure_mode == "short_write":
            monitor.stream = ShortWrite()
        else:
            def fail(fd):
                raise OSError("injected fsync failure")
            monkeypatch.setattr("chem_workbench.refinement_supervision.os.fsync", fail)
        with pytest.raises(OSError):
            monitor.check("after_process_tree_exit", force=True)
        assert monitor.summary()["journal_integrity_verified"] is False


def test_assignment_exception_keeps_empty_capture_prefixes(tmp_path, monkeypatch, limits):
    request_file(tmp_path, limits)
    fake_runner(monkeypatch, assignment_failure=True)
    with pytest.raises(OSError, match="assignment failed"):
        invoke(tmp_path, limits, disk_budget=budget())
    failure = json.loads((tmp_path / "supervisor-failure.json").read_bytes())
    assert failure["error"] == "assignment failed"
    assert all(ref["bytes"] == 0 for ref in failure["captured_prefixes"])
    assert failure["scientific_result_accepted"] is False


def test_retention_error_does_not_replace_original_supervision_failure(
    tmp_path, monkeypatch, limits
):
    request_file(tmp_path, limits)
    fake_runner(monkeypatch, assignment_failure=True)

    def failed_retention(self, *args, **kwargs):
        (tmp_path / "partial-retention.bin").write_bytes(b"retained prefix")
        raise OSError("injected disk write failure")

    monkeypatch.setattr(RefinementStorageMonitor, "retain_exception", failed_retention)
    with pytest.raises(OSError, match="assignment failed") as failure:
        invoke(tmp_path, limits, disk_budget=budget())
    assert "disk write failure" in failure.value.__notes__[0]
    assert (tmp_path / "partial-retention.bin").read_bytes() == b"retained prefix"
