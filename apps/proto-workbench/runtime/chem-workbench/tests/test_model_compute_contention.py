"""Contention evidence checks only; these tests launch no model or scientific calculation."""

from __future__ import annotations

import copy
import io
import json
import queue
import runpy
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
HARNESS = runpy.run_path(str(ROOT / "scripts/verify_model_compute_contention.py"))


def worker_identity():
    return {
        "pid": 123,
        "create_time": 100.5,
        "process_identity_verified": True,
        "samples_ns": [1_000_000_000, 2_000_000_000, 3_000_000_000],
    }


def test_overlap_uses_actual_worker_samples_and_provider_interval():
    result = HARNESS["verified_overlap"](
        {"start_ns": 1_500_000_000, "end_ns": 2_500_000_000}, worker_identity()
    )
    assert result["passed"]
    assert result["overlap_seconds_lower_bound"] == 1
    assert result["worker_samples_during_provider"] == 1


@pytest.mark.parametrize(
    "mutation",
    [
        {"samples_ns": []},
        {"samples_ns": [1_000_000_000]},
        {"samples_ns": [1_000_000_000, 1_000_000_000]},
        {"samples_ns": [2_000_000_000, 1_000_000_000]},
        {"samples_ns": [True, 2_000_000_000]},
        {"process_identity_verified": False},
        {"pid": None},
        {"create_time": None},
    ],
)
def test_queue_state_or_unverified_liveness_never_proves_overlap(mutation):
    result = HARNESS["verified_overlap"](
        {"start_ns": 1, "end_ns": 4_000_000_000},
        {**worker_identity(), **mutation, "job_state": "running"},
    )
    assert not result["passed"]
    assert result["overlap_seconds_lower_bound"] == 0


def test_nonoverlapping_real_intervals_fail_without_a_retry():
    result = HARNESS["verified_overlap"](
        {"start_ns": 3_000_000_000, "end_ns": 4_000_000_000}, worker_identity()
    )
    assert not result["passed"] and result["reason"] == "NO_OBSERVED_OVERLAP"


def test_launcher_command_line_is_insufficient_for_actual_worker_identity():
    interpreter = ROOT / "isolated-backend/python.exe"
    script = ROOT / "scripts/worker_molecular_psi4.py"
    identity = {"interpreter_path": str(interpreter)}
    actual = SimpleNamespace(
        is_running=lambda: True,
        exe=lambda: str(interpreter),
        cmdline=lambda: [str(interpreter), str(script)],
    )
    launcher = SimpleNamespace(
        is_running=lambda: True,
        exe=lambda: "C:/Windows/powershell.exe",
        cmdline=lambda: ["powershell.exe", "-File", str(script)],
    )
    unrelated = SimpleNamespace(
        is_running=lambda: True,
        exe=lambda: str(interpreter),
        cmdline=lambda: [str(interpreter), "other.py"],
    )
    assert HARNESS["is_registered_worker"](actual, identity)
    assert not HARNESS["is_registered_worker"](launcher, identity)
    assert not HARNESS["is_registered_worker"](unrelated, identity)


def test_owned_child_accepts_only_the_windows_venv_redirector_in_the_parent_chain():
    interpreter = ROOT / ".venv/Scripts/python.exe"
    host = SimpleNamespace(pid=10, parent=lambda: None)
    direct = SimpleNamespace(parent=lambda: host)
    redirector = SimpleNamespace(pid=11, parent=lambda: host, exe=lambda: str(interpreter))
    redirected = SimpleNamespace(parent=lambda: redirector)
    unrelated = SimpleNamespace(pid=12, parent=lambda: host, exe=lambda: "other.exe")
    additional = SimpleNamespace(pid=13, parent=lambda: redirector, exe=lambda: str(interpreter))
    assert HARNESS["is_owned_child"](direct, host.pid, interpreter)
    assert HARNESS["is_owned_child"](redirected, host.pid, interpreter)
    assert not HARNESS["is_owned_child"](
        SimpleNamespace(parent=lambda: unrelated), host.pid, interpreter
    )
    assert not HARNESS["is_owned_child"](
        SimpleNamespace(parent=lambda: additional), host.pid, interpreter
    )


