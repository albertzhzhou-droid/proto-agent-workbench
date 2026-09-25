"""Actual candidate generation chemistry and provenance; no held-out or LM inputs."""

from __future__ import annotations

import copy
import importlib
import math
from collections import Counter
from typing import Any

import pytest

from chem_workbench.design_candidates import (
    candidate_catalog,
    inorganic_candidates,
    organic_candidates,
)
from chem_workbench.visualization import compile_snapshot, content_hash


def verified_hash(record: dict[str, Any], field: str) -> None:
    body = copy.deepcopy(record)
    expected = body.pop(field)
    assert content_hash(body) == expected


def test_real_organic_catalog_generates_distinct_complex_molecules_and_geometry() -> None:
    chem = importlib.import_module("rdkit.Chem")
    result = organic_candidates({"source": "User source stays unchanged."})
    assert result["candidate_count"] == result["attempted_count"] == 8
    assert len({c["canonical_smiles"] for c in result["candidates"]}) == 8
    assert result["request"]["source"] == "User source stays unchanged."
    assert result["execution_authorized"] is False
    verified_hash(result, "result_hash")
    for candidate in result["candidates"]:
        assert candidate["family"] == "organic"
        verified_hash(candidate, "candidate_hash")
        verified_hash(candidate["geometry"], "geometry_hash")
        mol = chem.MolFromSmiles(candidate["canonical_smiles"])
        assert mol.GetNumHeavyAtoms() >= 8
        assert len(candidate["complexity"]["structural_feature_classes"]) >= 2
        assert chem.GetFormalCharge(mol) == 0
        geometry = candidate["geometry"]
        assert len(geometry["atoms"]) == chem.AddHs(mol).GetNumAtoms()
        assert all(math.isfinite(x) for atom in geometry["atoms"] for x in atom["position"])
        assert len(geometry["bonds"]) == chem.AddHs(mol).GetNumBonds()
        assert geometry["provenance"] == "tool_generated"
        assert "energy" not in candidate["descriptors"]
        snapshot = compile_snapshot(candidate["source"])
        assert snapshot.success
        assert snapshot.document is not None
        assert (
            snapshot.document["objects"][0]["payload"]["representations"][0]["value"]
            == candidate["canonical_smiles"]
        )


def test_scaffold_atoms_bonds_and_attachment_are_preserved_in_candidate_geometry() -> None:
    chem = importlib.import_module("rdkit.Chem")
    spec = {"scaffold_id": "pyridyl_amide", "fragment_ids": ["hydroxyethyl"]}
    candidate = organic_candidates(spec)["candidates"][0]
    generation = candidate["generation"]
    scaffold = chem.MolFromSmiles(generation["scaffold_smiles"])
    mapping = {
        m["source_atom_index"]: m["candidate_atom_index"]
        for m in generation["scaffold_atom_mapping"]
    }
    assert set(mapping) == {a.GetIdx() for a in scaffold.GetAtoms() if a.GetAtomicNum()}
    atoms, bonds = candidate["geometry"]["atoms"], candidate["geometry"]["bonds"]
    edges = {frozenset((b["a"], b["b"])): b["order"] for b in bonds}
    for old, new in mapping.items():
        assert atoms[new]["element"] == scaffold.GetAtomWithIdx(old).GetSymbol()
    for bond in scaffold.GetBonds():
        a, b = bond.GetBeginAtomIdx(), bond.GetEndAtomIdx()
        if a in mapping and b in mapping:
            assert edges[frozenset((mapping[a], mapping[b]))] == bond.GetBondTypeAsDouble()
    dummy = next(a for a in scaffold.GetAtoms() if a.GetAtomicNum() == 0)
    assert generation["attachment_atom_index"] == mapping[dummy.GetNeighbors()[0].GetIdx()]
    assert generation["anchor_atom_indices"]
    assert set(generation["anchor_atom_indices"]) <= set(mapping.values())


def test_custom_scaffold_creates_a_new_stereospecified_compound_and_deduplicates() -> None:
    chem = importlib.import_module("rdkit.Chem")
    spec = {
        "scaffold_id": "custom",
        "scaffold_smiles": "O=C(N[C@H](C)[*:1])c1ccncc1",
        "fragments": ["[*:1]CC", "CC[*:1]"],
    }
    result = organic_candidates(spec)
    assert result["candidate_count"] == 1
    assert "DUPLICATE_CANDIDATE" in result["rejected"][0]["reason"]
    candidate = result["candidates"][0]
    mol = chem.MolFromSmiles(candidate["canonical_smiles"])
    stereo = list(chem.FindPotentialStereo(mol))
    assert len(stereo) == 1
    assert stereo[0].specified == chem.StereoSpecified.Specified
    assert "@" in candidate["canonical_smiles"]
    assert compile_snapshot(candidate["source"]).success


