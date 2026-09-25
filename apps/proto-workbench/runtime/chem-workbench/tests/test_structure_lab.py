"""Scientific representation boundaries for the bounded geometry extension."""

from __future__ import annotations

import copy
from pathlib import Path

import pytest
from test_workflows import request

from chem_workbench.structure_lab import StructureLab


def test_chiral_import_retains_source_and_stereochemistry(tmp_path: Path) -> None:
    lab = StructureLab(tmp_path)
    geometry = lab.import_molecule("C[C@H](O)C(=O)O", "smiles")
    assert "@" in geometry["isomeric_smiles"]
    assert geometry["source_content"] == "C[C@H](O)C(=O)O"
    assert geometry["loss_report"]["added_hydrogens"] is True
    assert geometry["execution_authorized"] is False
    assert lab.read(geometry["geometry_hash"]) == geometry


def test_explicit_sdf_coordinates_are_preserved(tmp_path: Path) -> None:
    from rdkit import Chem
    from rdkit.Chem import AllChem

    molecule = Chem.AddHs(Chem.MolFromSmiles("O"))
    assert AllChem.EmbedMolecule(molecule, randomSeed=42) == 0
    block = Chem.MolToMolBlock(molecule)
    expected = Chem.MolFromMolBlock(block, removeHs=False)
    geometry = StructureLab(tmp_path).import_molecule(block + "\n$$$$\n", "sdf")
    for i, atom in enumerate(geometry["atoms"]):
        assert atom["position"] == list(expected.GetConformer().GetAtomPosition(i))
    assert geometry["provenance"] == "source_imported"


def test_coordinate_revision_invalidates_identity_and_comparison_is_geometric(
    tmp_path: Path,
) -> None:
    lab = StructureLab(tmp_path)
    initial = lab.import_molecule("O", "smiles")
    positions = [copy.copy(a["position"]) for a in initial["atoms"]]
    positions[0][0] += 1
    edited = lab.edit(initial["geometry_hash"], positions)
    assert edited["geometry_hash"] != initial["geometry_hash"]
    assert lab.read(initial["geometry_hash"])["atoms"] == initial["atoms"]
    comparison = lab.compare(initial["geometry_hash"], edited["geometry_hash"])
    assert comparison["maximum_displacement_angstrom"] == pytest.approx(1)
    different = lab.import_molecule("C", "smiles")
    with pytest.raises(ValueError, match="composition"):
        lab.compare(initial["geometry_hash"], different["geometry_hash"])
    positions[0][0] = float("nan")
    with pytest.raises(ValueError, match="finite"):
        lab.edit(initial["geometry_hash"], positions)


@pytest.mark.parametrize("site,count", [("none", 16), ("ontop", 17), ("fcc", 17)])
def test_real_ase_copper_construction(tmp_path: Path, site: str, count: int) -> None:
    data = request()
    geometry = StructureLab(tmp_path).construct_copper(
        data["source"], data["attachments"], "fcc_copper", site
    )
    assert len(geometry["atoms"]) == count
    assert {a["element"] for a in geometry["atoms"]} == {"Cu"}
    assert geometry["settings"]["pbc"] == [True, True, False]
    assert geometry["display_repeats"] == 1
    assert geometry["execution_authorized"] is False


@pytest.mark.parametrize("smiles", ["[Fe]", "O.O", "not-a-molecule"])
def test_unsupported_import_is_explicit(tmp_path: Path, smiles: str) -> None:
    with pytest.raises(ValueError):
        StructureLab(tmp_path).import_molecule(smiles, "smiles")