def resource_fixture():
    worker = worker_identity()
    sample = {
        "controller": {"rss_bytes": 10},
        "system_used_ram_bytes": 100,
        "system_total_ram_bytes": 200,
        "provider_name_matched_processes": [{"rss_bytes": 20}],
        "gpus": [{"memory_used_mib": 10, "memory_total_mib": 100}],
        "owned_compute_tree": [
            {
                "pid": worker["pid"],
                "create_time": worker["create_time"],
                "rss_bytes": 30,
                "cpu_seconds": 1,
            }
        ],
    }
    second = copy.deepcopy(sample)
    second["owned_compute_tree"][0]["cpu_seconds"] = 2
    return {
        "samples": [sample, second],
        "errors": [],
        "observations_truncated": False,
        "sampling_worker_stopped": True,
        "audit": {
            "complete": True,
            "unauthorized_attempts": 0,
            "successful_allowed_connections": 1,
        },
    }, worker


def test_resources_require_the_same_actual_worker_and_a_complete_audit():
    resources, worker = resource_fixture()
    result = HARNESS["assess_resources"](resources, worker, {"job_memory_bytes": 50})
    assert result["passed"] and result["actual_worker_observed_cpu_seconds_delta"] == 1
    assert not HARNESS["assess_resources"](
        resources, {**worker, "create_time": 101}, {"job_memory_bytes": 50}
    )["passed"]
    resources["audit"]["unauthorized_attempts"] = 1
    assert not HARNESS["assess_resources"](resources, worker, {"job_memory_bytes": 50})["passed"]


def test_missing_gpu_and_over_ceiling_samples_fail_resource_evidence():
    resources, worker = resource_fixture()
    resources["samples"][0]["gpus"] = []
    result = HARNESS["assess_resources"](resources, worker, {"job_memory_bytes": 29})
    assert not result["passed"]
    assert not result["checks"]["whole_device_gpu_sampled"]
    assert not result["checks"]["owned_tree_sampled_rss_within_profile_ceiling"]


@pytest.mark.parametrize(
    "raw, error",
    [
        ("x" * 16_385, "CHILD_PROTOCOL_LIMIT"),
        ('{"event":"other"}\n', "CHILD_PROTOCOL_INVALID"),
        ('{"event":"ready"}\n{"event":"ready"}\n', "CHILD_PROTOCOL_DUPLICATE_EVENT"),
    ],
)
def test_child_protocol_rejects_unbounded_or_repeated_events(raw, error):
    messages = queue.Queue()
    HARNESS["read_protocol"](io.StringIO(raw), messages, threading.Event())
    events = []
    while not messages.empty():
        events.append(messages.get_nowait())
    assert events[-1] == {"event": "protocol_error", "error": error}


def test_child_protocol_preserves_independently_observed_timestamps():
    records = [
        {"event": event, "monotonic_ns": i}
        for i, event in enumerate(["ready", "submitted", "worker_running", "completed"])
    ]
    messages = queue.Queue()
    HARNESS["read_protocol"](
        io.StringIO("\n".join(json.dumps(record) for record in records)),
        messages,
        threading.Event(),
    )
    assert [messages.get_nowait() for _ in records] == records


def test_exclusive_output_rejects_before_provider_or_compute(monkeypatch, tmp_path):
    path = tmp_path / "existing.json"
    path.write_text("preserved", encoding="utf-8")
    monkeypatch.setattr(HARNESS["sys"], "platform", "win32")

    def unexpected_call():
        pytest.fail("provider must not be queried for an existing output")

    monkeypatch.setattr(HARNESS["orchestrator"], "model_status", unexpected_call)
    with pytest.raises(ValueError, match="OUTPUT_EXISTS"):
        HARNESS["run"](path)
    assert path.read_text(encoding="utf-8") == "preserved"
