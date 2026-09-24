"""Pure request-v2 admission; never native execution or completion evidence.

Product spec v1/v2 and worker-request v1 are unchanged. The envelope binds the intended execution
route; the host must separately authenticate files and observe actual execution.
"""

from __future__ import annotations

import json
import math
from typing import Any

from chem_workbench.execution_validation import verify_hash
from chem_workbench.method_profiles import D3BJ_PROFILE_ID, artifact_ref, choice, closed
from chem_workbench.molecular_refinement import (
    MASS_BOUND_SPEC_VERSION,
    MAX_RECORD_BYTES,
    validate_refinement_spec,
)
from chem_workbench.refinement_execution.optimizer_policy import (
    validate_binding as _validate_optimizer_binding,
)
from chem_workbench.visualization import content_hash

CONTRACT_VERSION = "refinement-execution-contract/v1"
REQUEST_VERSION = "refinement-worker-request/v2"
DISPATCH = "psi4_qcengine_psiapi_v1"
NESTED_PROGRAM = "s-dftd3"
NESTED_ATTEMPT_POLICY = "record_each_native_call_zero_retries"
_CONTRACT_KEYS = {
    "version",
    "spec_hash",
    "mode",
    "dispatch",
    "nested_program",
    "nested_attempt_policy",
    "optimizer_binding",
    "contract_hash",
}
_OPTIMIZER_KEYS = {
    "version",
    "policy_id",
    "optimizer_settings",
    "requested_native_options",
    "effective_native_parameters",
    "runtime_binding_hash",
    "observation_artifact",
    "mutable_native_parameters",
    "final_accepted_geometry_reevaluation_required",
    "binding_hash",
}


def _json_value(value: object, depth: int = 0) -> None:
    """Reject coercions (tuple, non-string keys, custom types) before hashing."""
    if depth > 128:
        raise ValueError("RESOURCE_LIMIT: execution contract JSON exceeds depth 128")
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


def _detach(value: object) -> dict[str, Any]:
    if type(value) is not dict:
        raise ValueError("INVALID_ARGUMENT: execution contract expects a JSON object")
    _json_value(value)
    try:
        encoded = json.dumps(value, allow_nan=False, separators=(",", ":"))
    except (TypeError, ValueError, OverflowError, RecursionError) as error:
        raise ValueError("INVALID_ARGUMENT: finite bounded JSON required") from error
    if len(encoded.encode("utf-8")) > MAX_RECORD_BYTES:
        raise ValueError("RESOURCE_LIMIT: execution contract record exceeds 20 MiB")
    result: dict[str, Any] = json.loads(encoded)
    return result


def _admitted_spec(spec: object) -> dict[str, Any]:
    result = validate_refinement_spec(_detach(spec))
    if (
        result["version"] != MASS_BOUND_SPEC_VERSION
        or result["profile"]["profile_id"] != D3BJ_PROFILE_ID
    ):
        raise ValueError("UNSUPPORTED_PROFILE: request v2 requires mass-bound D3BJ spec v2")
    driver = result["electronic_settings"]["native_keywords"].get("function_kwargs")
    if (
        type(driver) is not dict
        or driver != {"dertype": 1, "engine": NESTED_PROGRAM}
        or type(driver["dertype"]) is not int
    ):
        raise ValueError("UNSUPPORTED_PROFILE: explicit analytic D3BJ driver required")
    retries = result["resources"]["backend_retry_policy"]
    if retries != {
        "requested_retries": 0,
        "effective_retries": 0,
        "accounting": "observe_every_backend_attempt",
    }:
        raise ValueError("UNSUPPORTED_PROFILE: request v2 requires a zero-retry policy")
    return result


def _optimizer_binding(value: object, spec: dict[str, Any], mode: str) -> dict[str, Any] | None:
    if mode == "gradient":
        if value is not None:
            raise ValueError("INVALID_ARGUMENT: gradient mode has no optimizer binding")
        return None
    if spec["optimizer_settings"]["max_gradient_evaluations"] < 2:
        raise ValueError("RESOURCE_LIMIT: optimization needs initial and final gradient capacity")
    binding = _detach(value)
    closed(binding, _OPTIMIZER_KEYS, "optimizer binding")
    verify_hash(binding, "binding_hash")
    artifact_ref(binding["observation_artifact"])
    if binding["final_accepted_geometry_reevaluation_required"] is not True:
        raise ValueError("UNSUPPORTED_PROFILE: final accepted-geometry reevaluation is required")
    try:
        result = _validate_optimizer_binding(
            binding, spec["optimizer_settings"], spec["runtime_binding"]["binding_hash"]
        )
    except (KeyError, TypeError, AttributeError) as error:
        raise ValueError("INVALID_ARGUMENT: malformed optimizer binding") from error
    return _detach(result)


def seal_execution_contract(
    spec: object, mode: str, optimizer_binding: object = None
) -> dict[str, Any]:
    """Seal requested behavior; this never observes native calls or optimizer options."""
    checked_spec = _admitted_spec(spec)
    checked_mode = choice(mode, {"gradient", "optimization"}, "execution mode")
    body = {
        "version": CONTRACT_VERSION,
        "spec_hash": checked_spec["spec_hash"],
        "mode": checked_mode,
        "dispatch": DISPATCH,
        "nested_program": NESTED_PROGRAM,
        "nested_attempt_policy": NESTED_ATTEMPT_POLICY,
        "optimizer_binding": _optimizer_binding(optimizer_binding, checked_spec, checked_mode),
    }
    return _detach({**body, "contract_hash": content_hash(body)})


def validate_execution_contract(value: object, spec: object, mode: str) -> dict[str, Any]:
    """Revalidate all policy/context fields and return a detached envelope."""
    result = _detach(value)
    closed(result, _CONTRACT_KEYS, "execution contract")
    verify_hash(result, "contract_hash")
    expected = seal_execution_contract(spec, mode, result["optimizer_binding"])
    if result != expected:
        raise ValueError("APPROVAL_STALE: execution contract differs from policy or context")
    return expected


def build_worker_request(spec: object, contract: object) -> dict[str, Any]:
    """Build only the new request envelope; it is not supported by legacy workers."""
    checked_contract = _detach(contract)
    closed(checked_contract, _CONTRACT_KEYS, "execution contract")
    checked_spec = _admitted_spec(spec)
    checked_mode = choice(checked_contract["mode"], {"gradient", "optimization"}, "execution mode")
    checked_contract = validate_execution_contract(checked_contract, checked_spec, checked_mode)
    return _detach(
        {
            "version": REQUEST_VERSION,
            "mode": checked_mode,
            "spec": checked_spec,
            "execution_contract": checked_contract,
        }
    )


def validate_worker_request(value: object) -> dict[str, Any]:
    """Admit request v2 only; legacy requests retain their original separate validator."""
    result = _detach(value)
    closed(result, {"version", "mode", "spec", "execution_contract"}, "worker request v2")
    if result["version"] != REQUEST_VERSION:
        raise ValueError("UNSUPPORTED_PROFILE: expected refinement-worker-request/v2")
    mode = choice(result["mode"], {"gradient", "optimization"}, "execution mode")
    contract = validate_execution_contract(result["execution_contract"], result["spec"], mode)
    return build_worker_request(result["spec"], contract)
