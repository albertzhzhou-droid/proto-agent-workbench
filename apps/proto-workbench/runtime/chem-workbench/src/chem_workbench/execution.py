"""Governed execution core (Structure Studio roadmap Next 1 / plan M2).

Resolved plans bind exact inputs, worker identity, resource ceilings, and
acceptance rules. Approvals bind actor, plan hash, expiry, and launch count.
The supervised runner assigns every worker to a Windows Job Object before it
executes, enforces a wall-clock deadline, kills the whole process tree on
timeout or host interruption, and caps captured outputs. Submissions are idempotent
through a derived submission id. Mock worker output can never be recorded as
scientific evidence. Runtime-model arguments never appear here: only the host
builds worker argv from first-party scripts whose bytes are hashed into the
approval.
"""

from __future__ import annotations

import copy
import ctypes
import getpass
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from _thread import LockType
from collections.abc import Iterator
from contextlib import AbstractContextManager, contextmanager, nullcontext, suppress
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from threading import Event, Lock, Thread
from typing import TYPE_CHECKING, Any, BinaryIO

from chem_workbench.execution_validation import (
    digest_id,
    number,
    prepared_input,
    validate_candidates,
    validate_plan,
    validate_water,
    verify_hash,
)
from chem_workbench.paths import psi4_prefix, resource_root
from chem_workbench.runtime_identity import environment_identity, refinement_environment_identity
from chem_workbench.visualization import content_hash
from chem_workbench.worker_supervision import capture_pipe, resume_suspended_process

if TYPE_CHECKING:
    from chem_workbench.refinement_execution.disk_budget import DiskBudget, OwnedRunDirectory
    from chem_workbench.refinement_execution.launch_context import LaunchSideband
    from chem_workbench.refinement_supervision import RefinementStorageMonitor

PLAN_VERSION = "resolved-plan/v1"
APPROVAL_VERSION = "execution-approval/v1"
JOB_VERSION = "job-record/v1"
REPOSITORY_ROOT = resource_root()

WATER_ACCEPTANCE_WINDOW_HARTREE = ("-75.1", "-74.8")


@dataclass(frozen=True, slots=True)
class WorkerSpec:
    kind: str
    script: str
    route: str  # "local" | "psi4_launcher"


@dataclass(frozen=True, slots=True, kw_only=True)
class WorkerResourceLimits:
    """Explicit host ceilings for the separate refinement worker."""

    wall_seconds: int
    memory_bytes: int
    cpu_seconds: int
    threads: int
    max_output_bytes: int

    def __post_init__(self) -> None:
        self.validate()

    def validate(self) -> None:
        for name, value, maximum in (
            ("wall_seconds", self.wall_seconds, 86400),
            ("memory_bytes", self.memory_bytes, 16 * 1024**3),
            ("cpu_seconds", self.cpu_seconds, 86400),
            ("threads", self.threads, 8),
            ("max_output_bytes", self.max_output_bytes, 20 * 1024**2),
        ):
            if type(value) is not int or not 1 <= value <= maximum:
                raise ValueError(f"INVALID_ARGUMENT: invalid refinement resource {name}")

    def as_dict(self) -> dict[str, int]:
        return {
            "wall_seconds": self.wall_seconds,
            "memory_bytes": self.memory_bytes,
            "cpu_seconds": self.cpu_seconds,
            "threads": self.threads,
            "max_output_bytes": self.max_output_bytes,
        }


WORKERS: dict[str, WorkerSpec] = {
    "mock": WorkerSpec("mock", "worker_mock.py", "local"),
    "ase_emt": WorkerSpec("ase_emt", "worker_ase_emt.py", "local"),
    "psi4_water": WorkerSpec("psi4_water", "worker_water_psi4.py", "psi4_launcher"),
    "psi4_molecular": WorkerSpec("psi4_molecular", "worker_molecular_psi4.py", "psi4_launcher"),
    "psi4_refinement": WorkerSpec("psi4_refinement", "worker_refinement_psi4.py", "psi4_launcher"),
}


