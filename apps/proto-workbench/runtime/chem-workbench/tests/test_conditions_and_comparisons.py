"""Conditions and comparison task semantics tests (RFC-0007)."""

from __future__ import annotations

import copy
import json
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

from chem_workbench.chemir.validation import validate_chemir_document
from chem_workbench.compiler import CompilationResult, compile_source

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
RunChem = Callable[..., subprocess.CompletedProcess[bytes]]

MOLECULE_SOURCE = """chem 0.1
molecule water {
  structure smiles "O"
}
"""

SURFACE_SOURCE = """chem 0.1

crystal fcc_copper {
  structure cif "structures/fcc-copper.cif"
  semantics explicit_configuration
}

surface_slab cu111 {
  parent fcc_copper
  construction fcc-cubic-cell-cut
  miller [1, 1, 1]
  termination "cu-111-a"
  layers 4
  vacuum 10
  vacuum_unit angstrom
}

adsorption_complex adatom_top {
  slab cu111
  adsorbate [Cu]
  site top
  height 2
  height_unit angstrom
}

adsorption_complex adatom_hollow {
  slab cu111
  adsorbate [Cu]
  site fcc_hollow
  height 2
  height_unit angstrom
}

conditions slab_conditions {
  target cu111
  phase gas_solid_interface
  temperature 0
  temperature_unit kelvin
}

conditions top_conditions {
  target adatom_top
  phase gas_solid_interface
  temperature 0
  temperature_unit kelvin
}

conditions hollow_conditions {
  target adatom_hollow
  phase gas_solid_interface
  temperature 0
  temperature_unit kelvin
}

calculation top_single_point {
  target adatom_top
  conditions top_conditions
  task single_point
  properties [energy]
  method "emt"
}

calculation hollow_single_point {
  target adatom_hollow
  conditions hollow_conditions
  task single_point
  properties [energy]
  method "emt"
}

comparison site_preference {
  kind stability
  stability_kind adsorption_site_preference
  subjects [adatom_top, adatom_hollow]
  conditions slab_conditions
  reference_state "cu111 slab with one copper adatom at 0 K"
  method "emt"
}
"""


def diagnostic_codes(result: CompilationResult) -> set[str]:
    return {diagnostic.code for diagnostic in result.diagnostics}


def test_conditions_and_comparison_compile_into_typed_chemir() -> None:
    result = compile_source(SURFACE_SOURCE, "surface.chem")

    assert result.success
    assert result.document is not None
    validate_chemir_document(result.document)
    kinds = {item["kind"] for item in result.document["objects"]}
    assert {"ConditionSet", "ComparisonSpec"} <= kinds
    condition = next(
        item
        for item in result.document["objects"]
        if item["kind"] == "ConditionSet" and item["id"] == "top_conditions"
    )
    assert condition["payload"] == {
        "target_reference": "adatom_top",
        "phase": "gas_solid_interface",
        "temperature": {"value": 0, "unit": "kelvin"},
    }
    comparison = next(
        item for item in result.document["objects"] if item["kind"] == "ComparisonSpec"
    )
    assert comparison["payload"]["stability_kind"] == "adsorption_site_preference"
    assert comparison["payload"]["reference_state"].startswith("cu111 slab")
    assert "CHM2612" in diagnostic_codes(result)


def test_calculation_without_conditions_reports_insufficient_conditions() -> None:
    source = (
        MOLECULE_SOURCE
        + """
electronic_state water_state {
  target water
  finite charge 0 multiplicity 1
}

calculation unconditioned {
  target water
  state water_state
  task single_point
  properties [energy]
  method "hf"
  basis "sto-3g"
}
"""
    )

    result = compile_source(source, "missing.chem")

    assert "CHM2601" in diagnostic_codes(result)
    assert not result.success


def test_missing_phase_or_temperature_is_insufficient_not_defaulted() -> None:
    source = (
        MOLECULE_SOURCE
        + """
conditions bare_conditions {
  target water
}

electronic_state water_state {
  target water
  finite charge 0 multiplicity 1
}

calculation water_energy {
  target water
  state water_state
  conditions bare_conditions
  task single_point
  properties [energy]
  method "hf"
  basis "sto-3g"
}
"""
    )

    result = compile_source(source, "bare.chem")

    assert "CHM2605" in diagnostic_codes(result)
    assert not result.success

    zero_kelvin = source.replace("  target water\n}", "  target water\n  phase gas\n}")
    still_missing = compile_source(zero_kelvin, "no-temperature.chem")
    assert "CHM2605" in diagnostic_codes(still_missing)


BASE_CONDITIONS_SOURCE = (
    MOLECULE_SOURCE
    + """
conditions water_conditions {
  target water
  phase gas
  temperature 0
  temperature_unit kelvin
}

electronic_state water_state {
  target water
  finite charge 0 multiplicity 1
}

calculation water_energy {
  target water
  state water_state
  conditions water_conditions
  task single_point
  properties [energy]
  method "hf"
  basis "sto-3g"
}
"""
)

_PROFILE_MUTATIONS = {
    "nonzero-temperature": BASE_CONDITIONS_SOURCE.replace(
        "  temperature 0\n", "  temperature 300\n"
    ),
    "wrong-phase": BASE_CONDITIONS_SOURCE.replace("  phase gas\n", "  phase liquid\n"),
    "solvent": BASE_CONDITIONS_SOURCE.replace("  phase gas\n", "  phase gas\n  solvent water\n"),
    "pressure": BASE_CONDITIONS_SOURCE.replace(
        "  phase gas\n", "  phase gas\n  pressure 1\n  pressure_unit bar\n"
    ),
}


