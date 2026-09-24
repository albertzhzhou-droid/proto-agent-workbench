"""Host refinement planning: no dispatch, approval issuance, or scientific imports.

Injected validators must authenticate the subject/spec/contract before returning.
The host must obtain these dependencies and observations, never accept them from
a model or worker. Hashes detect changes; they do not grant execution authority.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

Record = dict[str, Any]
SpecValidator = Callable[[object], Record]
SubjectValidator = Callable[[Record, Record], None]
ContractValidator = Callable[[Record, Record, str], object]
ResultValidator = Callable[[object, object], Record]
ContractResultValidator = Callable[[Record, Record, str, Record], None]
ArtifactReader = Callable[[Record], bytes]

PLAN_VERSION = "resolved-refinement-plan/v1"
LIMITS = {
    "wall_seconds": 86400,
    "memory_bytes": 16 * 1024**3,
    "cpu_seconds": 86400,
    "threads": 8,
    "max_output_bytes": 20 * 1024**2,
}
RUNNER_STATES = {"succeeded", "failed", "timeout", "cancelled", "interrupted", "output_limit"}


def content_hash(value: object) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _copy(value: object) -> Any:
    return json.loads(json.dumps(value, allow_nan=False))


def _object(value: object, name: str) -> Record:
    if not isinstance(value, dict):
        raise ValueError("INVALID_ARGUMENT: object required: " + name)
    return dict(value)


def _equal(actual: object, expected: object, name: str) -> None:
    if content_hash(actual) != content_hash(expected):
        raise ValueError("APPROVAL_STALE: " + name + " differs")


def _sealed(value: Record, field: str) -> None:
    _equal(value.get(field), content_hash({k: v for k, v in value.items() if k != field}), field)


@dataclass(frozen=True, kw_only=True)
class PlanContext:
    """Independent host inputs, re-obtained at prepare/approve/launch boundaries.

    Frozen attributes do not make nested dicts immutable. Each public operation
    detaches and revalidates them; do not derive this context from an untrusted plan.
    """

    subject: Record
    spec: Record
    worker_identity: Record
    mode: str
    resource_policy: Record
    validate_spec: SpecValidator
    validate_subject_spec: SubjectValidator
    execution_contract: Record | None = None
    validate_contract: ContractValidator | None = None


def build_resolved_plan(context: PlanContext) -> Record:
    spec = _copy(context.spec)
    _equal(context.validate_spec(_copy(spec)), spec, "validated spec")
    _sealed(spec, "spec_hash")
    subject = _copy(context.subject)
    if not isinstance(subject, dict) or not subject:
        raise ValueError("INVALID_ARGUMENT: validated subject closure required")
    context.validate_subject_spec(_copy(subject), _copy(spec))
    if context.mode not in {"gradient", "optimization"}:
        raise ValueError("INVALID_ARGUMENT: refinement mode")
    resources = _copy(context.resource_policy)
    if not isinstance(resources, dict) or set(resources) != set(LIMITS):
        raise ValueError("INVALID_ARGUMENT: exact supervisor resource policy required")
    for key, maximum in LIMITS.items():
        if type(resources[key]) is not int or not 1 <= resources[key] <= maximum:
            raise ValueError("INVALID_ARGUMENT: refinement resource outside host limit: " + key)
    _equal(resources, {key: spec["resources"][key] for key in LIMITS}, "spec resources")
    worker = _copy(context.worker_identity)
    if (
        not isinstance(worker, dict)
        or worker.get("kind") != "psi4_refinement"
        or worker.get("script") != "worker_refinement_psi4.py"
    ):
        raise ValueError("INVALID_ARGUMENT: host refinement worker identity required")
    contract = _copy(context.execution_contract)
    if contract is None:
        if context.mode != "gradient":
            raise ValueError(
                "UNSUPPORTED_PROFILE: legacy request permits gradient observation only"
            )
        request = {"version": "refinement-worker-request/v1", "mode": context.mode, "spec": spec}
    else:
        if not isinstance(contract, dict) or context.validate_contract is None:
            raise ValueError("INVALID_ARGUMENT: execution contract validator required")
        context.validate_contract(_copy(contract), _copy(spec), context.mode)
        request = {
            "version": "refinement-worker-request/v2",
            "mode": context.mode,
            "spec": spec,
            "execution_contract": contract,
        }
    logical = {
        "subject": subject,
        "spec": spec,
        "mode": context.mode,
        "resource_policy": resources,
        "execution_contract": contract,
    }
    plan = {
        "version": PLAN_VERSION,
        "kind": "molecular_refinement",
        "subject": subject,
        "subject_content_hash": content_hash(subject),
        "logical_plan_hash": content_hash(logical),
        "spec": spec,
        "mode": context.mode,
        "execution_contract": contract,
        "method_profile_id": spec["profile"]["profile_id"],
        "worker": worker,
        "resource_ceilings": resources,
        "allowed_actions": ["execute"],
        "acceptance": {
            "mode": context.mode,
            "authority": "existing_host_approval_required",
            "minimum_certification": "not_evaluated",
            "legacy_request_scope": "gradient_observation_only" if contract is None else None,
        },
        "prepared_input": request,
        "prepared_input_hash": content_hash(request),
    }
    return {**plan, "resolved_plan_hash": content_hash(plan)}


def validate_plan(plan: Record, context: PlanContext) -> Record:
    """Re-derive against independent context, including all rehashed conflicts."""
    expected = build_resolved_plan(context)
    _equal(plan, expected, "resolved refinement plan and host context")
    return expected


def prepared_input(plan: Record, context: PlanContext) -> Record:
    return _object(validate_plan(plan, context)["prepared_input"], "prepared input")


def _reference(value: Record) -> Record:
    reference = {key: value.get(key) for key in ("path", "sha256")}
    path, digest = reference["path"], reference["sha256"]
    if (
        not isinstance(path, str)
        or not path
        or "\\" in path
        or ":" in path
        or path.startswith("/")
        or any(part in {"", ".", ".."} for part in path.split("/"))
        or not isinstance(digest, str)
        or re.fullmatch("[0-9a-f]{64}", digest) is None
    ):
        raise ValueError("INVALID_ARGUMENT: contained raw artifact reference required")
    return reference


def _json_bytes(raw: bytes) -> Record:
    def pairs(items: list[tuple[str, Any]]) -> Record:
        result: Record = {}
        for key, value in items:
            if key in result:
                raise ValueError("INVALID_TOOL_OUTPUT: duplicate JSON key")
            result[key] = value
        return result

    def constant(value: str) -> None:
        raise ValueError("INVALID_TOOL_OUTPUT: nonfinite JSON constant: " + value)

    return _object(
        json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant),
        "raw JSON artifact",
    )


def admit_result(
    plan: Record,
    context: PlanContext,
    *,
    runner: Record,
    observed_worker_identity: Record,
    input_artifact: Record,
    output_artifact: Record | None,
    retained_artifacts: list[Record],
    read_artifact: ArtifactReader,
    validate_result: ResultValidator,
    validate_contract_result: ContractResultValidator | None = None,
) -> Record:
    """Classify retained evidence; never launch or fabricate a scientific envelope.

    Reader must enforce realpath/reparse containment and return the actual file
    bytes. This helper independently checks their hashes. The runner observation
    and current worker identity must come from the host supervisor, not output JSON.
    Host approval, registration, ownership, expiry and launch budgets stay outside.
    """
    plan = validate_plan(plan, context)
    runner = _copy(runner)
    _equal(observed_worker_identity, plan["worker"], "observed worker")
    _equal(runner.get("resource_limits"), plan["resource_ceilings"], "runner resources")
    status = runner.get("status")
    code = runner.get("returncode")
    if (
        status not in RUNNER_STATES
        or (code is not None and type(code) is not int)
        or (status == "succeeded" and code != 0)
    ):
        raise ValueError("INVALID_ARGUMENT: terminal host runner observation required")
    if not isinstance(retained_artifacts, list) or len(retained_artifacts) > 16010:
        raise ValueError("INVALID_ARGUMENT: bounded retained artifact inventory required")
    errors: list[str] = []
    observations: list[Record] = []
    cache: dict[str, tuple[Record, bytes]] = {}

    def read(reference: Record, label: str) -> bytes:
        ref = _reference(_object(reference, "artifact reference"))
        key = ref["path"].casefold()
        if key in cache:
            _equal(ref, cache[key][0], "reused artifact reference")
            return cache[key][1]
        raw = read_artifact(_copy(ref))
        if type(raw) is not bytes:
            raise ValueError("INVALID_TOOL_OUTPUT: artifact reader must return actual bytes")
        actual = hashlib.sha256(raw).hexdigest()
        observations.append(
            {"reference": ref, "observed_sha256": actual, "bytes": len(raw), "role": label}
        )
        if actual != ref["sha256"]:
            raise ValueError("EVIDENCE_CORRUPT: raw artifact hash differs: " + ref["path"])
        cache[key] = (ref, raw)
        return raw

    def failure(label: str, error: Exception) -> None:
        errors.append(label + ": " + type(error).__name__ + ": " + str(error)[:600])

    try:
        raw_input = read(input_artifact, "worker_input")
        if len(raw_input) > 20 * 1024**2:
            raise ValueError("RESOURCE_LIMIT: input record exceeds worker cap")
        _equal(_json_bytes(raw_input), plan["prepared_input"], "actual prepared input bytes")
    except (OSError, ValueError, TypeError, KeyError) as error:
        failure("input_authentication", error)
    scientific: Record | None = None
    if output_artifact is not None:
        try:
            raw_output = read(output_artifact, "worker_output")
            if len(raw_output) > plan["resource_ceilings"]["max_output_bytes"]:
                raise ValueError("RESOURCE_LIMIT: output record exceeds approved cap")
            raw_result = _json_bytes(raw_output)
            scientific = validate_result(_copy(plan["spec"]), _copy(raw_result))
            _equal(scientific, raw_result, "validated raw scientific result")
            scientific = _copy(scientific)
        except (OSError, ValueError, TypeError, KeyError) as error:
            scientific = None
            failure("result_validation", error)
    else:
        errors.append("NO_SEALED_RESULT: retain available raw files without synthesizing a result")
    refs = _copy(retained_artifacts)
    if scientific is not None:
        refs.extend(scientific["raw_artifacts"])
    for reference in refs:
        try:
            read(reference, "retained_raw")
        except (OSError, ValueError, TypeError, KeyError) as error:
            failure("artifact_authentication", error)
    authenticated = not errors
    mode_complete = False
    if scientific is not None:
        frames = scientific["trajectory"]
        convergence = scientific["convergence"]
        if plan["execution_contract"] is not None:
            try:
                if validate_contract_result is None:
                    raise ValueError("EXECUTION_CONTRACT_RESULT_VALIDATOR_REQUIRED")
                validate_contract_result(
                    _copy(plan["execution_contract"]),
                    _copy(plan["spec"]),
                    plan["mode"],
                    _copy(scientific),
                )
            except (OSError, ValueError, TypeError, KeyError) as error:
                failure("execution_contract_admission", error)
        if plan["mode"] == "gradient":
            mode_complete = (
                len(frames) == 1
                and scientific["state"] == "incomplete"
                and scientific["failure"] is None
                and frames[0]["step_status"] == "unknown"
                and convergence["geometry_status"] == "not_checked"
                and convergence["optimizer_reported_converged"] is None
                and convergence["optimizer_observation_json"] is None
            )
        else:
            accepted = [f for f in frames if f["step_status"] in {"initial", "accepted"}]
            mode_complete = (
                plan["execution_contract"] is not None
                and scientific["state"] == "succeeded"
                and scientific["failure"] is None
                and len(accepted) >= 2
                and frames[-1]["step_status"] == "reevaluation"
                and frames[-1]["reevaluates_frame_hash"] == accepted[-1]["frame_hash"]
                and convergence["geometry_status"] == "satisfied"
                and convergence["optimizer_reported_converged"] is True
            )
        if not mode_complete:
            errors.append("MODE_INCOMPLETE: result does not complete the bound " + plan["mode"])
        if scientific["evidence_origin"] != "worker_record":
            errors.append(
                "ACTUAL_WORKER_ORIGIN_REQUIRED: retain non-worker record without promotion"
            )
        mode_complete = (
            mode_complete
            and convergence["minimum_status"] == "not_evaluated"
            and scientific["evidence_origin"] == "worker_record"
            and not errors
            and status == "succeeded"
        )
    body = {
        "version": "refinement-lifecycle-admission/v1",
        "resolved_plan_hash": plan["resolved_plan_hash"],
        "mode": plan["mode"],
        "runner": runner,
        "execution_status": "succeeded"
        if mode_complete
        else status
        if status != "succeeded"
        else "failed",
        "scientific_state": scientific["state"] if scientific is not None else None,
        "mode_completed": mode_complete,
        "completion_scope": "legacy_single_gradient_observation_only"
        if plan["execution_contract"] is None
        else "bound_execution_contract",
        "scientific_result": scientific,
        "scientific_record_valid": scientific is not None,
        "artifacts_authenticated": authenticated,
        "observed_worker_identity": _copy(observed_worker_identity),
        "input_artifact": _copy(input_artifact),
        "output_artifact": _copy(output_artifact),
        "retained_artifacts": _copy(retained_artifacts),
        "artifact_observations": observations,
        "admission_errors": errors,
        "minimum_certified": False,
        "scientific_accuracy_validated": False,
        "authority": "existing_host_approval_required",
    }
    return {**body, "admission_hash": content_hash(body)}
