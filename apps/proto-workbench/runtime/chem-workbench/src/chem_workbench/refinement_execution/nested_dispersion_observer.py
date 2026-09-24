"""Serial-worker observation of nested D3 calls; standard library only.

Dependencies and native scratch access are injected. This module never imports a
scientific runtime or performs a calculation itself. It does not fabricate or
rewrite successful results. A killed native process can leave durable starts
without returns or a final summary; the supervisor must classify that condition.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

_SCOPE_LOCK = threading.Lock()


def _no_reparse(path: Path) -> None:
    for component in [path, *path.parents]:
        if component.exists():
            attributes = getattr(component.lstat(), "st_file_attributes", 0)
            if component.is_symlink() or attributes & 0x400:
                raise ValueError("Observer path contains a reparse component")


def _raw_model(model: Any) -> str:
    if isinstance(model, dict):
        return json.dumps(model, allow_nan=False)
    serializer = getattr(model, "model_dump_json", None)
    if serializer is None:
        serializer = getattr(model, "json", None)
    if not callable(serializer):
        raise TypeError("Observed model has no native JSON serializer")
    text = serializer()
    if not isinstance(text, str):
        raise TypeError("Native model serializer did not return text")
    return text


def _request_driver(text: str) -> str:
    body = json.loads(text)
    if not isinstance(body, dict):
        raise ValueError("Expected QCSchema request object")
    if body.get("schema_version") != 2 or body.get("schema_name") != "qcschema_atomic_input":
        raise ValueError("Only the installed nested QCSchema v2 path is admitted")
    spec = body.get("specification")
    if not isinstance(spec, dict):
        raise ValueError("Missing nested specification")
    extras = spec.get("extras", {})
    if not isinstance(extras, dict) or "_qcengine_local_config" in extras:
        raise ValueError("Nested local-config overrides are forbidden")
    # Reject a misplaced override too, rather than accepting an ambiguous input.
    outer_extras = body.get("extras", {})
    if not isinstance(outer_extras, dict) or "_qcengine_local_config" in outer_extras:
        raise ValueError("Nested local-config overrides are forbidden")
    driver = spec.get("driver")
    if driver not in {"energy", "gradient"}:
        raise ValueError("Only dispersion energy and gradient drivers are admitted")
    return str(driver)


@dataclass(frozen=True)
class BoundResources:
    ncores: int
    memory_gib: float
    scratch_directory: Path

    def validate(self) -> None:
        if type(self.ncores) is not int or not 1 <= self.ncores <= 8:
            raise ValueError("Invalid bound thread count")
        if (
            type(self.memory_gib) not in {float, int}
            or not math.isfinite(self.memory_gib)
            or not 0 < self.memory_gib <= 16
        ):
            raise ValueError("Invalid bound native memory")
        _no_reparse(self.scratch_directory)
        if not self.scratch_directory.is_absolute() or not self.scratch_directory.is_dir():
            raise ValueError("Bound scratch must be an existing owned absolute directory")


class NestedDispersionObserver:
    """One exclusive observer context per evaluation, inside one serial worker.

    Invoke the outer Psi4 computation via ``original_compute`` while this context
    is active. The patched public compute attribute then receives only nested D3
    calls. Directory ownership and total disk limits remain the host's job.
    """

    def __init__(
        self,
        *,
        qcengine: Any,
        dftd3_qcschema: Any,
        get_scratch: Callable[[], str],
        set_scratch: Callable[[str], None],
        resources: BoundResources,
        directory: Path,
        evaluation_id: str,
        spec_hash: str,
    ):
        resources.validate()
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,100}", evaluation_id):
            raise ValueError("Invalid evaluation identifier")
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", spec_hash):
            raise ValueError("Invalid bound spec hash")
        _no_reparse(directory)
        self.qcengine = qcengine
        self.qcschema = dftd3_qcschema
        self.get_scratch = get_scratch
        self.set_scratch = set_scratch
        self.resources = resources
        self.directory = directory
        self.evaluation_id = evaluation_id
        self.spec_hash = spec_hash
        self.original_compute = qcengine.compute
        self.original_qcschema = dftd3_qcschema.run_qcschema
        self._compute_wrapper = self._compute
        self._inner_wrapper = self._inner
        self._scratch_before: str | None = None
        self._scratch_effective: str | None = None
        self._thread: int | None = None
        self._entered = False
        self._used = False
        self._active_qce: tuple[str, str] | None = None
        self._inner_parent_dispatches: set[str] = set()
        self._directory_created = False
        self._artifacts: list[dict[str, Any]] = []
        self.counts = {
            "qce_calls_seen": 0,
            "qce_calls_forwarded": 0,
            "qce_calls_returned": 0,
            "inner_calls_seen": 0,
            "inner_calls_forwarded": 0,
            "inner_calls_returned": 0,
        }

    def _write(self, name: str, data: Any, *, raw: bool = False) -> str:
        text = data if raw else json.dumps(data, sort_keys=True, allow_nan=False, indent=2)
        payload = text.encode("utf-8")
        path = self.directory / name
        with path.open("xb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        digest = hashlib.sha256(payload).hexdigest()
        self._artifacts.append({"name": name, "sha256": digest, "bytes": len(payload)})
        return digest

    def _base(self) -> dict[str, Any]:
        return {
            "evaluation_id": self.evaluation_id,
            "spec_hash": self.spec_hash,
            "monotonic_seconds": time.monotonic(),
        }

    def _exception(self, prefix: str, error: BaseException) -> None:
        self._write(
            prefix + "-exception.json",
            {
                **self._base(),
                "type": type(error).__name__,
                "message": str(error),
            },
        )

    def _require_scope(self) -> None:
        if not self._entered or threading.get_ident() != self._thread:
            raise RuntimeError("Nested observation is confined to its active worker thread")

    def __enter__(self) -> NestedDispersionObserver:
        if self._used or not _SCOPE_LOCK.acquire(blocking=False):
            raise RuntimeError("Observer is single-use and cannot overlap another observer")
        self._used = True
        try:
            # Construction may precede another completed evaluation. Refresh only
            # after obtaining the exclusive scope, never restore a stale wrapper.
            self.original_compute = self.qcengine.compute
            self.original_qcschema = self.qcschema.run_qcschema
            self.directory.mkdir(exist_ok=False)
            self._directory_created = True
            self._thread = threading.get_ident()
            self._scratch_before = self.get_scratch()
            self._write(
                "context-start.json",
                {
                    **self._base(),
                    "scratch_before": self._scratch_before,
                    "scratch_forwarded": str(self.resources.scratch_directory),
                    "ncores": self.resources.ncores,
                    "memory_gib": self.resources.memory_gib,
                    "nested_retries": 0,
                    "scope": "Actual nested calls only; no scientific accuracy assertion",
                },
            )
            self.set_scratch(str(self.resources.scratch_directory))
            self._scratch_effective = self.get_scratch()
            if (
                Path(self._scratch_effective).resolve()
                != self.resources.scratch_directory.resolve()
            ):
                raise ValueError("Native scratch setter did not apply the owned path")
            self.qcengine.compute = self._compute_wrapper
            self.qcschema.run_qcschema = self._inner_wrapper
            self._entered = True
            return self
        except BaseException as error:
            try:
                restoration_errors = self._restore()
                if restoration_errors:
                    error.add_note("Observer setup restoration errors: " + repr(restoration_errors))
                if self._directory_created:
                    self._exception("context-setup", error)
            finally:
                _SCOPE_LOCK.release()
            raise

    def _forward_config(self, requested: Any) -> dict[str, Any]:
        if requested is None:
            requested = {}
        if not isinstance(requested, dict):
            raise ValueError("Nested task_config must be a dictionary")
        if set(requested) - {"retries", "ncores", "memory", "scratch_directory"}:
            raise ValueError("Unknown nested resource-control keys")
        target = {
            "retries": 0,
            "ncores": self.resources.ncores,
            "memory": self.resources.memory_gib,
            "scratch_directory": self._scratch_effective,
        }
        for key, value in requested.items():
            if key == "scratch_directory":
                if not isinstance(value, str) or not Path(value).is_absolute():
                    raise ValueError("Nested requested scratch is not an absolute path")
                _no_reparse(Path(value))
                matches = Path(value).resolve() == self.resources.scratch_directory.resolve()
            else:
                matches = not isinstance(value, bool) and value == target[key]
                if key in {"retries", "ncores"}:
                    matches = matches and type(value) is int
            if not matches:
                raise ValueError("Nested requested control disagrees with bound " + key)
        return target

    @staticmethod
    def _isolated_request(input_data: Any, text: str) -> Any:
        forwarded = copy.deepcopy(input_data)
        if type(forwarded) is not type(input_data) or _raw_model(forwarded) != text:
            raise ValueError("Input isolation changed the native request representation")
        return forwarded

    def _compute(
        self,
        input_data: Any,
        program: str,
        raise_error: bool = False,
        task_config: dict[str, Any] | None = None,
        return_dict: bool = False,
        return_version: int = -1,
    ) -> Any:
        self._require_scope()
        index = self.counts["qce_calls_seen"]
        self.counts["qce_calls_seen"] += 1
        prefix = f"qce-{index:04d}"
        self._write(prefix + "-start.json", {**self._base(), "program": program})
        previous_active = self._active_qce
        forwarded_input = None
        try:
            text = _raw_model(input_data)
            self._write(prefix + "-request.json", text, raw=True)
            self._write(prefix + "-requested-config.json", task_config)
            if program != "s-dftd3" or self._active_qce is not None:
                raise ValueError("Unknown program or recursive outer call in nested scope")
            driver = _request_driver(text)
            if raise_error is not True or return_dict is not False or return_version != 2:
                raise ValueError("Unexpected nested QCEngine return/error contract")
            forwarded = self._forward_config(task_config)
            self._write(prefix + "-forwarded-config.json", forwarded)
            forwarded_input = self._isolated_request(input_data, text)
            self._active_qce = (prefix, driver)
            self.counts["qce_calls_forwarded"] += 1
            result = self.original_compute(
                forwarded_input,
                program,
                raise_error=raise_error,
                task_config=forwarded,
                return_dict=return_dict,
                return_version=return_version,
            )
            self.counts["qce_calls_returned"] += 1
            self._write(prefix + "-return.json", _raw_model(result), raw=True)
            return result
        except BaseException as error:
            self._exception(prefix, error)
            raise
        finally:
            self._active_qce = previous_active
            if forwarded_input is not None:
                self._write(
                    prefix + "-forwarded-request-after.json", _raw_model(forwarded_input), raw=True
                )

    def _inner(self, input_data: Any) -> Any:
        self._require_scope()
        index = self.counts["inner_calls_seen"]
        self.counts["inner_calls_seen"] += 1
        prefix = f"inner-{index:04d}"
        self._write(
            prefix + "-start.json",
            {
                **self._base(),
                "parent_qce_call": self._active_qce[0] if self._active_qce else None,
            },
        )
        forwarded_input = None
        try:
            text = _raw_model(input_data)
            self._write(prefix + "-request.json", text, raw=True)
            driver = _request_driver(text)
            if self._active_qce is None or driver != self._active_qce[1]:
                raise ValueError("Orphan inner call or changed driver")
            if self._active_qce[0] in self._inner_parent_dispatches:
                raise ValueError("Repeated or recursive inner dispatch violates zero retries")
            forwarded_input = self._isolated_request(input_data, text)
            self._inner_parent_dispatches.add(self._active_qce[0])
            self.counts["inner_calls_forwarded"] += 1
            result = self.original_qcschema(forwarded_input)
            self.counts["inner_calls_returned"] += 1
            self._write(prefix + "-return.json", _raw_model(result), raw=True)
            return result
        except BaseException as error:
            self._exception(prefix, error)
            raise
        finally:
            if forwarded_input is not None:
                self._write(
                    prefix + "-forwarded-request-after.json", _raw_model(forwarded_input), raw=True
                )

    def _restore(self) -> list[str]:
        errors = []
        for owner, name, original in [
            (self.qcengine, "compute", self.original_compute),
            (self.qcschema, "run_qcschema", self.original_qcschema),
        ]:
            try:
                setattr(owner, name, original)
            except BaseException as error:
                errors.append(str(error))
        try:
            if self._scratch_before is not None:
                self.set_scratch(self._scratch_before)
        except BaseException as error:
            errors.append(str(error))
        self._entered = False
        return errors

    def __exit__(self, exc_type: Any, error: BaseException | None, tb: Any) -> Literal[False]:
        restoration_errors = []
        try:
            restoration_errors = self._restore()
            self._write(
                "summary.json",
                {
                    **self._base(),
                    "version": "nested-d3-observation-staged/v1",
                    "finalized": True,
                    "context_exception": None
                    if error is None
                    else {
                        "type": type(error).__name__,
                        "message": str(error),
                    },
                    "restoration_errors": restoration_errors,
                    "counts": self.counts.copy(),
                    "artifacts": self._artifacts.copy(),
                    "scientific_accuracy_validated": False,
                    "outer_electronic_attempts_observed": False,
                },
            )
        finally:
            _SCOPE_LOCK.release()
        if restoration_errors:
            if error is not None:
                error.add_note("Observer restoration errors: " + repr(restoration_errors))
            else:
                raise RuntimeError("Observer restoration failed: " + repr(restoration_errors))
        return False
