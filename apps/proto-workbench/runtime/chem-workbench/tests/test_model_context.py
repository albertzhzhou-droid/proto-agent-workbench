"""Check the host's model view against actual declaration and tool contracts."""

from pathlib import Path

import pytest
from test_visualization_and_tools import copper_snapshot

from chem_workbench.model_context import request_context, validate_selected_action
from chem_workbench.tool_gateway import invoke_tool
from chem_workbench.visualization import compile_snapshot

ROOT = Path(__file__).resolve().parents[1]


def test_all_declaration_kinds_are_inspectable_but_only_structures_have_coordinates():
    snapshot = copper_snapshot()
    brief, _ = request_context(snapshot)
    assert len(brief) == len(snapshot.document["objects"])
    for item in brief:
        action = {
            "action": "object_inspect",
            "object_id": item["object_id"],
            "scale_factors": [],
            "message": "Inspect",
        }
        validate_selected_action(action, brief)
        assert (
            invoke_tool("object_inspect", {"object_id": item["object_id"]}, snapshot)["status"]
            == "succeeded"
        )
        if item["kind"] not in {"Molecule", "PeriodicStructure"}:
            with pytest.raises(ValueError, match="UNSUPPORTED_PROFILE"):
                validate_selected_action({**action, "action": "structure_preview"}, brief)


def test_water_context_exposes_structure_and_linked_scientific_state():
    snapshot = compile_snapshot((ROOT / "examples/molecules/water.chem").read_text())
    brief, _ = request_context(snapshot)
    water = next(item for item in brief if item["kind"] == "Molecule")
    assert water["structure"]["representations"] == [{"format": "smiles", "value": "O"}]
    assert "plan_water_single_point" in water["admitted_tools"]
    assert {item["kind"] for item in water["linked_declarations"]} >= {
        "ElectronicState",
        "CalculationSpec",
    }


@pytest.mark.parametrize("scales", [[], [1], [1, 1], [0.94, 1], [1, 1.06]])
def test_invalid_copper_scales_are_rejected_without_replacement(scales):
    brief, _ = request_context(copper_snapshot())
    action = {
        "action": "plan_cu_lattice_scan",
        "object_id": "fcc_copper",
        "scale_factors": scales,
        "message": "Prepare",
    }
    with pytest.raises(ValueError, match="INVALID_ARGUMENT"):
        validate_selected_action(action, brief)
    assert action["scale_factors"] == scales


def test_context_limit_rejects_whole_workspace_instead_of_hiding_objects():
    source = "chem 0.1\n" + "\n".join(
        f'molecule molecule_{index} {{ structure smiles "O" }}' for index in range(65)
    )
    with pytest.raises(ValueError, match="CONTEXT_LIMIT"):
        request_context(compile_snapshot(source))


def test_capability_discovery_is_a_zero_argument_action():
    brief, _ = request_context(copper_snapshot())
    validate_selected_action(
        {"action": "capabilities_list", "object_id": "", "scale_factors": [], "message": "List"},
        brief,
    )


def test_unavailable_coordinates_are_not_advertised_as_admitted():
    sources = [
        (ROOT / "examples/crystals/fcc-copper.chem").read_text(),
        'chem 0.1\nmolecule fragments { structure smiles "O.O" }',
    ]
    for source in sources:
        brief, schema = request_context(compile_snapshot(source))
        structure = brief[0]
        assert "structure_preview" not in structure["admitted_tools"]
        assert structure["unavailable_profile_reasons"]
        assert all(
            b["properties"]["action"]["const"] != "structure_preview" for b in schema["anyOf"]
        )
