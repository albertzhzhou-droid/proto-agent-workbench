"""Conformance corpus and contract tests for the read-only CIF probe adapter."""

from __future__ import annotations

import copy
import hashlib
import json
import subprocess
from collections.abc import Callable
from pathlib import Path

from chem_workbench.adapters import (
    load_bundled_registry,
    validate_loss_report,
)
from chem_workbench.adapters.cif_probe import (
    ADAPTER_ID,
    ADAPTER_VERSION,
    CAPABILITY_ID,
    bundled_cif_capability,
    parse_cif_text,
    probe_cif_bytes,
)
from chem_workbench.chemir import pretty_bytes

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
RunChem = Callable[..., subprocess.CompletedProcess[bytes]]

ADMITTED_SOURCE = """# explicit P1 source
data_test_cell
_cell_length_a 3.6149(4)
_cell_length_b 3.6149
_cell_length_c 3.6149
_cell_angle_alpha 90.0
_cell_angle_beta 90.0
_cell_angle_gamma 90.0
loop_
_space_group_symop_operation_xyz
'x, y, z'
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
_atom_site_occupancy
Cu1 Cu 0.0 0.0 0.0 1.0000
Cu2 Cu 0.0 0.5 0.5 1.0000
_chemical_name 'test structure'
"""

DISORDERED_SOURCE = ADMITTED_SOURCE.replace(
    "Cu2 Cu 0.0 0.5 0.5 1.0000",
    "Cu2 Cu 0.0 0.5 0.5 0.5000",
)

SYMMETRY_SOURCE = ADMITTED_SOURCE.replace(
    "loop_\n_space_group_symop_operation_xyz\n'x, y, z'",
    "loop_\n_space_group_symop_operation_xyz\n'x, y, z'\n'-x, -y, z'",
)

MULTI_BLOCK_SOURCE = ADMITTED_SOURCE + "\ndata_second_block\n_cell_length_a 2.0\n"

INCOMPLETE_ROW_SOURCE = ADMITTED_SOURCE.replace(
    "Cu2 Cu 0.0 0.5 0.5 1.0000",
    "Cu2 Cu 0.0 0.5",
)

UNTERMINATED_QUOTE_SOURCE = ADMITTED_SOURCE.replace(
    "_chemical_name 'test structure'",
    "_chemical_name 'unterminated",
)

NO_TYPE_SYMBOL_SOURCE = (
    ADMITTED_SOURCE.replace(
        "_atom_site_label\n_atom_site_type_symbol\n",
        "_atom_site_label\n",
    )
    .replace("Cu1 Cu ", "Cu1 ")
    .replace("Cu2 Cu ", "Cu2 ")
)


def issue_codes(report: dict[str, object]) -> set[str]:
    issues = report["issues"]
    assert isinstance(issues, list)
    return {issue["code"] for issue in issues}


def probe(source: str) -> tuple[bool, dict[str, object], dict[str, object]]:
    result = probe_cif_bytes(source.encode("utf-8"))
    return result.admitted, result.summary, result.loss_report


def test_bundled_registry_keeps_cif_probe_active_with_compute() -> None:
    registry = load_bundled_registry()

    assert registry.adapter_count == 2
    assert registry.active_adapter_count == 2
    registration = registry.document["adapters"][0]
    manifest = registration["manifest"]
    assert manifest["adapter_id"] == ADAPTER_ID
    assert manifest["adapter_version"] == ADAPTER_VERSION
    assert manifest["permission_class"] == "local_pure"
    assert manifest["network_policy"] == "deny"
    assert registration["enabled"] is True
    capability = registration["format_capabilities"][0]["capability"]
    assert capability["capability_id"] == CAPABILITY_ID
    assert capability["classification"] == "QUERY_ONLY"

    resolution = registry.resolve_format_capability(bundled_cif_capability())
    assert resolution.registered is True
    assert resolution.trusted is True
    assert resolution.active is True
    assert resolution.reason == "ACTIVE"

    tampered = copy.deepcopy(bundled_cif_capability())
    tampered["classification"] = "LOSSY_WITH_REPORT"
    tampered["allowed_loss_codes"] = ["UNMAPPED_CIF_ITEMS_PRESERVED"]
    tampered_resolution = registry.resolve_format_capability(tampered)
    assert tampered_resolution.registered is False
    assert tampered_resolution.trusted is False
    assert tampered_resolution.active is False
    assert tampered_resolution.reason == "CAPABILITY_NOT_REGISTERED"


