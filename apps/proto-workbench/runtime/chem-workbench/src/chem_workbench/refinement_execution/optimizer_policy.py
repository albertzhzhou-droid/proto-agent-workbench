"""Pure admission for observed OptKing parameters.

The caller must persist the genuine observation before calling admission and bind
the artifact bytes and runtime through the execution contract. This module runs no native
calculation and supplies no claim of convergence or scientific accuracy.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
from decimal import Decimal
from pathlib import PurePath
from typing import Any

POLICY_ID = "optking.cartesian.rfo.lindh.bfgs.v1"
VERSION = "refinement-optimizer-policy-binding/v1"
_FLAGS = {
    "_i_max_force": True,
    "_i_rms_force": True,
    "_i_max_disp": True,
    "_i_rms_disp": True,
    "_i_max_DE": False,
    "_i_untampered": False,
}
_CRITERIA = {
    "max_force_hartree_per_bohr": ("max_force_g_convergence", "conv_max_force"),
    "rms_force_hartree_per_bohr": ("rms_force_g_convergence", "conv_rms_force"),
    "max_displacement_bohr": ("max_disp_g_convergence", "conv_max_disp"),
    "rms_displacement_bohr": ("rms_disp_g_convergence", "conv_rms_disp"),
}
_FIXED = {
    "program": "psi4",
    "opt_type": "min",
    "opt_coordinates": "cartesian",
    "step_type": "rfo",
    "full_hess_every": -1,
    "intrafrag_hess": "lindh",
    "h_guess_every": False,
    "hess_update": "bfgs",
    "cart_hess_read": False,
    "linesearch": False,
    "write_trajectory": False,
    "flexible_g_convergence": False,
    "dynamic_level": 0,
    "dynamic_lvl_max": 0,
    "consecutive_backsteps_allowed": 0,
    "intrafrag_trust": 0.5,
    "intrafrag_trust_min": 0.001,
    "intrafrag_trust_max": 1.0,
    "interfrag_trust": 0.5,
    "interfrag_trust_min": 0.001,
    "interfrag_trust_max": 1.0,
}


def _json_copy(value: Any) -> Any:
    # Reject NaN/Infinity and detach the complete native snapshot.
    return json.loads(json.dumps(value, allow_nan=False, sort_keys=True))


def _hash(value: Any) -> str:
    data = json.dumps(value, allow_nan=False, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _sha(value: Any) -> None:
    if (
        not isinstance(value, str)
        or len(value) != 71
        or not value.startswith("sha256:")
        or any(c not in "0123456789abcdef" for c in value[7:])
    ):
        raise ValueError("INVALID_ARGUMENT: SHA256 identity required")


def _integer(value: Any, maximum: int) -> None:
    if type(value) is not int or not 1 <= value <= maximum:
        raise ValueError("INVALID_ARGUMENT: bounded positive integer required")


def requested_options(settings: dict[str, Any]) -> dict[str, Any]:
    if set(settings) != {
        "engine",
        "coordinates",
        "criteria",
        "flexible_g_convergence",
        "maximum_iterations",
        "max_gradient_evaluations",
    }:
        raise ValueError("INVALID_ARGUMENT: closed optimizer settings required")
    if (
        settings["engine"] != "optking"
        or settings["coordinates"] != "cartesian"
        or settings["flexible_g_convergence"] is not False
    ):
        raise ValueError("UNSUPPORTED_PROFILE: explicit Cartesian OptKing required")
    _integer(settings["maximum_iterations"], 1000)
    _integer(settings["max_gradient_evaluations"], 4000)
    if set(settings["criteria"]) != set(_CRITERIA):
        raise ValueError("INVALID_ARGUMENT: four explicit criteria required")
    result = copy.deepcopy(_FIXED)
    result["geom_maxiter"] = settings["maximum_iterations"]
    result["alg_geom_maxiter"] = settings["maximum_iterations"]
    for key, (requested, _) in _CRITERIA.items():
        value = settings["criteria"][key]
        if not isinstance(value, str):
            raise ValueError("INVALID_ARGUMENT: decimal-string threshold required")
        exact = Decimal(value)
        if not exact.is_finite() or not 0 < exact <= 1:
            raise ValueError("INVALID_ARGUMENT: positive finite threshold required")
        native = float(exact)
        if not math.isfinite(native) or native <= 0:
            raise ValueError("INVALID_ARGUMENT: threshold underflows native binary64")
        result[requested] = native
    return result


def observe_parameters(params: Any) -> dict[str, Any]:
    """Observe native values, projecting only the known hessian_file Path to text.

    Installed OptKing's Python-mode serializer returns this field as pathlib.Path.
    Its exact text is JSON-safe; arbitrary non-JSON objects remain inadmissible.
    Neither the native object nor the serializer's dictionary is mutated.
    """
    raw = params.to_dict(by_alias=False)
    if not isinstance(raw, dict):
        raise ValueError("INVALID_TOOL_OUTPUT: native optimizer snapshot must be an object")
    projection = dict(raw)
    if isinstance(projection.get("hessian_file"), PurePath):
        projection["hessian_file"] = str(projection["hessian_file"])
    actual = _json_copy(projection)
    if not isinstance(actual, dict):
        raise ValueError("INVALID_TOOL_OUTPUT: serialized optimizer snapshot must be an object")
    for name in _FLAGS:
        observed = getattr(params, name)
        if type(observed) is not bool or actual.get(name) is not observed:
            raise ValueError("INVALID_TOOL_OUTPUT: convergence flag serialization differs")
    return actual


def _same(actual: Any, expected: Any) -> bool:
    if isinstance(expected, str):
        return isinstance(actual, str) and actual.casefold() == expected.casefold()
    return type(actual) is type(expected) and actual == expected


def admit_initial(settings: dict[str, Any], actual: dict[str, Any]) -> None:
    expected = requested_options(settings)
    for name, value in expected.items():
        native = next((target for request, target in _CRITERIA.values() if request == name), name)
        if native not in actual or not _same(actual[native], value):
            raise ValueError("APPROVAL_STALE: effective optimizer option differs: " + native)
    for name, value in _FLAGS.items():
        if actual.get(name) is not value:
            raise ValueError("APPROVAL_STALE: active convergence criterion differs: " + name)
    _json_copy(actual)


def seal_binding(
    settings: dict[str, Any],
    actual: dict[str, Any],
    *,
    runtime_binding_hash: str,
    observation_artifact: dict[str, str],
) -> dict[str, Any]:
    admit_initial(settings, actual)
    _sha(runtime_binding_hash)
    if set(observation_artifact) != {"path", "sha256"}:
        raise ValueError("INVALID_ARGUMENT: exact observation artifact reference required")
    _sha("sha256:" + observation_artifact["sha256"])
    path = observation_artifact["path"]
    if (
        not path
        or "\\" in path
        or ":" in path
        or path.startswith("/")
        or any(part in {"", ".", ".."} for part in path.split("/"))
    ):
        raise ValueError("INVALID_ARGUMENT: relative artifact path required")
    body = {
        "version": VERSION,
        "policy_id": POLICY_ID,
        "optimizer_settings": _json_copy(settings),
        "requested_native_options": requested_options(settings),
        "effective_native_parameters": _json_copy(actual),
        "runtime_binding_hash": runtime_binding_hash,
        "observation_artifact": _json_copy(observation_artifact),
        "mutable_native_parameters": ["intrafrag_trust", "interfrag_trust"],
        "final_accepted_geometry_reevaluation_required": True,
    }
    return {**body, "binding_hash": _hash(body)}


def validate_binding(
    value: dict[str, Any], settings: dict[str, Any], runtime_binding_hash: str
) -> dict[str, Any]:
    # Reconstruct only the policy envelope; the observed native snapshot stays intact.
    expected = seal_binding(
        settings,
        value["effective_native_parameters"],
        runtime_binding_hash=runtime_binding_hash,
        observation_artifact=value["observation_artifact"],
    )
    if expected != value or _hash(expected) != _hash(value):
        raise ValueError("APPROVAL_STALE: optimizer binding differs from policy or context")
    return expected


def verify_step_parameters(binding: dict[str, Any], actual: dict[str, Any]) -> None:
    """Trust radius may adapt within bound limits; other native parameters may not."""
    expected = binding["effective_native_parameters"]
    if set(actual) != set(expected):
        raise ValueError("APPROVAL_STALE: optimizer parameter inventory changed")
    for key, value in actual.items():
        if key in {"intrafrag_trust", "interfrag_trust"}:
            if (
                type(value) is not float
                or not math.isfinite(value)
                or not expected[key + "_min"] <= value <= expected[key + "_max"]
            ):
                raise ValueError("APPROVAL_STALE: optimizer trust radius outside bound range")
        elif type(value) is not type(expected[key]) or _hash(value) != _hash(expected[key]):
            raise ValueError("APPROVAL_STALE: optimizer parameter changed during run: " + key)
