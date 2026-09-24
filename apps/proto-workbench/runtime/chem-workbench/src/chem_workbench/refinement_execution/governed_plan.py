"""Rebuild host refinement plans from retained artifacts and observed worker identity.

This facade validates the retained Design graph/source closure, spec and execution
contract. It never issues approval, authenticates a caller, launches a worker or
claims that referenced scientific runtimes/bases are currently available. The host
store must pin the returned outer hash; launch must separately verify native
artifacts and retain an independently authenticated host subject admission.
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict
from pathlib import Path
from typing import Any, cast

from chem_workbench.molecular_refinement import MAX_RECORD_BYTES, validate_refinement_spec
from chem_workbench.refinement_execution import refinement_plan
from chem_workbench.refinement_execution.disk_budget import DiskBudget
from chem_workbench.refinement_execution.execution_contract import validate_execution_contract
from chem_workbench.refinement_execution.refinement_subject import (
    SUBJECT_VERSION,
    verify_design_subject_for_spec,
)
from chem_workbench.refinement_execution.worker_subject_replay import (
    artifact_ref,
    load_json,
    read_bound,
)

Record = dict[str, Any]
PLAN_VERSION = "governed-refinement-plan/v1"
_REF_KEYS = {"spec", "subject", "execution_contract"}
_DISK_KEYS = {
    "max_run_bytes",
    "max_entries",
    "minimum_free_bytes",
    "scan_timeout_seconds",
    "interval_seconds",
}


def _json_value(value: object, depth: int = 0) -> None:
    if depth > 128:
        raise ValueError("RESOURCE_LIMIT: plan JSON exceeds depth 128")
    if value is None or type(value) in (str, bool, int):
        return
    if type(value) is float and math.isfinite(value):
        return
    if type(value) is list:
        for item in value:
            _json_value(item, depth + 1)
        return
    if type(value) is dict and all(type(key) is str for key in value):
        for item in value.values():
            _json_value(item, depth + 1)
        return
    raise ValueError("INVALID_ARGUMENT: finite JSON values and string object keys required")


def _object(value: object) -> Record:
    if type(value) is not dict:
        raise ValueError("INVALID_ARGUMENT: plan JSON object required")
    _json_value(value)
    raw = json.dumps(value, allow_nan=False, separators=(",", ":")).encode()
    if len(raw) > MAX_RECORD_BYTES:
        raise ValueError("RESOURCE_LIMIT: plan exceeds 20 MiB")
    return cast(Record, json.loads(raw))


def _equal(left: object, right: object, label: str) -> None:
    if refinement_plan.content_hash(left) != refinement_plan.content_hash(right):
        raise ValueError("APPROVAL_STALE: " + label + " differs")


def _disk(value: object) -> Record:
    raw = asdict(value) if type(value) is DiskBudget else _object(value)
    if set(raw) != _DISK_KEYS:
        raise ValueError("INVALID_ARGUMENT: exact five-field disk budget required")
    budget = DiskBudget(**raw)
    budget.validate()
    return _object(raw)


def context_from_artifacts(
    root: Path,
    spec_ref: object,
    subject_ref: object,
    execution_contract_ref: object,
    mode: str,
    observed_worker_identity: object,
) -> refinement_plan.PlanContext:
    """Read and validate an actual Design closure; return an independent context.

    All refs are strict root-relative raw SHA-256 references. The worker identity
    must be independently obtained by the host, never copied from a proposed plan.
    Structure/cohort subjects need their own full host verifier and are unsupported
    by this facade, even when their geometry happens to match a Design candidate.
    """
    if type(mode) is not str or mode not in {"gradient", "optimization"}:
        raise ValueError("INVALID_ARGUMENT: refinement execution mode required")
    refs = {
        "spec": artifact_ref(spec_ref),
        "subject": artifact_ref(subject_ref),
        "execution_contract": artifact_ref(execution_contract_ref),
    }
    worker = _object(observed_worker_identity)
    raw = {role: read_bound(root, ref) for role, ref in refs.items()}
    supplied_spec = load_json(raw["spec"])
    spec = validate_refinement_spec(supplied_spec)
    _equal(spec, supplied_spec, "validated spec")
    _equal(refs["subject"], spec["source_binding"]["artifact"], "spec subject reference")
    supplied_subject = load_json(raw["subject"])
    if supplied_subject.get("version") != SUBJECT_VERSION:
        raise ValueError(
            "UNSUPPORTED_PROFILE: full retained Design subject required; "
            "Structure and cohort refinement subjects are not admitted here"
        )
    # Capture transitive source bytes before running the genuine host verifier.
    # These are checked again below so a concurrent edit cannot silently become
    # an admitted closure, including edits after the verifier has returned.
    record = _object(supplied_subject.get("design_record"))
    snapshot = _object(supplied_subject.get("source_snapshot"))
    dependencies = {
        "design_record": artifact_ref(record.get("artifact")),
        "source": artifact_ref(snapshot.get("artifact")),
    }
    before = {role: read_bound(root, ref) for role, ref in dependencies.items()}
    subject = verify_design_subject_for_spec(spec, root)
    _equal(subject, supplied_subject, "validated Design subject")
    supplied_contract = load_json(raw["execution_contract"])
    contract = validate_execution_contract(supplied_contract, spec, mode)
    _equal(contract, supplied_contract, "validated execution contract")

    subject_hash = refinement_plan.content_hash(subject)
    spec_hash = refinement_plan.content_hash(spec)
    contract_hash = refinement_plan.content_hash(contract)

    def subject_validator(candidate: Record, candidate_spec: Record) -> None:
        # Both values were obtained and authenticated above in this operation.
        # The core builder may only use those exact detached values.
        _equal(refinement_plan.content_hash(candidate), subject_hash, "core subject")
        _equal(refinement_plan.content_hash(candidate_spec), spec_hash, "core spec")

    def contract_validator(value: Record, candidate_spec: Record, candidate_mode: str) -> Record:
        _equal(refinement_plan.content_hash(value), contract_hash, "core contract")
        return validate_execution_contract(value, candidate_spec, candidate_mode)

    context = refinement_plan.PlanContext(
        subject=subject,
        spec=spec,
        worker_identity=worker,
        mode=mode,
        resource_policy={key: spec["resources"][key] for key in refinement_plan.LIMITS},
        validate_spec=validate_refinement_spec,
        validate_subject_spec=subject_validator,
        execution_contract=contract,
        validate_contract=contract_validator,
    )
    # Check all source bytes again before making the authenticated context usable.
    for role, ref in refs.items():
        if read_bound(root, ref) != raw[role]:
            raise ValueError("APPROVAL_STALE: raw " + role + " changed during verification")
    for role, ref in dependencies.items():
        if read_bound(root, ref) != before[role]:
            raise ValueError("APPROVAL_STALE: raw " + role + " changed during verification")
    refinement_plan.build_resolved_plan(context)
    return context


def prepare(
    *,
    root: Path,
    spec_ref: object,
    subject_ref: object,
    execution_contract_ref: object,
    mode: str,
    observed_worker_identity: object,
    disk_budget: DiskBudget | Record,
) -> Record:
    """Bind explicit disk policy outside the unchanged worker request and resource5."""
    budget = _disk(disk_budget)
    context = context_from_artifacts(
        root, spec_ref, subject_ref, execution_contract_ref, mode, observed_worker_identity
    )
    refs = {
        "spec": artifact_ref(spec_ref),
        "subject": artifact_ref(subject_ref),
        "execution_contract": artifact_ref(execution_contract_ref),
    }
    core = refinement_plan.build_resolved_plan(context)
    logical = {
        "core_logical_plan_hash": core["logical_plan_hash"],
        "artifact_refs": refs,
        "disk_budget": budget,
    }
    body = {
        **{key: value for key, value in core.items() if key != "resolved_plan_hash"},
        "version": PLAN_VERSION,
        "artifact_refs": refs,
        "disk_budget": budget,
        "core_plan_hash": core["resolved_plan_hash"],
        "core_logical_plan_hash": core["logical_plan_hash"],
        "logical_plan_hash": refinement_plan.content_hash(logical),
    }
    return _object({**body, "resolved_plan_hash": refinement_plan.content_hash(body)})


def validate_plan(plan: object, root: Path, observed_worker_identity: object) -> Record:
    """Re-read the artifact closure and rebuild; an outer hash is not approval.

    Plan references and disk policy are proposals revalidated for internal
    consistency. Their authorization comes from the existing host store's exact
    approved outer hash, never this function or worker self-attestation.
    """
    supplied = _object(plan)
    if supplied.get("version") != PLAN_VERSION:
        raise ValueError("UNSUPPORTED_PROFILE: governed refinement plan required")
    refs = _object(supplied.get("artifact_refs"))
    if set(refs) != _REF_KEYS:
        raise ValueError("INVALID_ARGUMENT: exact plan artifact references required")
    mode = supplied.get("mode")
    if type(mode) is not str:
        raise ValueError("INVALID_ARGUMENT: plan execution mode required")
    expected = prepare(
        root=root,
        spec_ref=refs["spec"],
        subject_ref=refs["subject"],
        execution_contract_ref=refs["execution_contract"],
        mode=mode,
        observed_worker_identity=observed_worker_identity,
        disk_budget=_object(supplied.get("disk_budget")),
    )
    _equal(supplied, expected, "governed refinement plan and retained host inputs")
    return expected


def validate_stored_plan(plan: object, root: Path) -> Record:
    """Validate retained history, without claiming its worker is current.

    This is for immutable-history reads only. It rechecks the actual subject,
    source, spec and contract bytes but treats the sealed worker descriptor as
    historical data. Approve/execute MUST call validate_plan with an independently
    observed current registered worker and the existing store's approval checks.
    """
    supplied = _object(plan)
    return validate_plan(supplied, root, supplied.get("worker"))
