"""Pure isotope-record consistency, without runtime defaults or scientific admission.

The host must separately match every row to the bound runtime's actual default
isotopes and resolve the artifact bytes. This module cannot establish that a
mass is physically accurate or a runtime default. The sole policy admits no
user-selected isotope substitutions. Geometry/profile/ghost validation remains
with the parent scientific validator.
"""

from __future__ import annotations

import copy
import math
from decimal import Decimal
from typing import Any

from chem_workbench.chemir.constraints import canonical_decimal
from chem_workbench.execution_validation import digest_id, number, verify_hash
from chem_workbench.method_profiles import ELEMENT_NUMBERS, artifact_ref, closed, integer, text_id
from chem_workbench.visualization import content_hash

ISOTOPE_BINDING_VERSION = "refinement-isotope-binding/v1"
ISOTOPE_POLICY = "runtime_default_isotopes"
_BODY_KEYS = {"version", "policy", "geometry_hash", "runtime_binding_hash", "atoms", "artifact"}
_ATOM_KEYS = {"atom_id", "element", "atomic_number", "mass_number", "mass_dalton"}


def _checked_binding(value: object) -> dict[str, Any]:
    binding: dict[str, Any] = closed(value, _BODY_KEYS | {"binding_hash"}, "isotope binding")
    if binding["version"] != ISOTOPE_BINDING_VERSION or binding["policy"] != ISOTOPE_POLICY:
        raise ValueError("UNSUPPORTED_PROFILE: runtime-default isotope policy required")
    digest_id(binding["geometry_hash"])
    digest_id(binding["runtime_binding_hash"])
    artifact_ref(binding["artifact"])
    atoms = binding["atoms"]
    if not isinstance(atoms, list) or not 1 <= len(atoms) <= 120:
        raise ValueError("INVALID_ARGUMENT: expected 1-120 isotope rows")
    identities: set[str] = set()
    for row in atoms:
        row = closed(row, _ATOM_KEYS, "isotope atom")
        atom_id = text_id(row["atom_id"], "isotope atom ID")
        if atom_id in identities:
            raise ValueError("INVALID_ARGUMENT: duplicate isotope atom ID")
        identities.add(atom_id)
        element = row["element"]
        if not isinstance(element, str) or element not in ELEMENT_NUMBERS:
            raise ValueError("UNSUPPORTED_PROFILE: isotope element outside descriptor")
        atomic_number = integer(row["atomic_number"], 1, 118, "atomic number")
        if atomic_number != ELEMENT_NUMBERS[element]:
            raise ValueError("INVALID_ARGUMENT: atomic number does not match element")
        mass_number = integer(row["mass_number"], 1, 300, "mass number")
        if mass_number < atomic_number:
            raise ValueError("INVALID_ARGUMENT: mass number is below atomic number")
        mass = number(row["mass_dalton"], "300")
        if mass <= 0 or canonical_decimal(row["mass_dalton"]) != row["mass_dalton"]:
            raise ValueError("INVALID_ARGUMENT: positive canonical mass in dalton required")
    verify_hash(binding, "binding_hash")
    return binding


def _context(value: object, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("INVALID_ARGUMENT: geometry and runtime binding must be objects")
    try:
        verify_hash(value, field)
    except (TypeError, OverflowError, RecursionError) as error:
        raise ValueError("INVALID_ARGUMENT: malformed geometry or runtime binding") from error
    return value


def validate_isotope_binding(
    value: object, geometry: object, runtime_binding: object
) -> dict[str, Any]:
    """Return a detached internally consistent record, without native admission.

    Callers retain responsibility for the geometry and runtime profile contracts.
    Their content hashes and ordered atom identities are checked here.
    """
    binding = _checked_binding(value)
    geometry = _context(geometry, "geometry_hash")
    runtime = _context(runtime_binding, "binding_hash")
    if (
        binding["geometry_hash"] != geometry["geometry_hash"]
        or binding["runtime_binding_hash"] != runtime["binding_hash"]
    ):
        raise ValueError("APPROVAL_STALE: isotope geometry or runtime binding differs")
    atoms = geometry.get("atoms")
    if not isinstance(atoms, list) or len(atoms) != len(binding["atoms"]):
        raise ValueError("APPROVAL_STALE: isotope atom inventory differs from geometry")
    for atom, row in zip(atoms, binding["atoms"], strict=True):
        if (
            not isinstance(atom, dict)
            or atom.get("id") != row["atom_id"]
            or atom.get("element") != row["element"]
        ):
            raise ValueError("APPROVAL_STALE: isotope atom order or identity differs")
    return copy.deepcopy(binding)


def seal_isotope_binding(body: object, geometry: object, runtime_binding: object) -> dict[str, Any]:
    """Seal only the supplied rows and validate; do not supply isotope defaults."""
    value = copy.deepcopy(closed(body, _BODY_KEYS, "isotope binding body"))
    try:
        value["binding_hash"] = content_hash(value)
    except (TypeError, OverflowError, RecursionError) as error:
        raise ValueError("INVALID_ARGUMENT: isotope binding must be JSON data") from error
    return validate_isotope_binding(value, geometry, runtime_binding)


def _raw_mass(value: object) -> Decimal:
    if type(value) is float:
        if not math.isfinite(value):
            raise ValueError("INVALID_ARGUMENT: raw mass must be finite")
        # A parsed float retains only its serialized decimal spelling. Callers
        # should parse raw JSON with parse_float=Decimal to preserve every digit.
        parsed = Decimal(str(value))
    elif type(value) is int:
        parsed = Decimal(value)
    elif type(value) is Decimal:
        parsed = value
    else:
        raise ValueError("INVALID_ARGUMENT: raw mass must be a numeric JSON value")
    if not parsed.is_finite() or not Decimal(0) < parsed <= Decimal(300):
        raise ValueError("INVALID_ARGUMENT: raw mass outside (0, 300] dalton")
    return parsed


def validate_raw_isotopes(raw_molecule: object, binding: object) -> None:
    """Match complete raw arrays to the binding with exact decimal equality.

    There is no mass tolerance. Missing arrays, isotope changes, numeric strings,
    booleans and nonfinite numbers are rejected. QCSchema atom/ghost/geometry
    validation is performed by the parent; this function never reconstructs it.
    """
    checked = _checked_binding(binding)
    if not isinstance(raw_molecule, dict):
        raise ValueError("INVALID_ARGUMENT: raw molecule must be an object")
    masses = raw_molecule.get("masses")
    mass_numbers = raw_molecule.get("mass_numbers")
    atoms = checked["atoms"]
    if (
        not isinstance(masses, list)
        or not isinstance(mass_numbers, list)
        or len(masses) != len(atoms)
        or len(mass_numbers) != len(atoms)
    ):
        raise ValueError("INVALID_ARGUMENT: complete raw masses and mass_numbers are required")
    for mass, mass_number, atom in zip(masses, mass_numbers, atoms, strict=True):
        integer(mass_number, 1, 300, "raw mass number")
        if mass_number != atom["mass_number"] or _raw_mass(mass) != Decimal(atom["mass_dalton"]):
            raise ValueError("APPROVAL_STALE: raw isotope mass or mass number differs")
