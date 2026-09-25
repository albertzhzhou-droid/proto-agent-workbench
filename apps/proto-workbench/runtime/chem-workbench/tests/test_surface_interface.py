"""Surface and interface reaction extension tests (RFC-0006 alpha subset)."""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from chem_workbench.chemir.constraints import ELEMENT_SYMBOLS
from chem_workbench.chemir.validation import validate_chemir_document
from chem_workbench.compiler import CompilationResult, compile_source

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
EXAMPLE_PATH = REPOSITORY_ROOT / "examples" / "surfaces" / "cu111-adatom-diffusion.chem"
RunChem = Callable[..., subprocess.CompletedProcess[bytes]]

PARENT_SOURCE = """chem 0.1

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
"""

VALID_COMPLEX_SOURCE = (
    PARENT_SOURCE
    + """
adsorption_complex cu_adatom_top {
  slab cu111
  adsorbate [Cu]
  site top
  height 2
  height_unit angstrom
}
"""
)


def diagnostic_codes(result: CompilationResult) -> set[str]:
    return {diagnostic.code for diagnostic in result.diagnostics}


def surface_source(*extra_declarations: str) -> str:
    return VALID_COMPLEX_SOURCE + "\n" + "\n".join(extra_declarations)


def test_surface_example_compiles_into_the_inspectable_chemir_subset() -> None:
    result = compile_source(EXAMPLE_PATH.read_bytes(), EXAMPLE_PATH.as_posix())

    assert result.success
    assert result.document is not None
    assert result.semantic_hash is not None
    assert result.artifact_bytes is not None
    kinds = [item["kind"] for item in result.document["objects"]]
    assert kinds == [
        "PeriodicStructure",
        "SurfaceSlab",
        "AdsorptionComplex",
        "AdsorptionComplex",
        "ConditionSet",
        "ConditionSet",
        "ConditionSet",
        "InterfaceReactionStep",
        "CalculationSpec",
        "CalculationSpec",
        "ComparisonSpec",
    ]
    validate_chemir_document(result.document)


def test_surface_compilation_is_deterministic_and_review_packet_ready() -> None:
    results = [compile_source(EXAMPLE_PATH.read_bytes(), EXAMPLE_PATH.as_posix()) for _ in range(2)]

    assert all(result.success for result in results)
    assert {result.artifact_bytes for result in results} == {results[0].artifact_bytes}
    assert {result.semantic_hash for result in results} == {results[0].semantic_hash}
    packet = results[0].review_packet()
    assert packet["verification_scope"] == "self_consistency"
    assert "claims" not in packet
    review_codes = {item["code"] for item in packet["diagnostics"]}
    assert {"CHM2303", "CHM2510", "CHM2519", "CHM2525"} <= review_codes


def test_surface_payloads_carry_declared_construction_provenance() -> None:
    result = compile_source(VALID_COMPLEX_SOURCE, "cu111.chem")
    assert result.success and result.document is not None

    slab = result.document["objects"][1]
    assert slab["payload"]["construction"] == {
        "algorithm": "fcc-cubic-cell-cut",
        "algorithm_version": "v1alpha1",
        "miller": [1, 1, 1],
        "termination": "cu-111-a",
        "layers": 4,
        "vacuum": {"value": 10, "unit": "angstrom"},
    }
    complex_payload = result.document["objects"][2]["payload"]
    assert complex_payload["adsorbate_elements"] == ["Cu"]
    assert complex_payload["height"] == {"value": 2, "unit": "angstrom"}


CROSS_SLAB_SOURCE = """chem 0.1

crystal fcc_copper {
  structure cif "structures/fcc-copper.cif"
  semantics explicit_configuration
}

surface_slab thin_slab {
  parent fcc_copper
  construction fcc-cubic-cell-cut
  miller [1, 1, 1]
  termination "cu-111-a"
  layers 4
  vacuum 10
  vacuum_unit angstrom
}

surface_slab thick_slab {
  parent fcc_copper
  construction fcc-cubic-cell-cut
  miller [1, 1, 1]
  termination "cu-111-b"
  layers 8
  vacuum 10
  vacuum_unit angstrom
}

adsorption_complex adatom_on_thin {
  slab thin_slab
  adsorbate [Cu]
  site top
  height 2
  height_unit angstrom
}

adsorption_complex adatom_on_thick {
  slab thick_slab
  adsorbate [Cu]
  site top
  height 2
  height_unit angstrom
}

interface_reaction_step cross_slab_step {
  reactants [adatom_on_thin]
  products [adatom_on_thick]
}
"""

