"""One observed model request overlapping one supervised aspirin RHF/STO-3G job.

This functional contention check is not a stress test or a model-promotion dataset.
The scientific job is approved by an owned host child before the parent enables its
model-only audit. Only the owned child tree is terminated during cleanup.
"""

from __future__ import annotations

import argparse
import copy
import getpass
import hashlib
import io
import json
import os
import queue
import runpy
import socket
import subprocess
import sys
import threading
import time
from contextlib import suppress
from pathlib import Path

from chem_workbench import execution, orchestrator
from chem_workbench.evaluation import model_identity
from chem_workbench.model_context import request_context
from chem_workbench.molecular_compute import MOLECULAR_PROFILE, validate_molecular_result
from chem_workbench.tool_gateway import invoke_tool
from chem_workbench.visualization import compile_snapshot, content_hash
from chem_workbench.worker_supervision import capture_pipe, resume_suspended_process
from chem_workbench.workflows import WorkflowService

ROOT = Path(__file__).resolve().parents[1]
DEADLINE_SECONDS = 180
RuntimeObserver = runpy.run_path(str(Path(__file__).with_name("model_resource_monitor.py")))[
    "RuntimeObserver"
]


def write_new(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")


def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def remaining(deadline_ns):
    return max(0.0, (deadline_ns - time.monotonic_ns()) / 1_000_000_000)


def verified_overlap(provider_interval, worker_liveness):
    """Only actually observed worker liveness can establish overlap, not queued job state."""
    start, end = provider_interval.get("start_ns"), provider_interval.get("end_ns")
    samples = worker_liveness.get("samples_ns", [])
    if (
        type(start) is not int
        or type(end) is not int
        or end <= start
        or not isinstance(samples, list)
        or len(samples) < 2
        or any(type(value) is not int for value in samples)
        or samples != sorted(set(samples))
        or worker_liveness.get("process_identity_verified") is not True
        or type(worker_liveness.get("pid")) is not int
        or worker_liveness["pid"] <= 0
        or type(worker_liveness.get("create_time")) not in (float, int)
        or worker_liveness["create_time"] <= 0
    ):
        return {
            "passed": False,
            "overlap_seconds_lower_bound": 0.0,
            "reason": "INSUFFICIENT_OBSERVED_WORKER_OR_PROVIDER_INTERVAL",
        }
    overlap = max(0, min(end, samples[-1]) - max(start, samples[0]))
    return {
        "passed": overlap > 0,
        "overlap_seconds_lower_bound": overlap / 1_000_000_000,
        "provider_interval_ns": [start, end],
        "observed_worker_interval_ns": [samples[0], samples[-1]],
        "worker_samples_during_provider": sum(start <= sample <= end for sample in samples),
        "reason": None if overlap > 0 else "NO_OBSERVED_OVERLAP",
        "clock": "same-host monotonic_ns (Windows system-wide performance counter)",
    }


def is_registered_worker(process, identity):
    expected_script = (ROOT / "scripts/worker_molecular_psi4.py").resolve()
    interpreter = Path(identity["interpreter_path"]).resolve()
    return (
        process.is_running()
        and Path(process.exe()).resolve() == interpreter
        and any(
            Path(argument).resolve() == expected_script
            for argument in process.cmdline()
            if argument.endswith(".py")
        )
    )


def is_owned_child(process, parent_pid, interpreter_path):
    parent = process.parent()
    if parent is None:
        return False
    if parent.pid == parent_pid:
        return True
    # Windows venv python.exe is a redirector. Accept exactly that executable
    # between this interpreter and the host, never an arbitrary ancestor chain.
    grandparent = parent.parent()
    return (
        grandparent is not None
        and grandparent.pid == parent_pid
        and Path(parent.exe()).resolve() == Path(interpreter_path).resolve()
    )


def child_main(artifact_root, deadline_ns, parent_pid):
    import psutil

    if not is_owned_child(psutil.Process(), parent_pid, sys.executable) or not (
        0 < remaining(deadline_ns) <= DEADLINE_SECONDS
    ):
        raise ValueError("INVALID_OWNED_CHILD_CONTEXT")
    events_lock = threading.Lock()
    worker = {
        "pid": None,
        "create_time": None,
        "samples_ns": [],
        "process_identity_verified": False,
    }
    launcher = {"pid": None, "create_time": None}

    def emit(event, **details):
        with events_lock:
            print(
                json.dumps({"event": event, "monotonic_ns": time.monotonic_ns(), **details}),
                flush=True,
            )

    original_resume = execution.resume_suspended_process

    def observed_resume(pid):
        original_resume(pid)
        process = psutil.Process(pid)
        if not process.is_running():
            raise ValueError("REGISTERED_LAUNCHER_NOT_OBSERVED")
        launcher.update(pid=pid, create_time=process.create_time())

    execution.resume_suspended_process = observed_resume
    source_path = ROOT / "examples/molecules/aspirin.chem"
    source = source_path.read_text(encoding="utf-8")
    snapshot = compile_snapshot(source, {})
    if not snapshot.success:
        raise ValueError("DEVELOPMENT_ASPIRIN_SOURCE_INVALID")
    proposal_output = invoke_tool("plan_molecular_single_point", {"object_id": "aspirin"}, snapshot)
    proposal = proposal_output["data"]
    service = WorkflowService(artifact_root / "compute-workspace")
    workflow = service.prepare(
        {
            "source": source,
            "attachments": {},
            "profile": "molecular",
            "object_id": "aspirin",
            "proposal": proposal,
        }
    )
    reference, plan = workflow["reference"], workflow["plan"]
    if plan["method_profile_id"] != MOLECULAR_PROFILE:
        raise ValueError("CONTENTION_PROFILE_MISMATCH")
    service.approve(reference, source, {})
    write_new(artifact_root / "approved-compute-plan.json", service.read(reference))
    emit(
        "ready",
        source_hash=snapshot.source_sha256,
        logical_plan_hash=plan["logical_plan_hash"],
        resolved_plan_hash=plan["resolved_plan_hash"],
        resource_ceilings=plan["resource_ceilings"],
    )
    if sys.stdin.readline().strip() != "submit-once" or remaining(deadline_ns) <= 0:
        raise ValueError("NO_BOUNDED_HOST_SUBMISSION_SIGNAL")
    started_ns = time.monotonic_ns()
    service.submit(reference)
    emit("submitted", reference=reference)
    completed = None
    try:
        while remaining(deadline_ns) > 0:
            # A PowerShell launcher is not the scientific worker. Resolve only its
            # live descendant matching the registered interpreter and worker script.
            if launcher["pid"] is not None and worker["pid"] is None:
                with suppress(psutil.NoSuchProcess, psutil.AccessDenied):
                    parent = psutil.Process(launcher["pid"])
                    if parent.create_time() == launcher["create_time"]:
                        for process in parent.children(recursive=True):
                            expected_script = (ROOT / "scripts/worker_molecular_psi4.py").resolve()
                            interpreter = Path(plan["worker"]["interpreter_path"]).resolve()
                            if is_registered_worker(process, plan["worker"]):
                                worker.update(
                                    pid=process.pid,
                                    create_time=process.create_time(),
                                    process_identity_verified=True,
                                    interpreter_path=str(interpreter),
                                    script_path=str(expected_script),
                                )
                                emit(
                                    "worker_running",
                                    pid=process.pid,
                                    create_time=worker["create_time"],
                                )
                                break
            if worker["pid"] is not None:
                with suppress(psutil.NoSuchProcess, psutil.AccessDenied):
                    process = psutil.Process(worker["pid"])
                    if process.is_running() and process.create_time() == worker["create_time"]:
                        worker["samples_ns"].append(time.monotonic_ns())
            completed = service.read(reference)
            if completed["state"] in {
                "succeeded",
                "failed",
                "cancelled",
                "timeout",
                "interrupted",
                "output_limit",
            }:
                break
            time.sleep(min(0.05, remaining(deadline_ns)))
        if completed is None or completed["state"] != "succeeded":
            raise ValueError("CONTENTION_COMPUTE_FAILED_OR_DEADLINE")
        job, result = completed["job"], completed["result"]
        run_dir = service.store.runs / job["job_id"]
        raw = json.loads((run_dir / "output.json").read_text(encoding="utf-8"))
        validated = validate_molecular_result(plan, raw)
        if (
            job["evidence_eligible"] is not True
            or validated.get("success") is not True
            or result.get("energy_hartree") != validated.get("energy_hartree")
            or result.get("worker") != plan["worker"]
            or result.get("resolved_plan_hash") != plan["resolved_plan_hash"]
            or result.get("input_sha256") != file_hash(run_dir / "input.json")
            or result.get("output_sha256") != file_hash(run_dir / "output.json")
            or job.get("result_hash") != content_hash(result)
        ):
            raise ValueError("CONTENTION_NUMERICAL_PROVENANCE_FAILED")
        jobs = list(service.store.jobs.glob("*.json"))
        if len(jobs) != 1:
            raise ValueError("CONTENTION_REQUIRES_EXACTLY_ONE_JOB")
        report = {
            "version": "contention-owned-compute/v1",
            "passed": True,
            "source_hash": snapshot.source_sha256,
            "source_file_sha256": file_hash(source_path),
            "logical_plan_hash": plan["logical_plan_hash"],
            "resolved_plan_hash": plan["resolved_plan_hash"],
            "method_profile_id": MOLECULAR_PROFILE,
            "resource_ceilings": plan["resource_ceilings"],
            "host_approval_actor": getpass.getuser(),
            "host_parent_pid": parent_pid,
            "host_child_interpreter_pid": os.getpid(),
            "workflow": completed,
            "worker_liveness": worker,
            "launcher_identity": launcher,
            "compute_interval_ns": [started_ns, time.monotonic_ns()],
            "compute_execution_seconds": result["execution"]["duration_ms"] / 1000,
            "job_count": 1,
            "result_hash": job["result_hash"],
            "new_real_computation": True,
            "cached_result_reused": False,
            "numeric_provenance_complete": True,
        }
        report["compute_report_hash"] = content_hash(report)
        write_new(artifact_root / "compute-report.json", report)
        emit("completed", compute_report_hash=report["compute_report_hash"])
        return 0
    finally:
        execution.resume_suspended_process = original_resume
        if completed is None or completed["state"] != "succeeded":
            with suppress(ValueError, KeyError, OSError):
                service.cancel(reference)


class ContentionObserver(RuntimeObserver):
    def __init__(self, child_pid):
        super().__init__()
        self.child_pid = child_pid
        import psutil

        self.child_create_time = psutil.Process(child_pid).create_time()
        self.owned_process_identities = {}
        self.provider_thread = None
        self.provider_sockets = []

    def audit(self, event, args):
        super().audit(event, args)
        if event == "socket.connect":
            self.provider_sockets.append(args[0])

    def __exit__(self, exc_type, exc, traceback):
        # Cancel only sockets observed in this harness, before disabling its audit.
        if self.provider_thread is not None and self.provider_thread.is_alive():
            for connection in self.provider_sockets:
                with suppress(OSError):
                    connection.shutdown(socket.SHUT_RDWR)
                with suppress(OSError):
                    connection.close()
            self.provider_thread.join(timeout=2)
        return super().__exit__(exc_type, exc, traceback)

    def _sample(self):
        sample = super()._sample()
        records = []
        if self.psutil is not None:
            try:
                child = self.psutil.Process(self.child_pid)
                if child.create_time() != self.child_create_time:
                    raise ValueError("OWNED_CHILD_IDENTITY_CHANGED")
                for process in [child, *child.children(recursive=True)]:
                    with suppress(self.psutil.NoSuchProcess, self.psutil.AccessDenied):
                        created = process.create_time()
                        previous = self.owned_process_identities.setdefault(process.pid, created)
                        if previous == created:
                            records.append({**self._process(process), "create_time": created})
            except self.psutil.NoSuchProcess:
                pass
        sample["monotonic_ns"] = time.monotonic_ns()
        sample["owned_compute_tree"] = records
        return sample


def assess_resources(resource_report, worker_liveness, ceilings):
    samples = resource_report.get("samples", [])
    actual_worker = [
        process
        for sample in samples
        for process in sample.get("owned_compute_tree", [])
        if process.get("pid") == worker_liveness.get("pid")
        and process.get("create_time") == worker_liveness.get("create_time")
    ]
    tree_rss = [
        sum(process["rss_bytes"] for process in sample.get("owned_compute_tree", []))
        for sample in samples
    ]
    audit = resource_report.get("audit", {})
    checks = {
        "resource_sampling_complete": bool(samples)
        and not resource_report.get("errors")
        and resource_report.get("observations_truncated") is False
        and resource_report.get("sampling_worker_stopped") is True,
        "model_controller_audit_complete": audit.get("complete") is True
        and audit.get("unauthorized_attempts") == 0
        and audit.get("successful_allowed_connections", 0) >= 1,
        "controller_and_system_ram_sampled": bool(samples)
        and all(
            sample.get("controller", {}).get("rss_bytes", 0) > 0
            and 0
            < sample.get("system_used_ram_bytes", 0)
            <= sample.get("system_total_ram_bytes", 0)
            for sample in samples
        ),
        "provider_name_matched_processes_sampled": any(
            sample.get("provider_name_matched_processes") for sample in samples
        ),
        "whole_device_gpu_sampled": bool(samples)
        and all(
            bool(sample.get("gpus"))
            and all(
                0 <= gpu.get("memory_used_mib", -1) <= gpu.get("memory_total_mib", -2)
                for gpu in sample["gpus"]
            )
            for sample in samples
        ),
        "actual_compute_worker_resources_sampled": len(actual_worker) >= 2,
        "owned_tree_sampled_rss_within_profile_ceiling": bool(tree_rss)
        and max(tree_rss) <= ceilings.get("job_memory_bytes", 0),
    }
    worker_cpu = [process["cpu_seconds"] for process in actual_worker]
    return {
        "passed": all(checks.values()),
        "checks": checks,
        "owned_compute_tree_sampled_peak_rss_bytes": max(tree_rss) if tree_rss else None,
        "actual_worker_sampled_peak_rss_bytes": max(
            (process["rss_bytes"] for process in actual_worker), default=None
        ),
        "actual_worker_observed_cpu_seconds_delta": max(worker_cpu) - min(worker_cpu)
        if len(worker_cpu) >= 2
        else None,
        "resource_ceilings": ceilings,
        "sampling_scope": "Sampled RSS and CPU are observations, not exact peaks. "
        "The registered worker and owned outer tree retain their existing Job Object ceilings. "
        "System RAM and GPU cover other processes too; provider names are a heuristic.",
    }


def read_protocol(stream, messages, stopped):
    try:
        observed_events = set()
        while not stopped.is_set():
            line = stream.readline(16_385)
            if not line:
                break
            if len(line) > 16_384:
                raise ValueError("CHILD_PROTOCOL_LIMIT")
            item = json.loads(line)
            if not isinstance(item, dict) or item.get("event") not in {
                "ready",
                "submitted",
                "worker_running",
                "completed",
            }:
                raise ValueError("CHILD_PROTOCOL_INVALID")
            if item["event"] in observed_events:
                raise ValueError("CHILD_PROTOCOL_DUPLICATE_EVENT")
            observed_events.add(item["event"])
            messages.put(item)
    except (ValueError, OSError) as error:
        messages.put({"event": "protocol_error", "error": str(error)})


def run(output):
    if sys.platform != "win32":
        raise ValueError("CONTENTION_REQUIRES_GOVERNED_WINDOWS_RUNNER")
    output = output.resolve()
    if output.exists():
        raise ValueError("OUTPUT_EXISTS")
    artifact_root = output.with_suffix("")
    artifact_root.mkdir(parents=True, exist_ok=False)
    deadline_ns = time.monotonic_ns() + DEADLINE_SECONDS * 1_000_000_000
    source_path = ROOT / "examples/molecules/aspirin.chem"
    source = source_path.read_text(encoding="utf-8")
    snapshot = compile_snapshot(source, {})
    brief, schema = request_context(snapshot)
    model = copy.deepcopy(orchestrator.model_status())
    if not model.get("available"):
        raise ValueError("CONTENTION_MODEL_UNAVAILABLE")
    runner = runpy.run_path(str(ROOT / "scripts/run_model_evaluation.py"))
    code_identity = {
        key: content_hash(value) for key, value in runner["code_snapshot"](ROOT).items()
    }
    messages = [
        {
            "role": "system",
            "content": "Return one structured action using the registered contract. "
            "Inspect exactly the named source object; grant no execution authority.",
        },
        {
            "role": "user",
            "content": json.dumps(
                {"objective": "Inspect the declared aspirin molecule.", "workspace_context": brief}
            ),
        },
    ]
    write_new(
        artifact_root / "contention-input.json",
        {
            "source": source,
            "source_hash": snapshot.source_sha256,
            "model_identity": model_identity(model),
            "code_identity": code_identity,
            "messages": messages,
            "action_schema": schema,
            "deadline_seconds": DEADLINE_SECONDS,
        },
    )
    protocol, protocol_stop = queue.Queue(), threading.Event()
    stderr_buffer, stderr_exceeded = bytearray(), threading.Event()
    provider = {"calls": [], "error": None, "action": None}
    provider_started = threading.Event()
    child = None
    provider_thread = None
    reader = stderr_reader = None
    observer = None
    outcome = {"passed": False, "failure": None}
    protocol_events = []
    with execution._JobObject() as child_job:
        try:
            child = subprocess.Popen(
                [
                    sys.executable,
                    str(Path(__file__).resolve()),
                    "--child",
                    "--artifact-root",
                    str(artifact_root),
                    "--deadline-ns",
                    str(deadline_ns),
                    "--parent-pid",
                    str(os.getpid()),
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=ROOT,
                creationflags=0x00000004 | 0x08000000,
            )
            child_job.assign(child)
            resume_suspended_process(child.pid)
            assert child.stdout is not None and child.stderr is not None and child.stdin is not None
            stdout_text = io.TextIOWrapper(child.stdout, encoding="utf-8")
            reader = threading.Thread(
                target=read_protocol, args=(stdout_text, protocol, protocol_stop), daemon=True
            )
            stderr_reader = threading.Thread(
                target=capture_pipe,
                args=(child.stderr, stderr_buffer, 1_000_000, stderr_exceeded),
                daemon=True,
            )
            reader.start()
            stderr_reader.start()
            ready = None
            while remaining(deadline_ns) > 0 and ready is None:
                try:
                    item = protocol.get(timeout=min(0.1, remaining(deadline_ns)))
                    protocol_events.append(item)
                    if item["event"] == "ready":
                        ready = item
                    else:
                        raise ValueError("EXPECTED_CHILD_READY")
                except queue.Empty:
                    if child.poll() is not None and not reader.is_alive() and protocol.empty():
                        raise ValueError("OWNED_CHILD_EXITED_BEFORE_READY") from None
            if ready is None or ready["source_hash"] != snapshot.source_sha256:
                raise ValueError("CHILD_READY_SOURCE_OR_DEADLINE_MISMATCH")

            def request_once():
                orchestrator.MODEL_METRICS.calls = []
                orchestrator.MODEL_METRICS.stage = "action"
                provider["start_ns"] = time.monotonic_ns()
                provider_started.set()
                try:
                    provider["action"] = orchestrator.request_action(
                        messages,
                        model["model_id"],
                        timeout=max(0.01, remaining(deadline_ns)),
                        schema=schema,
                    )
                except Exception as error:
                    provider["error"] = type(error).__name__ + ": " + str(error)[:600]
                finally:
                    provider["end_ns"] = time.monotonic_ns()
                    provider["calls"] = list(orchestrator.MODEL_METRICS.calls)

            observer = ContentionObserver(child.pid)
            with observer:
                provider_thread = threading.Thread(
                    target=request_once, name="contention-one-model-request", daemon=True
                )
                observer.provider_thread = provider_thread
                provider_thread.start()
                if not provider_started.wait(timeout=min(1.0, remaining(deadline_ns))):
                    raise ValueError("MODEL_REQUEST_NOT_STARTED")
                child.stdin.write(b"submit-once\n")
                child.stdin.flush()
                completed = False
                while remaining(deadline_ns) > 0:
                    try:
                        item = protocol.get(timeout=min(0.1, remaining(deadline_ns)))
                        protocol_events.append(item)
                        if item["event"] == "protocol_error":
                            raise ValueError("CHILD_PROTOCOL_ERROR: " + item["error"])
                        completed = completed or item["event"] == "completed"
                    except queue.Empty:
                        pass
                    if stderr_exceeded.is_set():
                        raise ValueError("OWNED_CHILD_OUTPUT_LIMIT")
                    if completed and not provider_thread.is_alive():
                        break
                    if (
                        child.poll() is not None
                        and not completed
                        and not reader.is_alive()
                        and protocol.empty()
                    ):
                        raise ValueError("OWNED_CHILD_FAILED")
                if not completed or provider_thread.is_alive():
                    raise ValueError("CONTENTION_DEADLINE_EXCEEDED")
                action = provider["action"] or {}
                if (
                    len(provider["calls"]) != 1
                    or provider["error"] is not None
                    or action.get("action") != "object_inspect"
                    or action.get("object_id") != "aspirin"
                    or action.get("scale_factors") != []
                ):
                    raise ValueError("SINGLE_MODEL_REQUEST_DID_NOT_SUCCEED")
                tool_started = time.monotonic()
                tool_result = invoke_tool("object_inspect", {"object_id": "aspirin"}, snapshot)
                provider["tool_seconds"] = time.monotonic() - tool_started
                provider["tool_result"] = tool_result
                if tool_result["status"] != "succeeded":
                    raise ValueError("MODEL_READ_RESULT_FAILED")
            child.wait(timeout=min(2.0, max(0.01, remaining(deadline_ns))))
            compute = json.loads(
                (artifact_root / "compute-report.json").read_text(encoding="utf-8")
            )
            if (
                compute.get("compute_report_hash")
                != content_hash(
                    {key: value for key, value in compute.items() if key != "compute_report_hash"}
                )
                or compute.get("source_hash") != snapshot.source_sha256
                or compute.get("source_file_sha256") != file_hash(source_path)
                or compute.get("logical_plan_hash") != ready.get("logical_plan_hash")
                or compute.get("resolved_plan_hash") != ready.get("resolved_plan_hash")
                or compute.get("job_count") != 1
                or sum(item["event"] == "submitted" for item in protocol_events) != 1
                or compute.get("passed") is not True
                or child.returncode != 0
            ):
                raise ValueError("COMPUTE_REPORT_INTEGRITY_OR_SUCCESS_MISMATCH")
            overlap = verified_overlap(provider, compute["worker_liveness"])
            final_code = {
                key: content_hash(value) for key, value in runner["code_snapshot"](ROOT).items()
            }
            final_model = orchestrator.model_status()
            stable = final_code == code_identity and model_identity(final_model) == model_identity(
                model
            )
            outcome.update(
                passed=overlap["passed"] and stable,
                overlap=overlap,
                identity_stable=stable,
                compute_report_hash=compute["compute_report_hash"],
                compute_result_hash=compute["result_hash"],
                resource_ceilings=compute["resource_ceilings"],
                compute_seconds=compute["compute_execution_seconds"],
                model_seconds=sum(call.get("seconds", 0) for call in provider["calls"]),
                tool_seconds=provider["tool_seconds"],
                serial_time_sum_seconds=compute["compute_execution_seconds"]
                + provider["tool_seconds"]
                + sum(call.get("seconds", 0) for call in provider["calls"]),
            )
            if not outcome["passed"]:
                outcome["failure"] = (
                    "NO_OBSERVED_OVERLAP" if not overlap["passed"] else "IDENTITY_CHANGED"
                )
        except Exception as error:
            outcome["failure"] = type(error).__name__ + ": " + str(error)[:1200]
        finally:
            # The Job Object contains only the created child and its descendants.
            child_job.terminate()
            if child is not None:
                if child.poll() is None:
                    child.kill()  # also covers assignment failure before resume
                with suppress(subprocess.TimeoutExpired):
                    child.wait(timeout=3)
            protocol_stop.set()
            for thread in (reader, stderr_reader):
                if thread is not None:
                    thread.join(timeout=1)
    write_new(artifact_root / "model-request.json", provider)
    if observer is not None and observer.started is not None:
        resource_report = observer.report()
        write_new(artifact_root / "contention-resources.json", resource_report)
        if outcome.get("passed"):
            resources = assess_resources(
                resource_report, compute["worker_liveness"], compute["resource_ceilings"]
            )
            outcome["resource_assessment"] = resources
            if not resources["passed"]:
                outcome.update(
                    passed=False, failure="CONTENTION_RESOURCE_EVIDENCE_INCOMPLETE_OR_EXCEEDED"
                )
    if (
        (provider_thread is not None and provider_thread.is_alive())
        or (child is not None and child.poll() is None)
        or any(thread is not None and thread.is_alive() for thread in (reader, stderr_reader))
    ):
        outcome.update(passed=False, failure="OWNED_HARNESS_ACTIVITY_DID_NOT_STOP")
    (artifact_root / "compute-child-stderr.txt").write_bytes(bytes(stderr_buffer))
    report = {
        "version": "model-compute-contention/v1",
        **outcome,
        "model_identity": model_identity(model),
        "source_hash": snapshot.source_sha256,
        "profile": MOLECULAR_PROFILE,
        "provider_request_count": len(provider["calls"]),
        "host_compute_submission_count": sum(
            item["event"] == "submitted" for item in protocol_events
        ),
        "protocol_events": protocol_events,
        "acceptance_deadline_seconds": DEADLINE_SECONDS,
        "deadline_scope": "Preflight and model/compute activity; "
        "bounded teardown and report writing follow.",
        "total_wall_seconds_including_teardown": (time.monotonic_ns() - deadline_ns) / 1_000_000_000
        + DEADLINE_SECONDS,
        "owned_child_pid": child.pid if child else None,
        "owned_child_stopped": child is None or child.poll() is not None,
        "provider_thread_stopped": provider_thread is None or not provider_thread.is_alive(),
        "artifact_hashes": {
            path.name: file_hash(path) for path in artifact_root.glob("*") if path.is_file()
        },
        "promotion_approved": False,
        "model_execution_authorized": False,
        "scope": "One development-aspirin computation and one structured model call. "
        "Functional resource-overlap evidence only; no repeats, stress testing, unseen-task credit "
        "or new operating-system isolation claim.",
    }
    report["contention_hash"] = content_hash(report)
    write_new(output, report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--artifact-root", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--deadline-ns", type=int, help=argparse.SUPPRESS)
    parser.add_argument("--parent-pid", type=int, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.child:
        if args.artifact_root is None or args.deadline_ns is None or args.parent_pid is None:
            parser.error("owned child context is required")
        return child_main(args.artifact_root, args.deadline_ns, args.parent_pid)
    if args.output is None:
        parser.error("--output is required")
    report = run(args.output)
    print(
        json.dumps(
            {"output": str(args.output), "passed": report["passed"], "failure": report["failure"]}
        )
    )
    return 0 if report["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