def test_custom_double_bond_stereo_source_roundtrip() -> None:
    result = organic_candidates(
        {"scaffold_smiles": "O=C(NCC[*:1])c1ccc(O)cc1", "fragments": ["[*:1]/C=C/C"]}
    )
    assert result["candidate_count"] == 1
    candidate = result["candidates"][0]
    assert "/" in candidate["canonical_smiles"] or "\\" in candidate["canonical_smiles"]
    assert compile_snapshot(candidate["source"]).success


def test_attachment_preserves_distinct_enantiomers() -> None:
    spec = {"scaffold_smiles": "O=C(N[C@H](C)[*:1])c1ccncc1", "fragment_ids": ["ethyl"]}
    first = organic_candidates(spec)["candidates"][0]
    second = organic_candidates({**spec, "scaffold_smiles": "O=C(N[C@@H](C)[*:1])c1ccncc1"})[
        "candidates"
    ][0]
    assert first["identity_hash"] != second["identity_hash"]
    assert first["canonical_smiles"] == "CC[C@@H](C)NC(=O)c1ccncc1"
    assert second["canonical_smiles"] == "CC[C@H](C)NC(=O)c1ccncc1"


def test_unspecified_stereo_is_rejected_without_inventing_configuration() -> None:
    result = organic_candidates(
        {"scaffold_smiles": "O=C(NC(C)[*:1])c1ccncc1", "fragment_ids": ["ethyl"]}
    )
    assert result["candidate_count"] == 0
    assert "unspecified stereochemistry" in result["rejected"][0]["reason"]


def test_single_amide_motif_does_not_count_as_two_complexity_features() -> None:
    result = organic_candidates({"scaffold_smiles": "CCCCC(=O)NCC[*:1]", "fragment_ids": ["ethyl"]})
    assert result["candidate_count"] == 0
    assert "two feature classes" in result["rejected"][0]["reason"]


def test_filters_and_ranking_are_applied_to_real_numeric_descriptors() -> None:
    result = organic_candidates(
        {"ranking": "high_tpsa", "max_candidates": 2, "filters": {"tpsa_min": 90, "logp_max": 2.0}}
    )
    assert 1 <= result["candidate_count"] <= 2
    assert result["rejected"]
    tpsa = [c["descriptors"]["tpsa"] for c in result["candidates"]]
    assert tpsa == sorted(tpsa, reverse=True)
    assert all(
        c["descriptors"]["tpsa"] >= 90 and c["descriptors"]["logp"] <= 2.0
        for c in result["candidates"]
    )
    empty = organic_candidates({"filters": {"tpsa_min": 400}})
    assert empty["candidate_count"] == 0
    assert len(empty["rejected"]) == empty["attempted_count"] == 8


@pytest.mark.parametrize(
    "spec",
    [
        {"max_candidates": True},
        {"max_candidates": 25},
        {"ranking": {}},
        {"filters": {"logp_min": float("nan")}},
        {"filters": {"mw_max": float("inf")}},
        {"filters": {"logp_min": 5, "logp_max": 1}},
        {"filters": {"energy_min": 0}},
        {"fragment_ids": ["missing"]},
        {"fragments": ["[*:1]C"] * 25},
        {"fragment_ids": []},
        {"scaffold_id": "custom", "scaffold_smiles": "CCCC"},
        {"scaffold_smiles": "O=C(NCC[*:1])c1ccncc1.[Na+]"},
        {"scaffold_smiles": "O=C(NCC[*:1])c1cc([*:1])ncc1"},
        {"scaffold_smiles": "O=C([NH2+]CC[*:1])c1ccncc1"},
        {"fragments": ["[*:1][CH3:2]"]},
        {"fragments": ["[*:1][13CH3]"]},
        {"fragments": ["[*:1]Br"]},
        {"fragments": ["[*:1]=C"]},
        {"scaffold_id": "catechol_amide", "scaffold_smiles": "[*:1]C"},
        {"approve": True},
    ],
)
def test_invalid_organic_requests_rejected(spec: dict[str, Any]) -> None:
    with pytest.raises(ValueError, match="INVALID_DESIGN_SPEC"):
        organic_candidates(spec)


def test_deterministic_request_result_geometry_hashes_and_source_binding() -> None:
    spec = {"fragment_ids": ["methyl", "ethyl"], "source": "first source"}
    assert organic_candidates(spec) == organic_candidates(spec)
    first = organic_candidates(spec)
    second = organic_candidates({**spec, "source": "second source"})
    assert first["request_hash"] != second["request_hash"]
    assert first["result_hash"] != second["result_hash"]
    assert first["candidates"][0]["identity_hash"] == second["candidates"][0]["identity_hash"]
    assert first["candidates"][0]["candidate_hash"] != second["candidates"][0]["candidate_hash"]
    assert spec == {"fragment_ids": ["methyl", "ethyl"], "source": "first source"}


