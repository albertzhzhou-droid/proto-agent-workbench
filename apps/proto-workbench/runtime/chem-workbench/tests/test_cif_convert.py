"""Conformance tests for the typed CIF structure import and chem convert."""

from __future__ import annotations

import copy
import json
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

from chem_workbench.adapters import load_bundled_registry
from chem_workbench.adapters.cif_import import import_cif_bytes
from chem_workbench.adapters.cif_probe import IMPORT_CAPABILITY_ID, bundled_capability
from chem_workbench.chemir import semantic_hash
from chem_workbench.chemir.constraints import canonical_decimal, is_canonical_decimal
from chem_workbench.chemir.validation import validate_chemir_document

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
RunChem = Callable[..., subprocess.CompletedProcess[bytes]]

FCC_COPPER_PATH = REPOSITORY_ROOT / "examples" / "crystals" / "structures" / "fcc-copper.cif"
SILICON_PATH = REPOSITORY_ROOT / "examples" / "crystals" / "structures" / "silicon.cif"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("3.6149", "3.6149"),
        ("3.6149(4)", None),
        ("90.0", "90"),
        ("0.50000", "0.5"),
        ("2.0", "2"),
        ("-0", "0"),
        ("-1.50", "-1.5"),
        ("1.5e-2", "0.015"),
        ("abc", None),
        ("", None),
        ("NaN", None),
    ],
)
def test_canonical_decimal_normalizes_exact_lexical_forms(text: str, expected: str | None) -> None:
    assert canonical_decimal(text) == expected
    if expected is not None:
        assert is_canonical_decimal(expected)


def test_registry_carries_both_cif_capabilities_as_active() -> None:
    registry = load_bundled_registry()
    registration = registry.document["adapters"][0]
    capabilities = registration["manifest"], registration["format_capabilities"]

    assert len(capabilities[1]) == 2
    by_id = {
        record["capability"]["capability_id"]: record["capability"]
        for record in registration["format_capabilities"]
    }
    assert set(by_id) == {
        "chem.cif.probe.cif-p1-explicit.import",
        IMPORT_CAPABILITY_ID,
    }
    assert by_id[IMPORT_CAPABILITY_ID]["classification"] == "SEMANTIC_EQUIVALENT_UNDER_PROFILE"
    assert by_id[IMPORT_CAPABILITY_ID]["profile"] == "cif-p1-explicit-typed-v1"
    assert by_id["chem.cif.probe.cif-p1-explicit.import"]["profile"] == "cif-p1-explicit-v1"

    resolution = registry.resolve_format_capability(bundled_capability(IMPORT_CAPABILITY_ID))
    assert resolution.registered is True
    assert resolution.active is True
    assert resolution.reason == "ACTIVE"


def test_fcc_copper_imports_exact_orthogonal_chemistry() -> None:
    result = import_cif_bytes(FCC_COPPER_PATH.read_bytes())

    assert result.admitted
    assert result.document is not None
    validate_chemir_document(result.document)
    structure = result.document["objects"][0]
    assert structure["id"] == "fcc_copper"
    payload = structure["payload"]
    assert payload["lattice"]["vectors"] == [
        ["3.6149", "0", "0"],
        ["0", "3.6149", "0"],
        ["0", "0", "3.6149"],
    ]
    assert payload["coordinate_system"] == "fractional"
    assert [site["element"] for site in payload["sites"]] == ["Cu"] * 4
    assert payload["sites"][1]["coordinates"] == ["0", "0.5", "0.5"]
    assert payload["sites"][1]["label"] == "Cu2"
    assert all(site["occupancy"] == 1 for site in payload["sites"])
    assert payload["representations"][0]["format"] == "cif"
    assert result.document_semantic_hash == semantic_hash(result.document)


def test_import_is_deterministic_and_reproducible() -> None:
    source = SILICON_PATH.read_bytes()
    first = import_cif_bytes(source)
    second = import_cif_bytes(source)

    assert first.admitted and second.admitted
    assert first.artifact_bytes == second.artifact_bytes
    assert first.document_semantic_hash == second.document_semantic_hash
    assert first.loss_report == second.loss_report


def test_loss_report_is_profile_equivalent_and_registry_bound() -> None:
    result = import_cif_bytes(FCC_COPPER_PATH.read_bytes())
    report = result.loss_report

    assert report["classification"] == "SEMANTIC_EQUIVALENT_UNDER_PROFILE"
    assert report["output_hash"]["type"] == "semantic_hash"
    assert report["output_hash"]["value"] == result.document_semantic_hash.split(":", 1)[1]
    codes = {issue["code"] for issue in report["issues"]}
    assert "ATOM_SITE_LABELS_PRESERVED" in codes
    assert all(issue["disposition"] in {"preserved", "normalized"} for issue in report["issues"])
    resolution = load_bundled_registry().resolve_loss_report(report)
    assert resolution.bindings_valid is True
    assert resolution.publishable is False


