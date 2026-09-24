"""Pure, sealed refinement records with evaluated geometry/energy/gradient binding.

No calculator, molecule embedding, optimization, filesystem resolution or backend
admission occurs here. An internally consistent record is not proof of trustworthy
execution. Host artifact binding and independent scientific validation are separate.
"""

from __future__ import annotations

import copy
import hashlib
import json
from collections import Counter
from decimal import Decimal, localcontext
from typing import Any

from chem_workbench.chemir.constraints import canonical_decimal
from chem_workbench.execution_validation import digest_id, number, verify_hash
from chem_workbench.refinement_isotopes import validate_isotope_binding, validate_raw_isotopes
from chem_workbench.visualization import content_hash

from .method_profiles import (
    ANGSTROM_TO_BOHR,
    ELEMENT_NUMBERS,
    artifact_ref,
    choice,
    closed,
    gradient_driver_arguments,
    integer,
    text_id,
    validate_method_profile,
)

SPEC_VERSION = "molecular-refinement-spec/v1"
MASS_BOUND_SPEC_VERSION = "molecular-refinement-spec/v2"
RESULT_VERSION = "molecular-refinement-result/v2"
FRAME_VERSION = "molecular-refinement-frame/v2"
OBSERVATION_VERSION = "refinement-optimizer-observation/v2"
_STEP_STATUSES = {"initial", "accepted", "rejected", "unknown", "reevaluation"}
MAX_RECORD_BYTES = 20 * 1024 * 1024
MAX_RAW_BYTES = 1024 * 1024
_FORCE_KEYS = {"max_force_hartree_per_bohr", "rms_force_hartree_per_bohr"}
_DISPLACEMENT_KEYS = {"max_displacement_bohr", "rms_displacement_bohr"}
_CRITERIA_KEYS = _FORCE_KEYS | _DISPLACEMENT_KEYS


def _decimal(value: object, bound: str = "1000000", nonnegative: bool = False) -> Decimal:
    parsed = number(value, bound)
    if (
        not isinstance(value, str)
        or canonical_decimal(value) != value
        or (nonnegative and parsed < 0)
    ):
        raise ValueError("INVALID_ARGUMENT: expected canonical bounded decimal string")
    return parsed


