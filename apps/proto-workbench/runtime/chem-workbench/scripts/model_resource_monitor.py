"""Runner-only observation of controller resources and Python network/process attempts.

The audit hook is dormant outside the observer's context. This is a scoped Python
observation and enforcement layer, not an operating-system sandbox or a monitor of
LM Studio's own process. No application module imports or enables it.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

_ACTIVE = None
_HOOK_INSTALLED = False
MAX_OBSERVATIONS = 4096
MAX_SAMPLES = 600
GPU_QUERY_TIMEOUT_SECONDS = 5.0
SAMPLER_WAIT_SECONDS = GPU_QUERY_TIMEOUT_SECONDS + 1.0
PROVIDER_PROCESS_NAMES = {"lm studio.exe", "llama-server.exe", "llmster.exe", "lmstudio.exe"}
GPU_ARGUMENTS = [
    "--query-gpu=index,name,memory.used,memory.total,utilization.gpu",
    "--format=csv,noheader,nounits",
]


def _audit_dispatch(event, args):
    observer = _ACTIVE
    if observer is not None:
        observer.audit(event, args)


class RuntimeObserver:
    def __init__(self, *, sample_resources=True, gpu=True, interval_seconds=1.0):
        if interval_seconds < 1.0:
            raise ValueError("RESOURCE_SAMPLING_INTERVAL_TOO_SHORT")
        self.sample_resources = sample_resources
        self.gpu = gpu
        self.interval_seconds = interval_seconds
        self.started = None
        self.ended = None
        self.events = []
        self.samples = []
        self.errors = []
        self.truncated = False
        self.stop = threading.Event()
        self.first_sample = threading.Event()
        self.thread = None
        self.sampler_thread_id = None
        self.psutil = None
        self.gpu_executable = None
        self.worker_stopped = True
        self.original_connect = None
        self.original_connect_ex = None
        self.wrapped_connect = None
        self.wrapped_connect_ex = None

    def _event(self, event, outcome, **details):
        item = {
            "event": event,
            "outcome": outcome,
            "thread_id": threading.get_ident(),
            "seconds_from_start": round(time.monotonic() - self.started, 6),
            **details,
        }
        if len(self.events) < MAX_OBSERVATIONS:
            self.events.append(item)
        else:
            self.truncated = True
        return item

    def audit(self, event, args):
        if event in {"socket.connect", "socket.sendto"}:
            address = args[1] if event == "socket.connect" else args[-1]
            host, port = (
                address[:2]
                if isinstance(address, tuple) and len(address) >= 2
                else (str(address), None)
            )
            allowed = event == "socket.connect" and host == "127.0.0.1" and port == 1234
            self._event(
                event,
                "allowed_attempt" if allowed else "denied_attempt",
                host=str(host),
                port=port,
                socket_id=id(args[0]),
            )
            if not allowed:
                raise PermissionError("EVALUATION_NETWORK_DENIED")
        elif event == "subprocess.Popen":
            executable, argv = args[:2]
            expected_argv = [self.gpu_executable, *GPU_ARGUMENTS] if self.gpu_executable else []
            argv_matches = (
                list(argv) == expected_argv
                if isinstance(argv, (list, tuple))
                else os.name == "nt"
                and bool(expected_argv)
                and argv == subprocess.list2cmdline(expected_argv)
            )
            actual_executable = str(
                executable
                or (
                    argv[0]
                    if isinstance(argv, (list, tuple)) and argv
                    else "inferred_by_subprocess"
                )
            )
            trusted = (
                threading.get_ident() == self.sampler_thread_id
                and self.gpu_executable is not None
                and (executable is None or str(executable) == self.gpu_executable)
                and argv_matches
            )
            self._event(
                event,
                "allowed_instrumentation" if trusted else "denied_attempt",
                executable=self.gpu_executable if trusted else actual_executable,
                argument_count=len(argv) if isinstance(argv, (list, tuple)) else None,
                instrumentation="nvidia-smi" if trusted else None,
            )
            if not trusted:
                raise PermissionError("EVALUATION_PROCESS_DENIED")
        elif event in {"os.system", "os.exec", "os.posix_spawn", "os.spawn"}:
            raw = repr(args).encode()
            self._event(event, "denied_attempt", arguments_hash=hashlib.sha256(raw).hexdigest())
            raise PermissionError("EVALUATION_PROCESS_DENIED")

    def __enter__(self):
        global _ACTIVE, _HOOK_INSTALLED
        if _ACTIVE is not None:
            raise RuntimeError("RUNTIME_OBSERVER_ALREADY_ACTIVE")
        if self.sample_resources:
            try:
                import psutil

                self.psutil = psutil
            except ImportError:
                self.errors.append("PSUTIL_UNAVAILABLE")
        if self.gpu:
            executable = shutil.which("nvidia-smi.exe" if os.name == "nt" else "nvidia-smi")
            self.gpu_executable = str(Path(executable).resolve()) if executable else None
            if self.gpu_executable is None:
                self.errors.append("NVIDIA_SMI_UNAVAILABLE")
        if not _HOOK_INSTALLED:
            sys.addaudithook(_audit_dispatch)
            _HOOK_INSTALLED = True
        self.started = time.monotonic()
        self.original_connect = socket.socket.connect
        self.original_connect_ex = socket.socket.connect_ex

        def connect(sock, address):
            try:
                result = self.original_connect(sock, address)
            except OSError as exc:
                self._event(
                    "socket.connect.result",
                    "connection_failed",
                    socket_id=id(sock),
                    error_type=type(exc).__name__,
                    errno=exc.errno,
                )
                raise
            self._event("socket.connect.result", "connection_succeeded", socket_id=id(sock))
            return result

        def connect_ex(sock, address):
            result = self.original_connect_ex(sock, address)
            self._event(
                "socket.connect.result",
                "connection_succeeded" if result == 0 else "connection_failed",
                socket_id=id(sock),
                errno=result,
            )
            return result

        self.wrapped_connect, self.wrapped_connect_ex = connect, connect_ex
        socket.socket.connect = connect
        socket.socket.connect_ex = connect_ex
        _ACTIVE = self
        if self.sample_resources or self.gpu:
            self.thread = threading.Thread(
                target=self._sample_loop, name="model-evaluation-observer", daemon=True
            )
            self.thread.start()
            self.first_sample.wait(timeout=SAMPLER_WAIT_SECONDS)
        return self

    def __exit__(self, exc_type, exc, traceback):
        global _ACTIVE
        self.stop.set()
        if self.thread is not None:
            self.thread.join(timeout=SAMPLER_WAIT_SECONDS)
            self.worker_stopped = not self.thread.is_alive()
        self.ended = time.monotonic()
        _ACTIVE = None
        if socket.socket.connect is self.wrapped_connect:
            socket.socket.connect = self.original_connect
        if socket.socket.connect_ex is self.wrapped_connect_ex:
            socket.socket.connect_ex = self.original_connect_ex
        return False

    def _sample_loop(self):
        self.sampler_thread_id = threading.get_ident()
        while not self.stop.is_set() and len(self.samples) < MAX_SAMPLES:
            try:
                self.samples.append(self._sample())
            except Exception as exc:
                # Observation failure remains visible and cannot become successful monitoring.
                self.errors.append(type(exc).__name__ + ": " + str(exc)[:300])
            finally:
                self.first_sample.set()
            self.stop.wait(self.interval_seconds)
        if len(self.samples) >= MAX_SAMPLES:
            self.truncated = True

    def _sample(self):
        sample = {"seconds_from_start": round(time.monotonic() - self.started, 6)}
        if self.psutil is not None:
            memory = self.psutil.virtual_memory()
            current = self.psutil.Process()
            sample["system_used_ram_bytes"] = memory.total - memory.available
            sample["system_total_ram_bytes"] = memory.total
            sample["controller"] = self._process(current)
            processes = []
            for process in self.psutil.process_iter(["pid", "name"]):
                if (process.info["name"] or "").lower() in PROVIDER_PROCESS_NAMES:
                    try:
                        processes.append(self._process(process))
                    except (self.psutil.NoSuchProcess, self.psutil.AccessDenied):
                        continue
            sample["provider_name_matched_processes"] = processes
        if self.gpu_executable is not None:
            started = time.monotonic()
            try:
                sample["gpus"] = self._sample_gpus()
            except Exception as exc:
                # Keep independently observed CPU/RAM values. GPU failure remains
                # explicit and still fails the unchanged resource completeness gate.
                error = type(exc).__name__ + ": " + str(exc)[:300]
                self.errors.append(error)
                sample["gpu_error"] = error
            sample["gpu_instrumentation_seconds"] = round(time.monotonic() - started, 6)
        return sample

    def _sample_gpus(self):
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        result = subprocess.run(
            [self.gpu_executable, *GPU_ARGUMENTS],
            capture_output=True,
            text=True,
            timeout=GPU_QUERY_TIMEOUT_SECONDS,
            creationflags=flags,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError("NVIDIA_SMI_EXIT_" + str(result.returncode))
        gpus = []
        for parts in csv.reader(io.StringIO(result.stdout)):
            if len(parts) != 5:
                raise ValueError("NVIDIA_SMI_INVALID_ROW")
            gpus.append(
                {
                    "index": int(parts[0]),
                    "name": parts[1].strip(),
                    "memory_used_mib": float(parts[2]),
                    "memory_total_mib": float(parts[3]),
                    "utilization_percent": float(parts[4]),
                }
            )
        if not gpus:
            raise ValueError("NVIDIA_SMI_EMPTY_RESULT")
        return gpus

    @staticmethod
    def _process(process):
        times = process.cpu_times()
        return {
            "pid": process.pid,
            "name": process.name(),
            "rss_bytes": process.memory_info().rss,
            "cpu_seconds": times.user + times.system,
        }

    def report(self):
        denied = [event for event in self.events if event["outcome"] == "denied_attempt"]
        connections = [event for event in self.events if event["event"] == "socket.connect"]
        controller_rss = [
            sample["controller"]["rss_bytes"] for sample in self.samples if "controller" in sample
        ]
        cpu_samples = [
            sample["controller"]["cpu_seconds"] for sample in self.samples if "controller" in sample
        ]
        system_used = [
            sample["system_used_ram_bytes"]
            for sample in self.samples
            if "system_used_ram_bytes" in sample
        ]
        provider_rss = [
            sum(
                process["rss_bytes"]
                for process in sample.get("provider_name_matched_processes", [])
            )
            for sample in self.samples
            if "provider_name_matched_processes" in sample
        ]
        gpu_used = [
            sum(gpu["memory_used_mib"] for gpu in sample.get("gpus", []))
            for sample in self.samples
            if "gpus" in sample
        ]
        return {
            "version": "model-controller-observations/v1",
            "sampling_interval_seconds": self.interval_seconds,
            "samples": self.samples,
            "errors": self.errors,
            "observations_truncated": self.truncated,
            "sampling_worker_stopped": self.worker_stopped,
            "duration_seconds": round((self.ended or time.monotonic()) - self.started, 6),
            "resources": {
                "controller_peak_rss_bytes": max(controller_rss) if controller_rss else None,
                "controller_cpu_seconds_delta": max(cpu_samples) - min(cpu_samples)
                if len(cpu_samples) >= 2
                else None,
                "system_peak_used_ram_bytes": max(system_used) if system_used else None,
                "provider_name_matched_peak_rss_bytes": max(provider_rss) if provider_rss else None,
                "gpu_peak_used_mib": max(gpu_used) if gpu_used else None,
            },
            "sampling_note": "Peaks are sampled maxima; transients may occur between samples.",
            "audit": {
                "events": self.events,
                "unauthorized_attempts": len(denied),
                "allowed_connection_attempts": sum(
                    event["outcome"] == "allowed_attempt" for event in connections
                ),
                "successful_allowed_connections": sum(
                    event["event"] == "socket.connect.result"
                    and event["outcome"] == "connection_succeeded"
                    for event in self.events
                ),
                "trusted_monitor_process_attempts": sum(
                    event["outcome"] == "allowed_instrumentation" for event in self.events
                ),
                "complete": self.ended is not None and self.worker_stopped and not self.truncated,
            },
            "instrumentation": {
                "executable": self.gpu_executable,
                "argv": [self.gpu_executable, *GPU_ARGUMENTS] if self.gpu_executable else None,
                "allowed_only_from_sampler_thread": True,
                "gpu_query_timeout_seconds": GPU_QUERY_TIMEOUT_SECONDS,
                "sampler_wait_seconds": SAMPLER_WAIT_SECONDS,
            },
            "scope": "Python controller connects and launches only; LM Studio runs separately. "
            "Provider names are a sampling heuristic. GPU values cover the whole device. "
            "This is not operating-system isolation or an audit of native-library traffic.",
        }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=float, default=1.1)
    parser.add_argument("--no-gpu", action="store_true")
    parser.add_argument("--probe-provider", action="store_true")
    args = parser.parse_args()
    if not 0 <= args.seconds <= 10:
        parser.error("--seconds must be between zero and ten")
    with RuntimeObserver(gpu=not args.no_gpu) as observer:
        if args.probe_provider:
            with socket.create_connection(("127.0.0.1", 1234), timeout=5):
                pass
        time.sleep(args.seconds)
    print(json.dumps(observer.report(), indent=2))
