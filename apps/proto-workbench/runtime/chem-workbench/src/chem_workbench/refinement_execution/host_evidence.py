"""Host-only, read-only run inventory and staged evidence assembly.

No scientific runtime imports or launches. A real supervisor supplies quiescence,
identity and approval context; worker reports cannot supply those observations.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import stat
import time
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from typing import Any, cast

from chem_workbench.refinement_execution.contract_result_evidence import (
    HostContext,
    digest,
    reference,
)

Record = dict[str, Any]
MAX_FILE = 20 * 1024**2
DISPATCH = re.compile(r"evaluation-([0-9]{4,})-dispatch")
RECORDER = re.compile(r"evaluation-[0-9]{4,}-(input|start|result|attempt|frame)\.json")
OPTIMIZER = re.compile(
    r"optimizer-([0-9]{4})-(before-start|after-start|after-step|after-convergence|"
    r"after-reevaluation|native-step-returned|native-step-exception|convergence)\.json"
)
AUXILIARY = frozenset(
    {
        "worker-result.json",
        "worker-lifecycle.json",
        "worker-failure.json",
        "optimizer-events.json",
        "optimizer-observation.json",
        "dispersion-preflight.json",
        "derivative-preflight.json",
        "molecule-preflight.json",
    }
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def copied(value: Any) -> Any:
    return json.loads(json.dumps(value, allow_nan=False))


def same(left: Any, right: Any, label: str) -> None:
    require(digest(left) == digest(right), label + " changed")


def fingerprint(value: os.stat_result) -> tuple[int, ...]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_nlink,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def handle_identity(value: os.stat_result) -> tuple[int, ...]:
    # Windows Python 3.13 path stat ctime is creation time; handle stat ctime is
    # change time. Compare birthtime explicitly, and compare ctime only within
    # the same API before/after. Keep inode/device/link/size/mtime exact.
    return (*fingerprint(value)[:-1], getattr(value, "st_birthtime_ns", 0))


def reserved(part: str) -> bool:
    stem = part.split(".", 1)[0].rstrip(" ").upper()
    return (
        stem in {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"}
        or re.fullmatch(r"(?:COM|LPT)[1-9\u00b9\u00b2\u00b3]", stem) is not None
        or any(ord(char) < 32 or char in '<>"|?*' for char in part)
    )


class ContainedReader:
    """Bounded stable reads, component lstat checks, and identity cross-checks.

    This detects observed races; it is not a replacement for a stopped JobObject
    and supervisor-owned directory ACLs against a hostile concurrent writer.
    """

    def __init__(self, root: Path, *, single_link_roots: Sequence[str] | None = None):
        self.root = root.absolute()
        self._components(self.root)
        require(self.root.is_dir(), "artifact root must exist")
        self._single_link_roots = None if single_link_roots is None else tuple(single_link_roots)
        for relative in self._single_link_roots or ():
            reference({"path": relative, "sha256": "0" * 64})

    @staticmethod
    def _components(path: Path) -> None:
        for item in (*reversed(path.parents), path):
            value = item.lstat()
            require(not stat.S_ISLNK(value.st_mode), "symlink refused: " + str(item))
            require(
                not getattr(value, "st_file_attributes", 0) & 0x400,
                "reparse point refused: " + str(item),
            )

    def path(self, relative: str) -> Path:
        reference({"path": relative, "sha256": "0" * 64})
        # Win32 aliases, ADS, reserved devices and case collisions are not paths.
        for part in relative.split("/"):
            require(
                not part.endswith((".", " ")) and not reserved(part),
                "noncanonical Windows artifact path",
            )
        path = self.root.joinpath(*relative.split("/"))
        self._components(path)
        require(path.resolve().is_relative_to(self.root.resolve()), "artifact escape")
        return path

    def raw(self, relative: str) -> bytes:
        path = self.path(relative)
        before = path.lstat()
        single_link = self._single_link_roots is None or any(
            relative.casefold().startswith(prefix.casefold() + "/")
            for prefix in self._single_link_roots
        )
        require(
            stat.S_ISREG(before.st_mode) and (not single_link or before.st_nlink == 1),
            "single-link regular file required",
        )
        require(0 <= before.st_size <= MAX_FILE, "artifact exceeds bounded read")
        with path.open("rb") as stream:
            opened = os.fstat(stream.fileno())
            require(handle_identity(before) == handle_identity(opened), "file replaced before open")
            raw = stream.read(MAX_FILE + 1)
            ended = os.fstat(stream.fileno())
        self._components(path)
        require(
            fingerprint(opened) == fingerprint(ended)
            and fingerprint(before) == fingerprint(path.lstat()),
            "file changed during read",
        )
        require(len(raw) == before.st_size and len(raw) <= MAX_FILE, "file size changed")
        return raw

    def ref(self, relative: str) -> Record:
        return {"path": relative, "sha256": hashlib.sha256(self.raw(relative)).hexdigest()}

    def __call__(self, value: Record) -> bytes:
        ref = reference(value)
        raw = self.raw(ref["path"])
        require(hashlib.sha256(raw).hexdigest() == ref["sha256"], "artifact hash changed")
        return raw

    def publish(self, directory: str, name: str, value: Record) -> Record:
        """Flush an exclusive temporary file; atomically publish without overwrite."""
        parent = self.path(directory)
        require(
            Path(name).name == name and "/" not in name and "\\" not in name,
            "publication must be a direct child",
        )
        require(
            name not in {".", ".."} and not name.endswith((".", " ")) and not reserved(name),
            "canonical publication filename required",
        )
        raw = (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + "\n").encode()
        require(len(raw) <= MAX_FILE, "host artifact exceeds bounded read")
        temporary = parent / (".pending-" + uuid.uuid4().hex)
        destination = parent / name
        with temporary.open("xb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            self._components(parent)
            # link is exclusive on Windows and POSIX, unlike POSIX rename/replace.
            os.link(temporary, destination)
        finally:
            temporary.unlink()
        observed = self.ref(directory + "/" + name)
        require(observed["sha256"] == hashlib.sha256(raw).hexdigest(), "published bytes changed")
        return observed


@dataclass(frozen=True, kw_only=True)
class Finalization:
    diagnostics_reference: Record
    inventory_reference: Record
    after_reference: Record | None
    host_context: HostContext | None
    evidence_reference: Record | None
    result_reference: Record | None
    scientific_result: Record | None


class HostEvidenceSession:
    """One host bracket. Inputs are detached; the session is never resumable.

    Construct and begin before launch, finalize only after owned processes stop.
    The injected validators and observations must be supervisor implementations.
    """

    def __init__(
        self,
        *,
        root: Path,
        run_directory: str,
        run_id: str,
        run_nonce: str,
        spec: Record,
        contract: Record,
        mode: str,
        worker_identity: Record,
        source_paths: Sequence[str],
        native_task_config: Record,
        native_dispersion_version: str,
        validate_spec: Callable[[object], Record],
        validate_contract: Callable[[object, object, str], Record],
        validate_result: Callable[[object, object], Record],
        observe_worker_identity: Callable[[], Record],
        assert_quiescent: Callable[[], None],
        auxiliary_names: Sequence[str] = (),
        max_inventory_files: int = 20000,
        max_inventory_bytes: int = 512 * 1024**2,
        max_inventory_entries: int = 40000,
        max_inventory_depth: int = 16,
    ):
        # Conda-installed, hash-bound basis files can legitimately be cache
        # hardlinks. New owned run evidence must have exactly one link.
        self.reader = ContainedReader(root, single_link_roots=(run_directory,))
        self._run = run_directory
        require(self.reader.path(run_directory).is_dir(), "owned run directory required")
        require(re.fullmatch(r"[A-Za-z0-9_.-]{1,120}", run_id) is not None, "run ID")
        require(re.fullmatch(r"[0-9a-f]{32,128}", run_nonce) is not None, "host run nonce")
        self._spec = copied(validate_spec(copied(spec)))
        same(self._spec, spec, "validated spec")
        self._contract = copied(validate_contract(copied(contract), copied(spec), mode))
        same(self._contract, contract, "validated contract")
        require(mode in {"gradient", "optimization"}, "explicit execution mode")
        self._mode = mode
        self._worker = copied(worker_identity)
        require(self._worker.get("kind") == "psi4_refinement", "refinement worker identity")
        require(
            bool(source_paths)
            and len(set(p.casefold() for p in source_paths)) == len(source_paths),
            "nonempty unique host source paths",
        )
        self._sources = tuple(source_paths)
        self._source: dict[str, str] = {}
        self._config = copied(native_task_config)
        require(
            set(self._config) == {"ncores", "memory", "retries", "scratch_directory"},
            "closed native task config",
        )
        require(
            type(self._config["retries"]) is int and self._config["retries"] == 0,
            "zero native retries",
        )
        require(
            type(self._config["ncores"]) is int
            and self._config["ncores"] == self._spec["resources"]["threads"],
            "bound native threads",
        )
        memory = self._config["memory"]
        require(
            type(memory) in {float, int}
            and math.isfinite(memory)
            and 0 < memory <= self._spec["resources"]["memory_bytes"] / 1024**3,
            "bound finite native memory",
        )
        require(
            isinstance(self._config["scratch_directory"], str)
            and PureWindowsPath(self._config["scratch_directory"])
            == PureWindowsPath(str(self.reader.root / run_directory / "scratch")),
            "scratch must be the owned run scratch root",
        )
        require(bool(native_dispersion_version), "observed native dispersion version")
        self._version = native_dispersion_version
        self._id, self._nonce = run_id, run_nonce
        self._identity = observe_worker_identity
        self._quiescent = assert_quiescent
        self._validate_result = validate_result
        require(
            type(max_inventory_files) is int and 0 < max_inventory_files <= 200000,
            "bounded inventory file count",
        )
        require(
            type(max_inventory_bytes) is int and 0 < max_inventory_bytes <= 2 * 1024**3,
            "bounded inventory byte count",
        )
        self._max_files, self._max_bytes = max_inventory_files, max_inventory_bytes
        require(
            type(max_inventory_entries) is int and 0 < max_inventory_entries <= 200000,
            "bounded inventory entry count",
        )
        require(
            type(max_inventory_depth) is int and 0 < max_inventory_depth <= 64,
            "bounded inventory nesting depth",
        )
        self._max_entries, self._max_depth = max_inventory_entries, max_inventory_depth
        self._aux = set(AUXILIARY)
        for name in auxiliary_names:
            reference({"path": name, "sha256": "0" * 64})
            require(
                "/" not in name
                and name not in {"scratch", "host-evidence"}
                and not name.startswith("evaluation-"),
                "host auxiliary direct child",
            )
            self._aux.add(name)
        self._host_dir = run_directory + "/host-evidence"
        self._host_refs: list[Record] = []
        self._last_inventory: Record = {}
        self._before: Record | None = None
        self._done = False

    def _write(self, name: str, body: Record) -> Record:
        ref = self.reader.publish(self._host_dir, name, body)
        self._host_refs.append(ref)
        return ref

    def _check_quiescent(self) -> None:
        require(self._quiescent() is None, "host quiescence verifier must return None or raise")

    def _verify_host_records(self) -> None:
        expected = {Path(item["path"]).name for item in self._host_refs}
        observed: set[str] = set()
        with os.scandir(self.reader.path(self._host_dir)) as entries:
            for item in entries:
                require(
                    item.name in expected and item.name not in observed,
                    "unexpected file in host evidence namespace",
                )
                observed.add(item.name)
        require(observed == expected, "missing host evidence file")
        for artifact in self._host_refs:
            self.reader(artifact)

    def _bindings(self) -> tuple[Record, dict[str, str]]:
        worker = copied(self._identity())
        source = {path: self.reader.ref(path)["sha256"] for path in self._sources}

        # The closed spec owns these expected hashes; the worker cannot choose them.
        def visit(value: object) -> None:
            if isinstance(value, dict):
                if {"path", "sha256"} <= value.keys():
                    self.reader({key: value[key] for key in ("path", "sha256")})
                for child in value.values():
                    visit(child)
            elif isinstance(value, list):
                for child in value:
                    visit(child)

        visit(self._spec)
        return worker, source

    def _bracket(
        self, phase: str, calls: list[Record], worker: Record, source: dict[str, str]
    ) -> Record:
        return {
            "version": "refinement-observer-host-bracket/v1",
            "phase": phase,
            "run_id": self._id,
            "run_nonce": self._nonce,
            "spec_hash": self._spec["spec_hash"],
            "contract_hash": self._contract["contract_hash"],
            "worker_identity": worker,
            "source_identity": source,
            "runtime_binding_hash": self._spec["runtime_binding"]["binding_hash"],
            "basis_binding_hash": self._spec["basis_binding"]["binding_hash"],
            "native_task_config": self._config,
            "native_dispersion_version": self._version,
            "monotonic_seconds": time.monotonic(),
            "call_artifacts": calls,
        }

    def _optimizer_artifact(self, name: str) -> bool:
        if self._mode != "optimization":
            return False
        if name in {"optimizer-effective-initial.json", "optimizer-final-reevaluation.json"}:
            return True
        matched = OPTIMIZER.fullmatch(name)
        return (
            matched is not None
            and int(matched[1]) < self._spec["optimizer_settings"]["maximum_iterations"]
        )

    def _inventory(self) -> Record:
        files: list[Record] = []
        directories: list[str] = []
        unknown: list[str] = []
        calls: list[Record] = []
        evaluation_dirs: list[str] = []
        excluded_metadata: list[Record] = []
        total = 0
        seen: set[str] = set()
        snapshot = {
            "files": files,
            "directories": directories,
            "call_artifacts": calls,
            "evaluation_directories": evaluation_dirs,
            "unknown_paths": unknown,
            "bytes_read": total,
            "excluded_subtrees": [self._run + "/scratch", self._host_dir],
            "excluded_subtree_metadata": excluded_metadata,
            "inventory_observed": True,
            "complete_scan": False,
        }
        self._last_inventory = snapshot

        def walk(relative: str, call: bool, depth: int) -> None:
            nonlocal total
            path = self.reader.path(relative)
            before = fingerprint(path.lstat())
            children: list[Path] = []
            # Path.iterdir() can pre-materialize all entries on Windows. Bound
            # lazy scandir enumeration BEFORE retaining/sorting any large list.
            with os.scandir(path) as entries:
                for entry in entries:
                    require(len(seen) < self._max_entries, "inventory entry budget exceeded")
                    key = (relative + "/" + entry.name).casefold()
                    require(key not in seen, "case-colliding inventory path")
                    seen.add(key)
                    children.append(Path(entry.path))
            children.sort(key=lambda p: p.name.casefold())
            for child in children:
                name = child.relative_to(self.reader.root).as_posix()
                checked = self.reader.path(name)
                value = checked.lstat()
                if stat.S_ISDIR(value.st_mode):
                    directories.append(name)
                    if relative == self._run and child.name in {"scratch", "host-evidence"}:
                        # Metadata only: scratch bytes are governed by the disk
                        # monitor, not represented as scientific call records.
                        excluded_metadata.append(
                            {
                                "path": name,
                                "device": value.st_dev,
                                "inode": value.st_ino,
                                "mode": value.st_mode,
                                "links": value.st_nlink,
                            }
                        )
                        continue
                    nested_call = call
                    if relative == self._run:
                        if DISPATCH.fullmatch(child.name):
                            nested_call = True
                            evaluation_dirs.append(name)
                        elif child.name not in self._aux:
                            unknown.append(name)
                    require(depth < self._max_depth, "inventory nesting depth exceeded")
                    walk(name, nested_call, depth + 1)
                else:
                    raw = self.reader.raw(name)
                    item = {"path": name, "sha256": hashlib.sha256(raw).hexdigest()}
                    total += len(raw)
                    snapshot["bytes_read"] = total
                    require(
                        len(files) < self._max_files and total <= self._max_bytes,
                        "inventory budget exceeded",
                    )
                    files.append({**item, "bytes": len(raw)})
                    if call:
                        calls.append(item)
                    elif (
                        relative == self._run
                        and child.name not in self._aux
                        and RECORDER.fullmatch(child.name) is None
                        and not self._optimizer_artifact(child.name)
                    ):
                        unknown.append(name)
            require(before == fingerprint(path.lstat()), "directory changed during inventory")

        walk(self._run, False, 0)
        snapshot["complete_scan"] = True
        return snapshot

    def begin(self) -> Record:
        require(self._before is None and not self._done, "host bracket is single use")
        self._check_quiescent()
        first = self._inventory()
        require(
            not first["call_artifacts"] and not first["evaluation_directories"],
            "cannot bracket preexisting dispatch observations",
        )
        require(not first["unknown_paths"], "unexpected run preparation files")
        require(
            not any(
                Path(item["path"]).name in AUXILIARY
                or RECORDER.fullmatch(Path(item["path"]).name)
                or self._optimizer_artifact(Path(item["path"]).name)
                for item in first["files"]
            ),
            "cannot bracket preexisting lifecycle/recorder/scientific artifacts",
        )
        worker, source = self._bindings()
        same(worker, self._worker, "worker identity before")
        self._check_quiescent()
        same(first, self._inventory(), "run preparation inventory")
        final_worker, final_source = self._bindings()
        same(worker, final_worker, "worker identity during preparation")
        same(source, final_source, "source identity during preparation")
        # Exclusive mkdir binds this session to a fresh host evidence namespace.
        (self.reader.path(self._run) / "host-evidence").mkdir()
        self._source = source
        self._before = self._write("before.json", self._bracket("before", [], worker, source))
        return cast(Record, copied(self._before))

    def _entries(self, inventory: Record, result: Record | None, errors: list[str]) -> list[Record]:
        refs = {
            item["path"]: {k: item[k] for k in ("path", "sha256")} for item in inventory["files"]
        }
        entries: list[Record] = []
        for index, directory in enumerate(inventory["evaluation_directories"]):
            try:
                require(
                    directory.endswith(f"/evaluation-{index:04d}-dispatch"),
                    "noncontiguous canonical evaluation directories",
                )

                def ref(name: str, owned: str = directory) -> Record | None:
                    return refs.get(owned + "/" + name)

                start_ref = ref("outer-start.json")
                request_ref = ref("outer-input.json")
                dispatch_ref = ref("dispatch-observation.json")
                require(
                    start_ref is not None and request_ref is not None and dispatch_ref is not None,
                    "missing mandatory outer/dispatch artifact",
                )
                assert start_ref is not None and request_ref is not None
                start = json.loads(self.reader(start_ref))
                require(
                    start["run_id"] == self._id
                    and start["run_nonce"] == self._nonce
                    and start["spec_hash"] == self._spec["spec_hash"]
                    and start["contract_hash"] == self._contract["contract_hash"],
                    "outer start differs from host context",
                )
                matched = []
                returned = ref("outer-result.json")
                if result is not None and returned is not None:
                    raw_input = self.reader(request_ref)
                    raw_return = self.reader(returned)
                    matched = [
                        frame
                        for frame in result["trajectory"]
                        if type(frame["evaluation_index"]) is int
                        and frame["evaluation_index"] == index
                        and frame["raw_input_artifact_id"] == f"evaluation-{index:04d}-input"
                        and frame["raw_result_artifact_id"] == f"evaluation-{index:04d}-result"
                        and frame["raw_input_json"].encode() == raw_input
                        and frame["raw_result_json"].encode() == raw_return
                    ]
                require(len(matched) <= 1, "ambiguous actual-byte frame association")
                entries.append(
                    {
                        "evaluation_id": start["evaluation_id"],
                        "attempt_index": index,
                        "frame_hash": matched[0]["frame_hash"] if matched else None,
                        "outer_start": start_ref,
                        "outer_request": request_ref,
                        "outer_return": returned,
                        "outer_exception": ref("outer-exception.json"),
                        "observer_directory": directory + "/nested",
                        "observer_summary": ref("nested/summary.json"),
                        "dispatch_observation": dispatch_ref,
                    }
                )
            except (ValueError, KeyError, TypeError, OSError) as error:
                errors.append(directory + ": " + str(error))
        return entries

    def finalize(self, *, optimizer_evidence_path: str | None = None) -> Finalization:
        require(self._before is not None and not self._done, "begin once before finalizing once")
        self._done = True
        self._last_inventory = {}
        errors: list[str] = []
        inventory: Record = {
            "files": [],
            "call_artifacts": [],
            "evaluation_directories": [],
            "inventory_observed": False,
            "complete_scan": False,
        }
        stable = False
        after: Record | None = None
        context: HostContext | None = None
        evidence_ref: Record | None = None
        result_ref: Record | None = None
        result: Record | None = None
        optimizer_ref: Record | None = None
        try:
            self._check_quiescent()
            self._verify_host_records()
            inventory = self._inventory()
            worker, source = self._bindings()
            same(worker, self._worker, "worker identity after")
            same(source, self._source, "source identity after")
            same(inventory, self._inventory(), "double host inventory")
            self._check_quiescent()
            same(inventory, self._inventory(), "inventory after quiescence check")
            require(not inventory["unknown_paths"], "unclassified files outside dispatch trees")
            stable = True
            after = self._write(
                "after.json", self._bracket("after", inventory["call_artifacts"], worker, source)
            )
            context = HostContext(
                run_id=self._id,
                run_nonce=self._nonce,
                run_directory=self._run,
                worker_identity=copied(self._worker),
                source_identity=dict(self._source),
                native_task_config=copied(self._config),
                native_dispersion_version=self._version,
                host_before=copied(self._before),
                host_after=after,
            )
        except (ValueError, TypeError, KeyError, OSError, RuntimeError) as error:
            if self._last_inventory:
                inventory = self._last_inventory
            errors.append("host inventory/binding: " + str(error))
        refs = {
            item["path"]: {k: item[k] for k in ("path", "sha256")} for item in inventory["files"]
        }
        try:
            result_ref = refs.get(self._run + "/worker-result.json")
            require(
                result_ref is not None, "scientific result absent; initialization/crash partial"
            )
            assert result_ref is not None
            raw_result = json.loads(self.reader(result_ref))
            result = copied(self._validate_result(copied(self._spec), raw_result))
            same(result, raw_result, "sealed scientific result")
            if optimizer_evidence_path is not None:
                require(self._mode == "optimization", "gradient has no optimizer evidence")
                optimizer_ref = refs.get(optimizer_evidence_path)
                require(
                    optimizer_ref is not None, "optimizer artifact not independently inventoried"
                )
                assert optimizer_ref is not None
                self.reader(optimizer_ref)
        except (ValueError, KeyError, TypeError, OSError) as error:
            result = None
            errors.append("scientific result/artifact: " + str(error))
        entries = self._entries(inventory, result, errors)
        if stable:
            try:
                self._check_quiescent()
                same(inventory, self._inventory(), "inventory before envelope publication")
                final_worker, final_source = self._bindings()
                same(final_worker, self._worker, "worker identity before envelope publication")
                same(final_source, self._source, "source identity before envelope publication")
                self._verify_host_records()
            except (ValueError, TypeError, KeyError, OSError, RuntimeError) as error:
                stable = False
                context = None
                errors.append("final host stability: " + str(error))
        # No syntactically valid envelope for missing mandatory records or unsafe inventories.
        if stable and not errors and result is not None and after is not None:
            body = {
                "version": "refinement-execution-evidence/v1",
                "run_id": self._id,
                "run_nonce": self._nonce,
                "contract_hash": self._contract["contract_hash"],
                "spec_hash": self._spec["spec_hash"],
                "result_hash": result["result_hash"],
                "host_before": self._before,
                "host_after": after,
                "evaluations": entries,
                "optimizer_evidence": optimizer_ref,
            }
            evidence_ref = self._write(
                "execution-evidence.json", {**body, "evidence_hash": digest(body)}
            )
        inventory_ref = self._write(
            "inventory.json",
            {
                "version": "refinement-host-file-inventory/v1",
                "run_id": self._id,
                "run_nonce": self._nonce,
                "stable_observation": stable,
                **inventory,
            },
        )
        diagnostics = self._write(
            "assembly.json",
            {
                "version": "refinement-host-evidence-assembly/v1",
                "run_id": self._id,
                "run_nonce": self._nonce,
                "host_before": self._before,
                "host_after": after,
                "inventory": inventory_ref,
                "result": result_ref,
                "evidence": evidence_ref,
                "evaluation_entries": entries,
                "errors": errors,
                "execution_evidence_admission": "unassessed",
                "scientific_accuracy_validated": False,
                "minimum_certified": False,
                "note": "Missing native returns remain missing. "
                "Only the actual validator decides coverage.",
            },
        )
        return Finalization(
            diagnostics_reference=diagnostics,
            inventory_reference=inventory_ref,
            after_reference=after,
            host_context=context,
            evidence_reference=evidence_ref,
            result_reference=result_ref,
            scientific_result=result,
        )
