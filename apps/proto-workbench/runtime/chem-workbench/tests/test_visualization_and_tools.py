"""Real geometry checks and authority boundaries for the non-executing UI tools."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from chem_workbench.tool_gateway import invoke_tool
from chem_workbench.visualization import (
    compile_snapshot,
    content_hash,
    scene_for_compilation,
)

ROOT = Path(__file__).resolve().parents[1]


def copper_snapshot():  # type: ignore[no-untyped-def]
    return compile_snapshot(
        (ROOT / "examples/crystals/fcc-copper.chem").read_text(),
        {
            "structures/fcc-copper.cif": (
                ROOT / "examples/crystals/structures/fcc-copper.cif"
            ).read_text()
        },
    )


def test_crystal_coordinates_derive_from_exact_cif_and_repetition() -> None:
    snapshot = copper_snapshot()
    scene = scene_for_compilation(snapshot)["structures"][0]
    assert scene["unit_cell_atoms"] == 4
    assert len(scene["atoms"]) == 32
    assert scene["atoms"][0]["position"] == [0.0, 0.0, 0.0]
    assert scene["atoms"][1]["position"] == [0.0, 1.80745, 1.80745]
    assert scene["cell"][0] == [3.6149, 0.0, 0.0]
    assert scene["provenance"] == "source_imported"
    assert scene["bonds"] == []
    assert scene["source_hash"] == snapshot.source_sha256
    digest = scene.pop("geometry_hash")
    assert content_hash(scene) == digest


@pytest.mark.skipif(importlib.util.find_spec("rdkit") is None, reason="RDKit is optional")
def test_molecular_conformer_has_real_bond_graph_and_explicit_provenance() -> None:
    snapshot = compile_snapshot('chem 0.1\nmolecule water { structure smiles "O" }')
    scene = scene_for_compilation(snapshot)["structures"][0]
    assert sorted(atom["element"] for atom in scene["atoms"]) == ["H", "H", "O"]
    assert len(scene["bonds"]) == 2
    assert scene["provenance"] == "tool_generated"
    assert "ETKDGv3" in scene["method"]
    assert (
        scene["geometry_hash"] == scene_for_compilation(snapshot)["structures"][0]["geometry_hash"]
    )


def test_missing_cif_never_fabricates_coordinates() -> None:
    snapshot = compile_snapshot((ROOT / "examples/crystals/fcc-copper.chem").read_text())
    scene = scene_for_compilation(snapshot)
    assert not scene["structures"]
    assert "MISSING_COORDINATES" in scene["unavailable"][0]["reason"]


def test_proposal_preserves_fractional_sites_and_changes_cell_only() -> None:
    snapshot = copper_snapshot()
    args = {"object_id": "fcc_copper", "scale_factors": [1.02, 0.98, 1]}
    result = invoke_tool("plan_cu_lattice_scan", args, snapshot)
    plan = result["data"]
    assert plan["status"] == "draft_not_executable"
    assert not plan["execution_authorized"]
    assert plan["results"] == []
    assert [candidate["scale"] for candidate in plan["candidates"]] == ["0.98", "1", "1.02"]
    assert plan["candidates"][0]["lattice_angstrom"][0][0] == "3.542602"
    assert snapshot.document is not None
    assert (
        plan["candidates"][2]["fractional_sites"]
        == snapshot.document["objects"][0]["payload"]["sites"]
    )
    assert result["data_hash"] == content_hash(plan)
    assert invoke_tool("plan_cu_lattice_scan", args, snapshot)["data"] == plan


@pytest.mark.parametrize(
    "args",
    [
        {"object_id": "other_workspace", "scale_factors": [0.98, 1.02]},
        {"object_id": "fcc_copper", "scale_factors": [0.1, 1.02]},
        {"object_id": "fcc_copper", "scale_factors": [1, 1]},
        {"object_id": "fcc_copper", "scale_factors": [1]},
        {"object_id": "fcc_copper", "scale_factors": [0.98, 1.02], "approved": True},
        {"object_id": "fcc_copper", "scale_factors": [0.98, 1.02], "command": "anything"},
    ],
)
def test_invalid_or_authority_expanding_proposals_fail_closed(args: object) -> None:
    with pytest.raises(ValueError):
        invoke_tool("plan_cu_lattice_scan", args, copper_snapshot())


def test_model_cannot_dispatch_execution_or_arbitrary_code() -> None:
    for name in ["workflow_submit", "approve", "run_shell", "execute_python"]:
        with pytest.raises(ValueError, match="UNKNOWN_TOOL"):
            invoke_tool(name, {}, copper_snapshot())


def test_non_copper_subject_rejected_by_design_profile() -> None:
    snapshot = compile_snapshot(
        (ROOT / "examples/crystals/silicon.chem").read_text(),
        {"structures/silicon.cif": (ROOT / "examples/crystals/structures/silicon.cif").read_text()},
    )
    with pytest.raises(ValueError, match="pure copper"):
        invoke_tool(
            "plan_cu_lattice_scan",
            {"object_id": "silicon", "scale_factors": [0.98, 1.02]},
            snapshot,
        )


def test_attachment_change_invalidates_geometry_and_proposal_hashes() -> None:
    original = copper_snapshot()
    changed = compile_snapshot(
        (ROOT / "examples/crystals/fcc-copper.chem").read_text(),
        {
            "structures/fcc-copper.cif": (ROOT / "examples/crystals/structures/fcc-copper.cif")
            .read_text()
            .replace("3.6149", "3.6200")
        },
    )
    assert original.semantic_hash != changed.semantic_hash
    old = scene_for_compilation(original)["structures"][0]
    new = scene_for_compilation(changed)["structures"][0]
    assert old["geometry_hash"] != new["geometry_hash"]
    args = {"object_id": "fcc_copper", "scale_factors": [0.98, 1.02]}
    assert (
        invoke_tool("plan_cu_lattice_scan", args, original)["data"]["logical_plan_hash"]
        != (invoke_tool("plan_cu_lattice_scan", args, changed)["data"]["logical_plan_hash"])
    )


def test_ui_sources_are_english() -> None:
    import re

    for name in ["index.html", "app.js", "viewer.js"]:
        source = (ROOT / "src/chem_workbench/web_assets" / name).read_text(encoding="utf-8")
        assert re.search(r"[\u3400-\u9fff]", source) is None


def test_equivalent_scale_numbers_have_identical_proposal_hashes():
    snapshot = copper_snapshot()
    first = invoke_tool(
        "plan_cu_lattice_scan",
        {"object_id": "fcc_copper", "scale_factors": [0.98, 1, 1.02]},
        snapshot,
    )
    second = invoke_tool(
        "plan_cu_lattice_scan",
        {"object_id": "fcc_copper", "scale_factors": [0.98, 1.0, 1.02]},
        snapshot,
    )
    assert first["data"] == second["data"]