def test_manifest_pins_the_exact_implementation_bytes() -> None:
    registry = load_bundled_registry()
    manifest = registry.document["adapters"][0]["manifest"]
    package_material = b"".join(
        (REPOSITORY_ROOT / "src" / "chem_workbench" / "adapters" / name).read_bytes()
        for name in ("cif_probe.py", "cif_import.py")
    )

    assert manifest["package_hash"] == {
        "type": "adapter_package_hash",
        "algorithm": "sha256",
        "value": hashlib.sha256(package_material).hexdigest(),
    }


def test_admitted_explicit_p1_source_is_query_only_with_normalized_notices() -> None:
    admitted, summary, report = probe(ADMITTED_SOURCE)

    assert admitted
    assert report["classification"] == "QUERY_ONLY"
    assert summary["site_count"] == 2
    assert summary["elements"] == ["Cu"]
    assert summary["element_counts"] == {"Cu": 2}
    assert summary["cell_complete"] is True
    assert summary["symmetry_operations"] == 1
    assert summary["symmetry_identity_only"] is True
    assert summary["standard_uncertainty_count"] == 1
    assert summary["unmapped_tags"] == ["_chemical_name"]
    assert issue_codes(report) == {
        "STANDARD_UNCERTAINTY_STRIPPED",
        "UNMAPPED_CIF_ITEMS_PRESERVED",
    }
    validate_loss_report(report)
    resolution = load_bundled_registry().resolve_loss_report(report)
    assert resolution.bindings_valid is True
    assert resolution.publishable is False


def test_repository_cif_examples_are_admitted(tmp_path: Path) -> None:
    for name, sites, elements in (("fcc-copper.cif", 4, ["Cu"]), ("silicon.cif", 8, ["Si"])):
        source = (REPOSITORY_ROOT / "examples" / "crystals" / "structures" / name).read_bytes()
        result = probe_cif_bytes(source)

        assert result.admitted, name
        assert result.summary["site_count"] == sites
        assert result.summary["elements"] == elements
        assert result.loss_report["classification"] == "QUERY_ONLY"


def test_missing_occupancy_column_is_recorded_not_assumed() -> None:
    source = ADMITTED_SOURCE.replace("_atom_site_occupancy\n", "").replace(" 1.0000\n", "\n")
    source = source.replace("Cu1 Cu 0.0 0.0 0.0 ", "Cu1 Cu 0.0 0.0 0.0")
    source = source.replace("Cu2 Cu 0.0 0.5 0.5 ", "Cu2 Cu 0.0 0.5 0.5")

    admitted, summary, report = probe(source)

    assert admitted
    assert "CIF_OCCUPANCY_DEFAULTED" in issue_codes(report)
    assert summary["site_count"] == 2


def test_probe_is_deterministic_for_identical_bytes() -> None:
    first = probe_cif_bytes(ADMITTED_SOURCE.encode("utf-8"))
    second = probe_cif_bytes(ADMITTED_SOURCE.encode("utf-8"))

    assert first.loss_report == second.loss_report
    assert pretty_bytes(first.loss_report) == pretty_bytes(second.loss_report)


def test_partial_occupancy_is_rejected_as_unsupported() -> None:
    admitted, _summary, report = probe(DISORDERED_SOURCE)

    assert not admitted
    assert report["classification"] == "UNSUPPORTED"
    assert "PARTIAL_OCCUPANCY" in issue_codes(report)
    validate_loss_report(report)


