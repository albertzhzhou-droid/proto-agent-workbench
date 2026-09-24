"""Pure checks of retained installed D3 QCSchema v2 bytes; no native imports."""

from __future__ import annotations

import copy
import json
import math
from decimal import Decimal
from typing import Any

Record = dict[str, Any]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError("CONTRACT_EVIDENCE_REJECTED: " + message)


def parse(raw: bytes) -> Record:
    def pairs(items: list[tuple[str, Any]]) -> Record:
        value: Record = {}
        for key, item in items:
            require(key not in value, "duplicate raw JSON key")
            value[key] = item
        return value

    def invalid(value: str) -> None:
        raise ValueError("Nonfinite raw JSON constant: " + value)

    require(type(raw) is bytes, "actual raw bytes required")
    result = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=invalid)
    require(type(result) is dict, "raw JSON object required")
    # Also reject a finite-looking JSON exponent that overflows binary64.
    json.dumps(result, allow_nan=False)
    return dict(result)


def same(actual: object, expected: object, name: str) -> None:
    require(
        json.dumps(actual, sort_keys=True, allow_nan=False)
        == json.dumps(expected, sort_keys=True, allow_nan=False),
        name + " differs",
    )


def number(value: object) -> Decimal:
    require(type(value) in {int, float}, "raw finite JSON number required; bool/string forbidden")
    require(not isinstance(value, float) or math.isfinite(value), "nonfinite number")
    return Decimal(str(value))


def native_integer(value: object) -> int:
    """Only native molecule multiplicities use exact integral-float compatibility."""
    result = number(value)
    require(result == result.to_integral_value(), "fractional native multiplicity")
    return int(result)


def molecule(value: Record, spec: Record, geometry: Record) -> None:
    atoms = geometry["atoms"]
    isotopes = spec["isotope_binding"]["atoms"]
    require(value.get("schema_name") == "qcschema_molecule", "native molecule schema")
    require(
        type(value.get("schema_version")) is int and value["schema_version"] == 3,
        "native nested molecule schema version",
    )
    same(value.get("symbols"), [atom["element"] for atom in atoms], "symbols")
    same(value.get("atom_labels"), [atom["id"] for atom in atoms], "stable atom IDs")
    same(value.get("real"), [True] * len(atoms), "real atoms")
    same(
        value.get("atomic_numbers"), [atom["atomic_number"] for atom in isotopes], "nuclear charges"
    )
    same(value.get("mass_numbers"), [atom["mass_number"] for atom in isotopes], "mass numbers")
    masses = value.get("masses")
    if not isinstance(masses, list) or len(masses) != len(atoms):
        raise ValueError("complete bound masses required")
    for mass, atom in zip(masses, isotopes, strict=True):
        require(
            number(mass) == Decimal(atom["mass_dalton"]),
            "bound isotope mass differs",
        )
    require(number(value.get("molecular_charge")) == geometry["charge"], "charge differs")
    require(
        native_integer(value.get("molecular_multiplicity")) == geometry["multiplicity"],
        "multiplicity differs",
    )
    same(value.get("fragments"), [list(range(len(atoms)))], "fragment partition")
    charges = value.get("fragment_charges")
    multiplicities = value.get("fragment_multiplicities")
    require(
        type(charges) is list and len(charges) == 1 and number(charges[0]) == geometry["charge"],
        "fragment charge differs",
    )
    require(
        type(multiplicities) is list
        and len(multiplicities) == 1
        and native_integer(multiplicities[0]) == geometry["multiplicity"],
        "fragment multiplicity differs",
    )
    require(
        value.get("fix_com") is True and value.get("fix_orientation") is True,
        "coordinate frame is not fixed",
    )
    coordinates = value.get("geometry")
    expected = [
        Decimal(v) * Decimal(spec["profile"]["angstrom_to_bohr"])
        for atom in atoms
        for v in atom["position"]
    ]
    if not isinstance(coordinates, list) or len(coordinates) != len(expected):
        raise ValueError("flat geometry shape required")
    for actual, wanted in zip(coordinates, expected, strict=True):
        # Same representation-only tolerance as the current product raw geometry contract.
        require(abs(number(actual) - wanted) <= Decimal("1e-7"), "evaluated geometry differs")
    require(value.get("extras", {}) == {}, "unexpected native molecule extras")


def _parameters(actual: object, spec: Record, translated: bool) -> None:
    expected = {
        k: Decimal(v)
        for k, v in spec["profile"]["dispersion"]["parameters"].items()
        if translated or k != "s9"
    }
    if not isinstance(actual, dict) or set(actual) != set(expected):
        raise ValueError("exact dispersion parameters required")
    for key, wanted in expected.items():
        require(number(actual[key]) == wanted, "dispersion parameter differs: " + key)


