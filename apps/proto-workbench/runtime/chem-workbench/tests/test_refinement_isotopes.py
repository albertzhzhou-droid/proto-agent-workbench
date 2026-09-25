"""Pure isotope contracts on retained complex geometry; no calculation/runtime imports.

Geometry: first target organic_4e7c7a1515dbac54, a generated 34-atom catechol
amide candidate, copied exactly from build/refinement-complex-cohort-20260913.json
(raw SHA256 60b5e69850e1bed2f6d6949e8c5c016ea237e700c968d698d0ff5b124a200403).
This is retained ETKDG input geometry, not an optimized or measured structure.
Default arrays: actual Psi4 Molecule.to_schema molecule retained within
build/refinement-native-atomic-serialization-20260913.json, field
reparsed_atomic_result_json.molecule (raw SHA256
a0efaf9eba133f8b29f73f400fe037f98fd2b1f005d637382ee87357aa120e27).
That record's energy/gradient container was synthetic; none of its energy or
gradient values are copied here. Tests use copied native mass data with a
synthetic runtime-binding fixture and do not certify scientific accuracy.
"""

import copy
import json
from decimal import Decimal

import pytest
from test_molecular_refinement import _spec, _without

from chem_workbench import molecular_refinement as refinement
from chem_workbench.method_profiles import (
    ANGSTROM_TO_BOHR,
    ELEMENT_NUMBERS,
    MASS_BOUND_PROFILE_ID,
    PROFILE_ID,
    get_method_profile,
)
from chem_workbench.refinement_isotopes import (
    ISOTOPE_BINDING_VERSION,
    ISOTOPE_POLICY,
    seal_isotope_binding,
    validate_isotope_binding,
    validate_raw_isotopes,
)
from chem_workbench.visualization import content_hash

_RETAINED_ATOMS = [
    ("atom-1", "O", ("-0.43922736421237696", "-1.8681574194890882", "-1.5911733222229225")),
    ("atom-2", "C", ("-0.7030503795790239", "-1.3396652230980082", "-0.45937442562962183")),
    ("atom-3", "N", ("0.2721735368037474", "-1.5192321244766607", "0.5492681055274766")),
    ("atom-4", "C", ("1.4693265352612424", "-2.2453657152898967", "0.30712178724360223")),
    ("atom-5", "C", ("2.333328850162166", "-1.6758923375753019", "-0.7850140608063857")),
    ("atom-6", "C", ("-1.940418939132722", "-0.599340091275292", "-0.23913435477560754")),
    ("atom-7", "C", ("-2.2846117416751146", "-0.010136863944427279", "0.9436781200661096")),
    ("atom-8", "C", ("-3.4920609222791525", "0.6795077804716091", "1.062697009723163")),
    ("atom-9", "O", ("-3.836832907089114", "1.272482978127866", "2.2556362048905445")),
    ("atom-10", "C", ("-4.377612219317338", "0.7962561602068341", "0.011553960398896288")),
    ("atom-11", "O", ("-5.583592460610233", "1.4819469519378843", "0.12131319352951828")),
    ("atom-12", "C", ("-4.021637486396768", "0.1994903467686025", "-1.1748590367216898")),
    ("atom-13", "C", ("-2.8272928326529763", "-0.4825516575499737", "-1.2922402871332281")),
    ("atom-14", "C", ("2.75121997227081", "-0.28725536645566174", "-0.45691769571253443")),
    ("atom-15", "C", ("3.9211683170246863", "-0.07228607860732326", "0.24962618574844245")),
    ("atom-16", "C", ("4.379808505368366", "1.1771609541900836", "0.5933275313194838")),
    ("atom-17", "C", ("3.6439897435453537", "2.282927841481016", "0.22002401087275777")),
    ("atom-18", "C", ("2.482729997453942", "2.096526215955487", "-0.4797360920135556")),
    ("atom-19", "C", ("2.0333246854162437", "0.8280300245491437", "-0.8190573108139874")),
    ("atom-20", "H", ("0.10694588707032582", "-1.1050121532161385", "1.501859568751947")),
    ("atom-21", "H", ("2.1027251025852887", "-2.30322473587043", "1.2166565702772398")),
    ("atom-22", "H", ("1.2863708286012971", "-3.318423508013419", "0.02562398732377649")),
    ("atom-23", "H", ("3.266220526587496", "-2.273456846448499", "-0.8562665712149591")),
    ("atom-24", "H", ("1.8836018090469846", "-1.711555870677618", "-1.792218855123137")),
    ("atom-25", "H", ("-1.632115116899022", "-0.07657297615123691", "1.775473559017067")),
    ("atom-26", "H", ("-4.3299567280072955", "2.1540812203757937", "2.336497351530631")),
    ("atom-27", "H", ("-6.054836537197406", "1.3799191811206661", "1.0234699399525096")),
    ("atom-28", "H", ("-4.683565026623398", "0.25663001620805465", "-2.048733924323687")),
    ("atom-29", "H", ("-2.60853692906538", "-0.9324471247762107", "-2.2646912282833886")),
    ("atom-30", "H", ("4.493881832829309", "-0.9590923896498867", "0.5386809754618903")),
    ("atom-31", "H", ("5.303861359528375", "1.2266171169746656", "1.1444828090188297")),
    ("atom-32", "H", ("4.038930272719534", "3.2447973624795554", "0.5094661615177012")),
    ("atom-33", "H", ("1.924424398199713", "2.982899543461743", "-0.7602702070226095")),
    ("atom-34", "H", ("1.121315430260774", "0.720394788258378", "-1.3667696603749473")),
]
_NATIVE_MASSES_JSON = (
    "[15.99491461957,12.0,14.00307400443,12.0,12.0,12.0,12.0,12.0,15.9949146195"
    "7,12.0,15.99491461957,12.0,12.0,12.0,12.0,12.0,12.0,12.0,12.0,1.0078250322"
    "3,1.00782503223,1.00782503223,1.00782503223,1.00782503223,1.00782503223,1."
    "00782503223,1.00782503223,1.00782503223,1.00782503223,1.00782503223,1.0078"
    "2503223,1.00782503223,1.00782503223,1.00782503223]"
)
_NATIVE_MASS_NUMBERS = [
    16,
    12,
    14,
    12,
    12,
    12,
    12,
    12,
    16,
    12,
    16,
    12,
    12,
    12,
    12,
    12,
    12,
    12,
    12,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
]