def worker_identity(
    worker: WorkerSpec, *, refinement_profile_id: str | None = None
) -> dict[str, Any]:
    if refinement_profile_id is not None and worker.kind != "psi4_refinement":
        raise ValueError("INVALID_ARGUMENT: explicit refinement profile requires refinement worker")
    script = REPOSITORY_ROOT / "scripts" / worker.script
    if not script.is_file():
        raise ValueError(f"WORKER_UNAVAILABLE: {worker.script} is missing")
    identity: dict[str, Any] = {
        "kind": worker.kind,
        "script": worker.script,
        "script_sha256": hashlib.sha256(script.read_bytes()).hexdigest(),
    }
    interpreter = (
        psi4_prefix(REPOSITORY_ROOT) / "python.exe"
        if worker.route == "psi4_launcher"
        else Path(sys.executable)
    )
    paths = {"interpreter": interpreter, "lock": REPOSITORY_ROOT / "uv.lock"}
    if worker.route == "psi4_launcher":
        paths["launcher"] = REPOSITORY_ROOT / "scripts" / "run_psi4_python.ps1"
    for name, path in paths.items():
        if not path.is_file():
            raise ValueError(f"WORKER_UNAVAILABLE: {name} is missing")
        identity[name + "_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    identity["interpreter_path"] = str(interpreter.resolve())
    if worker.kind == "psi4_refinement":
        from chem_workbench.method_profiles import PROFILE_ID

        identity["environment"] = refinement_environment_identity(
            REPOSITORY_ROOT, profile_id=refinement_profile_id or PROFILE_ID
        )
        # Refinement imports shared canonicalization, schema and hash validators.
        # Bind the complete Python package, including newly added modules, instead
        # of assuming that three direct imports cover its source dependency chain.
        package = Path(__file__).resolve().parent
        source_files: dict[str, str] = {}
        for directory, children, files in os.walk(package, followlinks=False):
            parent = Path(directory)
            for name in children + files:
                path = parent / name
                info = path.lstat()
                if path.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400:
                    raise ValueError("WORKER_UNAVAILABLE: linked refinement package content")
            children[:] = sorted(name for name in children if name != "__pycache__")
            for name in sorted(files):
                path = parent / name
                if path.suffix in {".py", ".json"}:
                    source_files[path.relative_to(package).as_posix()] = hashlib.sha256(
                        path.read_bytes()
                    ).hexdigest()
        identity["product_module_sha256"] = dict(sorted(source_files.items()))
    else:
        identity["environment"] = environment_identity(worker.kind, REPOSITORY_ROOT)
    identity["policy_sha256"] = hashlib.sha256(
        (Path(__file__).with_name("execution_validation.py")).read_bytes()
    ).hexdigest()
    return identity


def _canonical_decimal(value: object) -> str:
    from chem_workbench.chemir.constraints import canonical_decimal

    number(value)
    result = canonical_decimal(value) if isinstance(value, str) else None
    if result is None:
        raise ValueError(f"INVALID_NUMBER: {value!r} is not a canonical decimal")
    return result


def _worker_argv(worker: WorkerSpec, input_path: Path, output_path: Path) -> list[str]:
    script = str(REPOSITORY_ROOT / "scripts" / worker.script)
    if worker.route == "psi4_launcher":
        launcher = REPOSITORY_ROOT / "scripts" / "run_psi4_python.ps1"
        backend = psi4_prefix(REPOSITORY_ROOT) / "python.exe"
        if not launcher.is_file() or not backend.is_file():
            raise ValueError("WORKER_UNAVAILABLE: the isolated Psi4 environment is missing")
        return [
            str(Path(os.environ["SYSTEMROOT"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(launcher),
            script,
            str(input_path),
            str(output_path),
        ]
    return [sys.executable, script, str(input_path), str(output_path)]


def build_water_resolved_plan(
    geometry: dict[str, Any],
    *,
    deadline_seconds: int = 300,
    max_output_bytes: int = 1_000_000,
) -> dict[str, Any]:
    """Resolve a fixed-geometry water HF/STO-3G proposal against the pinned backend."""
    validate_water(geometry)
    geometry = copy.deepcopy(geometry)
    required = {"atoms", "charge", "multiplicity"}
    if not isinstance(geometry, dict) or not required <= set(geometry):
        raise ValueError("INVALID_ARGUMENT: geometry needs atoms, charge, multiplicity")
    worker = WORKERS["psi4_water"]
    plan = {
        "version": PLAN_VERSION,
        "kind": "water_hf_sto3g",
        "subject": {"content_hash": content_hash(geometry), "geometry": geometry},
        "method_profile_id": "qcengine.psi4.hf_sto3g.smoke.v1",
        "method": "hf",
        "basis": "sto-3g",
        "engine": "psi4",
        "worker": worker_identity(worker),
        "resource_ceilings": {
            "deadline_seconds": deadline_seconds,
            "max_output_bytes": max_output_bytes,
            "job_memory_bytes": 3 * 1024**3,
            "job_cpu_seconds": 600,
        },
        "acceptance": {
            "property": "energy_hartree",
            "minimum": WATER_ACCEPTANCE_WINDOW_HARTREE[0],
            "maximum": WATER_ACCEPTANCE_WINDOW_HARTREE[1],
        },
        "normalization": "hartree",
        "allowed_actions": ["execute"],
    }
    plan["prepared_input"] = prepared_input(plan)
    plan["prepared_input_hash"] = content_hash(plan["prepared_input"])
    plan["resolved_plan_hash"] = content_hash(plan)
    validate_plan(plan)
    return plan


def build_molecular_resolved_plan(
    proposal: dict[str, Any],
    *,
    deadline_seconds: int = 600,
    max_output_bytes: int = 2_000_000,
) -> dict[str, Any]:
    """Resolve one explicit, generated organic geometry against the governed Psi4 worker."""
    from chem_workbench.molecular_compute import MOLECULAR_PROFILE, validate_molecular_proposal

    validate_molecular_proposal(proposal)
    proposal = copy.deepcopy(proposal)
    plan = {
        "version": PLAN_VERSION,
        "kind": "molecular_hf_sto3g",
        "subject": {
            "subject_ref": proposal["object_id"],
            "subject_hash": proposal["subject_hash"],
            "source_hash": proposal["source_hash"],
            "source_semantic_hash": proposal["source_semantic_hash"],
            "linked_state_hash": proposal["linked_state_hash"],
            "geometry_hash": proposal["geometry_hash"],
            "proposal": proposal,
        },
        "logical_plan_hash": proposal["logical_plan_hash"],
        "method_profile_id": MOLECULAR_PROFILE,
        "method": "hf",
        "basis": "sto-3g",
        "engine": "psi4",
        "worker": worker_identity(WORKERS["psi4_molecular"]),
        "resource_ceilings": {
            "deadline_seconds": deadline_seconds,
            "max_output_bytes": max_output_bytes,
            "job_memory_bytes": 3 * 1024**3,
            "job_cpu_seconds": 600,
        },
        "acceptance": {
            "property": "energy_hartree",
            "rule": "finite_negative_energy_and_scf_converged",
        },
        "normalization": "hartree",
        "allowed_actions": ["execute"],
    }
    plan["prepared_input"] = prepared_input(plan)
    plan["prepared_input_hash"] = content_hash(plan["prepared_input"])
    plan["resolved_plan_hash"] = content_hash(plan)
    validate_plan(plan)
    return plan


def build_cu_resolved_plan(
    draft: dict[str, Any],
    *,
    deadline_seconds: int = 300,
    max_output_bytes: int = 1_000_000,
) -> dict[str, Any]:
    """Resolve a copper cell-scale draft proposal from the first-party tool."""
    if not isinstance(draft, dict) or draft.get("version") != "cu-scan-proposal/v1":
        raise ValueError("INVALID_ARGUMENT: expected a cu-scan-proposal/v1 draft")
    if draft.get("status") != "draft_not_executable":
        raise ValueError("INVALID_ARGUMENT: the draft must still be a non-executable draft")
    if draft.get("method_profile_id") != "ase.emt.cu.scan.v1":
        raise ValueError("UNSUPPORTED_PROFILE: only ase.emt.cu.scan.v1 resolves")
    candidates = draft.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise ValueError("INVALID_ARGUMENT: the draft carries no candidates")
    verify_hash(draft, "logical_plan_hash")
    validate_candidates(candidates)
    candidates = copy.deepcopy(candidates)
    worker = WORKERS["ase_emt"]
    plan = {
        "version": PLAN_VERSION,
        "kind": "cu_lattice_scan",
        "subject": {
            "subject_ref": draft["subject_ref"],
            "subject_hash": draft["subject_hash"],
            "source_semantic_hash": draft.get("source_semantic_hash"),
        },
        "method_profile_id": "ase.emt.cu.scan.v1",
        "logical_plan_hash": draft.get("logical_plan_hash"),
        "worker": worker_identity(worker),
        "candidates": candidates,
        "resource_ceilings": {
            "deadline_seconds": deadline_seconds,
            "max_output_bytes": max_output_bytes,
            "job_memory_bytes": 3 * 1024**3,
            "job_cpu_seconds": 600,
        },
        "acceptance": {
            "property": "energy_eV_per_atom",
            "rule": "finite_decimal_and_converged_per_candidate",
        },
        "normalization": "eV/atom",
        "allowed_actions": ["execute"],
    }
    plan["prepared_input"] = prepared_input(plan)
    plan["prepared_input_hash"] = content_hash(plan["prepared_input"])
    plan["resolved_plan_hash"] = content_hash(plan)
    validate_plan(plan)
    return plan


class ExecutionStore:
    """File-backed, atomically written store for plans, approvals, jobs, and runs."""

    def __init__(self, root: Path, *, artifact_root: Path | None = None) -> None:
        root = root.resolve()
        self.root = root
        self.artifact_root = (artifact_root or REPOSITORY_ROOT).absolute()
        self.plans = root / "plans"
        self.approvals = root / "approvals"
        self.jobs = root / "jobs"
        self.runs = root / "runs"
        for directory in (self.plans, self.approvals, self.jobs, self.runs):
            directory.mkdir(parents=True, exist_ok=True)

    def _write(self, path: Path, value: dict[str, Any]) -> None:
        temporary = path.with_suffix("." + uuid.uuid4().hex + ".tmp")
        temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        os.replace(temporary, path)

    def _read(self, path: Path, *, max_bytes: int = 10_000_000) -> dict[str, Any]:
        if type(max_bytes) is not int or not 1 <= max_bytes <= 64 * 1024**2:
            raise ValueError("STORE_CORRUPT: invalid internal read budget")
        if path.stat().st_size > max_bytes:
            raise ValueError("STORE_CORRUPT: record exceeds size limit")
        with path.open("rb") as stream:
            raw = stream.read(max_bytes + 1)
        if len(raw) > max_bytes:
            raise ValueError("STORE_CORRUPT: record exceeds size limit")
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError(f"STORE_CORRUPT: {path.name} is not an object")
        return value

    def read_refinement_result(self, job_id: str) -> dict[str, Any]:
        """Read the bounded host envelope containing two copies of a <=20 MiB result.

        This is only storage decoding. The caller still authenticates the saved
        job's committed result hash, plan, raw output and transitive artifacts.
        Legacy records keep their existing 10 MB limit.
        """
        from chem_workbench.refinement_execution.host_evidence import (
            ContainedReader,
            fingerprint,
        )

        self._check_id(job_id)
        reader = ContainedReader(self.root)
        relative = "runs/" + job_id + "/result.json"
        path = reader.path(relative)
        before = fingerprint(path.lstat())
        result = self._read(path, max_bytes=64 * 1024**2)
        if before != fingerprint(reader.path(relative).lstat()):
            raise ValueError("STORE_CORRUPT: refinement result changed during read")
        return result

    def save_plan(self, plan: dict[str, Any]) -> Path:
        validate_plan(plan, refinement_root=self.artifact_root)
        path = self.plans / f"{digest_id(plan['resolved_plan_hash'])}.json"
        self._write(path, plan)
        return path

    def load_plan(self, resolved_plan_hash: str) -> dict[str, Any]:
        path = self.plans / f"{digest_id(resolved_plan_hash)}.json"
        if not path.is_file():
            raise ValueError("APPROVAL_STALE: the resolved plan is absent from the store")
        plan = self._read(path)
        validate_plan(plan, refinement_root=self.artifact_root)
        if plan["resolved_plan_hash"] != resolved_plan_hash:
            raise ValueError("APPROVAL_STALE: stored plan identity mismatch")
        return plan

    def save_approval(self, approval: dict[str, Any]) -> Path:
        self._check_id(approval["token"])
        path = self.approvals / f"{approval['token']}.json"
        self._write(path, approval)
        return path

    def load_approval(self, token: str) -> dict[str, Any] | None:
        if not re.fullmatch(r"[0-9a-f]{32}", token):
            return None
        path = self.approvals / f"{token}.json"
        return self._read(path) if path.is_file() else None

    def save_job(self, job: dict[str, Any]) -> Path:
        self._check_id(job["job_id"])
        path = self.jobs / f"{job['job_id']}.json"
        self._write(path, job)
        return path

    def load_job(self, job_id: str) -> dict[str, Any] | None:
        self._check_id(job_id)
        path = self.jobs / f"{job_id}.json"
        return self._read(path) if path.is_file() else None

    def find_job_by_submission(self, submission_id: str) -> dict[str, Any] | None:
        for path in sorted(self.jobs.glob("*.json")):
            job = self._read(path)
            if job.get("submission_id") == submission_id:
                return job
        return None

    def run_directory(self, job_id: str) -> Path:
        self._check_id(job_id)
        directory = self.runs / job_id
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    @staticmethod
    def _check_id(value: str) -> None:
        if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{32}", value):
            raise ValueError("INVALID_ARGUMENT: invalid store identifier")

    @contextmanager
    def submission_lock(self) -> Iterator[None]:
        # OS releases the byte-range lock even when the owner crashes.
        if sys.platform != "win32":
            raise ValueError("UNSUPPORTED_PLATFORM: governed execution requires Windows")
        import msvcrt

        with (self.root / "submission.lock").open("a+b") as stream:
            if stream.tell() == 0:
                stream.write(b"0")
                stream.flush()
            stream.seek(0)
            try:
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as error:
                raise ValueError(
                    "EXECUTION_BUSY: another submission owns this store; retry later"
                ) from error
            try:
                yield
            finally:
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)


def issue_approval(
    store: ExecutionStore,
    resolved_plan_hash: str,
    *,
    actor: str,
    ttl_seconds: int = 3600,
    max_launches: int = 1,
    now: int | None = None,
) -> dict[str, Any]:
    """Bind an approval to the exact resolved plan content."""
    plan = store.load_plan(resolved_plan_hash)
    _verify_worker(plan, refinement_root=store.artifact_root)
    if (
        not actor.strip()
        or len(actor) > 200
        or type(ttl_seconds) is not int
        or not 1 <= ttl_seconds <= 86400
        or type(max_launches) is not int
        or not 1 <= max_launches <= 100
    ):
        raise ValueError("INVALID_ARGUMENT: invalid approval actor, expiry or launch budget")
    issued_at = int(now if now is not None else time.time())
    approval = {
        "version": APPROVAL_VERSION,
        "token": uuid.uuid4().hex,
        "actor": actor,
        "owner": getpass.getuser(),
        "workspace": str(store.root),
        "resolved_plan_hash": resolved_plan_hash,
        "binding": {
            "kind": plan["kind"],
            "method_profile_id": plan["method_profile_id"],
            "worker": plan["worker"],
            "subject": plan["subject"],
            "candidate_hashes": [
                candidate.get("candidate_hash") for candidate in plan.get("candidates", [])
            ],
            "resource_ceilings": plan["resource_ceilings"],
        },
        "allowed_actions": plan.get("allowed_actions", ["execute"]),
        "issued_at": issued_at,
        "expires_at": issued_at + max(1, int(ttl_seconds)),
        "max_launches": max(1, int(max_launches)),
        "launches_used": 0,
    }
    store.save_approval(approval)
    return approval


class _JobObject:
    """Windows Job Object supervision: assign before resume, kill the tree."""

    def __init__(self, *, job_memory_bytes: int = 3 * 1024**3, job_cpu_seconds: int = 600) -> None:
        if (
            type(job_memory_bytes) is not int
            or not 1 <= job_memory_bytes <= 16 * 1024**3
            or type(job_cpu_seconds) is not int
            or not 1 <= job_cpu_seconds <= 86400
        ):
            raise ValueError("INVALID_ARGUMENT: invalid Job Object resource ceilings")
        self.job_memory_bytes = job_memory_bytes
        self.job_cpu_seconds = job_cpu_seconds
        self.handle: int | None = None
        self._kernel32: Any = None

    def __enter__(self) -> _JobObject:
        if sys.platform == "win32":
            kernel32 = ctypes.windll.kernel32
            kernel32.CreateJobObjectW.restype = ctypes.c_void_p
            kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
            kernel32.SetInformationJobObject.restype = ctypes.c_int
            kernel32.SetInformationJobObject.argtypes = [
                ctypes.c_void_p,
                ctypes.c_int,
                ctypes.c_void_p,
                ctypes.c_uint32,
            ]
            kernel32.AssignProcessToJobObject.restype = ctypes.c_int
            kernel32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
            kernel32.TerminateJobObject.restype = ctypes.c_int
            kernel32.TerminateJobObject.argtypes = [ctypes.c_void_p, ctypes.c_uint]
            kernel32.CloseHandle.restype = ctypes.c_int
            kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
            handle = kernel32.CreateJobObjectW(None, None)
            if not handle:
                raise OSError("JOB_OBJECT_FAILED: CreateJobObjectW returned null")

            class _IO_COUNTERS(ctypes.Structure):
                _fields_ = [
                    (name, ctypes.c_ulonglong)
                    for name in (
                        "ReadOperationCount",
                        "WriteOperationCount",
                        "OtherOperationCount",
                        "ReadTransferCount",
                        "WriteTransferCount",
                        "OtherTransferCount",
                    )
                ]

            class _BASIC(ctypes.Structure):
                _fields_ = [
                    ("PerProcessUserTimeLimit", ctypes.c_ulonglong),
                    ("PerJobUserTimeLimit", ctypes.c_ulonglong),
                    ("LimitFlags", ctypes.c_uint32),
                    ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t),
                    ("ActiveProcessLimit", ctypes.c_uint32),
                    ("Affinity", ctypes.c_size_t),
                    ("PriorityClass", ctypes.c_uint32),
                    ("SchedulingClass", ctypes.c_uint32),
                ]

            class _EXTENDED(ctypes.Structure):
                _fields_ = [
                    ("BasicLimitInformation", _BASIC),
                    ("IoInfo", _IO_COUNTERS),
                    ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t),
                ]

            info = _EXTENDED()
            info.BasicLimitInformation.LimitFlags = 0x2000 | 0x200 | 0x4
            info.BasicLimitInformation.PerJobUserTimeLimit = self.job_cpu_seconds * 10_000_000
            info.JobMemoryLimit = self.job_memory_bytes
            if not kernel32.SetInformationJobObject(
                handle, 9, ctypes.byref(info), ctypes.sizeof(info)
            ):
                kernel32.CloseHandle(handle)
                raise OSError("JOB_OBJECT_FAILED: SetInformationJobObject failed")
            self.handle = int(handle)
            self._kernel32 = kernel32
        return self

    def assign(self, process: subprocess.Popen[bytes]) -> None:
        handle = getattr(process, "_handle", None)
        if (
            self.handle is not None
            and handle is not None
            and not self._kernel32.AssignProcessToJobObject(self.handle, int(handle))
        ):
            raise OSError("JOB_OBJECT_FAILED: AssignProcessToJobObject failed")

    def terminate(self) -> None:
        if self.handle is not None:
            self._kernel32.TerminateJobObject(self.handle, 1)

    def active_processes(self) -> int:
        """Query the exact owned Job Object, never infer exit from its leader."""
        if self.handle is None:
            raise ValueError("JOB_OBJECT_FAILED: no live job handle for accounting")

        class Accounting(ctypes.Structure):
            _fields_ = [
                ("TotalUserTime", ctypes.c_longlong),
                ("TotalKernelTime", ctypes.c_longlong),
                ("ThisPeriodTotalUserTime", ctypes.c_longlong),
                ("ThisPeriodTotalKernelTime", ctypes.c_longlong),
                ("TotalPageFaultCount", ctypes.c_uint32),
                ("TotalProcesses", ctypes.c_uint32),
                ("ActiveProcesses", ctypes.c_uint32),
                ("TotalTerminatedProcesses", ctypes.c_uint32),
            ]

        query = self._kernel32.QueryInformationJobObject
        query.restype = ctypes.c_int
        query.argtypes = [
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.c_void_p,
        ]
        info = Accounting()
        if not query(self.handle, 1, ctypes.byref(info), ctypes.sizeof(info), None):
            raise OSError("JOB_OBJECT_FAILED: QueryInformationJobObject accounting failed")
        return int(info.ActiveProcesses)

    def wait_until_empty(self, timeout_seconds: float = 10.0) -> None:
        deadline = time.monotonic() + timeout_seconds
        while self.active_processes() != 0:
            if time.monotonic() >= deadline:
                raise TimeoutError("JOB_OBJECT_FAILED: descendants did not exit before retention")
            time.sleep(0.02)

    def __exit__(self, *_args: object) -> None:
        if self.handle is not None:
            self._kernel32.CloseHandle(self.handle)
            self.handle = None


def _validate_refinement_resources(
    input_path: Path, resources: WorkerResourceLimits
) -> dict[str, Any]:
    from chem_workbench.molecular_refinement import validate_refinement_spec
    from chem_workbench.refinement_execution.execution_contract import validate_worker_request
    from chem_workbench.refinement_execution.worker_subject_replay import load_json

    with input_path.open("rb") as stream:
        raw = stream.read(20 * 1024**2 + 1)
    if len(raw) > 20 * 1024**2:
        raise ValueError("RESOURCE_LIMIT: refinement input exceeds 20 MiB")
    try:
        request = load_json(raw)
    except (ValueError, UnicodeError) as error:
        raise ValueError("INVALID_ARGUMENT: malformed refinement worker input") from error
    if request.get("version") == "refinement-worker-request/v2":
        request = validate_worker_request(request)
    elif (
        set(request) != {"version", "mode", "spec"}
        or request["version"] != "refinement-worker-request/v1"
        or not isinstance(request["mode"], str)
        or request["mode"] not in {"gradient", "optimization"}
    ):
        raise ValueError("INVALID_ARGUMENT: refinement worker request")
    spec = validate_refinement_spec(request["spec"])
    if any(spec["resources"][key] != value for key, value in resources.as_dict().items()):
        raise ValueError("APPROVAL_STALE: refinement spec and supervisor resource ceilings differ")
    return request


def _capture_refinement_pipe(
    stream: BinaryIO, buffer: bytearray, budget: list[int], lock: LockType, exceeded: Event
) -> None:
    """Share one capture budget between refinement stdout and stderr."""
    try:
        while chunk := stream.read(4096):
            with lock:
                retained = min(len(chunk), budget[0])
                buffer.extend(chunk[:retained])
                budget[0] -= retained
                if retained < len(chunk):
                    exceeded.set()
    finally:
        stream.close()


def _prepare_refinement_worker_cwd(owned: OwnedRunDirectory) -> OwnedRunDirectory:
    """Create one exclusive scratch cwd without changing the host process cwd."""
    from chem_workbench.refinement_execution.disk_budget import OwnedRunDirectory

    owned.verify()
    scratch = owned.path / "scratch"
    # Only the checked directory chain below can admit existing scratch.
    with suppress(FileExistsError):
        scratch.mkdir()
    owned.verify()
    scratch_owned = OwnedRunDirectory.capture(
        owned.repository_root, owned.relative_path + "/scratch"
    )
    scratch_owned.verify()
    (scratch / "worker-cwd").mkdir()  # Refuse an occupied file, directory or reparse point.
    scratch_owned.verify()
    cwd_owned = OwnedRunDirectory.capture(
        owned.repository_root, owned.relative_path + "/scratch/worker-cwd"
    )
    owned.verify()
    scratch_owned.verify()
    cwd_owned.verify()
    return cwd_owned


def run_worker(
    worker: WorkerSpec,
    input_path: Path,
    output_path: Path,
    *,
    deadline_seconds: int,
    max_output_bytes: int,
    cancel_path: Path | None = None,
    resources: WorkerResourceLimits | None = None,
    disk_budget: DiskBudget | None = None,
    launch_sideband: LaunchSideband | None = None,
) -> dict[str, Any]:
    """Launch one first-party worker under Job Object supervision."""
    if sys.platform != "win32":
        raise ValueError("UNSUPPORTED_PLATFORM: governed execution requires Windows")
    if worker not in WORKERS.values():
        raise ValueError("UNSUPPORTED_PROFILE: unknown worker")
    if disk_budget is not None and worker.kind != "psi4_refinement":
        raise ValueError("INVALID_ARGUMENT: disk monitoring requires the refinement worker")
    if launch_sideband is not None and worker.kind != "psi4_refinement":
        raise ValueError("INVALID_ARGUMENT: host launch context requires the refinement worker")
    if worker.kind == "psi4_refinement":
        if type(resources) is not WorkerResourceLimits:
            raise ValueError("INVALID_ARGUMENT: refinement requires explicit WorkerResourceLimits")
        resources.validate()
        if (
            type(deadline_seconds) is not int
            or type(max_output_bytes) is not int
            or deadline_seconds != resources.wall_seconds
            or max_output_bytes != resources.max_output_bytes
        ):
            raise ValueError("INVALID_ARGUMENT: refinement runner resource ceilings differ")
    elif resources is not None:
        raise ValueError("INVALID_ARGUMENT: extended resources require the refinement worker")
    elif (
        type(deadline_seconds) is not int
        or not 1 <= deadline_seconds <= 600
        or type(max_output_bytes) is not int
        or not 1 <= max_output_bytes <= 10_000_000
    ):
        raise ValueError("INVALID_ARGUMENT: invalid worker resource ceilings")
    monitor_context: AbstractContextManager[RefinementStorageMonitor | None] = nullcontext(None)
    storage_monitor: RefinementStorageMonitor | None = None
    owned_cwd: OwnedRunDirectory | None = None
    if disk_budget is not None:
        from chem_workbench.refinement_supervision import RefinementStorageMonitor

        # Capture lexical ancestors before resolve() can erase a reparse boundary.
        run_path = output_path.absolute().parent
        if input_path.absolute().parent != run_path:
            raise ValueError("INVALID_ARGUMENT: monitored input/output run directories differ")
        storage_monitor = RefinementStorageMonitor(
            REPOSITORY_ROOT, run_path.relative_to(REPOSITORY_ROOT).as_posix(), disk_budget
        )
        monitor_context = storage_monitor
    input_path, output_path = input_path.resolve(), output_path.resolve()
    if output_path.exists():
        raise ValueError("INVALID_ARGUMENT: worker output must not already exist")
    if resources is not None:
        request = _validate_refinement_resources(input_path, resources)
        if request["version"] == "refinement-worker-request/v2":
            if launch_sideband is None or disk_budget is None:
                raise ValueError("HOST_CONTEXT_REQUIRED: v2 requires host launch and disk policy")
            from chem_workbench.refinement_execution.launch_context import verify_launch_sideband

            verify_launch_sideband(
                launch_sideband,
                root=REPOSITORY_ROOT,
                code_root=REPOSITORY_ROOT,
                runtime_root=psi4_prefix(REPOSITORY_ROOT),
                input_path=input_path,
                output_path=output_path,
                request=request,
                disk_budget=disk_budget,
            )
            assert storage_monitor is not None
            owned_cwd = _prepare_refinement_worker_cwd(storage_monitor.owned)
        elif launch_sideband is not None:
            raise ValueError("INVALID_ARGUMENT: legacy request cannot receive v2 launch context")
    argv = _worker_argv(worker, input_path, output_path)
    environment = {
        key: value
        for key, value in os.environ.items()
        if key.upper()
        in {
            "SYSTEMROOT",
            "WINDIR",
            "COMSPEC",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "LOCALAPPDATA",
            "APPDATA",
            "PROGRAMDATA",
            "PROGRAMFILES",
            "PROCESSOR_ARCHITECTURE",
            "PROCESSOR_IDENTIFIER",
            "NUMBER_OF_PROCESSORS",
            "COMPUTERNAME",
            "USERNAME",
        }
    }
    environment["PATH"] = str(Path(os.environ["SYSTEMROOT"]) / "System32")
    environment["CHEM_PSI4_PREFIX"] = str(psi4_prefix(REPOSITORY_ROOT))
    environment["PSI_SCRATCH"] = str(output_path.parent / "scratch")
    thread_count = str(resources.threads) if resources is not None else "1"
    environment["OMP_NUM_THREADS"] = thread_count
    environment["OPENBLAS_NUM_THREADS"] = thread_count
    environment["MKL_NUM_THREADS"] = thread_count
    environment["PATHEXT"] = ".COM;.EXE;.BAT;.CMD"
    if launch_sideband is not None:
        from chem_workbench.refinement_execution.launch_context import ENVIRONMENT_KEYS

        environment.update({key: launch_sideband.environment[key] for key in ENVIRONMENT_KEYS})
    started = time.monotonic()
    buffers = [bytearray(), bytearray()]
    exceeded = Event()
    threads = []
    capture_budget, capture_lock = [max_output_bytes], Lock()
    storage_stop: str | None = None
    process_tree_empty_verified = False
    with (
        monitor_context as monitor,
        _JobObject(
            job_memory_bytes=resources.memory_bytes if resources is not None else 3 * 1024**3,
            job_cpu_seconds=resources.cpu_seconds if resources is not None else 600,
        ) as job,
    ):
        if owned_cwd is not None:
            owned_cwd.verify()
        process = subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=owned_cwd.path if owned_cwd is not None else output_path.parent,
            env=environment,
            creationflags=0x00000004 | 0x08000000,
        )  # SUSPENDED | NO_WINDOW
        try:
            job.assign(process)
            if owned_cwd is not None:
                owned_cwd.verify()
            resume_suspended_process(process.pid)
            for stream, buffer in zip((process.stdout, process.stderr), buffers, strict=True):
                assert stream is not None
                thread = Thread(
                    target=_capture_refinement_pipe if resources is not None else capture_pipe,
                    args=(stream, buffer, capture_budget, capture_lock, exceeded)
                    if resources is not None
                    else (stream, buffer, max_output_bytes, exceeded),
                    daemon=True,
                )
                thread.start()
                threads.append(thread)
            status = "failed"
            while True:
                if monitor is not None:
                    try:
                        previous_observations = monitor.count
                        if not monitor.check("running"):
                            storage_stop = "disk observation failed or budget exceeded"
                            status = "failed"
                            break
                        if owned_cwd is not None and monitor.count != previous_observations:
                            owned_cwd.verify()
                    except (OSError, ValueError) as error:
                        storage_stop = str(error)[:600]
                        status = "failed"
                        break
                if cancel_path is not None and cancel_path.exists():
                    status = "cancelled"
                    break
                if exceeded.is_set() or (
                    output_path.exists() and output_path.stat().st_size > max_output_bytes
                ):
                    status = "output_limit"
                    break
                if time.monotonic() - started >= deadline_seconds:
                    status = "timeout"
                    break
                if process.poll() is not None:
                    status = "succeeded" if process.returncode == 0 else "failed"
                    break
                time.sleep(0.02)
        finally:
            pending_error = sys.exc_info()[1]

            def retain_failure(original: BaseException) -> None:
                if monitor is not None:
                    try:
                        monitor.retain_exception(
                            original,
                            bytes(buffers[0]),
                            bytes(buffers[1]),
                            tree_empty=process_tree_empty_verified,
                        )
                    except BaseException as retention_error:
                        original.add_note(
                            "Partial supervisor log retention failed: "
                            + type(retention_error).__name__
                            + ": "
                            + str(retention_error)[:600]
                        )

            try:
                # Kill descendants even when the top-level worker exits normally.
                job.terminate()
                if process.poll() is None:
                    process.kill()  # also covers failed job assignment before resume
                process.wait(timeout=10)
                for thread in threads:
                    thread.join(timeout=10)
                if monitor is not None:
                    job.wait_until_empty()
                    process_tree_empty_verified = True
                    if owned_cwd is not None:
                        owned_cwd.verify()
                    if any(thread.is_alive() for thread in threads):
                        raise OSError("CAPTURE_INCOMPLETE: pipes remain after process tree exit")
                    try:
                        if not monitor.check("after_process_tree_exit", force=True):
                            storage_stop = storage_stop or "terminal disk observation failed"
                    except (OSError, ValueError) as error:
                        storage_stop = storage_stop or str(error)[:600]
            except BaseException as error:
                retain_failure(error)
                raise
            if pending_error is not None and monitor is not None:
                retain_failure(pending_error)
    if exceeded.is_set() or (
        output_path.exists() and output_path.stat().st_size > max_output_bytes
    ):
        status = "output_limit"
    scratch = output_path.parent / "scratch"
    if scratch.exists() and disk_budget is None:
        resolved = scratch.resolve()
        if resolved.parent != output_path.parent.resolve() or scratch.is_symlink():
            raise ValueError("SCRATCH_PATH_REJECTED: scratch escaped the owned run directory")
        shutil.rmtree(resolved)
    stdout, stderr = bytes(buffers[0]), bytes(buffers[1])
    result = {
        "status": status,
        "returncode": process.returncode,
        "duration_ms": int((time.monotonic() - started) * 1000),
        "stdout_bytes": len(stdout),
        "stderr_bytes": len(stderr),
        "stdout_sha256": hashlib.sha256(stdout).hexdigest(),
        "stderr_sha256": hashlib.sha256(stderr).hexdigest(),
        "_stdout": stdout,
        "_stderr": stderr,
    }
    if resources is not None:
        result["resource_limits"] = resources.as_dict()
    if monitor is not None:
        result["storage"] = monitor.summary()
        result["process_tree_empty_verified"] = process_tree_empty_verified
        result["storage_stop_reason"] = storage_stop
        if storage_stop is not None:
            result["status"] = "failed"
    return result