def request(value: Record, spec: Record, geometry: Record, driver: str, translated: bool) -> None:
    require(value.get("schema_name") == "qcschema_atomic_input", "nested input schema")
    require(
        type(value.get("schema_version")) is int and value["schema_version"] == 2,
        "nested input schema version",
    )
    molecule(value["molecule"], spec, geometry)
    native = value["specification"]
    require(native.get("schema_name") == "qcschema_atomic_specification", "specification schema")
    require(native.get("driver") == driver and driver in {"energy", "gradient"}, "nested driver")
    model = native["model"]
    require(set(model) == {"method", "basis"} and model["basis"] == "(auto)", "dispersion basis")
    expected_method = "wb97x" if translated else "wb97x-d3bj"
    require(
        isinstance(model["method"], str) and model["method"].lower() == expected_method,
        "native dispersion method differs",
    )
    keywords = native["keywords"]
    allowed = {"level_hint", "params_tweaks", "dashcoeff_supplement", "verbose"}
    if not translated:
        allowed.add("apply_qcengine_aliases")
    require(set(keywords) == allowed, "unexpected nested keywords/local overrides")
    require(keywords["level_hint"] == ("d3bj" if translated else "d3bj2b"), "damping level")
    _parameters(keywords["params_tweaks"], spec, translated)
    require(type(keywords["verbose"]) is int and keywords["verbose"] == 1, "native verbosity")
    require(type(keywords["dashcoeff_supplement"]) is dict, "native supplement object")
    if not translated:
        require(keywords["apply_qcengine_aliases"] is True, "explicit alias translation required")
        require(native.get("extras") == {}, "outer nested extras/local override")
    else:
        require(set(native["extras"]) == {"info"}, "translated extras/local override")
        info = native["extras"]["info"]
        require(
            set(info) == {"dashlevel", "dashparams", "fctldash", "dashparams_citation"},
            "translated dispersion information fields",
        )
        require(
            info["dashlevel"] == "d3bj2b" and info["fctldash"].lower() == "wb97x-d3bj",
            "translated dispersion identity",
        )
        _parameters(info["dashparams"], spec, True)
        require(isinstance(info["dashparams_citation"], str), "native citation type")
    require(value.get("extras", {}) == {}, "outer local-config override")
    require(native.get("program") == "", "unexpected native specification program")
    provenance = value["provenance"]
    require(
        provenance.get("creator") == "Psi4"
        and provenance.get("version") == spec["runtime_binding"]["versions"]["psi4"],
        "request Psi4 provenance",
    )


def _numeric_equal(actual: object, expected: object) -> None:
    if type(expected) is list:
        if not isinstance(actual, list) or len(actual) != len(expected):
            raise ValueError("numeric result shape differs")
        for first, second in zip(actual, expected, strict=True):
            _numeric_equal(first, second)
    else:
        require(
            abs(number(actual) - number(expected)) <= Decimal("1e-12"),
            "bridge/inner numerical result differs",
        )


def result(value: Record, translated_input: Record, driver: str, native_version: str) -> None:
    require(value.get("schema_name") == "qcschema_atomic_result", "nested result schema")
    require(
        type(value.get("schema_version")) is int and value["schema_version"] == 2,
        "nested result schema version",
    )
    require(value.get("success") is True, "returned native failure is not successful coverage")
    # Installed QCEngine returns the translated wb97x/d3bj request in input_data.
    same(value.get("input_data"), translated_input, "actual returned translated input_data")
    same(value.get("molecule"), translated_input["molecule"], "returned molecule")
    provenance = value["provenance"]
    require(
        provenance.get("creator") == "s-dftd3" and provenance.get("version") == native_version,
        "bound s-dftd3 provenance",
    )
    if "retries" in provenance:
        require(
            type(provenance["retries"]) is int and provenance["retries"] == 0,
            "returned retry provenance contradicts zero retries",
        )
    energy = value["properties"]["return_energy"]
    number(energy)
    library = value["extras"]["dftd3"]
    _numeric_equal(library["energy"], energy)
    if driver == "energy":
        _numeric_equal(value["return_result"], energy)
    else:
        gradient = value["return_result"]
        count = len(translated_input["molecule"]["symbols"])
        require(
            type(gradient) is list and len(gradient) == 3 * count,
            "installed QCSchema v2 gradient must be flat 3N",
        )
        for coordinate in gradient:
            number(coordinate)
        library_gradient = library["gradient"]
        require(
            type(library_gradient) is list and len(library_gradient) == count,
            "native library gradient row count",
        )
        for row in library_gradient:
            require(type(row) is list and len(row) == 3, "native library gradient must be N by 3")
        _numeric_equal([v for row in library_gradient for v in row], gradient)


def validate_call(
    *,
    outer_request: bytes,
    inner_request: bytes,
    outer_result: bytes,
    inner_result: bytes,
    spec: Record,
    geometry: Record,
    driver: str,
    native_version: str,
) -> None:
    """Check one real bridge/inner pair from original bytes, without rewriting them."""
    outer, inner = parse(outer_request), parse(inner_request)
    request(outer, spec, geometry, driver, False)
    request(inner, spec, geometry, driver, True)
    # Only the observed explicit alias transformation may change the request.
    projected = copy.deepcopy(outer)
    projected["specification"]["model"] = inner["specification"]["model"]
    projected["specification"]["keywords"].pop("apply_qcengine_aliases")
    projected["specification"]["keywords"]["level_hint"] = "d3bj"
    projected["specification"]["keywords"]["params_tweaks"] = inner["specification"]["keywords"][
        "params_tweaks"
    ]
    projected["specification"]["extras"] = inner["specification"]["extras"]
    same(projected, inner, "exact installed alias translation")
    qce, native = parse(outer_result), parse(inner_result)
    result(qce, inner, driver, native_version)
    result(native, inner, driver, native_version)
    _numeric_equal(qce["return_result"], native["return_result"])
    _numeric_equal(qce["properties"]["return_energy"], native["properties"]["return_energy"])
