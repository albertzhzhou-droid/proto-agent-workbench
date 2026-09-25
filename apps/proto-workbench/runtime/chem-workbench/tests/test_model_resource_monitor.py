"""Run the observer in disposable Python processes so hooks never enter the application."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def run_driver(tmp_path, body):
    driver = tmp_path / "observer_driver.py"
    prefix = (
        "import json, os, socket, subprocess, sys\n"
        "from pathlib import Path\n"
        f"sys.path.insert(0, {str(ROOT / 'scripts')!r})\n"
        "from model_resource_monitor import RuntimeObserver\n"
    )
    driver.write_text(prefix + body, encoding="utf-8")
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    result = subprocess.run(
        [sys.executable, str(driver)],
        capture_output=True,
        text=True,
        check=True,
        timeout=15,
        creationflags=flags,
    )
    return json.loads(result.stdout)


def test_unexpected_connection_process_and_shell_are_denied_before_effects(tmp_path):
    result = run_driver(
        tmp_path,
        """
blocked = []
original_connect = socket.socket.connect
with RuntimeObserver(sample_resources=False, gpu=False) as observer:
    for name, action in [
        ("network", lambda: socket.create_connection(("192.0.2.1", 443), timeout=0.1)),
        ("process", lambda: subprocess.Popen([sys.executable, "-c", "raise RuntimeError"])),
        ("shell", lambda: os.system("echo must-not-run")),
    ]:
        try:
            action()
        except PermissionError:
            blocked.append(name)
report = observer.report()
# An audit event outside the context is observed by no active guard and causes no launch.
sys.audit("subprocess.Popen", "outside.exe", ["outside.exe"], None, None)
print(json.dumps({"blocked": blocked, "report": report,
                  "socket_restored": socket.socket.connect is original_connect}))
""",
    )
    assert result["blocked"] == ["network", "process", "shell"]
    assert result["socket_restored"]
    audit = result["report"]["audit"]
    assert audit["unauthorized_attempts"] == 3
    assert audit["successful_allowed_connections"] == 0
    assert audit["complete"]


def test_allowed_attempts_and_successes_are_distinct_observations(tmp_path):
    result = run_driver(
        tmp_path,
        """
# A fake transport emits the real audit event; this test does not contact a server.
def fake_connect(sock, address):
    sys.audit("socket.connect", sock, address)
socket.socket.connect = fake_connect
with RuntimeObserver(sample_resources=False, gpu=False) as observer:
    with socket.socket() as sock:
        sock.connect(("127.0.0.1", 1234))
print(json.dumps(observer.report()))
""",
    )
    assert result["audit"]["allowed_connection_attempts"] == 1
    assert result["audit"]["successful_allowed_connections"] == 1
    assert result["audit"]["unauthorized_attempts"] == 0


def test_a_controller_cannot_impersonate_the_trusted_gpu_sampling_thread(tmp_path):
    result = run_driver(
        tmp_path,
        """
from model_resource_monitor import GPU_ARGUMENTS
with RuntimeObserver(sample_resources=False, gpu=False) as observer:
    observer.gpu_executable = "C:/trusted/nvidia-smi.exe"
    argv = [observer.gpu_executable, *GPU_ARGUMENTS]
    audit_argv = subprocess.list2cmdline(argv) if os.name == "nt" else argv
    try:
        sys.audit("subprocess.Popen", observer.gpu_executable, audit_argv, None, None)
    except PermissionError:
        pass
print(json.dumps(observer.report()))
""",
    )
    assert result["audit"]["unauthorized_attempts"] == 1
    assert result["audit"]["trusted_monitor_process_attempts"] == 0


def test_observer_cli_reports_real_controller_resource_samples():
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/model_resource_monitor.py"),
            "--seconds",
            "1.1",
            "--no-gpu",
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=15,
        creationflags=flags,
    )
    report = json.loads(result.stdout)
    assert report["sampling_worker_stopped"] and len(report["samples"]) >= 2
    assert report["resources"]["controller_peak_rss_bytes"] > 0
    assert report["resources"]["controller_cpu_seconds_delta"] >= 0
    assert report["audit"]["trusted_monitor_process_attempts"] == 0


def test_slow_bounded_gpu_query_is_observed_and_sampler_stops(tmp_path):
    result = run_driver(
        tmp_path,
        """
import time
import model_resource_monitor as monitor
timeouts = []
def slow_query(argv, *, timeout, **kwargs):
    timeouts.append(timeout)
    delay = 2.1
    time.sleep(min(delay, timeout))
    if timeout < delay:
        raise subprocess.TimeoutExpired(argv, timeout)
    return subprocess.CompletedProcess(argv, 0, '0, Development GPU, 321, 8192, 50\\n', '')
monitor.shutil.which = lambda _: sys.executable
monitor.subprocess.run = slow_query
with RuntimeObserver() as observer:
    pass
print(json.dumps({'report': observer.report(), 'timeouts': timeouts}))
""",
    )
    report = result["report"]
    assert report["errors"] == []
    assert report["sampling_worker_stopped"] and report["audit"]["complete"]
    assert report["resources"]["gpu_peak_used_mib"] == 321
    assert report["resources"]["controller_peak_rss_bytes"] > 0
    assert result["timeouts"] and all(2.1 < limit <= 10 for limit in result["timeouts"])
    assert report["samples"][0]["gpu_instrumentation_seconds"] >= 2.1


@pytest.mark.parametrize(
    "failure_mode, error_text",
    [("timeout", "TimeoutExpired"), ("empty", "NVIDIA_SMI_EMPTY_RESULT")],
)
def test_gpu_failure_preserves_cpu_samples_and_remains_an_error(tmp_path, failure_mode, error_text):
    result = run_driver(
        tmp_path,
        """
import model_resource_monitor as monitor
def failed_query(argv, *, timeout, **kwargs):
    if FAILURE_MODE == 'timeout':
        raise subprocess.TimeoutExpired(argv, timeout)
    return subprocess.CompletedProcess(argv, 0, '', '')
monitor.shutil.which = lambda _: sys.executable
monitor.subprocess.run = failed_query
with RuntimeObserver() as observer:
    pass
print(json.dumps(observer.report()))
""".replace("FAILURE_MODE", repr(failure_mode)),
    )
    assert result["sampling_worker_stopped"] and result["audit"]["complete"]
    assert len(result["samples"]) == 1
    assert result["resources"]["controller_peak_rss_bytes"] > 0
    assert result["resources"]["gpu_peak_used_mib"] is None
    assert error_text in result["errors"][0]
    assert result["samples"][0]["gpu_error"] == result["errors"][0]