def test_real_ordered_oxide_geometry_charge_stoichiometry_and_coordination() -> None:
    core = importlib.import_module("pymatgen.core")
    result = inorganic_candidates({"max_candidates": 24})
    assert result["candidate_count"] == result["attempted_count"] == 18
    verified_hash(result, "result_hash")
    for candidate in result["candidates"]:
        verified_hash(candidate, "candidate_hash")
        verified_hash(candidate["geometry"], "geometry_hash")
        assert candidate["family"] == "inorganic"
        sites = candidate["structure"]["sites"]
        assert len(sites) == 40
        assert Counter(s["sublattice"] for s in sites) == {"A": 8, "B": 4, "B_prime": 4, "O": 24}
        assert sum(s["oxidation_state"] * s["occupancy"] for s in sites) == 0
        assert all(s["occupancy"] == 1 for s in sites)
        rebuilt = core.Structure(
            candidate["structure"]["lattice"],
            [core.Species(s["element"], s["oxidation_state"]) for s in sites],
            [s["fractional_coordinates"] for s in sites],
        )
        assert rebuilt.is_ordered
        assert rebuilt.charge == 0
        assert min(float(rebuilt.distance_matrix[i, j]) for i in range(40) for j in range(i)) > 1
        for row in candidate["validation"]["site_coordination"]:
            assert row["oxygen_coordination"] == (12 if row["sublattice"] == "A" else 6)
        assert all(math.isfinite(x) for row in candidate["geometry"]["cell"] for x in row)
        assert "energy" not in candidate["descriptors"]
        assert "structural screening only" in candidate["score_scope"]


def test_oxide_shannon_radius_formula_and_target_control_actual_ranking() -> None:
    result = inorganic_candidates(
        {"a_elements": ["Ca", "Ba"], "b_pairs": [["Mg", "W"]], "tolerance_target": 0.8}
    )
    assert result["candidates"][0]["formula"] == "Ca2MgWO6"
    for candidate in result["candidates"]:
        a = candidate["generation"]["a_element"]
        radius_a = {"Ca": 1.34, "Ba": 1.61}[a]
        expected = (radius_a + 1.4) / (math.sqrt(2) * ((0.72 + 0.60) / 2 + 1.4))
        assert candidate["descriptors"]["tolerance_factor"] == pytest.approx(expected)
        assert candidate["score"] == pytest.approx(abs(expected - 0.8))
    assert (
        inorganic_candidates(
            {"a_elements": ["Ca", "Ba"], "b_pairs": [["Mg", "W"]], "tolerance_target": 1.1}
        )["candidates"][0]["formula"]
        == "Ba2MgWO6"
    )


@pytest.mark.parametrize(
    "spec",
    [
        {"a_elements": ["Na"]},
        {"a_elements": ["Ca", "Ca"]},
        {"a_elements": []},
        {"b_pairs": [["Mg", "Ti"]]},
        {"b_pairs": [["Mg", "W"], ["Mg", "W"]]},
        {"b_pairs": [["W", "Mg"]]},
        {"b_pairs": []},
        {"tolerance_target": float("nan")},
        {"tolerance_target": 1.2},
        {"tolerance_target": True},
        {"max_candidates": 0},
        {"charge": 1},
    ],
)
def test_invalid_oxide_and_unbalanced_element_requests_rejected(spec: dict[str, Any]) -> None:
    with pytest.raises(ValueError, match="INVALID_DESIGN_SPEC"):
        inorganic_candidates(spec)


def test_oxide_determinism_limits_source_binding_and_catalog_are_isolated() -> None:
    spec = {
        "a_elements": ["Sr"],
        "b_pairs": [["Sc", "Nb"], ["Mg", "W"]],
        "max_candidates": 1,
        "source": "source input",
    }
    first = inorganic_candidates(spec)
    assert first == inorganic_candidates(spec)
    assert first["candidate_count"] == 1
    assert len(first["rejected"]) == 1
    assert first["rejected"][0]["reason"] == "RANKING_LIMIT"
    second = inorganic_candidates({**spec, "source": "changed"})
    assert first["result_hash"] != second["result_hash"]
    assert first["candidates"][0]["identity_hash"] == second["candidates"][0]["identity_hash"]
    catalog = candidate_catalog()
    catalog["scaffolds"][0]["name"] = "Changed"
    catalog["b_pairs"][0][0] = "Changed"
    assert candidate_catalog()["scaffolds"][0]["name"] != "Changed"
    assert candidate_catalog()["b_pairs"][0][0] == "Mg"
