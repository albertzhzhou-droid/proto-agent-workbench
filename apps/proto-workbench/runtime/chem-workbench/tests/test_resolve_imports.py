"""Tests for opt-in CIF import resolution during .chem compilation."""

from __future__ import annotations

import json
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path

from chem_workbench.chemir import semantic_hash, validate_typed_digest
from chem_workbench.chemir.schema_validation import validate_review_packet_schema
from chem_workbench.compiler import compile_source

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = REPOSITORY_ROOT / "examples" / "crystals"
RunChem = Callable[..., subprocess.CompletedProcess[bytes]]

FCC_COPPER_CHEM = (EXAMPLES / "fcc-copper.chem").read_text(encoding="utf-8")

DISORDERED_CIF = """data_disordered
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


def diagnostic_codes(result: object) -> set[str]:
    return {diagnostic.code for diagnostic in result.diagnostics}  # type: ignore[attr-defined]


def example_resolver(path: str) -> bytes | None:
    candidate = EXAMPLES / path
    return candidate.read_bytes() if candidate.is_file() else None


def memory_resolver(content: bytes) -> Callable[[str], bytes | None]:
    def resolve(_path: str) -> bytes | None:
        return content

    return resolve


def test_resolved_compilation_attaches_typed_structure_and_binds_the_cif_hash() -> None:
    result = compile_source(
        FCC_COPPER_CHEM, "examples/crystals/fcc-copper.chem", import_resolver=example_resolver
    )

    assert result.success
    assert result.document is not None
    assert "CHM2309" in diagnostic_codes(result)
    assert "CHM2303" not in diagnostic_codes(result)
    assert len(result.conversion_loss_reports) == 1
    crystal = result.document["objects"][0]
    payload = crystal["payload"]
    assert payload["lattice"]["vectors"][0] == ["3.6149", "0", "0"]
    assert len(payload["sites"]) == 4
    assert len(crystal["source_references"]) == 2
    second_hash = crystal["source_references"][1]
    assert second_hash.startswith("source:sha256:")


def test_resolved_semantic_hash_tracks_the_cif_bytes() -> None:
    original_cif = (EXAMPLES / "structures" / "fcc-copper.cif").read_bytes()
    first = compile_source(FCC_COPPER_CHEM, "a.chem", import_resolver=memory_resolver(original_cif))
    edited = original_cif + b"# a trailing comment changes the bytes only\n"
    second = compile_source(FCC_COPPER_CHEM, "a.chem", import_resolver=memory_resolver(edited))

    assert first.success and second.success
    assert first.semantic_hash != second.semantic_hash
    assert semantic_hash(first.document) == first.semantic_hash


def test_resolution_is_deterministic() -> None:
    results = [
        compile_source(FCC_COPPER_CHEM, "a.chem", import_resolver=example_resolver)
        for _ in range(2)
    ]

    assert all(result.success for result in results)
    assert {result.artifact_bytes for result in results} == {results[0].artifact_bytes}
    assert {result.semantic_hash for result in results} == {results[0].semantic_hash}


def test_rejected_import_keeps_the_preserved_source_representation() -> None:
    result = compile_source(
        FCC_COPPER_CHEM,
        "a.chem",
        import_resolver=memory_resolver(DISORDERED_CIF.encode("utf-8")),
    )

    assert result.success
    codes = diagnostic_codes(result)
    assert "CHM2310" in codes
    assert "CHM2303" in codes
    assert "CHM2309" not in codes
    crystal = result.document["objects"][0]
    assert "lattice" not in crystal["payload"]
    assert len(crystal["source_references"]) == 1
    assert len(result.conversion_loss_reports) == 1
    assert result.conversion_loss_reports[0]["classification"] == "UNSUPPORTED"


def test_unreadable_reference_fails_the_opt_in_resolution() -> None:
    result = compile_source(FCC_COPPER_CHEM, "a.chem", import_resolver=lambda _path: None)

    assert not result.success
    assert "CHM2311" in diagnostic_codes(result)
    assert result.document is None


def test_resolved_review_packet_binds_every_source_hash() -> None:
    result = compile_source(FCC_COPPER_CHEM, "a.chem", import_resolver=example_resolver)
    assert result.success

    packet = result.review_packet()

    validate_review_packet_schema(packet)
    recorded = [validate_typed_digest(item, "source_sha256") for item in packet["source_hashes"]]
    assert len(recorded) == 2
    assert result.source_sha256 in recorded
    evidence = packet["observations"][0]["evidence_hashes"]
    assert [validate_typed_digest(item, "source_sha256") for item in evidence] == recorded


def test_cli_compile_resolve_imports_writes_chemir_and_loss_sidecars(
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    workspace = tmp_path / "crystals"
    shutil.copytree(EXAMPLES, workspace)
    output = workspace / "out.chemir.json"

    completed = run_chem(
        "compile",
        workspace / "fcc-copper.chem",
        "--resolve-imports",
        "--output",
        output,
    )

    assert completed.returncode == 0, completed.stderr.decode("utf-8", errors="replace")
    document = json.loads(output.read_text(encoding="utf-8"))
    crystal = document["objects"][0]
    assert "lattice" in crystal["payload"]
    sidecar = workspace / "out.chemir.json.import-0.loss.json"
    assert sidecar.is_file()
    report = json.loads(sidecar.read_text(encoding="utf-8"))
    assert report["classification"] == "SEMANTIC_EQUIVALENT_UNDER_PROFILE"

    checked = run_chem("check", workspace / "fcc-copper.chem", "--resolve-imports")
    assert checked.returncode == 0
    assert b"CHM2309" in checked.stderr

    packet = run_chem("review-compile", output)
    assert packet.returncode == 0, packet.stderr.decode("utf-8", errors="replace")


def test_cli_check_reports_rejected_imports_as_review_required(
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    workspace = tmp_path / "crystals"
    (workspace / "structures").mkdir(parents=True)
    (workspace / "fcc-copper.chem").write_text(FCC_COPPER_CHEM, encoding="utf-8")
    (workspace / "structures" / "fcc-copper.cif").write_text(DISORDERED_CIF, encoding="utf-8")

    completed = run_chem("check", workspace / "fcc-copper.chem", "--resolve-imports")

    assert completed.returncode == 0
    assert b"CHM2310" in completed.stderr
    assert b"CHM2303" in completed.stderr


def test_cli_check_fails_closed_on_missing_reference(
    tmp_path: Path,
    run_chem: RunChem,
) -> None:
    workspace = tmp_path / "crystals"
    workspace.mkdir(parents=True)
    (workspace / "fcc-copper.chem").write_text(FCC_COPPER_CHEM, encoding="utf-8")

    completed = run_chem("check", workspace / "fcc-copper.chem", "--resolve-imports")

    assert completed.returncode == 1
    assert b"CHM2311" in completed.stderr

    without_resolution = run_chem("check", workspace / "fcc-copper.chem")
    assert without_resolution.returncode == 0