def fixture():
    geometry = {
        "version": "refinement-geometry/v1",
        "units": "angstrom",
        "charge": 0,
        "multiplicity": 1,
        "atoms": [
            {"id": atom_id, "element": element, "position": list(position)}
            for atom_id, element, position in _RETAINED_ATOMS
        ],
    }
    geometry["geometry_hash"] = content_hash(geometry)
    assert geometry["geometry_hash"] == (
        "sha256:55cb8dc3e440adb89cb63fb3a9dc7fb7895420d86f733fdbbc6991655a581a1b"
    )
    runtime = {
        "version": "refinement-runtime-binding/v1",
        "engine": "psi4",
        "versions": {
            name: "test-only-binding"
            for name in ["python", "psi4", "optking", "qcengine", "qcelemental", "libxc"]
        },
        "files": [{"path": "fixture/runtime.json", "sha256": "b" * 64}],
    }
    runtime["binding_hash"] = content_hash(runtime)
    masses = json.loads(_NATIVE_MASSES_JSON, parse_float=Decimal)
    body = {
        "version": ISOTOPE_BINDING_VERSION,
        "policy": ISOTOPE_POLICY,
        "geometry_hash": geometry["geometry_hash"],
        "runtime_binding_hash": runtime["binding_hash"],
        "atoms": [
            {
                "atom_id": atom["id"],
                "element": atom["element"],
                "atomic_number": ELEMENT_NUMBERS[atom["element"]],
                "mass_number": mass_number,
                "mass_dalton": str(mass).removesuffix(".0"),
            }
            for atom, mass, mass_number in zip(
                geometry["atoms"], masses, _NATIVE_MASS_NUMBERS, strict=True
            )
        ],
        "artifact": {
            "path": "build/refinement-native-atomic-serialization-20260913.json",
            "sha256": "a0efaf9eba133f8b29f73f400fe037f98fd2b1f005d637382ee87357aa120e27",
        },
    }
    return geometry, runtime, body


def bound_fixture():
    geometry, runtime, body = fixture()
    return seal_isotope_binding(body, geometry, runtime)


def raw_fixture():
    return {
        "masses": json.loads(_NATIVE_MASSES_JSON, parse_float=Decimal),
        "mass_numbers": list(_NATIVE_MASS_NUMBERS),
    }


