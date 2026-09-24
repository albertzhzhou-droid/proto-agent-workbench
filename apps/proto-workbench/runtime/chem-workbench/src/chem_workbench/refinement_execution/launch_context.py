"""Host-owned launch sideband for the first-party refinement worker.

Only a supervisor that already reserved and approved the job may create this
record and construct its child's environment. A hash and a nonce bind that
transport; they are neither approval tokens nor protection from a malicious
process running under the same OS account. No native package is imported here.
Artifact, installed-code and runtime roots are separate, explicit inputs.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import stat
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass, replace
from pathlib import Path, PurePosixPath
from typing import Any

from chem_workbench.molecular_refinement import validate_refinement_spec
from chem_workbench.refinement_execution.disk_budget import DiskBudget, OwnedRunDirectory
from chem_workbench.refinement_execution.execution_contract import (
    validate_execution_contract,
    validate_worker_request,
)
from chem_workbench.refinement_execution.refinement_plan import (
    PlanContext,
    build_resolved_plan,
    content_hash,
)
from chem_workbench.refinement_execution.worker_subject_replay import artifact_ref

Record = dict[str, Any]
VERSION = "refinement-host-launch-context/v1"
CLAIM_VERSION = "refinement-host-launch-claim/v1"
ENV_PATH = "CHEM_REFINEMENT_CONTEXT_PATH"
ENV_SHA256 = "CHEM_REFINEMENT_CONTEXT_SHA256"
ENV_NONCE = "CHEM_REFINEMENT_CONTEXT_NONCE"
ENVIRONMENT_KEYS = frozenset({ENV_PATH, ENV_SHA256, ENV_NONCE})
MAX_BYTES = 20 * 1024**2
RESOURCE_FIELDS = {"wall_seconds", "memory_bytes", "cpu_seconds", "threads", "max_output_bytes"}
DISK_FIELDS = {
    "max_run_bytes",
    "max_entries",
    "minimum_free_bytes",
    "scan_timeout_seconds",
    "interval_seconds",
}
_FIELDS = {
    "version",
    "root",
    "code_root",
    "runtime_root",
    "job_id",
    "approval_id",
    "run_id",
    "run_nonce",
    "run_directory",
    "worker_identity",
    "source_identity",
    "plan_context",
    "resolved_plan_hash",
    "prepared_input_hash",
    "input_artifact",
    "output_path",
    "resource_policy",
    "native_task_config",
    "trusted_subject_admission_ref",
}


@dataclass(frozen=True, kw_only=True)
class HostLaunchContext:
    """Validated launch data, compatible with the lifecycle context protocol."""

    root: Path
    code_root: Path
    runtime_root: Path
    job_id: str
    approval_id: str
    run_id: str
    run_nonce: str
    run_directory: str
    worker_identity: Record
    source_identity: dict[str, str]
    plan_context: Record
    resolved_plan_hash: str
    prepared_input_hash: str
    input_artifact: Record
    output_path: str
    resource_policy: Record
    native_task_config: Record
    trusted_subject_admission_ref: Record
    sidecar_reference: Record
    claim_reference: Record | None = None


HostVerifier = Callable[[Record, HostLaunchContext], object]
HostPlanValidator = Callable[[Record, PlanContext], Record]


@dataclass(frozen=True, kw_only=True)
class LaunchSideband:
    context: HostLaunchContext
    environment: dict[str, str]


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError("HOST_LAUNCH_REJECTED: " + message)


def _same(actual: object, expected: object, label: str) -> None:
    _require(content_hash(actual) == content_hash(expected), label + " differs")


def _raw(value: object) -> bytes:
    raw = json.dumps(value, sort_keys=True, allow_nan=False, separators=(",", ":")).encode()
    _require(len(raw) <= MAX_BYTES, "bounded launch record required")
    return raw


def _parse(raw: bytes) -> Record:
    _require(len(raw) <= MAX_BYTES, "bounded JSON bytes required")

    def pairs(items: list[tuple[str, Any]]) -> Record:
        value: Record = {}
        for key, item in items:
            _require(key not in value, "duplicate JSON key")
            value[key] = item
        return value

    def constant(_value: str) -> None:
        raise ValueError("HOST_LAUNCH_REJECTED: nonfinite JSON constant")

    value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)
    _require(type(value) is dict, "JSON object required")
    result: Record = value
    return result


def _copy(value: Record) -> Record:
    return _parse(_raw(value))


def _relative(value: object) -> str:
    ref = artifact_ref({"path": value, "sha256": "0" * 64})
    result: str = ref["path"]
    return result


def _root(value: Path) -> Path:
    _require(isinstance(value, Path) and value.is_absolute(), "absolute explicit root required")
    _require(".." not in value.parts, "lexical root cannot contain parent traversal")
    for path in (*reversed(value.parents), value):
        info = path.lstat()
        _require(
            stat.S_ISDIR(info.st_mode)
            and not getattr(info, "st_file_attributes", 0) & 0x400
            and not stat.S_ISLNK(info.st_mode),
            "root has a linked or non-directory component",
        )
    return value


def _path(root: Path, relative: str) -> Path:
    _root(root)
    target = root / _relative(relative)
    _root(target.parent)
    return target


def _metadata(info: os.stat_result) -> tuple[int, int, int, int]:
    _require(
        stat.S_ISREG(info.st_mode)
        and info.st_nlink == 1
        and info.st_ino != 0
        and not getattr(info, "st_file_attributes", 0) & 0x400,
        "regular single-link file required",
    )
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def _read(root: Path, reference: object) -> bytes:
    ref = artifact_ref(reference)
    path = _path(root, ref["path"])
    before = _metadata(path.lstat())
    _require(before[2] <= MAX_BYTES, "file exceeds bounded input size")
    with path.open("rb") as stream:
        _same(_metadata(os.fstat(stream.fileno())), before, "open file identity")
        raw = stream.read(before[2] + 1)
        _same(_metadata(os.fstat(stream.fileno())), before, "read file identity")
    _same(_metadata(path.lstat()), before, "file after read")
    _root(path.parent)
    _require(len(raw) == before[2], "file length changed during read")
    _require(hashlib.sha256(raw).hexdigest() == ref["sha256"], "raw artifact hash differs")
    return raw


def _write_new(root: Path, relative: str, body: Record) -> Record:
    raw = _raw(body)
    path = _path(root, relative)
    with path.open("xb", buffering=0) as stream:
        identity = _metadata(os.fstat(stream.fileno()))[:2]
        if stream.write(raw) != len(raw):
            raise OSError("HOST_LAUNCH_REJECTED: incomplete exclusive sideband write")
        os.fsync(stream.fileno())
        _same(_metadata(path.lstat())[:2], identity, "created file identity")
    ref = {"path": relative, "sha256": hashlib.sha256(raw).hexdigest()}
    _require(_read(root, ref) == raw, "created sideband bytes changed")
    return ref


def _sidecar(run_directory: str) -> str:
    path = PurePosixPath(_relative(run_directory))
    return str(path.parent / ("." + path.name + "-refinement-launch.json"))


def _claim_path(sidecar: str) -> str:
    return sidecar.removesuffix(".json") + ".claimed.json"


def _plan(plan: Record, request: Record) -> Record:
    """Replay data bindings only; full subject admission remains a separate verifier."""
    version = plan.get("version")
    _require(
        version in {"resolved-refinement-plan/v1", "governed-refinement-plan/v1"},
        "supported independently supplied plan required",
    )

    def subject_binding(subject: Record, spec: Record) -> None:
        _same(content_hash(subject), plan.get("subject_content_hash"), "subject content hash")
        _same(spec, request["spec"], "bound subject spec")

    core = build_resolved_plan(
        PlanContext(
            subject=plan["subject"],
            spec=request["spec"],
            worker_identity=plan["worker"],
            mode=request["mode"],
            resource_policy=plan["resource_ceilings"],
            validate_spec=validate_refinement_spec,
            validate_subject_spec=subject_binding,
            execution_contract=request["execution_contract"],
            validate_contract=validate_execution_contract,
        )
    )
    if version == "resolved-refinement-plan/v1":
        _same(plan, core, "core plan replay")
        return core
    refs = plan.get("artifact_refs")
    _require(
        type(refs) is dict and set(refs) == {"spec", "subject", "execution_contract"},
        "exact governed artifact refs required",
    )
    assert isinstance(refs, dict)
    for ref in refs.values():
        artifact_ref(ref)
    disk = plan.get("disk_budget")
    _require(type(disk) is dict and set(disk) == DISK_FIELDS, "exact governed disk policy")
    assert isinstance(disk, dict)
    DiskBudget(**disk).validate()
    body = {key: value for key, value in core.items() if key != "resolved_plan_hash"}
    body.update(
        {
            "version": version,
            "artifact_refs": refs,
            "disk_budget": disk,
            "core_plan_hash": core["resolved_plan_hash"],
            "core_logical_plan_hash": core["logical_plan_hash"],
            "logical_plan_hash": content_hash(
                {
                    "core_logical_plan_hash": core["logical_plan_hash"],
                    "artifact_refs": refs,
                    "disk_budget": disk,
                }
            ),
        }
    )
    expected = {**body, "resolved_plan_hash": content_hash(body)}
    _same(plan, expected, "governed plan replay")
    return expected


def _record(context: HostLaunchContext) -> Record:
    return _copy(
        {
            "version": VERSION,
            **{key: str(getattr(context, key)) for key in ("root", "code_root", "runtime_root")},
            **{
                key: getattr(context, key)
                for key in _FIELDS - {"version", "root", "code_root", "runtime_root"}
            },
        }
    )


def _context(record: Record, sidecar: Record, claim: Record | None = None) -> HostLaunchContext:
    _require(set(record) == _FIELDS and record["version"] == VERSION, "exact sideband schema")
    values = {key: value for key, value in _copy(record).items() if key != "version"}
    for key in ("root", "code_root", "runtime_root"):
        _require(type(values[key]) is str, "explicit serialized root required")
        values[key] = Path(values[key])
    return HostLaunchContext(**values, sidecar_reference=_copy(sidecar), claim_reference=claim)


def _validate(context: HostLaunchContext, request: Record) -> None:
    checked = validate_worker_request(request)
    for path in (context.root, context.code_root, context.runtime_root):
        _root(path)
    for identifier in (context.job_id, context.run_id):
        _require(
            type(identifier) is str
            and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,100}", identifier) is not None,
            "bounded host job/run identifier required",
        )
    _require(
        type(context.approval_id) is str
        and re.fullmatch(r"sha256:[0-9a-f]{64}", context.approval_id) is not None,
        "opaque approval binding required; never send the approval token",
    )
    _require(
        type(context.run_nonce) is str
        and re.fullmatch(r"[0-9a-f]{64}", context.run_nonce) is not None,
        "host-generated nonce required",
    )
    owned = OwnedRunDirectory.capture(context.root, _relative(context.run_directory))
    plan = _plan(context.plan_context, checked)
    _same(context.worker_identity, plan["worker"], "worker identity")
    _same(context.resolved_plan_hash, plan["resolved_plan_hash"], "resolved plan hash")
    _same(context.prepared_input_hash, content_hash(checked), "canonical prepared request")
    _same(context.resource_policy, plan["resource_ceilings"], "resource policy")
    _same(
        context.resource_policy,
        {key: checked["spec"]["resources"][key] for key in RESOURCE_FIELDS},
        "spec supervisor resources",
    )
    expected_config = {
        "ncores": context.resource_policy["threads"],
        "memory": context.resource_policy["memory_bytes"] / 1024**3 * 0.6,
        "retries": 0,
        "scratch_directory": str(owned.path / "scratch"),
    }
    _same(context.native_task_config, expected_config, "native resource configuration")
    _require(
        context.runtime_root == Path(context.worker_identity["environment"]["prefix"]),
        "host worker runtime root differs",
    )
    _same(context.output_path, context.run_directory + "/worker-result.json", "worker output path")
    input_ref = artifact_ref(context.input_artifact)
    actual = validate_worker_request(_parse(_read(context.root, input_ref)))
    _same(actual, checked, "actual prepared input bytes")
    _same(plan["prepared_input"], checked, "plan prepared request")
    if plan["version"] == "governed-refinement-plan/v1":
        for role, value in (
            ("spec", checked["spec"]),
            ("subject", plan["subject"]),
            ("execution_contract", checked["execution_contract"]),
        ):
            _same(
                _parse(_read(context.root, plan["artifact_refs"][role])),
                value,
                "governed " + role + " artifact",
            )
    admission = _parse(_read(context.root, context.trusted_subject_admission_ref))
    _same(admission.get("spec_hash"), checked["spec"]["spec_hash"], "host subject admission spec")
    sources = context.source_identity
    _require(type(sources) is dict and 0 < len(sources) <= 4096, "bounded source identity required")
    _require(len({key.casefold() for key in sources}) == len(sources), "aliased source paths")
    total = 0
    for relative, digest in sources.items():
        total += len(_read(context.code_root, {"path": relative, "sha256": digest}))
        _require(total <= 128 * 1024**2, "source verification exceeds total byte cap")
    owned.verify()


def _call_verifier(callback: HostVerifier, request: Record, context: HostLaunchContext) -> None:
    _require(callable(callback), "independent host verifier required")
    before = _record(context)
    argument = _copy(request)
    result = callback(argument, context)
    _require(result is None, "host verifier must return None or raise")
    _same(argument, request, "host verifier request mutation")
    _same(_record(context), before, "host verifier context mutation")


def create_launch_context(
    *,
    root: Path,
    code_root: Path,
    runtime_root: Path,
    job_id: str,
    approval_id: str,
    run_id: str,
    run_directory: str,
    plan: Record,
    plan_context: PlanContext,
    input_artifact: Record,
    trusted_subject_admission_ref: Record,
    source_identity: dict[str, str],
    native_task_config: Record,
    validate_host_plan: HostPlanValidator,
    verify_host_admission: HostVerifier,
) -> LaunchSideband:
    """Create only after a host reservation; callbacks are never read from JSON.

    ``approval_id`` is a host-computed opaque sha256 binding, not its approval
    token. The verifier must independently verify the reservation and approval.
    Failed writes remain exclusive partial artifacts, never reusable launches.
    """
    _require(callable(validate_host_plan), "host plan validator required")
    frozen = _copy(plan)
    _same(validate_host_plan(_copy(frozen), plan_context), frozen, "host plan validation")
    request = validate_worker_request(frozen["prepared_input"])
    relative = _sidecar(run_directory)
    context = HostLaunchContext(
        root=root,
        code_root=code_root,
        runtime_root=runtime_root,
        job_id=job_id,
        approval_id=approval_id,
        run_id=run_id,
        run_nonce=secrets.token_hex(32),
        run_directory=run_directory,
        worker_identity=_copy(frozen["worker"]),
        source_identity=dict(source_identity),
        plan_context=frozen,
        resolved_plan_hash=frozen["resolved_plan_hash"],
        prepared_input_hash=frozen["prepared_input_hash"],
        input_artifact=_copy(input_artifact),
        output_path=run_directory + "/worker-result.json",
        resource_policy=_copy(frozen["resource_ceilings"]),
        native_task_config=_copy(native_task_config),
        trusted_subject_admission_ref=_copy(trusted_subject_admission_ref),
        sidecar_reference={"path": relative, "sha256": "0" * 64},
    )
    _validate(context, request)
    _call_verifier(verify_host_admission, request, context)
    _validate(context, request)
    reference = _write_new(root, relative, _record(context))
    context = replace(context, sidecar_reference=reference)
    return LaunchSideband(
        context=context,
        environment={
            ENV_PATH: reference["path"],
            ENV_SHA256: reference["sha256"],
            ENV_NONCE: context.run_nonce,
        },
    )


def _claim(context: HostLaunchContext) -> Record:
    return {
        "version": CLAIM_VERSION,
        "job_id": context.job_id,
        "run_id": context.run_id,
        "run_nonce": context.run_nonce,
        "sidecar_reference": context.sidecar_reference,
        "input_artifact": context.input_artifact,
    }


def verify_launch_context(request: Record, context: HostLaunchContext) -> None:
    """Recheck an already consumed launch for lifecycle admission; no new claim."""
    _same(context.sidecar_reference["path"], _sidecar(context.run_directory), "sidecar path")
    record = _parse(_read(context.root, context.sidecar_reference))
    _same(record, _record(context), "sideband context")
    _require(context.claim_reference is not None, "one-time worker launch claim required")
    assert context.claim_reference is not None
    _same(
        context.claim_reference["path"],
        _claim_path(context.sidecar_reference["path"]),
        "claim path",
    )
    _same(_parse(_read(context.root, context.claim_reference)), _claim(context), "launch claim")
    _validate(context, request)


def verify_launch_sideband(
    sideband: LaunchSideband,
    *,
    root: Path,
    code_root: Path,
    runtime_root: Path,
    input_path: Path,
    output_path: Path,
    request: Record,
    disk_budget: DiskBudget,
) -> None:
    """Host pre-Popen recheck, without consuming the worker's one-time claim.

    This checks an already approved typed sideband; it does not issue, renew or
    consume host approval. Only the host supervisor may use the resulting three
    environment values. Recheck does not remove the need for exclusive job ownership.
    """
    _require(type(sideband) is LaunchSideband, "typed host launch sideband required")
    context = sideband.context
    _require(type(context) is HostLaunchContext, "typed host launch context required")
    _require(context.claim_reference is None, "worker launch already consumed")
    _require(type(disk_budget) is DiskBudget, "typed host disk budget required")
    disk_budget.validate()
    _require(type(sideband.environment) is dict, "controlled environment mapping required")
    _same(
        sideband.environment,
        {
            ENV_PATH: context.sidecar_reference["path"],
            ENV_SHA256: context.sidecar_reference["sha256"],
            ENV_NONCE: context.run_nonce,
        },
        "three host launch environment values",
    )
    for actual, expected in (
        (context.root, root),
        (context.code_root, code_root),
        (context.runtime_root, runtime_root),
    ):
        _require(actual == expected, "independent root differs")
    _require(input_path == root / context.input_artifact["path"], "actual input argv path differs")
    _require(output_path == root / context.output_path, "actual output argv path differs")
    _same(context.sidecar_reference["path"], _sidecar(context.run_directory), "fixed sidecar path")
    _same(context.plan_context.get("disk_budget"), asdict(disk_budget), "approved host disk budget")
    claim_path = _path(root, _claim_path(context.sidecar_reference["path"]))

    def unclaimed() -> None:
        try:
            claim_path.lstat()
        except FileNotFoundError:
            return
        raise ValueError("HOST_LAUNCH_REJECTED: worker launch claim already exists")

    unclaimed()
    _same(_parse(_read(root, context.sidecar_reference)), _record(context), "sideband context")
    _validate(context, request)
    unclaimed()


def load_launch_context(
    *,
    root: Path,
    code_root: Path,
    runtime_root: Path,
    input_path: Path,
    output_path: Path,
    request: Record,
    environment: Mapping[str, str],
    verify_host_admission: HostVerifier,
) -> HostLaunchContext:
    """Consume independent controlled environment once, before any native import.

    Explicit roots and argv paths are supplied by first-party worker code. The
    environment is not taken from request fields. A same-account actor that can
    replace the whole launch/environment can replace this binding too.
    """
    present = {key for key in environment if key.upper().startswith("CHEM_REFINEMENT_CONTEXT_")}
    _require(present == ENVIRONMENT_KEYS, "exact controlled sideband environment required")
    ref = artifact_ref({"path": environment[ENV_PATH], "sha256": environment[ENV_SHA256]})
    record = _parse(_read(root, ref))
    context = _context(record, ref)
    for actual, expected in (
        (context.root, root),
        (context.code_root, code_root),
        (context.runtime_root, runtime_root),
    ):
        _require(actual == expected, "independent root differs")
    _same(context.run_nonce, environment[ENV_NONCE], "independent launch nonce")
    _same(ref["path"], _sidecar(context.run_directory), "fixed sidecar path")
    _require(input_path == root / context.input_artifact["path"], "actual input argv path differs")
    _require(output_path == root / context.output_path, "actual output argv path differs")
    _validate(context, request)
    _call_verifier(verify_host_admission, request, context)
    _validate(context, request)
    _same(_parse(_read(root, ref)), record, "sideband changed during admission")
    claim = _write_new(root, _claim_path(ref["path"]), _claim(context))
    context = replace(context, claim_reference=claim)
    verify_launch_context(request, context)
    return context