def test_symmetry_expansion_is_rejected_as_unsupported() -> None:
    admitted, summary, report = probe(SYMMETRY_SOURCE)

    assert not admitted
    assert summary["symmetry_operations"] == 2
    assert "SYMMETRY_EXPANSION_REQUIRED" in issue_codes(report)


def test_multiple_data_blocks_are_rejected() -> None:
    admitted, _summary, report = probe(MULTI_BLOCK_SOURCE)

    assert not admitted
    assert "MULTIPLE_DATA_BLOCKS" in issue_codes(report)


def test_incomplete_loop_row_is_a_syntax_rejection() -> None:
    admitted, _summary, report = probe(INCOMPLETE_ROW_SOURCE)

    assert not admitted
    assert "CIF_LOOP_ROW_INCOMPLETE" in issue_codes(report)


def test_unterminated_quote_is_a_syntax_rejection() -> None:
    admitted, _summary, report = probe(UNTERMINATED_QUOTE_SOURCE)

    assert not admitted
    assert "CIF_SYNTAX_ERROR" in issue_codes(report)


def test_missing_type_symbols_block_element_inference() -> None:
    admitted, _summary, report = probe(NO_TYPE_SYMBOL_SOURCE)

    assert not admitted
    assert "MISSING_TYPE_SYMBOL" in issue_codes(report)


def test_parser_rejects_duplicate_items_and_reserved_constructs() -> None:
    duplicate = ADMITTED_SOURCE.replace(
        "_cell_length_b 3.6149", "_cell_length_b 3.6149\n_cell_length_a 4.0"
    )
    try:
        parse_cif_text(duplicate)
    except Exception as error:  # CifSyntaxError
        assert "more than once" in str(error)
    else:
        raise AssertionError("duplicate item unexpectedly parsed")

    reserved = ADMITTED_SOURCE + "\nsave_frame\n"
    admitted_flag, _summary, report = probe(reserved)
    assert not admitted_flag
    assert "CIF_SYNTAX_ERROR" in issue_codes(report)


def test_probe_reports_non_utf8_as_an_operational_error() -> None:
    try:
        probe_cif_bytes(b"data_x\n\xff\xfe\n")
    except ValueError as error:
        assert "UTF-8" in str(error)
    else:
        raise AssertionError("non-UTF-8 source unexpectedly probed")


def test_cli_probe_emits_inspectable_loss_reports(
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    source = tmp_path / "good.cif"
    source.write_text(ADMITTED_SOURCE, encoding="utf-8")
    report_path = tmp_path / "good.loss.json"

    completed = run_chem("probe", source, "--output", report_path)
    assert completed.returncode == 0, completed.stderr.decode("utf-8", errors="replace")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["classification"] == "QUERY_ONLY"

    inspected = run_chem("inspect", report_path)
    assert inspected.returncode == 0, inspected.stderr.decode("utf-8", errors="replace")
    summary = json.loads(inspected.stdout)
    assert summary["artifact_type"] == "LossReport"
    assert summary["registered"] is True
    assert summary["active"] is True
    assert summary["bindings_valid"] is True
    assert summary["publishable"] is False

    rejected = tmp_path / "disordered.cif"
    rejected.write_text(DISORDERED_SOURCE, encoding="utf-8")
    rejected_run = run_chem("probe", rejected)
    assert rejected_run.returncode == 1
    rejected_report = json.loads(rejected_run.stdout)
    assert rejected_report["classification"] == "UNSUPPORTED"


def test_cli_probe_rejects_unreadable_paths(run_chem: RunChem) -> None:
    completed = run_chem("probe", "does-not-exist.cif")

    assert completed.returncode == 2
    assert b"CHM9002" in completed.stderr


def test_capabilities_now_reports_the_registered_adapter(run_chem: RunChem) -> None:
    completed = run_chem("capabilities", "--format", "text")

    assert completed.returncode == 0
    assert b"registered_adapters=2" in completed.stdout
    assert b"active_adapters=2" in completed.stdout