def _detach(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("INVALID_ARGUMENT: expected a JSON object")
    try:
        encoded = json.dumps(value, allow_nan=False, separators=(",", ":"))
    except (TypeError, ValueError, RecursionError) as error:
        raise ValueError("INVALID_ARGUMENT: expected finite JSON data") from error
    if len(encoded.encode("utf-8")) > MAX_RECORD_BYTES:
        raise ValueError("RESOURCE_LIMIT: refinement record exceeds 20 MiB")
    return copy.deepcopy(value)


def _seal(body: object, field: str) -> dict[str, Any]:
    result = _detach(body)
    if field in result:
        raise ValueError(f"INVALID_ARGUMENT: seal expects body without {field}")
    result[field] = content_hash(result)
    return result


def seal_refinement_geometry(body: object) -> dict[str, Any]:
    result = _seal(body, "geometry_hash")
    _geometry(result)
    return result


def _geometry(value: object) -> dict[str, Any]:
    geometry = closed(
        value, {"version", "units", "charge", "multiplicity", "atoms", "geometry_hash"}, "geometry"
    )
    verify_hash(geometry, "geometry_hash")
    if geometry["version"] != "refinement-geometry/v1" or geometry["units"] != "angstrom":
        raise ValueError("UNSUPPORTED_PROFILE: unsupported geometry version or units")
    if type(geometry["charge"]) is not int or geometry["charge"] != 0:
        raise ValueError("UNSUPPORTED_PROFILE: first descriptor requires neutral geometry")
    if type(geometry["multiplicity"]) is not int or geometry["multiplicity"] != 1:
        raise ValueError("UNSUPPORTED_PROFILE: first descriptor requires singlet geometry")
    atoms = geometry["atoms"]
    if not isinstance(atoms, list) or not 8 <= len(atoms) <= 120:
        raise ValueError("UNSUPPORTED_PROFILE: expected 8-120 explicit atoms")
    identities: set[str] = set()
    positions: set[tuple[Decimal, ...]] = set()
    elements: list[str] = []
    for atom in atoms:
        atom = closed(atom, {"id", "element", "position"}, "atom")
        identity = text_id(atom["id"], "atom ID")
        element = atom["element"]
        if not isinstance(element, str) or element not in ELEMENT_NUMBERS:
            raise ValueError("UNSUPPORTED_PROFILE: element outside first descriptor")
        position = atom["position"]
        if not isinstance(position, list) or len(position) != 3:
            raise ValueError("INVALID_ARGUMENT: expected Cartesian XYZ coordinates")
        parsed = tuple(_decimal(part, "1000") for part in position)
        if identity in identities or parsed in positions:
            raise ValueError("INVALID_ARGUMENT: duplicate atom identity or coincident atoms")
        identities.add(identity)
        positions.add(parsed)
        elements.append(element)
    if "C" not in elements or not 8 <= sum(e != "H" for e in elements) <= 32:
        raise ValueError("UNSUPPORTED_PROFILE: expected organic geometry with 8-32 heavy atoms")
    if sum(ELEMENT_NUMBERS[e] for e in elements) % 2:
        raise ValueError(
            "UNSUPPORTED_PROFILE: odd electron count conflicts with closed-shell singlet"
        )
    return geometry


def _identity(geometry: dict[str, Any]) -> list[list[str]]:
    return [[atom["id"], atom["element"]] for atom in geometry["atoms"]]


def _binding(value: object, basis: bool) -> dict[str, Any]:
    fields = {"version", "files", "binding_hash"} | (
        {"basis", "elements"} if basis else {"engine", "versions"}
    )
    binding = closed(value, fields, "basis binding" if basis else "runtime binding")
    verify_hash(binding, "binding_hash")
    expected = "refinement-basis-binding/v1" if basis else "refinement-runtime-binding/v1"
    if binding["version"] != expected:
        raise ValueError("UNSUPPORTED_PROFILE: binding version mismatch")
    if basis:
        if binding["basis"] != "def2-tzvppd" or binding["elements"] != list(ELEMENT_NUMBERS):
            raise ValueError("UNSUPPORTED_PROFILE: basis descriptor coverage mismatch")
    else:
        if binding["engine"] != "psi4":
            raise ValueError("UNSUPPORTED_PROFILE: engine mismatch")
        versions = closed(
            binding["versions"],
            {"python", "psi4", "optking", "qcengine", "qcelemental", "libxc"},
            "runtime versions",
        )
        for package, version in versions.items():
            if (
                not isinstance(version, str)
                or not 1 <= len(version) <= 128
                or any(ord(c) < 32 for c in version)
            ):
                raise ValueError(f"INVALID_ARGUMENT: explicit {package} version required")
    files = binding["files"]
    if not isinstance(files, list) or not 1 <= len(files) <= 20000:
        raise ValueError("INVALID_ARGUMENT: binding needs bounded file references")
    paths = [artifact_ref(item)["path"] for item in files]
    if paths != sorted(paths) or len(paths) != len(set(path.casefold() for path in paths)):
        raise ValueError(
            "INVALID_ARGUMENT: binding files must be sorted and case-insensitively unique"
        )
    return binding


def seal_refinement_spec(body: object) -> dict[str, Any]:
    return validate_refinement_spec(_seal(body, "spec_hash"))


def validate_refinement_spec(value: object) -> dict[str, Any]:
    spec = _detach(value)
    closed(
        spec,
        {
            "version",
            "profile",
            "source_binding",
            "geometry",
            "electronic_settings",
            "optimizer_settings",
            "environment",
            "runtime_binding",
            "basis_binding",
            "resources",
            "spec_hash",
        }
        | ({"isotope_binding"} if spec.get("version") == MASS_BOUND_SPEC_VERSION else set()),
        "refinement spec",
    )
    verify_hash(spec, "spec_hash")
    if spec["version"] not in {SPEC_VERSION, MASS_BOUND_SPEC_VERSION}:
        raise ValueError("UNSUPPORTED_PROFILE: refinement spec version")
    validate_method_profile(spec["profile"])
    geometry = _geometry(spec["geometry"])
    has_isotopes = spec["version"] == MASS_BOUND_SPEC_VERSION
    if has_isotopes != (spec["profile"]["scope"]["isotopes"] == "runtime_defaults_only"):
        raise ValueError("UNSUPPORTED_PROFILE: spec and profile nuclear identity policy differ")
    source = closed(
        spec["source_binding"],
        {
            "kind",
            "source_hash",
            "candidate_hash",
            "atom_identity_hash",
            "geometry_hash",
            "artifact",
        },
        "source binding",
    )
    choice(source["kind"], {"candidate_geometry", "supplied_geometry"}, "geometry source kind")
    digest_id(source["source_hash"])
    if source["kind"] == "candidate_geometry":
        digest_id(source["candidate_hash"])
    elif source["candidate_hash"] is not None:
        raise ValueError("INVALID_ARGUMENT: supplied geometry has no inferred candidate")
    artifact_ref(source["artifact"])
    if source["geometry_hash"] != geometry["geometry_hash"] or source[
        "atom_identity_hash"
    ] != content_hash(_identity(geometry)):
        raise ValueError("APPROVAL_STALE: source geometry or atom identity mismatch")
    electronic = closed(
        spec["electronic_settings"],
        {"native_keywords", "functional_definition_hash", "effective_options_artifact"},
        "electronic settings",
    )
    digest_id(electronic["functional_definition_hash"])
    artifact_ref(electronic["effective_options_artifact"])
    keywords = electronic["native_keywords"]
    base = {
        "reference",
        "scf_type",
        "e_convergence",
        "d_convergence",
        "maxiter",
        "fail_on_maxiter",
        "dft_radial_points",
        "dft_spherical_points",
        "dft_pruning_scheme",
        "dft_density_tolerance",
    }
    if spec["profile"]["method"] == "wb97x-v":
        base |= {"dft_vv10_radial_points", "dft_vv10_spherical_points"}
    else:
        base.add("puream")
    if not isinstance(keywords, dict):
        raise ValueError("INVALID_ARGUMENT: native keywords must be an object")
    closed(
        keywords,
        base
        | ({"function_kwargs"} if "function_kwargs" in keywords else set())
        | ({"df_basis_scf"} if keywords.get("scf_type") == "df" else set())
        | ({"ints_tolerance", "df_scf_guess"} if keywords.get("scf_type") == "direct" else set()),
        "native keywords",
    )
    choice(keywords["scf_type"], {"pk", "df", "direct"}, "SCF algorithm")
    if "puream" in keywords and keywords["puream"] is not True:
        raise ValueError("UNSUPPORTED_PROFILE: explicit spherical basis functions required")
    if "function_kwargs" in keywords:
        expected_driver = gradient_driver_arguments(spec["profile"])
        driver = closed(
            keywords["function_kwargs"], set(expected_driver), "gradient driver arguments"
        )
        if type(driver["dertype"]) is not int or driver != expected_driver:
            raise ValueError("UNSUPPORTED_PROFILE: only an explicit analytic gradient is admitted")
    elif has_isotopes:
        raise ValueError(
            "UNSUPPORTED_PROFILE: versioned analytic profile requires explicit driver arguments"
        )
    if keywords["scf_type"] == "direct":
        tolerance = keywords["ints_tolerance"]
        if (
            type(tolerance) not in (int, float)
            or not Decimal(str(tolerance)).is_finite()
            or not Decimal("0") < Decimal(str(tolerance)) <= Decimal("0.000000000001")
            or keywords["df_scf_guess"] is not False
        ):
            raise ValueError(
                "UNSUPPORTED_PROFILE: DIRECT requires explicit integral tolerance <= 1e-12 "
                "and disabled DF preconvergence"
            )
    if keywords["reference"] != "rks" or keywords["fail_on_maxiter"] is not True:
        raise ValueError("UNSUPPORTED_PROFILE: explicit RKS and SCF failure handling required")
    for key in ("e_convergence", "d_convergence"):
        item = keywords[key]
        if type(item) not in {int, float} or not Decimal("0") < Decimal(str(item)) <= Decimal(
            "0.000001"
        ):
            raise ValueError(
                "INVALID_ARGUMENT: SCF thresholds must be finite, positive and <= 1e-6"
            )
    integer(keywords["maxiter"], 1, 1000, "SCF iterations")
    integer(keywords["dft_radial_points"], 1, 10000, "radial grid points")
    integer(keywords["dft_spherical_points"], 1, 10000, "spherical grid points")
    if spec["profile"]["method"] == "wb97x-v":
        integer(keywords["dft_vv10_radial_points"], 1, 10000, "VV10 radial grid points")
        integer(keywords["dft_vv10_spherical_points"], 1, 10000, "VV10 spherical grid points")
    density = keywords["dft_density_tolerance"]
    if (
        type(density) not in {int, float}
        or not Decimal(str(density)).is_finite()
        or not Decimal("0") < Decimal(str(density)) <= Decimal("0.000001")
    ):
        raise ValueError(
            "INVALID_ARGUMENT: DFT density tolerance must be finite, positive and <= 1e-6"
        )
    text_id(keywords["dft_pruning_scheme"], "DFT pruning scheme")
    if keywords["scf_type"] == "df":
        text_id(keywords["df_basis_scf"], "explicit auxiliary basis")
    optimizer = closed(
        spec["optimizer_settings"],
        {
            "engine",
            "coordinates",
            "criteria",
            "flexible_g_convergence",
            "maximum_iterations",
            "max_gradient_evaluations",
        },
        "optimizer settings",
    )
    if (
        optimizer["engine"] != "optking"
        or optimizer["coordinates"] != "cartesian"
        or optimizer["flexible_g_convergence"] is not False
    ):
        raise ValueError(
            "UNSUPPORTED_PROFILE: explicit Cartesian OptKing with all criteria required"
        )
    criteria = closed(optimizer["criteria"], _CRITERIA_KEYS, "optimization criteria")
    for threshold in criteria.values():
        if not Decimal("0") < _decimal(threshold, "1"):
            raise ValueError(
                "INVALID_ARGUMENT: strictly positive explicit optimization thresholds required"
            )
    integer(optimizer["maximum_iterations"], 1, 1000, "optimizer iterations")
    integer(optimizer["max_gradient_evaluations"], 1, 4000, "gradient evaluations")
    if spec["environment"] != {
        "boundary": "isolated",
        "phase": "gas",
        "solvent": None,
        "physical_temperature_kelvin": None,
    }:
        raise ValueError(
            "UNSUPPORTED_PROFILE: isolated gas-phase PES, no physical temperature assigned"
        )
    _binding(spec["runtime_binding"], False)
    _binding(spec["basis_binding"], True)
    if has_isotopes:
        validate_isotope_binding(spec["isotope_binding"], geometry, spec["runtime_binding"])
    resources = closed(
        spec["resources"],
        {
            "wall_seconds",
            "memory_bytes",
            "cpu_seconds",
            "threads",
            "max_output_bytes",
            "backend_retry_policy",
        },
        "resources",
    )
    for key, maximum in (
        ("wall_seconds", 86400),
        ("memory_bytes", 1024**4),
        ("cpu_seconds", 86400),
        ("threads", 256),
        ("max_output_bytes", 1024**3),
    ):
        integer(resources[key], 1, maximum, key)
    policy = closed(
        resources["backend_retry_policy"],
        {"requested_retries", "effective_retries", "accounting"},
        "retry policy",
    )
    integer(policy["requested_retries"], 0, 10, "requested retries")
    integer(policy["effective_retries"], 0, 10, "effective retries")
    if policy["accounting"] != "observe_every_backend_attempt":
        raise ValueError("UNSUPPORTED_PROFILE: backend retry accounting required")
    return spec


def _json_object(text: object) -> dict[str, Any]:
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_RAW_BYTES:
        raise ValueError("RESOURCE_LIMIT: raw JSON must be a string <= 1 MiB")

    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, item in items:
            if key in value:
                raise ValueError("INVALID_ARGUMENT: duplicate raw JSON key")
            value[key] = item
        return value

    def constant(_: str) -> None:
        raise ValueError("INVALID_ARGUMENT: nonfinite raw JSON constant")

    try:
        result = json.loads(
            text, object_pairs_hook=pairs, parse_float=Decimal, parse_constant=constant
        )
    except (json.JSONDecodeError, RecursionError) as error:
        raise ValueError("INVALID_ARGUMENT: malformed raw JSON") from error
    if not isinstance(result, dict):
        raise ValueError("INVALID_ARGUMENT: raw JSON must be an object")
    return result


def _raw_decimal(value: object) -> Decimal:
    if type(value) is not int and type(value) is not Decimal:
        raise ValueError("INVALID_ARGUMENT: raw QCSchema number required")
    parsed = Decimal(value)
    if not parsed.is_finite() or parsed.copy_abs() > Decimal("1000000000"):
        raise ValueError("INVALID_ARGUMENT: raw value nonfinite or out of bounds")
    return parsed


def _same_typed_json(actual: object, expected: object) -> bool:
    """Compare parsed JSON without Python's bool/int equality coercion.

    Integer options remain integers. Decimal expectations admit an equal JSON
    integer or decimal number, but never a boolean. Parsing already excludes
    nonfinite JSON values; strings, null and booleans retain their exact types.
    """
    if isinstance(expected, dict):
        return (
            isinstance(actual, dict)
            and set(actual) == set(expected)
            and all(_same_typed_json(actual[key], value) for key, value in expected.items())
        )
    if isinstance(expected, list):
        return (
            isinstance(actual, list)
            and len(actual) == len(expected)
            and all(
                _same_typed_json(item, wanted)
                for item, wanted in zip(actual, expected, strict=False)
            )
        )
    if type(expected) is Decimal:
        return type(actual) in {int, Decimal} and actual == expected
    return type(actual) is type(expected) and actual == expected


def _gradient(value: object, count: int, raw: bool = False) -> list[Decimal]:
    if not isinstance(value, list):
        raise ValueError("INVALID_ARGUMENT: gradient must be an array")
    if len(value) == count and all(isinstance(row, list) and len(row) == 3 for row in value):
        flat = [part for row in value for part in row]
    elif raw and len(value) == count * 3 and not any(isinstance(part, list) for part in value):
        flat = value
    else:
        raise ValueError("INVALID_ARGUMENT: gradient shape does not match atoms")
    return [_raw_decimal(part) if raw else _decimal(part) for part in flat]


def _raw_geometry(
    value: object, geometry: dict[str, Any], isotope_binding: dict[str, Any] | None = None
) -> None:
    if not isinstance(value, dict):
        raise ValueError("INVALID_ARGUMENT: raw molecule required")
    atoms = geometry["atoms"]
    if value.get("symbols") != [atom["element"] for atom in atoms] or value.get("atom_labels") != [
        atom["id"] for atom in atoms
    ]:
        raise ValueError("APPROVAL_STALE: raw evaluated atom identity or order mismatch")
    # QCSchema omission means all real; an explicit mask is strict JSON bools.
    if "real" in value and (
        not isinstance(value["real"], list)
        or len(value["real"]) != len(atoms)
        or any(real is not True for real in value["real"])
    ):
        raise ValueError(
            "UNSUPPORTED_PROFILE: every evaluated atom must be real; ghost centers are not admitted"
        )
    if "atomic_numbers" in value and value["atomic_numbers"] is not None:
        numbers = value["atomic_numbers"]
        if (
            not isinstance(numbers, list)
            or len(numbers) != len(atoms)
            or any(
                type(actual) is not int or actual != ELEMENT_NUMBERS[atom["element"]]
                for actual, atom in zip(numbers, atoms, strict=False)
            )
        ):
            raise ValueError("APPROVAL_STALE: raw nuclear charges differ from bound elements")
    if isotope_binding is not None:
        validate_raw_isotopes(value, isotope_binding)
    elif any(value.get(key) is not None for key in ("masses", "mass_numbers")):
        raise ValueError(
            "UNSUPPORTED_PROFILE: explicit isotope or mass data requires a separately bound profile"
        )
    if (
        _raw_decimal(value.get("molecular_charge")) != geometry["charge"]
        or type(value.get("molecular_multiplicity")) is not int
        or value["molecular_multiplicity"] != geometry["multiplicity"]
    ):
        raise ValueError("APPROVAL_STALE: raw evaluated electronic state mismatch")
    if value.get("fix_com") is not True or value.get("fix_orientation") is not True:
        raise ValueError("UNSUPPORTED_PROFILE: raw evaluated coordinate frame must be fixed")
    coordinates = value.get("geometry")
    if not isinstance(coordinates, list) or len(coordinates) != len(atoms) * 3:
        raise ValueError("INVALID_ARGUMENT: raw geometry must be flat QCSchema bohr coordinates")
    with localcontext() as context:
        context.prec = 80
        expected = [
            _decimal(part, "1000") * Decimal(ANGSTROM_TO_BOHR)
            for atom in atoms
            for part in atom["position"]
        ]
        if any(
            abs(_raw_decimal(actual) - wanted) > Decimal("0.0000001")
            for actual, wanted in zip(coordinates, expected, strict=False)
        ):
            raise ValueError("APPROVAL_STALE: evaluated coordinate mismatch")
    # The tolerance is JSON/unit-conversion representation tolerance, not accuracy.


def _embedded(
    text: object, artifact_id: object, artifacts: dict[str, dict[str, Any]], role: str
) -> dict[str, Any]:
    identity = text_id(artifact_id, "raw artifact ID")
    if identity not in artifacts or artifacts[identity]["role"] != role:
        raise ValueError("INVALID_ARGUMENT: missing raw artifact or wrong role")
    parsed = _json_object(text)
    if not isinstance(text, str):
        raise ValueError("RESOURCE_LIMIT: raw JSON must be a string <= 1 MiB")
    if hashlib.sha256(text.encode("utf-8")).hexdigest() != artifacts[identity]["sha256"]:
        raise ValueError("APPROVAL_STALE: embedded raw JSON differs from referenced bytes")
    return parsed


def seal_refinement_frame(body: object) -> dict[str, Any]:
    """Hash a frame body; complete scientific binding requires result validation."""
    return _seal(body, "frame_hash")


def _frame(
    spec: dict[str, Any], value: object, index: int, artifacts: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    frame = closed(
        value,
        {
            "version",
            "evaluation_index",
            "optimizer_iteration",
            "step_status",
            "reevaluates_frame_hash",
            "geometry",
            "energy_hartree",
            "gradient_hartree_per_bohr",
            "elapsed_wall_seconds",
            "physical_time_s",
            "raw_input_json",
            "raw_result_json",
            "raw_input_artifact_id",
            "raw_result_artifact_id",
            "frame_hash",
        },
        "trajectory frame",
    )
    verify_hash(frame, "frame_hash")
    if (
        frame["version"] != FRAME_VERSION
        or type(frame["evaluation_index"]) is not int
        or frame["evaluation_index"] != index
    ):
        raise ValueError("INVALID_ARGUMENT: frame version or contiguous evaluation index mismatch")
    if frame["optimizer_iteration"] is not None:
        integer(
            frame["optimizer_iteration"],
            0,
            spec["optimizer_settings"]["maximum_iterations"],
            "optimizer iteration",
        )
    choice(frame["step_status"], _STEP_STATUSES, "step attribution")
    if frame["optimizer_iteration"] is None and frame["step_status"] != "unknown":
        raise ValueError(
            "INVALID_ARGUMENT: unknown iteration cannot carry invented step attribution"
        )
    if frame["step_status"] == "initial" and index != 0:
        raise ValueError("INVALID_ARGUMENT: initial attribution belongs only to first evaluation")
    if frame["step_status"] == "reevaluation":
        digest_id(frame["reevaluates_frame_hash"])
    elif frame["reevaluates_frame_hash"] is not None:
        raise ValueError(
            "INVALID_ARGUMENT: only reevaluations can reference an accepted evaluation"
        )
    if frame["physical_time_s"] is not None:
        raise ValueError("UNSUPPORTED_PROFILE: optimization frames have no physical time")
    _decimal(frame["elapsed_wall_seconds"], "86400", True)
    geometry = _geometry(frame["geometry"])
    if _identity(geometry) != _identity(spec["geometry"]):
        raise ValueError("APPROVAL_STALE: stable atom IDs or ordering changed")
    if index == 0 and geometry != spec["geometry"]:
        raise ValueError(
            "APPROVAL_STALE: first evaluated geometry differs from exact supplied coordinates"
        )
    energy = _decimal(frame["energy_hartree"])
    gradient = _gradient(frame["gradient_hartree_per_bohr"], len(geometry["atoms"]))
    raw_input = _embedded(
        frame["raw_input_json"], frame["raw_input_artifact_id"], artifacts, "atomic_input"
    )
    raw_result = _embedded(
        frame["raw_result_json"], frame["raw_result_artifact_id"], artifacts, "atomic_result"
    )
    for record, schema in ((raw_input, "qcschema_input"), (raw_result, "qcschema_output")):
        if (
            record.get("schema_name") != schema
            or type(record.get("schema_version")) is not int
            or record["schema_version"] != 1
            or record.get("driver") != "gradient"
        ):
            raise ValueError("UNSUPPORTED_PROFILE: explicit QCSchema v1 gradient envelope required")
        if record.get("model") != {
            "method": spec["profile"]["method"],
            "basis": spec["profile"]["basis"],
        }:
            raise ValueError("APPROVAL_STALE: raw method or basis mismatch")
        # Parse expected keywords identically, avoiding binary-float/Decimal equality artifacts.
        if not _same_typed_json(
            record.get("keywords"),
            _json_object(json.dumps(spec["electronic_settings"]["native_keywords"])),
        ):
            raise ValueError("APPROVAL_STALE: raw electronic keywords mismatch")
        _raw_geometry(record.get("molecule"), geometry, spec.get("isotope_binding"))
    if raw_result.get("success") is not True:
        raise ValueError(
            "INVALID_ARGUMENT: retained trajectory contains only successful gradient evaluations"
        )
    properties = raw_result.get("properties")
    if not isinstance(properties, dict) or _raw_decimal(properties.get("return_energy")) != energy:
        raise ValueError("APPROVAL_STALE: evaluated energy differs from raw AtomicResult")
    if _gradient(raw_result.get("return_result"), len(geometry["atoms"]), True) != gradient:
        raise ValueError("APPROVAL_STALE: evaluated gradient differs from raw AtomicResult")
    provenance = raw_result.get("provenance")
    if (
        not isinstance(provenance, dict)
        or str(provenance.get("creator", "")).lower() != "psi4"
        or provenance.get("version") != spec["runtime_binding"]["versions"]["psi4"]
    ):
        raise ValueError("APPROVAL_STALE: result engine/version provenance mismatch")
    return frame


def _metrics(
    previous: dict[str, Any], accepted: dict[str, Any], final: dict[str, Any]
) -> dict[str, Decimal]:
    with localcontext() as context:
        context.prec = 80
        gradient = _gradient(final["gradient_hartree_per_bohr"], len(final["geometry"]["atoms"]))
        displacement = [
            (_decimal(b, "1000") - _decimal(a, "1000")) * Decimal(ANGSTROM_TO_BOHR)
            for old, new in zip(
                previous["geometry"]["atoms"], accepted["geometry"]["atoms"], strict=False
            )
            for a, b in zip(old["position"], new["position"], strict=False)
        ]
        return {
            "max_force_hartree_per_bohr": max(abs(v) for v in gradient),
            "rms_force_hartree_per_bohr": (
                sum((v * v for v in gradient), Decimal(0)) / len(gradient)
            ).sqrt(),
            "max_displacement_bohr": max(abs(v) for v in displacement),
            "rms_displacement_bohr": (
                sum((v * v for v in displacement), Decimal(0)) / len(displacement)
            ).sqrt(),
        }


def seal_refinement_result(spec: object, body: object) -> dict[str, Any]:
    return validate_refinement_result(spec, _seal(body, "result_hash"))


def validate_refinement_result(spec: object, value: object) -> dict[str, Any]:
    spec = validate_refinement_spec(spec)
    result = _detach(value)
    closed(
        result,
        {
            "version",
            "spec_hash",
            "state",
            "evidence_origin",
            "runtime_binding_hash",
            "basis_binding_hash",
            "trajectory",
            "final_frame_hash",
            "convergence",
            "timing",
            "failure",
            "raw_artifacts",
            "result_hash",
        },
        "refinement result",
    )
    verify_hash(result, "result_hash")
    if (
        result["version"] != RESULT_VERSION
        or result["spec_hash"] != spec["spec_hash"]
        or result["runtime_binding_hash"] != spec["runtime_binding"]["binding_hash"]
        or result["basis_binding_hash"] != spec["basis_binding"]["binding_hash"]
    ):
        raise ValueError("APPROVAL_STALE: result/spec/runtime/basis binding mismatch")
    choice(
        result["state"],
        {"succeeded", "incomplete", "failed", "cancelled", "resource_limit"},
        "refinement result state",
    )
    choice(
        result["evidence_origin"],
        {"worker_record", "imported_unverified", "synthetic_validation"},
        "evidence origin",
    )
    refs = result["raw_artifacts"]
    if not isinstance(refs, list) or len(refs) > 16010:
        raise ValueError("RESOURCE_LIMIT: invalid raw artifact inventory")
    artifacts: dict[str, dict[str, Any]] = {}
    paths: set[str] = set()
    for reference in refs:
        reference = closed(reference, {"artifact_id", "role", "path", "sha256"}, "raw artifact")
        identity = text_id(reference["artifact_id"], "artifact ID")
        artifact_ref({"path": reference["path"], "sha256": reference["sha256"]})
        choice(
            reference["role"],
            {
                "atomic_input",
                "atomic_result",
                "optimizer_observation",
                "optimizer_raw",
                "backend_attempt",
                "failure",
                "log",
            },
            "raw artifact role",
        )
        if identity in artifacts or reference["path"].casefold() in paths:
            raise ValueError("INVALID_ARGUMENT: duplicate artifact or unknown role")
        artifacts[identity] = reference
        paths.add(reference["path"].casefold())
    frames = result["trajectory"]
    if (
        not isinstance(frames, list)
        or len(frames) > spec["optimizer_settings"]["max_gradient_evaluations"]
    ):
        raise ValueError("RESOURCE_LIMIT: too many gradient evaluations")
    seen_raw: set[str] = set()
    last_time = Decimal(0)
    accepted: list[dict[str, Any]] = []
    for index, item in enumerate(frames):
        frame = _frame(spec, item, index, artifacts)
        wall = _decimal(frame["elapsed_wall_seconds"], "86400", True)
        iteration = frame["optimizer_iteration"]
        if wall < last_time:
            raise ValueError("INVALID_ARGUMENT: trajectory clocks are not monotonic")
        last_time = wall
        # Iteration identifies an attributed optimizer step, not event time. A
        # reevaluation may return to accepted step 1 after rejected step 2.
        # Event order is already bound by contiguous evaluation_index and wall.
        if frame["step_status"] in {"initial", "accepted"}:
            if accepted and iteration <= accepted[-1]["optimizer_iteration"]:
                raise ValueError(
                    "INVALID_ARGUMENT: distinct accepted steps require strictly increasing "
                    "optimizer iterations"
                )
            accepted.append(frame)
        elif frame["step_status"] == "reevaluation":
            if (
                not accepted
                or frame["reevaluates_frame_hash"] != accepted[-1]["frame_hash"]
                or iteration != accepted[-1]["optimizer_iteration"]
                or frame["geometry"]["geometry_hash"] != accepted[-1]["geometry"]["geometry_hash"]
            ):
                raise ValueError(
                    "APPROVAL_STALE: reevaluation must bind the latest accepted step and its "
                    "exact geometry"
                )
        for key in ("raw_input_artifact_id", "raw_result_artifact_id"):
            if frame[key] in seen_raw:
                raise ValueError("INVALID_ARGUMENT: evaluation raw artifacts must be distinct")
            seen_raw.add(frame[key])
    expected_final = frames[-1]["frame_hash"] if frames else None
    if result["final_frame_hash"] != expected_final:
        raise ValueError("APPROVAL_STALE: final frame must be the last retained evaluated frame")
    timing = closed(
        result["timing"],
        {"clock", "elapsed_seconds", "physical_duration_seconds", "backend_attempts_observed"},
        "timing",
    )
    elapsed = _decimal(timing["elapsed_seconds"], "86400", True)
    if (
        timing["clock"] != "wall"
        or timing["physical_duration_seconds"] is not None
        or elapsed < last_time
    ):
        raise ValueError("INVALID_ARGUMENT: timing conflicts with optimizer clock")
    attempts = timing["backend_attempts_observed"]
    if attempts is not None:
        integer(attempts, 0, 44000, "observed backend attempts")
        if attempts < len(frames) or attempts != sum(
            ref["role"] == "backend_attempt" for ref in refs
        ):
            raise ValueError("INVALID_ARGUMENT: observed attempt count lacks per-attempt inventory")
    convergence = closed(
        result["convergence"],
        {
            "geometry_status",
            "minimum_status",
            "optimizer_reported_converged",
            "optimizer_observation_json",
            "optimizer_observation_artifact_id",
        },
        "convergence",
    )
    choice(
        convergence["geometry_status"],
        {"satisfied", "not_satisfied", "not_checked"},
        "geometric convergence status",
    )
    if convergence["minimum_status"] != "not_evaluated":
        raise ValueError("UNSUPPORTED_PROFILE: geometry convergence cannot certify a minimum")
    reported = convergence["optimizer_reported_converged"]
    if reported is not None and type(reported) is not bool:
        raise ValueError("INVALID_ARGUMENT: optimizer report must be boolean or unknown")
    observation = None
    if convergence["optimizer_observation_json"] is not None:
        observation = _embedded(
            convergence["optimizer_observation_json"],
            convergence["optimizer_observation_artifact_id"],
            artifacts,
            "optimizer_observation",
        )
        closed(
            observation,
            {
                "version",
                "spec_hash",
                "engine",
                "reported_converged",
                "final_frame_hash",
                "attributions",
                "backend_attempts_observed",
                "source_artifact_ids",
            },
            "optimizer observation",
        )
        if (
            observation["reported_converged"] is not None
            and type(observation["reported_converged"]) is not bool
        ):
            raise ValueError("INVALID_ARGUMENT: raw optimizer convergence is boolean or unknown")
        if observation["backend_attempts_observed"] is not None:
            integer(
                observation["backend_attempts_observed"], 0, 44000, "raw observed backend attempts"
            )
        if (
            observation["version"] != OBSERVATION_VERSION
            or observation["engine"] != "optking"
            or observation["spec_hash"] != spec["spec_hash"]
            or observation["final_frame_hash"] != expected_final
            or observation["reported_converged"] != reported
            or observation["backend_attempts_observed"] != attempts
        ):
            raise ValueError("APPROVAL_STALE: optimizer observation binding mismatch")
        expected_attributions = [
            {
                key: frame[key]
                for key in (
                    "frame_hash",
                    "optimizer_iteration",
                    "step_status",
                    "reevaluates_frame_hash",
                )
            }
            for frame in frames
        ]
        attributions = observation["attributions"]
        if not isinstance(attributions, list) or len(attributions) != len(expected_attributions):
            raise ValueError(
                "INVALID_ARGUMENT: optimizer attributions must match the retained frame count"
            )
        for attribution in attributions:
            attribution = closed(
                attribution,
                {"frame_hash", "optimizer_iteration", "step_status", "reevaluates_frame_hash"},
                "optimizer attribution",
            )
            digest_id(attribution["frame_hash"])
            if attribution["optimizer_iteration"] is not None:
                integer(
                    attribution["optimizer_iteration"],
                    0,
                    spec["optimizer_settings"]["maximum_iterations"],
                    "attributed optimizer iteration",
                )
            choice(attribution["step_status"], _STEP_STATUSES, "attributed optimizer step status")
            if attribution["reevaluates_frame_hash"] is not None:
                digest_id(attribution["reevaluates_frame_hash"])
        if attributions != expected_attributions:
            raise ValueError("APPROVAL_STALE: optimizer evaluation/step attribution mismatch")
        sources = observation["source_artifact_ids"]
        if (
            not isinstance(sources, list)
            or not sources
            or any(
                not isinstance(identity, str)
                or identity not in artifacts
                or artifacts[identity]["role"] != "optimizer_raw"
                for identity in sources
            )
            or len(sources) != len(set(sources))
        ):
            raise ValueError("INVALID_ARGUMENT: original optimizer evidence references required")
    elif (
        convergence["optimizer_observation_artifact_id"] is not None
        or reported is not None
        or any(
            frame["step_status"] != "unknown" or frame["optimizer_iteration"] is not None
            for frame in frames
        )
    ):
        raise ValueError(
            "INVALID_ARGUMENT: optimizer report/attribution requires a bound observation"
        )
    # A final reevaluation supplies a newer evaluated gradient, not another move.
    checked = (
        observation is not None
        and len(accepted) >= 2
        and (
            frames[-1] is accepted[-1]
            or (
                frames[-1]["step_status"] == "reevaluation"
                and frames[-1]["reevaluates_frame_hash"] == accepted[-1]["frame_hash"]
            )
        )
    )
    if checked and any(
        frame["step_status"] == "unknown"
        for frame in frames[accepted[-2]["evaluation_index"] + 1 :]
    ):
        checked = False  # An unclassified intermediate evaluation could hide a move.
    status = "not_checked"
    if checked:
        metrics = _metrics(accepted[-2], accepted[-1], frames[-1])
        status = (
            "satisfied"
            if all(
                value <= _decimal(spec["optimizer_settings"]["criteria"][key], "1")
                for key, value in metrics.items()
            )
            else "not_satisfied"
        )
    if convergence["geometry_status"] != status:
        raise ValueError(
            "APPROVAL_STALE: reported geometric convergence differs from evaluated-frame criteria"
        )
    if result["state"] == "succeeded" and (
        status != "satisfied"
        or reported is not True
        or attempts is None
        or result["evidence_origin"] == "imported_unverified"
    ):
        raise ValueError(
            "INVALID_ARGUMENT: successful state lacks bound convergence/attempt evidence"
        )
    if result["state"] == "succeeded" and attempts > len(frames) * (
        spec["resources"]["backend_retry_policy"]["effective_retries"] + 1
    ):
        raise ValueError("INVALID_ARGUMENT: successful run exceeds declared backend attempt budget")
    failure = result["failure"]
    if failure is not None:
        failure = closed(
            failure,
            {"phase", "code", "message", "last_evaluated_frame_hash", "artifact_id"},
            "failure",
        )
        choice(
            failure["phase"],
            {"preflight", "scf", "gradient", "optimization", "supervisor", "validation"},
            "failure phase",
        )
        text_id(failure["code"], "failure code")
        if not isinstance(failure["message"], str) or not 1 <= len(failure["message"]) <= 4096:
            raise ValueError("INVALID_ARGUMENT: bounded failure message required")
        if (
            failure["last_evaluated_frame_hash"] != expected_final
            or not isinstance(failure["artifact_id"], str)
            or failure["artifact_id"] not in artifacts
            or artifacts[failure["artifact_id"]]["role"] != "failure"
        ):
            raise ValueError("APPROVAL_STALE: failure evaluated-frame/evidence binding mismatch")
    if result["state"] in {"failed", "cancelled", "resource_limit"} and failure is None:
        raise ValueError("INVALID_ARGUMENT: terminal failure evidence required")
    if result["state"] == "succeeded" and failure is not None:
        raise ValueError("INVALID_ARGUMENT: successful result cannot contain terminal failure")
    return result


def raw_energy_comparison_key(value: object, result: object = None) -> dict[str, Any]:
    """Return shared physical grouping plus this member's exact coordinate binding.

    Geometry hashes intentionally differ between conformers; comparing the entire
    returned object would incorrectly require identical geometries. Composition,
    stable atom identity, electronic state and Hamiltonian must match group_hash.
    """
    spec = validate_refinement_spec(value)
    evaluated = validate_refinement_result(spec, result) if result is not None else None
    if evaluated is not None and evaluated["state"] != "succeeded":
        raise ValueError(
            "UNSUPPORTED_COMPARISON: result comparison requires successful geometric convergence"
        )
    counts = Counter(atom["element"] for atom in spec["geometry"]["atoms"])
    elements = (["C", "H"] if "H" in counts else ["C"]) + sorted(
        e for e in counts if e not in {"C", "H"}
    )
    formula = "".join(
        element + (str(counts[element]) if counts[element] != 1 else "") for element in elements
    )
    group = {
        "version": "raw-electronic-energy-comparison/v2",
        "formula": formula,
        "composition": {element: counts[element] for element in sorted(counts)},
        "atom_identity": sorted(_identity(spec["geometry"])),
        "charge": spec["geometry"]["charge"],
        "multiplicity": spec["geometry"]["multiplicity"],
        "profile_hash": spec["profile"]["profile_hash"],
        "electronic_settings": {
            "native_keywords": spec["electronic_settings"]["native_keywords"],
            "functional_definition_hash": spec["electronic_settings"]["functional_definition_hash"],
            "effective_options_sha256": spec["electronic_settings"]["effective_options_artifact"][
                "sha256"
            ],
        },
        "environment": spec["environment"],
        "runtime_binding_hash": spec["runtime_binding"]["binding_hash"],
        "basis_binding_hash": spec["basis_binding"]["binding_hash"],
        "quantity": "electronic_energy_hartree",
    }
    return {
        "group_hash": content_hash(group),
        "group": group,
        "spec_hash": spec["spec_hash"],
        "geometry_hash": evaluated["trajectory"][-1]["geometry"]["geometry_hash"]
        if evaluated
        else spec["geometry"]["geometry_hash"],
        "coordinate_role": "final_evaluated" if evaluated else "input_only",
        "result_hash": evaluated["result_hash"] if evaluated else None,
        "frame_hash": evaluated["final_frame_hash"] if evaluated else None,
        "evidence_origin": evaluated["evidence_origin"] if evaluated else None,
    }


def validate_raw_energy_comparison(values: object, results: object = None) -> list[dict[str, Any]]:
    """Admit grouping only; this neither ranks results nor proves thermodynamic stability."""
    if not isinstance(values, list) or not 2 <= len(values) <= 100:
        raise ValueError("INVALID_ARGUMENT: comparison requires 2-100 bound specs")
    if results is not None and (not isinstance(results, list) or len(results) != len(values)):
        raise ValueError("INVALID_ARGUMENT: one result required for each comparison spec")
    keys = [
        raw_energy_comparison_key(value, results[index] if results is not None else None)
        for index, value in enumerate(values)
    ]
    if len({item["group_hash"] for item in keys}) != 1:
        raise ValueError(
            "UNSUPPORTED_COMPARISON: raw energies require identical composition, atom identity, "
            "state, environment and method bindings"
        )
    if len({item["evidence_origin"] for item in keys}) != 1:
        raise ValueError(
            "UNSUPPORTED_COMPARISON: synthetic/imported/worker origins cannot be mixed"
        )
    return keys