def test_retained_native_defaults_match_all_34_stable_atom_rows_exactly():
    geometry, runtime, body = fixture()
    binding = seal_isotope_binding(body, geometry, runtime)
    assert len(binding["atoms"]) == 34
    assert [row["atom_id"] for row in binding["atoms"]] == [a["id"] for a in geometry["atoms"]]
    assert validate_isotope_binding(binding, geometry, runtime) == binding
    assert validate_raw_isotopes(raw_fixture(), binding) is None
    raw = raw_fixture()
    raw["masses"] = json.loads(_NATIVE_MASSES_JSON)
    validate_raw_isotopes(raw, binding)
    raw["masses"][1] = 12
    validate_raw_isotopes(raw, binding)


def test_sealing_and_validation_return_detached_copies_without_changing_inputs():
    geometry, runtime, body = fixture()
    original = copy.deepcopy((geometry, runtime, body))
    binding = seal_isotope_binding(body, geometry, runtime)
    result = validate_isotope_binding(binding, geometry, runtime)
    result["atoms"][0]["mass_dalton"] = "1"
    assert binding["atoms"][0]["mass_dalton"] == "15.99491461957"
    binding["artifact"]["path"] = "different.json"
    assert (geometry, runtime, body) == original


@pytest.mark.parametrize("location", ["row", "artifact", "geometry", "runtime"])
def test_mutation_without_resealing_is_rejected(location):
    geometry, runtime, body = fixture()
    binding = seal_isotope_binding(body, geometry, runtime)
    if location == "row":
        binding["atoms"][0]["mass_dalton"] = "15.9"
    elif location == "artifact":
        binding["artifact"]["sha256"] = "c" * 64
    elif location == "geometry":
        geometry["atoms"][0]["position"][0] = "0"
    else:
        runtime["versions"]["psi4"] = "changed"
    with pytest.raises(ValueError):
        validate_isotope_binding(binding, geometry, runtime)


@pytest.mark.parametrize("which", ["geometry", "runtime"])
def test_resealed_context_change_rejects_existing_isotope_binding(which):
    geometry, runtime, body = fixture()
    binding = seal_isotope_binding(body, geometry, runtime)
    if which == "geometry":
        geometry["atoms"][0]["position"][0] = "0"
        geometry["geometry_hash"] = content_hash(
            {k: v for k, v in geometry.items() if k != "geometry_hash"}
        )
    else:
        runtime["versions"]["psi4"] = "different"
        runtime["binding_hash"] = content_hash(
            {k: v for k, v in runtime.items() if k != "binding_hash"}
        )
    with pytest.raises(ValueError, match="geometry or runtime"):
        validate_isotope_binding(binding, geometry, runtime)


@pytest.mark.parametrize("mutation", ["reorder", "duplicate", "id", "element", "missing"])
def test_atom_identity_and_order_fail_even_if_binding_is_resealed(mutation):
    geometry, runtime, body = fixture()
    if mutation == "reorder":
        body["atoms"][0], body["atoms"][1] = body["atoms"][1], body["atoms"][0]
    elif mutation == "duplicate":
        body["atoms"][1]["atom_id"] = body["atoms"][0]["atom_id"]
    elif mutation == "id":
        body["atoms"][0]["atom_id"] = "different-atom"
    elif mutation == "element":
        body["atoms"][0]["element"] = "N"
        body["atoms"][0]["atomic_number"] = 7
    else:
        body["atoms"].pop()
    with pytest.raises(ValueError):
        seal_isotope_binding(body, geometry, runtime)


@pytest.mark.parametrize("value", [True, False, 8.0, Decimal(8), "8", 0, 7, 119, None])
def test_atomic_number_requires_exact_element_integer(value):
    geometry, runtime, body = fixture()
    body["atoms"][0]["atomic_number"] = value
    with pytest.raises(ValueError):
        seal_isotope_binding(body, geometry, runtime)


@pytest.mark.parametrize("value", [True, False, 16.0, Decimal(16), "16", 0, 7, 301, None])
def test_mass_number_requires_strict_integer_not_below_atomic_number(value):
    geometry, runtime, body = fixture()
    body["atoms"][0]["mass_number"] = value
    with pytest.raises(ValueError):
        seal_isotope_binding(body, geometry, runtime)


