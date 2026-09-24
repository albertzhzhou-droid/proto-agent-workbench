"""Serial psiapi transport with real nested observation, dependencies injected.

This module does not import a native runtime. The host must admit its worker/run,
supervise the entire process, authenticate resulting evidence, and enforce ongoing
disk/resource limits. Pre/post-call checks alone are not a live scratch-size cap.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import Any

from chem_workbench.refinement_execution.execution_contract import validate_execution_contract
from chem_workbench.refinement_execution.native_options import NativeOptionsObserver
from chem_workbench.refinement_execution.nested_dispersion_observer import (
    BoundResources,
    NestedDispersionObserver,
    _raw_model,
)
from chem_workbench.visualization import content_hash


def _directory(path: Path, root: Path) -> None:
    if not path.is_absolute() or not root.is_absolute() or not path.is_relative_to(root):
        raise ValueError("APPROVAL_STALE: dispatch directory must be inside owned root")
    for part in [path, *path.parents]:
        if part.exists():
            flags = getattr(part.lstat(), "st_file_attributes", 0)
            if part.is_symlink() or flags & 0x400:
                raise ValueError("APPROVAL_STALE: dispatch path contains a reparse point")
    if any(part in {"..", "."} for part in path.parts) or not path.is_dir():
        raise ValueError("APPROVAL_STALE: dispatch directory is not an existing owned directory")


class ObservedPsiapiDispatch:
    """One instance per isolated run; never use in the long-lived web process.

    The constructor accepts native module objects from the isolated recorder.
    Repeated invocations create distinct durable evaluation directories. This is
    a transport, not authority to start jobs or a scientific completion validator.
    """

    def __init__(
        self,
        *,
        spec: dict[str, Any],
        contract: dict[str, Any],
        root: Path,
        run_directory: Path,
        run_id: str,
        run_nonce: str,
        qcengine: Any,
        psi4: Any,
        dftd3_qcschema: Any,
    ) -> None:
        self.contract = validate_execution_contract(contract, spec, contract["mode"])
        self.spec = copy.deepcopy(spec)
        _directory(root, root)
        _directory(run_directory, root)
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,100}", run_id):
            raise ValueError("INVALID_ARGUMENT: unique host run identity required")
        if not re.fullmatch(r"[0-9a-f]{32,128}", run_nonce):
            raise ValueError("INVALID_ARGUMENT: unique host run nonce required")
        self.run_id, self.run_nonce = run_id, run_nonce
        self.root, self.run = root, run_directory
        self.qcengine, self.psi4, self.dftd3 = qcengine, psi4, dftd3_qcschema
        self.index = 0
        self.active = False
        self.observations: list[dict[str, Any]] = []

    def _write(
        self, directory: Path, name: str, value: Any, *, raw: bool = False
    ) -> dict[str, Any]:
        data = (value if raw else json.dumps(value, sort_keys=True, allow_nan=False)).encode(
            "utf-8"
        )
        if len(data) > self.spec["resources"]["max_output_bytes"]:
            raise ValueError("RESOURCE_LIMIT: retained dispatch artifact exceeds output bound")
        path = directory / name
        with path.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        return {
            "path": path.relative_to(self.root).as_posix(),
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data),
        }

    def __call__(
        self,
        atomic_input: Any,
        program: str,
        *,
        raise_error: bool,
        task_config: dict[str, Any],
    ) -> Any:
        if self.active:
            raise ValueError("UNSUPPORTED_PROFILE: recursive outer dispatch")
        limits = self.spec["resources"]
        attempt_limit = (
            1
            if self.contract["mode"] == "gradient"
            else self.spec["optimizer_settings"]["max_gradient_evaluations"]
        )
        if self.index >= attempt_limit:
            raise ValueError("RESOURCE_LIMIT: outer dispatch budget exhausted")
        requested: dict[str, Any] = {
            "ncores": limits["threads"],
            "memory": limits["memory_bytes"] / 1024**3 * 0.6,
            "retries": 0,
            "scratch_directory": str(self.run / "scratch"),
        }
        if (
            program != "psi4"
            or raise_error is not False
            or set(task_config) != set(requested)
            or any(
                type(task_config[k]) is not type(v) or task_config[k] != v
                for k, v in requested.items()
            )
        ):
            raise ValueError("APPROVAL_STALE: outer invocation differs from bound route/resources")
        input_text = _raw_model(atomic_input)
        body = json.loads(input_text)
        if (
            body.get("schema_name") != "qcschema_input"
            or type(body.get("schema_version")) is not int
            or body["schema_version"] != 1
            or body.get("driver") != "gradient"
            or content_hash(body.get("extras")) != content_hash({"psiapi": True})
            or body.get("model")
            != {"method": self.spec["profile"]["method"], "basis": self.spec["profile"]["basis"]}
            or content_hash(body.get("keywords"))
            != content_hash(self.spec["electronic_settings"]["native_keywords"])
        ):
            raise ValueError(
                "APPROVAL_STALE: genuine outer input differs from bound psiapi contract"
            )
        copied = copy.deepcopy(atomic_input)
        if _raw_model(copied) != input_text:
            raise ValueError("INVALID_TOOL_OUTPUT: outer input copy changed native serialization")
        _directory(self.run, self.root)
        scratch = self.run / "scratch"
        if not scratch.exists():
            scratch.mkdir()
        _directory(scratch, self.run)
        identity = f"evaluation-{self.index:04d}"
        directory = self.run / (identity + "-dispatch")
        directory.mkdir(exist_ok=False)
        scratch = scratch / identity
        scratch.mkdir(exist_ok=False)
        _directory(scratch, self.run)
        call: dict[str, Any] = {
            "evaluation_id": identity,
            "artifacts": [],
            "outer_forwarded": False,
        }
        manager = self.psi4.core.IOManager.shared_object()
        effective = {**requested, "scratch_directory": str(scratch)}
        observer = NestedDispersionObserver(
            qcengine=self.qcengine,
            dftd3_qcschema=self.dftd3,
            get_scratch=manager.get_default_path,
            set_scratch=manager.set_default_path,
            resources=BoundResources(requested["ncores"], requested["memory"], scratch),
            directory=directory / "nested",
            evaluation_id=identity,
            spec_hash=self.spec["spec_hash"],
        )
        expected_memory = int(requested["memory"] * 1024**3)

        def controls(stage: str) -> None:
            actual: dict[str, Any] = {
                "stage": stage,
                "threads": self.psi4.core.get_num_threads(),
                "memory_bytes": self.psi4.core.get_memory(),
                "scratch": manager.get_default_path(),
            }
            call["artifacts"].append(
                self._write(directory, f"native-controls-{stage}.json", actual)
            )
            if (
                type(actual["threads"]) is not int
                or actual["threads"] != requested["ncores"]
                or type(actual["memory_bytes"]) is not int
                or actual["memory_bytes"] != expected_memory
                or Path(actual["scratch"]).resolve() != scratch.resolve()
            ):
                raise ValueError(
                    "APPROVAL_STALE: actual native controls differ from bound resources"
                )

        self.index += 1
        self.active = True
        self.observations.append(call)
        try:
            call["artifacts"].append(
                self._write(directory, "outer-input.json", input_text, raw=True)
            )
            call["artifacts"].append(
                self._write(
                    directory,
                    "outer-start.json",
                    {
                        "version": "refinement-electronic-call-start/v1",
                        "run_id": self.run_id,
                        "run_nonce": self.run_nonce,
                        "evaluation_id": identity,
                        "spec_hash": self.spec["spec_hash"],
                        "contract_hash": self.contract["contract_hash"],
                        "dispatch": self.contract["dispatch"],
                        "task_config": effective,
                        "input_sha256": hashlib.sha256(input_text.encode()).hexdigest(),
                        "program": program,
                        "monotonic_seconds": time.monotonic(),
                    },
                )
            )
            call["artifacts"].append(
                self._write(
                    directory,
                    "outer-dispatch-controls.json",
                    {
                        "requested_task_config": requested,
                        "forwarded_task_config": effective,
                        "return_version": 1,
                        "program": program,
                        "raise_error": raise_error,
                    },
                )
            )
            binding = {
                "run_id": self.run_id,
                "run_nonce": self.run_nonce,
                "evaluation_id": identity,
                "spec_hash": self.spec["spec_hash"],
                "contract_hash": self.contract["contract_hash"],
                "outer_input_sha256": hashlib.sha256(input_text.encode()).hexdigest(),
            }

            def retain_native(name: str, value: Any, raw: bool) -> None:
                call["artifacts"].append(self._write(directory, name, value, raw=raw))

            native_options = NativeOptionsObserver(
                psi4=self.psi4, outer=body, binding=binding, write=retain_native
            )
            with observer, native_options:
                self.psi4.set_num_threads(requested["ncores"])
                self.psi4.set_memory(expected_memory)
                controls("before")
                call["outer_forwarded"] = True
                result = observer.original_compute(
                    copied,
                    program,
                    raise_error=False,
                    return_version=1,
                    task_config=effective,
                )
                call["artifacts"].append(
                    self._write(directory, "outer-result.json", _raw_model(result), raw=True)
                )
                native_options.require_complete()
                controls("after")
            return result
        except BaseException as error:
            call["artifacts"].append(
                self._write(
                    directory,
                    "outer-exception.json",
                    {
                        "type": type(error).__name__,
                        "message": str(error),
                        "outer_forwarded": call["outer_forwarded"],
                    },
                )
            )
            raise
        finally:
            try:
                call["artifacts"].append(
                    self._write(
                        directory, "outer-forwarded-input-after.json", _raw_model(copied), raw=True
                    )
                )
                summary = directory / "nested/summary.json"
                call["nested_summary_present"] = summary.is_file()
                if summary.is_file():
                    raw = summary.read_bytes()
                    call["nested_summary"] = {
                        "path": summary.relative_to(self.root).as_posix(),
                        "sha256": hashlib.sha256(raw).hexdigest(),
                        "bytes": len(raw),
                    }
                self._write(directory, "dispatch-observation.json", call)
            finally:
                self.active = False