NON_ORTHOGONAL_SOURCE = """data_hex_cell
_cell_length_a 2.466
_cell_length_b 2.466
_cell_length_c 2.466
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 120
loop_
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
Zn 0.0 0.0 0.0
"""

NEGATIVE_LENGTH_SOURCE = """data_negative
_cell_length_a -3.0
_cell_length_b 3.0
_cell_length_c 3.0
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
loop_
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
Cu 0.0 0.0 0.0
"""

DISORDERED_SOURCE = """data_disordered
_cell_length_a 3.0
_cell_length_b 3.0
_cell_length_c 3.0
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
loop_
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
_atom_site_occupancy
Cu 0.0 0.0 0.0 0.5
"""


@pytest.mark.parametrize(
    ("source", "expected_code"),
    [
        (NON_ORTHOGONAL_SOURCE, "NON_ORTHOGONAL_CELL"),
        (NEGATIVE_LENGTH_SOURCE, "NON_POSITIVE_CELL_LENGTH"),
        (DISORDERED_SOURCE, "PARTIAL_OCCUPANCY"),
    ],
    ids=("non-orthogonal", "negative-length", "disordered"),
)
def test_import_rejects_sources_outside_the_typed_profile(source: str, expected_code: str) -> None:
    result = import_cif_bytes(source.encode("utf-8"))

    assert not result.admitted
    assert result.document is None
    assert result.artifact_bytes is None
    assert result.loss_report["classification"] == "UNSUPPORTED"
    assert expected_code in {issue["code"] for issue in result.loss_report["issues"]}


def test_tampered_imported_structures_fail_inspection() -> None:
    result = import_cif_bytes(FCC_COPPER_PATH.read_bytes())
    assert result.document is not None

    non_canonical = copy.deepcopy(result.document)
    non_canonical["objects"][0]["payload"]["lattice"]["vectors"][0][0] = "3.61490"
    with pytest.raises(ValueError, match="Schema validation failed"):
        validate_chemir_document(non_canonical)

    exponent_form = copy.deepcopy(result.document)
    exponent_form["objects"][0]["payload"]["lattice"]["vectors"][0][0] = "3.6149e0"
    with pytest.raises(ValueError):
        validate_chemir_document(exponent_form)

    partial_occupancy = copy.deepcopy(result.document)
    partial_occupancy["objects"][0]["payload"]["sites"][0]["occupancy"] = 0.5
    with pytest.raises(ValueError, match="Schema validation failed"):
        validate_chemir_document(partial_occupancy)

    partial_geometry = copy.deepcopy(result.document)
    del partial_geometry["objects"][0]["payload"]["sites"]
    with pytest.raises(ValueError, match="partial geometry fields"):
        validate_chemir_document(partial_geometry)


def test_cli_convert_writes_chemir_and_loss_report(
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    chemir_output = tmp_path / "cu.chemir.json"
    completed = run_chem("convert", FCC_COPPER_PATH, "--output", chemir_output, "--force")

    assert completed.returncode == 0, completed.stderr.decode("utf-8", errors="replace")
    assert chemir_output.is_file()
    loss_output = tmp_path / "cu.chemir.json.loss.json"
    assert loss_output.is_file()
    document = json.loads(chemir_output.read_text(encoding="utf-8"))
    assert document["objects"][0]["kind"] == "PeriodicStructure"
    report = json.loads(loss_output.read_text(encoding="utf-8"))
    assert report["classification"] == "SEMANTIC_EQUIVALENT_UNDER_PROFILE"

    inspected = run_chem("inspect", chemir_output)
    assert inspected.returncode == 0
    summary = json.loads(inspected.stdout)
    assert summary["artifact_type"] == "ChemIR"
    assert summary["kinds"] == ["PeriodicStructure"]

    packet = run_chem("review-compile", chemir_output)
    assert packet.returncode == 0, packet.stderr.decode("utf-8", errors="replace")


def test_cli_convert_rejections_write_no_chemir(
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    source = tmp_path / "hex.cif"
    source.write_text(NON_ORTHOGONAL_SOURCE, encoding="utf-8")
    chemir_output = tmp_path / "hex.chemir.json"

    completed = run_chem("convert", source, "--output", chemir_output)

    assert completed.returncode == 1
    assert not chemir_output.exists()
    assert Path(f"{chemir_output}.loss.json").is_file()


def test_cli_convert_requires_an_explicit_output(run_chem: RunChem) -> None:
    completed = run_chem("convert", FCC_COPPER_PATH)

    assert completed.returncode == 3
    assert b"--output" in completed.stderr
