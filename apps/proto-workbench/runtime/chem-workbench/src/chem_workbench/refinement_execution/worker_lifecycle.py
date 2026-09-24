"""Request-v2 worker orchestration with mandatory independently trusted admission.

This is not a supervisor, approval service or evidence assembler. Importing it
loads no native runtime. There is no default importer or permissive verifier.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import stat
import time
from collections.abc import Callable
from pathlib import Path, PurePosixPath
from typing import Any, Protocol

from chem_workbench.molecular_refinement import validate_refinement_result
from chem_workbench.refinement_backend import verified_file
from chem_workbench.refinement_execution.execution_contract import validate_worker_request
from chem_workbench.refinement_execution.observed_dispatch import ObservedPsiapiDispatch
from chem_workbench.refinement_execution.optimizer_loop import (
    run_bound_optimization,
    verify_bound_optimizer_artifact,
)
from chem_workbench.refinement_execution.refinement_recorder import StagedGradientRecorder
from chem_workbench.visualization import content_hash

Record = dict[str, Any]
VERSION = "refinement-worker-lifecycle/v1"
RESULT_FILE = "worker-result.json"
LIFECYCLE_FILE = "worker-lifecycle.json"
EVENTS_FILE = "worker-lifecycle-events.jsonl"
RESOURCE_FIELDS = {"wall_seconds", "memory_bytes", "cpu_seconds", "threads", "max_output_bytes"}


class HostLaunchContext(Protocol):
    """Independent host input; field shape alone grants no execution authority."""

    @property
    def root(self) -> Path: ...
    @property
    def run_id(self) -> str: ...
    @property
    def run_nonce(self) -> str: ...
    @property
    def run_directory(self) -> str: ...
    @property
    def worker_identity(self) -> Record: ...
    @property
    def source_identity(self) -> dict[str, str]: ...
    @property
    def plan_context(self) -> object: ...
    @property
    def resolved_plan_hash(self) -> str: ...
    @property
    def prepared_input_hash(self) -> str: ...
    @property
    def input_artifact(self) -> Record: ...
    @property
    def resource_policy(self) -> Record: ...
    @property
    def native_task_config(self) -> Record: ...


HostVerifier = Callable[[Record, HostLaunchContext], None]
SpecVerifier = Callable[[Record, HostLaunchContext], None]
Importer = Callable[[str], Any]


def _detached(value: Record) -> Record:
    result: Record = json.loads(json.dumps(value, allow_nan=False))
    return result


def _same(actual: object, expected: object, label: str) -> None:
    if content_hash(actual) != content_hash(expected):
        raise ValueError("APPROVAL_STALE: " + label + " changed")


def _directory(root: Path, relative: str) -> Path:
    if not root.is_absolute() or not root.is_dir():
        raise ValueError("REFINEMENT_PATH_ESCAPE: absolute existing host root required")
    if (
        not isinstance(relative, str)
        or not relative
        or "\\" in relative
        or ":" in relative
        or PurePosixPath(relative).is_absolute()
        or any(part in {"", ".", ".."} for part in relative.split("/"))
    ):
        raise ValueError("REFINEMENT_PATH_ESCAPE: relative owned run directory required")
    target = root / relative
    for path in (
        *reversed(root.parents),
        root,
        *[root.joinpath(*relative.split("/")[:n]) for n in range(1, len(relative.split("/")) + 1)],
    ):
        info = path.lstat()
        if path.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("REFINEMENT_PATH_ESCAPE: reparse component")
    if not target.is_dir() or not target.resolve().is_relative_to(root.resolve()):
        raise ValueError("REFINEMENT_PATH_ESCAPE: existing owned run directory required")
    return target


def _context_snapshot(context: HostLaunchContext) -> Record:
    if not isinstance(context.root, Path):
        raise ValueError("INVALID_ARGUMENT: host root Path required")
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,100}", context.run_id) is None:
        raise ValueError("INVALID_ARGUMENT: host run ID required")
    if re.fullmatch(r"[0-9a-f]{32,128}", context.run_nonce) is None:
        raise ValueError("INVALID_ARGUMENT: host run nonce required")
    if context.plan_context is None or not context.source_identity:
        raise ValueError("APPROVAL_STALE: independent plan and source context required")
    if context.worker_identity.get("kind") != "psi4_refinement":
        raise ValueError("APPROVAL_STALE: independently admitted worker kind required")
    for value in (context.resolved_plan_hash, context.prepared_input_hash):
        if not isinstance(value, str) or re.fullmatch(r"(?:sha256:)?[0-9a-f]{64}", value) is None:
            raise ValueError("APPROVAL_STALE: independent plan/input identity required")
    for path, raw_sha in context.source_identity.items():
        if not isinstance(path, str) or re.fullmatch(r"[0-9a-f]{64}", raw_sha) is None:
            raise ValueError("APPROVAL_STALE: complete raw source identity required")
    return _detached(
        {
            "root": str(context.root),
            "run_id": context.run_id,
            "run_nonce": context.run_nonce,
            "run_directory": context.run_directory,
            "worker_identity": context.worker_identity,
            "source_identity": context.source_identity,
            "resolved_plan_hash": context.resolved_plan_hash,
            "prepared_input_hash": context.prepared_input_hash,
            "input_artifact": context.input_artifact,
            "resource_policy": context.resource_policy,
            "native_task_config": context.native_task_config,
        }
    )


def _write_new(context: HostLaunchContext, name: str, value: object) -> Record:
    directory = _directory(context.root, context.run_directory)
    raw = json.dumps(value, allow_nan=False, sort_keys=True).encode("utf-8")
    if name.endswith(".jsonl"):
        raw += b"\n"
    path = directory / name
    with path.open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    return {
        "path": path.relative_to(context.root).as_posix(),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def _verify_prepared_bytes(request: Record, context: HostLaunchContext) -> None:
    path = verified_file(context.root, context.input_artifact)
    with path.open("rb") as stream:
        raw = stream.read(20 * 1024**2 + 1)
    if (
        len(raw) > 20 * 1024**2
        or hashlib.sha256(raw).hexdigest() != context.input_artifact["sha256"]
    ):
        raise ValueError("APPROVAL_STALE: bounded original prepared input bytes required")

    def pairs(values: list[tuple[str, Any]]) -> Record:
        result: Record = {}
        for key, value in values:
            if key in result:
                raise ValueError("INVALID_ARGUMENT: duplicate key in prepared worker request")
            result[key] = value
        return result

    actual = validate_worker_request(json.loads(raw.decode("utf-8"), object_pairs_hook=pairs))
    _same(actual, request, "original prepared input record")


class _EventLog:
    """One exclusive handle; replacement, links and byte changes fail closed."""

    def __init__(self, root: Path, directory: Path):
        self.root = root
        self.path = directory / EVENTS_FILE
        self.stream = self.path.open("x+b", buffering=0)
        try:
            self.identity = self._identity(os.fstat(self.stream.fileno()))
            self.raw = b""
            self._check()
        except BaseException:
            self.stream.close()
            raise

    @staticmethod
    def _identity(info: os.stat_result) -> tuple[int, int]:
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or getattr(info, "st_file_attributes", 0) & 0x400
            or info.st_ino == 0
        ):
            raise ValueError("REFINEMENT_PATH_ESCAPE: regular single-link event file required")
        return info.st_dev, info.st_ino

    def _check(self) -> None:
        if (
            self._identity(self.path.lstat()) != self.identity
            or self._identity(os.fstat(self.stream.fileno())) != self.identity
        ):
            raise ValueError("APPROVAL_STALE: event file identity changed")
        self.stream.seek(0)
        if self.stream.read(len(self.raw) + 1) != self.raw:
            raise ValueError("APPROVAL_STALE: event file bytes changed")

    def append(self, value: Record) -> Record:
        self._check()
        addition = json.dumps(value, allow_nan=False, sort_keys=True).encode() + b"\n"
        self.stream.seek(0, os.SEEK_END)
        self.stream.write(addition)
        self.stream.flush()
        os.fsync(self.stream.fileno())
        self.raw += addition
        self._check()
        return {
            "path": self.path.relative_to(self.root).as_posix(),
            "sha256": hashlib.sha256(self.raw).hexdigest(),
        }

    def close(self) -> None:
        self.stream.close()


def run_worker_lifecycle(
    request: object,
    *,
    context: HostLaunchContext | None = None,
    verify_host_admission: HostVerifier | None = None,
    verify_subject: SpecVerifier | None = None,
    verify_runtime: SpecVerifier | None = None,
    import_module: Importer | None = None,
) -> Record:
    """Run one independently admitted worker request and retain a terminal report.

    Verifiers are trusted injected code, not request fields. Each must return None
    on success or raise; booleans/self-declared acceptance are rejected. Runtime
    verification must cover installed identity, basis, effective options,
    analytic derivative support, isotope defaults and source closure. It runs
    before native construction and again at terminal, including failed attempts.
    The importer is required; no fallback can silently load an installed runtime.

    Before host admission, errors return in memory and no files are written.
    After admission, initialization and native errors are retained with whatever
    raw evidence exists. Execution-evidence completion is always unassessed here.
    """
    checked: Record | None = None
    frozen_context: Record | None = None
    recorder: Any = None
    dispatcher: Any = None
    scientific: Record | None = None
    result_ref: Record | None = None
    events_ref: Record | None = None
    event_log: _EventLog | None = None
    errors: list[Record] = []
    verifications: list[str] = []
    failure: Exception | None = None
    reported: bool | None = None
    authorized = False
    writable = False
    interrupted = False
    phase = "request_validation"
    started = time.monotonic()

    def fail(stage: str, error: BaseException) -> None:
        nonlocal failure, interrupted
        interrupted = interrupted or isinstance(error, (KeyboardInterrupt, SystemExit))
        errors.append(
            {
                "stage": stage,
                "type": type(error).__name__,
                "message": str(error)[:4096],
                "notes": [str(note)[:4096] for note in getattr(error, "__notes__", [])],
            }
        )
        if failure is None:
            failure = (
                error
                if isinstance(error, Exception)
                else RuntimeError(type(error).__name__ + ": " + str(error))
            )

    def unchanged() -> None:
        assert context is not None and frozen_context is not None
        _same(_context_snapshot(context), frozen_context, "host context")

    def verified(label: str, callback: Callable[..., Any], value: Record) -> None:
        unchanged()
        detached = copy.deepcopy(value)
        returned = callback(detached, context)
        if returned is not None:
            raise ValueError("HOST_VERIFICATION_REJECTED: verifier must return None or raise")
        _same(detached, value, "verified input")
        unchanged()
        verifications.append(label)

    def event(stage: str) -> None:
        nonlocal events_ref
        if not writable:
            return
        assert context is not None
        unchanged()
        _directory(context.root, context.run_directory)
        assert event_log is not None
        events_ref = event_log.append(
            {"stage": stage, "monotonic_seconds": time.monotonic(), "errors": errors}
        )

    try:
        checked = validate_worker_request(request)
        if context is None or any(
            callback is None
            for callback in (verify_host_admission, verify_subject, verify_runtime, import_module)
        ):
            raise ValueError("HOST_ADMISSION_REQUIRED: context and all trusted callbacks required")
        if not all(
            callable(callback)
            for callback in (verify_host_admission, verify_subject, verify_runtime, import_module)
        ):
            raise ValueError("HOST_ADMISSION_REQUIRED: callable verifiers/importer required")
        frozen_context = _context_snapshot(context)
        phase = "host_admission"
        if context.prepared_input_hash != content_hash(checked):
            raise ValueError("APPROVAL_STALE: independent canonical prepared input differs")
        assert verify_host_admission is not None
        verified(phase, verify_host_admission, checked)
        authorized = True
        phase = "owned_run_admission"
        directory = _directory(context.root, context.run_directory)
        _verify_prepared_bytes(checked, context)
        occupied = (
            any((directory / name).exists() for name in (RESULT_FILE, LIFECYCLE_FILE, EVENTS_FILE))
            or any(directory.glob("evaluation-*"))
            or any(directory.glob("optimizer-*"))
        )
        if occupied:
            raise ValueError("APPROVAL_STALE: worker run already contains lifecycle/call artifacts")
        expected_config = {
            "ncores": checked["spec"]["resources"]["threads"],
            "memory": checked["spec"]["resources"]["memory_bytes"] / 1024**3 * 0.6,
            "retries": 0,
            "scratch_directory": str(directory / "scratch"),
        }
        _same(
            context.resource_policy,
            {key: checked["spec"]["resources"][key] for key in RESOURCE_FIELDS},
            "approved supervisor resources",
        )
        _same(context.native_task_config, expected_config, "approved native task configuration")
        event_log = _EventLog(context.root, directory)
        writable = True
        event("host_admitted")
        phase = "subject_verification"
        assert verify_subject is not None and verify_runtime is not None
        verified(phase, verify_subject, checked["spec"])
        event(phase)
        phase = "runtime_verification"
        verified(phase, verify_runtime, checked["spec"])
        event(phase)
        phase = "optimizer_observation_verification"
        if checked["mode"] == "optimization":
            verify_bound_optimizer_artifact(
                checked["spec"], checked["execution_contract"]["optimizer_binding"], context.root
            )
        phase = "native_initialization"
        assert import_module is not None
        # Loader cache ensures recorder, dispatcher and loop see the same objects.
        loaded: dict[str, Any] = {}

        def native(name: str) -> Any:
            if name not in loaded:
                unchanged()
                loaded[name] = import_module(name)
                unchanged()
            return loaded[name]

        dispatcher = ObservedPsiapiDispatch(
            spec=checked["spec"],
            contract=checked["execution_contract"],
            root=context.root,
            run_directory=directory,
            run_id=context.run_id,
            run_nonce=context.run_nonce,
            qcengine=native("qcengine"),
            psi4=native("psi4"),
            dftd3_qcschema=native("dftd3.qcschema"),
        )

        def recorded_dispatch(*args: Any, **kwargs: Any) -> Any:
            nonlocal interrupted
            try:
                return dispatcher(*args, **kwargs)
            except (KeyboardInterrupt, SystemExit) as error:
                # The dispatcher already retained the original exception bytes.
                # The frozen recorder catches Exception only; bridge interruption
                # so its genuinely started attempt gets its terminal inventory.
                interrupted = True
                wrapped = RuntimeError(type(error).__name__ + ": " + str(error))
                wrapped.add_note("Original interruption retained by observed dispatcher")
                raise wrapped from error

        recorder = StagedGradientRecorder(
            checked["spec"],
            directory / RESULT_FILE,
            context.root,
            import_module=native,
            dispatch=recorded_dispatch,
        )
        phase = "native_execution"
        event(phase)
        if checked["mode"] == "gradient":
            recorder.evaluate(json.loads(recorder.molecule(checked["spec"]["geometry"]).json()))
        else:
            reported = run_bound_optimization(
                recorder, checked["execution_contract"]["optimizer_binding"], import_module=native
            )
        unchanged()
    except BaseException as error:
        fail(phase, error)

    # A terminal source/runtime failure does not erase earlier native exceptions.
    if writable and checked is not None:
        assert context is not None and verify_subject is not None and verify_runtime is not None
        for phase, callback in (
            ("terminal_subject_verification", verify_subject),
            ("terminal_runtime_verification", verify_runtime),
        ):
            try:
                verified(phase, callback, checked["spec"])
            except BaseException as error:
                fail(phase, error)
        if recorder is not None:
            try:
                candidate = recorder.result(reported, failure)
                scientific = validate_refinement_result(checked["spec"], candidate)
                unchanged()
                result_ref = _write_new(context, RESULT_FILE, scientific)
            except BaseException as error:
                fail("result_retention", error)
        try:
            event("terminal")
        except BaseException as error:
            fail("terminal_event_retention", error)

    if event_log is not None:
        try:
            event_log.close()
        except BaseException as error:
            fail("event_handle_close", error)

    observations = [] if dispatcher is None else copy.deepcopy(dispatcher.observations)
    artifacts = [] if recorder is None else copy.deepcopy(recorder.artifacts)
    native_report = None if recorder is None else recorder.last_native_report
    outcome = (
        "interrupted"
        if interrupted
        else "rejected"
        if not authorized
        else ("failed" if errors else "completed")
    )
    report = {
        "version": VERSION,
        "run_id": None if frozen_context is None else frozen_context["run_id"],
        "run_nonce": None if frozen_context is None else frozen_context["run_nonce"],
        "run_directory": None if frozen_context is None else frozen_context["run_directory"],
        "request_hash": None if checked is None else content_hash(checked),
        "spec_hash": None if checked is None else checked["spec"]["spec_hash"],
        "contract_hash": None
        if checked is None
        else checked["execution_contract"]["contract_hash"],
        "mode": None if checked is None else checked["mode"],
        "host_admitted": authorized,
        "runner_outcome": outcome,
        "scientific_state": None if scientific is None else scientific["state"],
        "scientific_result": scientific,
        "result_reference": result_ref,
        "last_native_report": native_report,
        "execution_evidence_state": "unassessed",
        "dispatch_observations": observations,
        "dispatch_directories": []
        if frozen_context is None
        else [
            frozen_context["run_directory"] + f"/evaluation-{index:04d}-dispatch"
            for index in range(len(observations))
        ],
        "recorder_artifacts": artifacts,
        "optimizer_artifacts": [item for item in artifacts if item["role"] == "optimizer_raw"],
        "backend_attempts_observed": 0 if recorder is None else recorder.attempts,
        "verification_stages": verifications,
        "events_reference": events_ref,
        "errors": errors,
        "elapsed_seconds": time.monotonic() - started,
        "scientific_accuracy_validated": False,
        "minimum_certified": False,
    }
    if writable:
        assert context is not None
        try:
            unchanged()
            _write_new(context, LIFECYCLE_FILE, report)
        except BaseException as error:
            fail("lifecycle_retention", error)
            report["runner_outcome"] = "interrupted" if interrupted else "failed"
            report["errors"] = errors
    return _detached(report)