@pytest.mark.parametrize(
    "value",
    [
        True,
        16,
        16.0,
        Decimal(16),
        "0",
        "-1",
        "301",
        "NaN",
        "Infinity",
        "16.0",
        "+16",
        "1.6e1",
        "016",
        " 16",
    ],
)
def test_bound_mass_requires_positive_canonical_finite_string(value):
    geometry, runtime, body = fixture()
    body["atoms"][0]["mass_dalton"] = value
    with pytest.raises(ValueError):
        seal_isotope_binding(body, geometry, runtime)


@pytest.mark.parametrize(
    "mutation",
    [
        "policy",
        "version",
        "extra",
        "row_extra",
        "artifact_extra",
        "path",
        "artifact_hash",
        "body_hash",
    ],
)
def test_closed_policy_and_artifact_contract(mutation):
    geometry, runtime, body = fixture()
    if mutation == "policy":
        body["policy"] = "user_selected_isotopes"
    elif mutation == "version":
        body["version"] = "refinement-isotope-binding/v2"
    elif mutation == "extra":
        body["tolerance"] = "0.0000000001"
    elif mutation == "row_extra":
        body["atoms"][0]["isotope_override"] = True
    elif mutation == "artifact_extra":
        body["artifact"]["verified"] = True
    elif mutation == "path":
        body["artifact"]["path"] = "../outside.json"
    elif mutation == "artifact_hash":
        body["artifact"]["sha256"] = "unknown"
    else:
        body["binding_hash"] = "sha256:" + "a" * 64
    with pytest.raises(ValueError):
        seal_isotope_binding(body, geometry, runtime)


@pytest.mark.parametrize(
    "value",
    [
        True,
        False,
        "15.99491461957",
        None,
        float("nan"),
        float("inf"),
        float("-inf"),
        Decimal("NaN"),
        Decimal("sNaN"),
        Decimal("Infinity"),
        0,
        -1,
        301,
    ],
)
def test_raw_masses_reject_wrong_types_and_nonfinite_or_out_of_bounds(value):
    raw = raw_fixture()
    raw["masses"][0] = value
    with pytest.raises(ValueError):
        validate_raw_isotopes(raw, bound_fixture())


@pytest.mark.parametrize("value", [True, False, "16", 16.0, Decimal(16), None, 0, 301, 17])
def test_raw_mass_numbers_require_exact_bound_strict_integers(value):
    raw = raw_fixture()
    raw["mass_numbers"][0] = value
    with pytest.raises(ValueError):
        validate_raw_isotopes(raw, bound_fixture())


@pytest.mark.parametrize("key", ["masses", "mass_numbers"])
@pytest.mark.parametrize("value", [None, [], (), [1] * 33, [1] * 35])
def test_raw_arrays_cannot_be_missing_partial_or_nonlists(key, value):
    raw = raw_fixture()
    raw[key] = value
    with pytest.raises(ValueError):
        validate_raw_isotopes(raw, bound_fixture())
    del raw[key]
    with pytest.raises(ValueError):
        validate_raw_isotopes(raw, bound_fixture())


def test_no_mass_tolerance_or_same_formula_reordering_is_allowed():
    binding = bound_fixture()
    raw = raw_fixture()
    raw["masses"][0] = Decimal("15.994914619570000000001")
    with pytest.raises(ValueError, match="differs"):
        validate_raw_isotopes(raw, binding)
    raw = raw_fixture()
    raw["masses"][0], raw["masses"][1] = raw["masses"][1], raw["masses"][0]
    raw["mass_numbers"][0], raw["mass_numbers"][1] = raw["mass_numbers"][1], raw["mass_numbers"][0]
    with pytest.raises(ValueError, match="differs"):
        validate_raw_isotopes(raw, binding)


def test_sealing_cannot_authenticate_native_defaults_but_raw_substitution_is_detected():
    geometry, runtime, body = fixture()
    # Internally consistent data is deliberately not a runtime-default admission.
    # The host must compare this altered row with its actual default-isotope probe.
    body["atoms"][0]["mass_number"] = 17
    body["atoms"][0]["mass_dalton"] = "17"
    binding = seal_isotope_binding(body, geometry, runtime)
    with pytest.raises(ValueError, match="differs"):
        validate_raw_isotopes(raw_fixture(), binding)