def _verify_worker(plan: dict[str, Any], *, refinement_root: Path | None = None) -> None:
    if plan["kind"] != "mock":
        from chem_workbench.adapters.governed_compute import require_registration

        require_registration(plan["method_profile_id"])
    observed = (
        worker_identity(WORKERS["psi4_refinement"], refinement_profile_id=plan["method_profile_id"])
        if plan["kind"] == "molecular_refinement"
        else worker_identity(WORKERS[plan["worker"]["kind"]])
    )
    if observed != plan["worker"]:
        raise ValueError("APPROVAL_STALE: current worker or launch chain changed")
    if plan["kind"] == "molecular_refinement":
        if refinement_root is None:
            raise ValueError("HOST_CONTEXT_REQUIRED: refinement artifact root required")
        from chem_workbench.refinement_execution.governed_plan import (
            validate_plan as validate_current,
        )

        validate_current(plan, refinement_root, observed)


def _verify_approval(
    store: ExecutionStore,
    token: str,
    *,
    now: int | None = None,
    current_subject_hash: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    approval = store.load_approval(token)
    if approval is None:
        raise ValueError("APPROVAL_REQUIRED: unknown approval token")
    if (
        approval.get("version") != APPROVAL_VERSION
        or approval.get("token") != token
        or approval.get("allowed_actions") != ["execute"]
    ):
        raise ValueError("APPROVAL_STALE: invalid approval identity or actions")
    if approval.get("owner") != getpass.getuser() or approval.get("workspace") != str(store.root):
        raise ValueError("APPROVAL_STALE: approval belongs to another workspace or owner")
    clock = int(now if now is not None else time.time())
    if clock >= approval["expires_at"]:
        raise ValueError("APPROVAL_STALE: the approval has expired")
    plan = store.load_plan(approval["resolved_plan_hash"])
    _verify_worker(plan, refinement_root=store.artifact_root)
    binding = approval["binding"]
    stale_fields = [
        field
        for field in ("kind", "method_profile_id", "worker", "subject", "resource_ceilings")
        if plan.get(field) != binding.get(field)
    ]
    if stale_fields:
        raise ValueError(f"APPROVAL_STALE: plan fields changed after approval: {stale_fields}")
    plan_candidates = [c.get("candidate_hash") for c in plan.get("candidates", [])]
    if plan_candidates != binding.get("candidate_hashes"):
        raise ValueError("APPROVAL_STALE: the candidate set changed after approval")
    approved_subject_hash = plan["subject"].get("subject_hash") or plan["subject"].get(
        "content_hash"
    )
    if (
        current_subject_hash is not None
        and approved_subject_hash is not None
        and current_subject_hash != approved_subject_hash
    ):
        raise ValueError("APPROVAL_STALE: the current subject differs from the approved subject")
    return approval, plan


def submit_run(
    store: ExecutionStore,
    token: str,
    *,
    launch_intent: str = "default",
    current_subject_hash: str | None = None,
    now: int | None = None,
) -> dict[str, Any]:
    if not launch_intent or len(launch_intent) > 200:
        raise ValueError("INVALID_ARGUMENT: invalid launch intent")
    with store.submission_lock():
        return _submit_run_locked(
            store,
            token,
            launch_intent=launch_intent,
            current_subject_hash=current_subject_hash,
            now=now,
        )


def _submit_run_locked(
    store: ExecutionStore,
    token: str,
    *,
    launch_intent: str = "default",
    current_subject_hash: str | None = None,
    now: int | None = None,
) -> dict[str, Any]:
    """Idempotently submit an approved plan; the same intent returns the same job.

    The submission id binds the approval token, the exact resolved plan, and
    the user-authorized launch intent: a retry of the same intent returns the
    recorded job, while an explicitly new intent spends a fresh launch from
    the approval budget.
    """
    approval, plan = _verify_approval(
        store, token, now=now, current_subject_hash=current_subject_hash
    )
    submission_id = (
        "sha256:"
        + hashlib.sha256(
            token.encode("utf-8")
            + plan["resolved_plan_hash"].encode("utf-8")
            + launch_intent.encode("utf-8")
        ).hexdigest()
    )
    existing = store.find_job_by_submission(submission_id)
    if existing is not None:
        # A repeated intent returns the recorded job and spends no launch budget.
        return existing
    if approval["launches_used"] >= approval["max_launches"]:
        raise ValueError("APPROVAL_STALE: the approval launch budget is exhausted")
    job = {
        "version": JOB_VERSION,
        "job_id": uuid.uuid4().hex,
        "submission_id": submission_id,
        "approval_token": token,
        "resolved_plan_hash": plan["resolved_plan_hash"],
        "status": "running",
        "worker_kind": plan["worker"]["kind"],
        "evidence_eligible": False,
        "submitted_at": int(now if now is not None else time.time()),
        "owner": getpass.getuser(),
        "workspace": str(store.root),
    }
    approval["launches_used"] += 1
    store.save_approval(approval)  # fail closed if interrupted before the job reservation
    store.save_job(job)
    try:
        result = _execute(store, job, plan)
        job["result_hash"] = content_hash(result)
        job["status"] = result["execution_status"]
        job["evidence_eligible"] = result.get("evidence_eligible", False)
        job["result_summary"] = result.get(
            "summary", {"property": result.get("property"), "status": result["execution_status"]}
        )
    except Exception as error:
        job["status"] = "failed"
        job["failure"] = str(error)[:600]
    store.save_job(job)
    return job


def _execute(store: ExecutionStore, job: dict[str, Any], plan: dict[str, Any]) -> dict[str, Any]:
    validate_plan(plan, refinement_root=store.artifact_root)
    _verify_worker(plan, refinement_root=store.artifact_root)
    if plan["kind"] == "molecular_refinement":
        from chem_workbench.refinement_execution.governed_execution import run_refinement_job

        return run_refinement_job(store, job, plan)
    worker = WORKERS[plan["worker"]["kind"]]
    run_dir = store.run_directory(job["job_id"])
    worker_input = plan["prepared_input"]
    input_path = run_dir / "input.json"
    input_path.write_text(json.dumps(worker_input, sort_keys=True), encoding="utf-8")
    output_path = run_dir / "output.json"
    ceilings = plan["resource_ceilings"]
    execution = run_worker(
        worker,
        input_path,
        output_path,
        deadline_seconds=ceilings["deadline_seconds"],
        max_output_bytes=ceilings["max_output_bytes"],
        cancel_path=run_dir / "cancel.request",
    )
    (run_dir / "stdout.txt").write_bytes(execution.pop("_stdout"))
    (run_dir / "stderr.txt").write_bytes(execution.pop("_stderr"))
    if execution["status"] != "succeeded" or not output_path.is_file():
        failure = {
            "execution_status": execution["status"]
            if execution["status"] != "succeeded"
            else "failed",
            "execution": execution,
            "evidence_eligible": False,
            "summary": "Worker failed or did not produce an output record",
        }
        store._write(run_dir / "result.json", failure)
        return failure
    if output_path.stat().st_size > ceilings["max_output_bytes"]:
        raise ValueError("INVALID_TOOL_OUTPUT: output record exceeds cap")
    try:
        response = json.loads(output_path.read_text(encoding="utf-8"))
        validated = _validate_result(plan, response)
    except (ValueError, TypeError, KeyError) as error:
        failure = {
            "version": "execution-result/v1",
            "job_id": job["job_id"],
            "resolved_plan_hash": plan["resolved_plan_hash"],
            "execution_status": "failed",
            "execution": execution,
            "evidence_eligible": False,
            "summary": f"Result validation failed: {str(error)[:600]}",
            "input_sha256": hashlib.sha256(input_path.read_bytes()).hexdigest(),
            "output_sha256": hashlib.sha256(output_path.read_bytes()).hexdigest(),
        }
        store._write(run_dir / "result.json", failure)
        return failure
    result = {
        "version": "execution-result/v1",
        "execution_status": "succeeded",
        "job_id": job["job_id"],
        "resolved_plan_hash": plan["resolved_plan_hash"],
        "method_profile_id": plan["method_profile_id"],
        "worker": plan["worker"],
        "execution": execution,
        "environment": response.get("environment"),
        "evidence_eligible": worker.kind != "mock",
        "input_sha256": hashlib.sha256(input_path.read_bytes()).hexdigest(),
        "output_sha256": hashlib.sha256(output_path.read_bytes()).hexdigest(),
        **validated,
    }
    store._write(run_dir / "result.json", result)
    return result


def _validate_result(plan: dict[str, Any], response: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(response, dict) or response.get("worker") != plan["worker"]["kind"]:
        raise ValueError("INVALID_TOOL_OUTPUT: worker identity mismatch")
    if plan["kind"] == "molecular_hf_sto3g":
        from chem_workbench.molecular_compute import validate_molecular_result

        return validate_molecular_result(plan, response)
    if plan["kind"] == "water_hf_sto3g":
        acceptance = plan["acceptance"]
        energy = response.get("energy_hartree")
        try:
            energy_value = Decimal(_canonical_decimal(energy))
        except (TypeError, ValueError) as error:
            raise ValueError(f"INVALID_TOOL_OUTPUT: energy is not canonical: {error}") from error
        in_window = Decimal(acceptance["minimum"]) <= energy_value <= Decimal(acceptance["maximum"])
        if response.get("success") is not True or not in_window:
            raise ValueError("INVALID_TOOL_OUTPUT: water calculation failed acceptance")
        return {
            "property": "energy_hartree",
            "energy_hartree": _canonical_decimal(energy),
            "success": bool(response.get("success")) and in_window,
            "within_acceptance_window": in_window,
        }
    if plan["kind"] == "cu_lattice_scan":
        outcomes = response.get("outcomes")
        if not isinstance(outcomes, list) or not outcomes:
            raise ValueError("INVALID_TOOL_OUTPUT: no candidate outcomes")
        if response.get("normalization") != "eV/atom":
            raise ValueError("INVALID_TOOL_OUTPUT: incorrect normalization")
        expected = {c["candidate_hash"]: c for c in plan["candidates"]}
        seen = set()
        for outcome in outcomes:
            if not isinstance(outcome, dict):
                raise ValueError("INVALID_TOOL_OUTPUT: malformed outcome")
            key = outcome.get("candidate_hash")
            if (
                not isinstance(key, str)
                or key not in expected
                or key in seen
                or outcome.get("scale") != expected[key]["scale"]
            ):
                raise ValueError("INVALID_TOOL_OUTPUT: candidate identity mismatch or duplicate")
            seen.add(key)
        if seen != set(expected):
            raise ValueError("INVALID_TOOL_OUTPUT: missing candidate outcomes")
        eligible = []
        excluded = []
        for outcome in outcomes:
            if outcome.get("convergence") != "converged":
                excluded.append({**outcome, "reason": "NOT_CONVERGED"})
                continue
            try:
                energy = _canonical_decimal(outcome["energy_eV_per_atom"])
                total = Decimal(_canonical_decimal(outcome["energy_eV"]))
                count = len(expected[outcome["candidate_hash"]]["fractional_sites"])
                if abs(total / count - Decimal(energy)) > Decimal("1e-10"):
                    raise ValueError("energy normalization mismatch")
            except (KeyError, TypeError, ValueError):
                excluded.append({**outcome, "reason": "NON_FINITE_OR_NON_CANONICAL"})
                continue
            eligible.append({**outcome, "energy_eV_per_atom": energy})
        if not eligible:
            raise ValueError("INVALID_TOOL_OUTPUT: every candidate failed validation")
        ranking = sorted(eligible, key=lambda item: Decimal(item["energy_eV_per_atom"]))
        return {
            "property": "energy_eV_per_atom",
            "ranking": [
                {
                    "rank": index,
                    "scale": item["scale"],
                    "energy_eV_per_atom": item["energy_eV_per_atom"],
                    "candidate_hash": item["candidate_hash"],
                }
                for index, item in enumerate(ranking, start=1)
            ],
            "excluded": excluded,
            "plot": {
                "scales": [
                    item["scale"] for item in sorted(eligible, key=lambda x: Decimal(x["scale"]))
                ],
                "energies_eV_per_atom": [
                    item["energy_eV_per_atom"]
                    for item in sorted(eligible, key=lambda x: Decimal(x["scale"]))
                ],
            },
        }
    if plan["kind"] == "mock":
        return {"property": "marker", "marker": response.get("marker")}
    raise ValueError(f"UNSUPPORTED_PROFILE: {plan['kind']} cannot be validated")


def build_mock_resolved_plan(
    marker: str = "mock",
    *,
    sleep_seconds: float = 0.0,
    deadline_seconds: int = 30,
) -> dict[str, Any]:
    worker = WORKERS["mock"]
    subject_payload = {"input": {"marker": marker, "sleep_seconds": sleep_seconds}}
    plan = {
        "version": PLAN_VERSION,
        "kind": "mock",
        "subject": {**subject_payload, "content_hash": content_hash(subject_payload)},
        "method_profile_id": "mock.worker.v1",
        "worker": worker_identity(worker),
        "resource_ceilings": {
            "deadline_seconds": deadline_seconds,
            "max_output_bytes": 100_000,
            "job_memory_bytes": 3 * 1024**3,
            "job_cpu_seconds": 600,
        },
        "acceptance": {"property": "marker"},
        "allowed_actions": ["execute"],
    }
    plan["prepared_input"] = prepared_input(plan)
    plan["prepared_input_hash"] = content_hash(plan["prepared_input"])
    plan["resolved_plan_hash"] = content_hash(plan)
    validate_plan(plan)
    return plan


def cancel_job(store: ExecutionStore, job_id: str) -> dict[str, Any]:
    job = store.load_job(job_id)
    if (
        job is None
        or job.get("owner") != getpass.getuser()
        or job.get("workspace") != str(store.root)
    ):
        raise ValueError("JOB_NOT_OWNED: no owned job with this identifier")
    if job["status"] == "running":
        (store.run_directory(job_id) / "cancel.request").touch()
        return {"job_id": job_id, "status": "cancellation_requested"}
    return {"job_id": job_id, "status": job["status"]}


def recover_interrupted_jobs(store: ExecutionStore) -> list[str]:
    recovered = []
    # Acquiring the process-shared lock proves no governed execution owns this store.
    with store.submission_lock():
        for path in store.jobs.glob("*.json"):
            job = store._read(path)
            if job.get("status") == "running":
                job.update(
                    status="interrupted",
                    evidence_eligible=False,
                    failure="Host stopped before final job state; review before a new approval",
                )
                store.save_job(job)
                recovered.append(job["job_id"])
    return recovered