NEGATIVE_CASES = [
    (
        surface_source(
            """
calculation co_adsorption {
  target cu_adatom_top
  task single_point
  properties [energy]
  method "emt"
}
"""
        ).replace("[Cu]", '["C", "O"]'),
        "CHM2532",
        "co-adsorbate-outside-copper-profile",
    ),
    (
        surface_source(
            """
calculation hf_surface {
  target cu_adatom_top
  task single_point
  properties [energy]
  method "hf"
  basis "sto-3g"
}
"""
        ),
        "CHM2531",
        "hf-method-not-admitted",
    ),
    (
        surface_source(
            """
electronic_state surface_state {
  target cu_adatom_top
  finite charge 0 multiplicity 1
}
"""
        ),
        "CHM2202",
        "finite-state-on-surface-target",
    ),
    (
        PARENT_SOURCE.replace("construction fcc-cubic-cell-cut", "construction arbitrary-cut"),
        "CHM2503",
        "unknown-construction",
    ),
    (PARENT_SOURCE.replace("miller [1, 1, 1]", "miller [1, 1, 0]"), "CHM2505", "unadmitted-plane"),
    (PARENT_SOURCE.replace("vacuum 10", "vacuum 10.5"), "CHM2508", "decimal-vacuum"),
    (PARENT_SOURCE.replace("  vacuum_unit angstrom\n", "\n"), "CHM2509", "missing-vacuum-unit"),
    (
        PARENT_SOURCE.replace("parent fcc_copper", "parent unknown_parent"),
        "CHM2501",
        "dangling-parent",
    ),
    (PARENT_SOURCE.replace("  layers 4", "  layers 999"), "CHM2507", "layers-out-of-bounds"),
    (
        """chem 0.1

molecule water {
  structure smiles "O"
}

surface_slab bad_parent {
  parent water
  construction fcc-cubic-cell-cut
  miller [1, 1, 1]
  termination "cu-111-a"
  layers 4
  vacuum 10
  vacuum_unit angstrom
}
""",
        "CHM2502",
        "parent-not-crystal",
    ),
    (VALID_COMPLEX_SOURCE.replace("  site top", "  site octahedral"), "CHM2516", "unknown-site"),
    (VALID_COMPLEX_SOURCE.replace("  height 2", "  height true"), "CHM2517", "boolean-height"),
    (
        VALID_COMPLEX_SOURCE.replace("  height_unit angstrom\n", "\n"),
        "CHM2518",
        "missing-height-unit",
    ),
    (
        VALID_COMPLEX_SOURCE.replace("  adsorbate [Cu]", "  adsorbate [Xx]"),
        "CHM2515",
        "unknown-element",
    ),
    (
        VALID_COMPLEX_SOURCE.replace("slab cu111", "slab fcc_copper"),
        "CHM2512",
        "complex-targets-crystal",
    ),
    (
        surface_source(
            """
interface_reaction_step dangling_step {
  reactants [missing_complex]
  products [cu_adatom_top]
}
"""
        ),
        "CHM2521",
        "dangling-step-reference",
    ),
    (
        surface_source(
            """
interface_reaction_step self_step {
  reactants [cu_adatom_top]
  products [cu_adatom_top]
}
"""
        ),
        "CHM2523",
        "self-referencing-step",
    ),
    (
        surface_source(
            """
molecule water {
  structure smiles "O"
}

electronic_state water_state {
  target water
  finite charge 0 multiplicity 1
}

calculation stateful_surface {
  target cu_adatom_top
  state water_state
  task single_point
  properties [energy]
  method "emt"
}
"""
        ),
        "CHM2530",
        "calculation-state-on-surface-target",
    ),
    (CROSS_SLAB_SOURCE, "CHM2524", "cross-slab-step"),
]


@pytest.mark.parametrize(
    ("source", "expected_code"),
    [(case[0], case[1]) for case in NEGATIVE_CASES],
    ids=[case[2] for case in NEGATIVE_CASES],
)
def test_surface_and_interface_sources_fail_closed(source: str, expected_code: str) -> None:
    result = compile_source(source, "surface-negative.chem")

    assert expected_code in diagnostic_codes(result)
    assert not result.success
    assert result.document is None
    assert result.semantic_hash is None


def _compiled_surface_document() -> dict[str, Any]:
    result = compile_source(EXAMPLE_PATH.read_bytes(), EXAMPLE_PATH.as_posix())
    assert result.success and result.document is not None
    return result.document


def test_tampered_out_of_profile_adsorbate_is_rejected_on_inspection() -> None:
    document = _compiled_surface_document()
    document["objects"][2]["payload"]["adsorbate_elements"] = ["C", "O"]

    with pytest.raises(ValueError, match="copper-only surface profile"):
        validate_chemir_document(document)


def test_tampered_slab_parameters_and_open_payloads_are_rejected_on_inspection() -> None:
    document = _compiled_surface_document()
    document["objects"][1]["payload"]["construction"]["miller"] = [1, 1, 0]

    with pytest.raises(ValueError, match="Miller indices"):
        validate_chemir_document(document)

    open_payload = _compiled_surface_document()
    open_payload["objects"][1]["payload"]["surface_energy"] = 1

    with pytest.raises(ValueError, match="Schema validation failed"):
        validate_chemir_document(open_payload)


def test_tampered_reaction_step_is_rejected_on_inspection() -> None:
    document = _compiled_surface_document()
    document["objects"][7]["payload"]["claim_scope"] = "barrier_estimate"

    with pytest.raises(ValueError):
        validate_chemir_document(document)

    document = _compiled_surface_document()
    document["objects"][7]["payload"]["reactant_references"] = ["fcc_copper"]

    with pytest.raises(ValueError, match="not an AdsorptionComplex"):
        validate_chemir_document(document)


def test_element_symbol_set_matches_the_schema_enum() -> None:
    common_schema = json.loads(
        (REPOSITORY_ROOT / "schemas" / "chemir" / "v1alpha1" / "common.schema.json").read_text(
            encoding="utf-8"
        )
    )
    schema_elements = set(common_schema["$defs"]["ElementSymbol"]["enum"])

    assert schema_elements == ELEMENT_SYMBOLS


def test_surface_example_compiles_through_the_cli(tmp_path: Path, run_chem: RunChem) -> None:
    output = tmp_path / "cu111.chemir.json"
    completed = run_chem("compile", EXAMPLE_PATH, "--output", output)

    assert completed.returncode == 0, completed.stderr.decode("utf-8", errors="replace")
    emitted = json.loads(output.read_text(encoding="utf-8"))
    assert {item["kind"] for item in emitted["objects"]} >= {
        "SurfaceSlab",
        "AdsorptionComplex",
        "InterfaceReactionStep",
    }