def mass_bound_spec_body():
    geometry, _, isotope_body = fixture()
    spec_body = _without(_spec(geometry), "spec_hash")
    spec_body["version"] = refinement.MASS_BOUND_SPEC_VERSION
    spec_body["profile"] = get_method_profile(MASS_BOUND_PROFILE_ID)
    spec_body["electronic_settings"]["native_keywords"]["function_kwargs"] = {"dertype": 1}
    isotope_body["runtime_binding_hash"] = spec_body["runtime_binding"]["binding_hash"]
    spec_body["isotope_binding"] = seal_isotope_binding(
        isotope_body, geometry, spec_body["runtime_binding"]
    )
    return spec_body


def test_new_spec_requires_bound_default_isotopes_while_v1_remains_unchanged():
    body = mass_bound_spec_body()
    spec = refinement.seal_refinement_spec(body)
    assert len(spec["geometry"]["atoms"]) == 34
    assert spec["version"] == "molecular-refinement-spec/v2"
    assert spec["profile"]["scope"]["isotopes"] == "runtime_defaults_only"
    legacy = _spec(spec["geometry"])
    assert legacy["version"] == "molecular-refinement-spec/v1"
    assert legacy["profile"]["scope"]["isotopes"] == "unsupported"
    assert "isotope_binding" not in legacy


@pytest.mark.parametrize("mutation", ["v2_old_profile", "v1_new_profile", "missing", "policy"])
def test_spec_and_isotope_policy_mismatch_is_rejected(mutation):
    body = mass_bound_spec_body()
    if mutation == "v2_old_profile":
        body["profile"] = get_method_profile(PROFILE_ID)
    elif mutation == "v1_new_profile":
        body["version"] = refinement.SPEC_VERSION
        del body["isotope_binding"]
    elif mutation == "missing":
        del body["isotope_binding"]
    else:
        body["isotope_binding"]["policy"] = "user_selected_isotopes"
        body["isotope_binding"]["binding_hash"] = content_hash(
            {k: v for k, v in body["isotope_binding"].items() if k != "binding_hash"}
        )
    with pytest.raises(ValueError):
        refinement.seal_refinement_spec(body)


def evaluated_raw_molecule(geometry):
    return {
        **raw_fixture(),
        "symbols": [atom["element"] for atom in geometry["atoms"]],
        "atom_labels": [atom["id"] for atom in geometry["atoms"]],
        "atomic_numbers": [ELEMENT_NUMBERS[atom["element"]] for atom in geometry["atoms"]],
        "real": [True] * len(geometry["atoms"]),
        "molecular_charge": 0,
        "molecular_multiplicity": 1,
        "fix_com": True,
        "fix_orientation": True,
        "geometry": [
            Decimal(coordinate) * Decimal(ANGSTROM_TO_BOHR)
            for atom in geometry["atoms"]
            for coordinate in atom["position"]
        ],
    }


def test_parent_raw_geometry_accepts_bound_defaults_and_preserves_legacy_refusal():
    spec = refinement.seal_refinement_spec(mass_bound_spec_body())
    geometry, binding = spec["geometry"], spec["isotope_binding"]
    raw = evaluated_raw_molecule(geometry)
    refinement._raw_geometry(raw, geometry, binding)
    with pytest.raises(ValueError, match="separately bound profile"):
        refinement._raw_geometry(raw, geometry)
    del raw["masses"]
    del raw["mass_numbers"]
    refinement._raw_geometry(raw, geometry)
    with pytest.raises(ValueError, match="complete raw"):
        refinement._raw_geometry(raw, geometry, binding)


@pytest.mark.parametrize("mutation", ["ghost", "labels", "nuclear_charge", "mass"])
def test_new_binding_does_not_bypass_parent_atom_identity_checks(mutation):
    spec = refinement.seal_refinement_spec(mass_bound_spec_body())
    geometry, binding = spec["geometry"], spec["isotope_binding"]
    raw = evaluated_raw_molecule(geometry)
    if mutation == "ghost":
        raw["real"][0] = False
    elif mutation == "labels":
        raw["atom_labels"][0], raw["atom_labels"][1] = raw["atom_labels"][1], raw["atom_labels"][0]
    elif mutation == "nuclear_charge":
        raw["atomic_numbers"][0] = True
    else:
        raw["masses"][0] = Decimal("15.994914619570000000001")
    with pytest.raises(ValueError):
        refinement._raw_geometry(raw, geometry, binding)
