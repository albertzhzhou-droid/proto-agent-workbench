"""Versioned method descriptors. Registration is not backend or accuracy evidence.

This module has no dispatch, imports of chemistry runtimes, or defaults
for scientific settings. Records are detached, content-addressed JSON snapshots;
callers must revalidate their hash at every trust boundary.
"""

from __future__ import annotations

import copy
import re
from typing import Any

from chem_workbench.execution_validation import digest_id, verify_hash
from chem_workbench.visualization import content_hash

PROFILE_ID = "psi4.wb97x_v.def2_tzvppd.optimize.v1"
MASS_BOUND_PROFILE_ID = "psi4.wb97x_v.def2_tzvppd.optimize.v2"
D3BJ_PROFILE_ID = "psi4.wb97x_d3bj.def2_tzvppd.optimize.v1"
ANGSTROM_TO_BOHR = "1.8897261254578281"
ELEMENT_NUMBERS = {"H": 1, "C": 6, "N": 7, "O": 8, "F": 9, "S": 16, "Cl": 17}

_BODY: dict[str, Any] = {
    "version": "refinement-method-profile/v1",
    "profile_id": PROFILE_ID,
    "engine": "psi4",
    "method": "wb97x-v",
    "basis": "def2-tzvppd",
    "task": "geometry_optimization",
    "backend_verified": False,
    "availability": "registered_descriptor_only",
    "scientific_validation": "not_performed",
    "scope": {
        "elements": ["H", "C", "N", "O", "F", "S", "Cl"],
        "charge": 0,
        "multiplicity": 1,
        "reference": "rks",
        "heavy_atoms": [8, 32],
        "maximum_atoms": 120,
        "carbon_required": True,
        "boundary": "isolated",
        "environment": "gas_phase",
        "isotopes": "unsupported",
        "connectivity": "one_connected_molecule_requires_upstream_validation",
    },
    "geometry_units": "angstrom",
    "gradient_units": "hartree/bohr",
    "energy_units": "hartree",
    "angstrom_to_bohr": ANGSTROM_TO_BOHR,
    "trajectory_clock": "gradient_evaluation_index",
    "physical_time": "unavailable_for_geometry_optimization",
    "minimum_certification": "requires_separate_hessian_branch",
    "unresolved": [
        "Admit actual functional, LibXC, NLC grid, effective options and basis bytes.",
        "Verify analytic gradients and optimizer API on the bound runtime.",
        "Validate atom identity, connectivity, hydrogen count and stereochemistry upstream.",
        "Choose and validate explicit SCF, integration and optimization thresholds.",
        "Observe and account backend attempts; requested zero retries is not proof.",
        "Validate reference geometries and relative energies on complex held-out molecules.",
        "Add bound Hessian, frequency and minimum classification before minimum claims.",
        "Ions, radicals, metals, periodic solids and interfaces require further profiles.",
    ],
}
_PROFILE = {**_BODY, "profile_hash": content_hash(_BODY)}
_MASS_BODY = copy.deepcopy(_BODY)
_MASS_BODY["profile_id"] = MASS_BOUND_PROFILE_ID
_MASS_BODY["scope"]["isotopes"] = "runtime_defaults_only"
_MASS_BODY["nuclear_identity"] = "explicit_runtime_default_isotope_binding_required"
_MASS_PROFILE = {**_MASS_BODY, "profile_hash": content_hash(_MASS_BODY)}
_D3BJ_BODY = copy.deepcopy(_MASS_BODY)
_D3BJ_BODY.update(
    profile_id=D3BJ_PROFILE_ID,
    method="wb97x-d3bj",
    dispersion={
        "engine": "s-dftd3",
        "type": "d3bj2b",
        "nonlocal_correlation": False,
        "parameters": {"s6": "1", "s8": "0.2641", "a1": "0", "a2": "5.4959", "s9": "0"},
        "three_body_atm": False,
    },
)
_D3BJ_BODY["unresolved"][0] = (
    "Admit actual functional, LibXC, D3(BJ) engine/parameters, effective options and basis bytes."
)
_D3BJ_PROFILE = {**_D3BJ_BODY, "profile_hash": content_hash(_D3BJ_BODY)}
_PROFILES = {
    PROFILE_ID: _PROFILE,
    MASS_BOUND_PROFILE_ID: _MASS_PROFILE,
    D3BJ_PROFILE_ID: _D3BJ_PROFILE,
}


def gradient_driver_arguments(profile: dict[str, Any]) -> dict[str, Any]:
    """Exact driver arguments for a validated descriptor; no backend dispatch."""
    result: dict[str, Any] = {"dertype": 1}
    if profile["profile_id"] == D3BJ_PROFILE_ID:
        result["engine"] = "s-dftd3"
    return result


def get_method_profile(profile_id: str) -> dict[str, Any]:
    """Return a detached descriptor, without probing or admitting a backend."""
    if profile_id not in _PROFILES:
        raise ValueError("UNSUPPORTED_PROFILE: unregistered refinement descriptor")
    return copy.deepcopy(_PROFILES[profile_id])


def validate_method_profile(value: object) -> dict[str, Any]:
    """Reject descriptor changes, including invented availability or accuracy."""
    if not isinstance(value, dict):
        raise ValueError("INVALID_ARGUMENT: method profile must be an object")
    verify_hash(value, "profile_hash")
    if value != _PROFILES.get(str(value.get("profile_id"))):
        raise ValueError("UNSUPPORTED_PROFILE: descriptor differs from registered version")
    return copy.deepcopy(value)


def closed(value: object, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError(f"INVALID_ARGUMENT: {label} has missing or unexpected fields")
    return value


def text_id(value: object, label: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.:-]{0,127}", value):
        raise ValueError(f"INVALID_ARGUMENT: malformed {label}")
    return value


def integer(value: object, minimum: int, maximum: int, label: str) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"INVALID_ARGUMENT: {label} outside integer bounds")
    return value


def choice(value: object, options: set[str], label: str) -> str:
    if not isinstance(value, str) or value not in options:
        raise ValueError(f"INVALID_ARGUMENT: unknown {label}")
    return value


def artifact_ref(value: object) -> dict[str, Any]:
    """Validate metadata only. The host must resolve and rehash actual file bytes."""
    item = closed(value, {"path", "sha256"}, "artifact reference")
    path = item["path"]
    if (
        not isinstance(path, str)
        or not 1 <= len(path) <= 512
        or path.startswith("/")
        or any(part in {"", ".", ".."} or part != part.rstrip(" .") for part in path.split("/"))
        or any(ord(char) < 32 or char in '\\:*?"<>|' for char in path)
    ):
        raise ValueError("INVALID_ARGUMENT: expected a safe relative artifact path")
    reserved = {"CON", "PRN", "AUX", "NUL"} | {
        prefix + str(index) for prefix in ("COM", "LPT") for index in range(1, 10)
    }
    if any(part.split(".", 1)[0].upper() in reserved for part in path.split("/")):
        raise ValueError("INVALID_ARGUMENT: artifact path uses a reserved device name")
    if not isinstance(item["sha256"], str):
        raise ValueError("INVALID_ARGUMENT: malformed artifact SHA-256")
    digest_id("sha256:" + item["sha256"])
    return item