@pytest.mark.parametrize(
    ("case", "expected_code"),
    [
        ("nonzero-temperature", "CHM2604"),
        ("wrong-phase", "CHM2604"),
        ("solvent", "CHM2604"),
        ("pressure", "CHM2604"),
    ],
    ids=("nonzero-temperature", "wrong-phase", "solvent", "pressure"),
)
def test_fields_outside_the_admitted_profile_are_rejected(case: str, expected_code: str) -> None:
    result = compile_source(_PROFILE_MUTATIONS[case], "outside-profile.chem")

    assert expected_code in diagnostic_codes(result)
    assert not result.success


def test_conditions_target_mismatch_is_rejected() -> None:
    source = (
        MOLECULE_SOURCE
        + """
molecule ammonia {
  structure smiles "N"
}

conditions water_conditions {
  target ammonia
  phase gas
  temperature 0
  temperature_unit kelvin
}

electronic_state water_state {
  target water
  finite charge 0 multiplicity 1
}

calculation water_energy {
  target water
  state water_state
  conditions water_conditions
  task single_point
  properties [energy]
  method "hf"
  basis "sto-3g"
}
"""
    )

    result = compile_source(source, "mismatch.chem")

    assert "CHM2603" in diagnostic_codes(result)
    assert not result.success


def test_comparison_requires_explicit_reference_state_and_conditions() -> None:
    no_reference = SURFACE_SOURCE.replace(
        '  reference_state "cu111 slab with one copper adatom at 0 K"\n', ""
    )
    result = compile_source(no_reference, "no-reference.chem")
    assert "CHM2610" in diagnostic_codes(result)
    assert not result.success

    no_conditions = SURFACE_SOURCE.replace("  conditions slab_conditions\n", "")
    result = compile_source(no_conditions, "no-conditions.chem")
    assert "CHM2610" in diagnostic_codes(result)
    assert not result.success


_COMPARISON_MUTATIONS = {
    "single-subject": SURFACE_SOURCE.replace(
        "subjects [adatom_top, adatom_hollow]", "subjects [adatom_top]"
    ),
    "mixed-kinds": SURFACE_SOURCE.replace(
        "subjects [adatom_top, adatom_hollow]", "subjects [adatom_top, fcc_copper]"
    ),
    "unadmitted-method": SURFACE_SOURCE.replace(
        'at 0 K"\n  method "emt"', 'at 0 K"\n  method "hf"'
    ),
}


@pytest.mark.parametrize(
    ("case", "expected_code"),
    [
        ("single-subject", "CHM2611"),
        ("mixed-kinds", "CHM2611"),
        ("unadmitted-method", "CHM2610"),
    ],
    ids=("single-subject", "mixed-kinds", "unadmitted-method"),
)
def test_incomparable_or_unsemantic_comparisons_fail_closed(case: str, expected_code: str) -> None:
    result = compile_source(_COMPARISON_MUTATIONS[case], "comparison-negative.chem")

    assert expected_code in diagnostic_codes(result)
    assert not result.success


def test_cross_slab_site_comparison_is_rejected() -> None:
    second_slab = SURFACE_SOURCE.replace(
        "adsorption_complex adatom_hollow {",
        """surface_slab cu111_thick {
  parent fcc_copper
  construction fcc-cubic-cell-cut
  miller [1, 1, 1]
  termination "cu-111-b"
  layers 8
  vacuum 10
  vacuum_unit angstrom
}

adsorption_complex adatom_hollow {""",
    ).replace(
        "adsorption_complex adatom_hollow {\n  slab cu111",
        "adsorption_complex adatom_hollow {\n  slab cu111_thick",
    )
    result = compile_source(second_slab, "cross-slab.chem")

    assert "CHM2611" in diagnostic_codes(result)
    assert not result.success


def test_tampered_conditions_and_comparisons_fail_inspection() -> None:
    result = compile_source(SURFACE_SOURCE, "surface.chem")
    assert result.success and result.document is not None

    warm = copy.deepcopy(result.document)
    condition = next(item for item in warm["objects"] if item["id"] == "top_conditions")
    condition["payload"]["temperature"]["value"] = 300
    with pytest.raises(ValueError):
        validate_chemir_document(warm)

    solvent = copy.deepcopy(result.document)
    condition = next(item for item in solvent["objects"] if item["id"] == "top_conditions")
    condition["payload"]["solvent"] = "water"
    with pytest.raises(ValueError):
        validate_chemir_document(solvent)

    cross_slab = copy.deepcopy(result.document)
    comparison = next(item for item in cross_slab["objects"] if item["kind"] == "ComparisonSpec")
    comparison["payload"]["subject_references"] = ["adatom_top", "fcc_copper"]
    with pytest.raises(ValueError):
        validate_chemir_document(cross_slab)


def test_inspect_reports_three_validity_levels(
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    source = tmp_path / "surface.chem"
    source.write_text(SURFACE_SOURCE, encoding="utf-8")
    artifact = tmp_path / "surface.chemir.json"

    compiled = run_chem("compile", source, "--output", artifact)
    assert compiled.returncode == 0, compiled.stderr.decode("utf-8", errors="replace")

    inspected = run_chem("inspect", artifact)
    assert inspected.returncode == 0
    summary = json.loads(inspected.stdout)
    assert summary["validity_levels"] == {
        "format": True,
        "within_model": "not_evaluated",
        "experimental": "not_claimed",
    }
