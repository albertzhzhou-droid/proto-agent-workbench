"""Independent graph and stoichiometry checks for declared complex-molecule recipes."""

from __future__ import annotations

import copy
import importlib
from collections import Counter
from typing import Any

import pytest

from chem_workbench.design_candidates import (
    candidate_catalog,
    inorganic_candidates,
    organic_candidates,
)
from chem_workbench.interface_mechanisms import mechanism_eligibility, mechanism_for_candidate
from chem_workbench.visualization import content_hash


@pytest.fixture(scope="module")
def organic() -> list[dict[str, Any]]:
    return organic_candidates({})["candidates"]


@pytest.fixture(scope="module")
def oxide() -> dict[str, Any]:
    return inorganic_candidates({"a_elements": ["Sr"], "b_pairs": [["Sc", "Nb"]]})["candidates"][0]


def verify_hash(value: dict[str, Any], field: str) -> None:
    record = copy.deepcopy(value)
    digest = record.pop(field)
    assert content_hash(record) == digest


@pytest.mark.parametrize("profile", ["electrode_electrolyte", "catalyst_reactant", "solid_liquid"])
def test_all_default_variants_have_real_balanced_molecular_graphs(
    profile: str, organic: list[dict[str, Any]], oxide: dict[str, Any]
) -> None:
    chem = importlib.import_module("rdkit.Chem")
    parser = chem.SmilesParserParams()
    parser.removeHs = False
    assert len(organic) == 8
    for candidate in organic:
        mechanism = mechanism_for_candidate(profile, candidate, oxide)
        verify_hash(mechanism, "mechanism_hash")
        assert mechanism["source_candidate_hash"] == content_hash(candidate)
        assert mechanism["candidate_hashes"]["inorganic"] == content_hash(oxide)
        records = {s["id"]: s for s in mechanism["species"]}
        assert set(mechanism["state_species"].values()) <= set(records)
        assert mechanism["vacant_site"] in records
        calculated = {}
        for key, species in records.items():
            verify_hash(species, "species_hash")
            if species["canonical_smiles"] is None:
                assert species["special_species"] in {"site", "electron"}
                counts = Counter()
                charge = -1 if species["special_species"] == "electron" else 0
            else:
                molecule = chem.MolFromSmiles(species["canonical_smiles"], parser)
                assert molecule is not None
                chem.SanitizeMol(molecule)
                counts = Counter(a.GetSymbol() for a in chem.AddHs(molecule).GetAtoms())
                charge = chem.GetFormalCharge(molecule)
                assert (
                    sum(a.GetNumRadicalElectrons() for a in molecule.GetAtoms())
                    == species["radical_electrons"]
                )
                assert len(species["graph"]["atoms"]) == sum(counts.values())
                assert len(species["graph"]["bonds"]) == chem.AddHs(molecule).GetNumBonds()
            assert dict(counts) == species["element_counts"]
            assert charge == species["formal_charge"]
            calculated[key] = (counts, charge, species["site_count"])
        for step in mechanism["steps"]:
            delta: Counter[str] = Counter()
            charge = sites = 0
            for sign, side in ((-1, "reactants"), (1, "products")):
                for key, count in step[side].items():
                    elements, q, occupancy = calculated[key]
                    for element, number in elements.items():
                        delta[element] += sign * count * number
                    charge += sign * count * q
                    sites += sign * count * occupancy
            assert all(v == 0 for v in delta.values())
            assert charge == sites == 0
        assert all(
            p["passed"] and p["electron_balance"] == 0 for p in mechanism["conservation_proofs"]
        )


def test_catalyst_has_specific_quinone_and_explicit_hydrogen_stoichiometry(
    organic: list[dict[str, Any]],
) -> None:
    candidate = next(c for c in organic if c["generation"]["fragment_id"] == "methyl")
    mechanism = mechanism_for_candidate("catalyst_reactant", candidate)
    species = {s["id"]: s for s in mechanism["species"]}
    assert species["reactant"]["formula"] == "C10H13NO3"
    assert species["product"]["formula"] == "C10H11NO3"
    assert species["product"]["canonical_smiles"] == "CCCNC(=O)C1=CC(=O)C(=O)C=C1"
    assert species["hydrogen"]["element_counts"] == {"H": 2}
    step = next(s for s in mechanism["steps"] if s["id"] == "catechol_dehydrogenation")
    assert step["reactants"] == {"reactant_adsorbed": 1}
    assert step["products"] == {"product_adsorbed": 1, "hydrogen": 1}
    assert mechanism["chemostats"][0]["activity_binding"] == "parameters.hydrogen_activity"
    assert "not an elementary pathway" in step["rate_assumption"]


def test_electrode_one_electron_pair_preserves_atoms_and_has_one_radical(
    organic: list[dict[str, Any]],
) -> None:
    mechanism = mechanism_for_candidate("electrode_electrolyte", organic[0])
    species = {s["id"]: s for s in mechanism["species"]}
    oxidized, reduced = species["oxidized"], species["reduced_adsorbed"]
    assert oxidized["element_counts"] == reduced["element_counts"]
    assert oxidized["formal_charge"] == oxidized["radical_electrons"] == 0
    assert reduced["formal_charge"] == -1
    assert reduced["radical_electrons"] == 1
    assert mechanism["steps"][0]["reactants"]["electron"] == 1
    assert "resonance representation" in " ".join(mechanism["limitations"])
    assert mechanism["state_species"] == {
        "theta_reduced": "reduced_adsorbed",
        "concentration_oxidized_mol_m3": "oxidized",
    }
    assert oxidized["canonical_smiles"] != mechanism["source_canonical_smiles"]


def test_liquid_non_covalent_association_and_real_basic_atom_protonation(
    organic: list[dict[str, Any]], oxide: dict[str, Any]
) -> None:
    chem = importlib.import_module("rdkit.Chem")
    for fragment, expected_site in (
        ("pyridyl", "pyridyl_nitrogen"),
        ("aminocarbonyl", "scaffold_amide_carbonyl_oxygen"),
    ):
        candidate = next(c for c in organic if c["generation"]["fragment_id"] == fragment)
        mechanism = mechanism_for_candidate("solid_liquid", candidate, oxide)
        species = {s["id"]: s for s in mechanism["species"]}
        site, adduct, protonated = (
            species["vacant_site"],
            species["adsorbed_complex"],
            species["protonated_site"],
        )
        assert len(chem.GetMolFrags(chem.MolFromSmiles(adduct["canonical_smiles"]))) == 2
        assert adduct["element_counts"] == {k: 2 * v for k, v in site["element_counts"].items()}
        assert adduct["site_count"] == protonated["site_count"] == site["site_count"] == 1
        assert protonated["formal_charge"] == 1
        expected = dict(site["element_counts"])
        expected["H"] += 1
        assert protonated["element_counts"] == expected
        assert mechanism["site_recipe"]["protonation_site"]["site_type"] == expected_site
        assert mechanism["site_recipe"]["support_candidate_hash"] == content_hash(oxide)
        assert "independent of bulk unit-cell" in mechanism["site_recipe"]["site_density"]
        assert "no covalent support bond" in mechanism["site_recipe"]["immobilization"]


@pytest.mark.parametrize("profile", ["electrode_electrolyte", "catalyst_reactant", "solid_liquid"])
@pytest.mark.parametrize("scaffold", ["carboxylate_amide", "pyridyl_amide"])
def test_unsupported_catalog_scaffold_requires_its_own_mechanism(
    profile: str, scaffold: str
) -> None:
    candidate = organic_candidates({"scaffold_id": scaffold, "fragment_ids": ["methyl"]})[
        "candidates"
    ][0]
    with pytest.raises(ValueError, match="MECHANISM_REQUIRED"):
        mechanism_for_candidate(profile, candidate)


def test_two_catechol_groups_require_explicit_selection() -> None:
    candidate = organic_candidates(
        {"scaffold_smiles": "O=C(NCC[*:1])c1cc(O)c(O)cc1", "fragments": ["[*:1]c1cc(O)c(O)cc1"]}
    )["candidates"][0]
    with pytest.raises(ValueError, match="exactly one non-fused catechol"):
        mechanism_for_candidate("catalyst_reactant", candidate)


def test_ambiguous_basic_sites_require_explicit_site_selection() -> None:
    candidate = organic_candidates({"fragments": ["[*:1]c1nccnc1"]})["candidates"][0]
    with pytest.raises(ValueError, match="multiple basic aromatic nitrogens"):
        mechanism_for_candidate("solid_liquid", candidate)


@pytest.mark.parametrize(
    "fragment,expected_type",
    [
        ("[*:1]c1ccn(C)c1", "scaffold_amide_carbonyl_oxygen"),
        ("[*:1]c1cn(C)cn1", "pyridyl_nitrogen"),
    ],
)
def test_pyrrolic_nitrogen_is_not_mistaken_for_pyridine_type_site(
    fragment: str, expected_type: str
) -> None:
    chem = importlib.import_module("rdkit.Chem")
    candidate = organic_candidates({"fragments": [fragment]})["candidates"][0]
    mechanism = mechanism_for_candidate("solid_liquid", candidate)
    selected = mechanism["site_recipe"]["protonation_site"]
    assert selected["site_type"] == expected_type
    parent = chem.MolFromSmiles(candidate["canonical_smiles"])
    atom = parent.GetAtomWithIdx(selected["source_atom_index"])
    if atom.GetSymbol() == "N":
        assert atom.GetDegree() == 2 and atom.GetIsAromatic()
    else:
        assert atom.GetSymbol() == "O"
    assert mechanism_eligibility("solid_liquid", candidate["canonical_smiles"])["eligible"]
    assert all(proof["passed"] for proof in mechanism["conservation_proofs"])


def test_custom_nonfused_catechol_retains_spectator_stereochemistry() -> None:
    chem = importlib.import_module("rdkit.Chem")
    candidate = organic_candidates(
        {"scaffold_smiles": "O=C(N[C@H](C)[*:1])c1cc(O)c(O)cc1", "fragment_ids": ["ethyl"]}
    )["candidates"][0]
    mechanism = mechanism_for_candidate("catalyst_reactant", candidate)
    for item in mechanism["species"]:
        if item["id"] not in {"reactant", "product"}:
            continue
        molecule = chem.MolFromSmiles(item["canonical_smiles"])
        stereo = list(chem.FindPotentialStereo(molecule))
        assert len(stereo) == 1
        assert stereo[0].specified == chem.StereoSpecified.Specified


def test_source_candidate_and_support_are_bound_without_mutation(
    organic: list[dict[str, Any]], oxide: dict[str, Any]
) -> None:
    inputs = copy.deepcopy((organic[0], oxide))
    result = mechanism_for_candidate("solid_liquid", *inputs)
    assert result == mechanism_for_candidate("solid_liquid", *inputs)
    assert inputs == (organic[0], oxide)
    other = inorganic_candidates({"a_elements": ["Ba"], "b_pairs": [["Sc", "Nb"]]})["candidates"][0]
    assert (
        result["mechanism_hash"]
        != mechanism_for_candidate("solid_liquid", organic[0], other)["mechanism_hash"]
    )
    changed = copy.deepcopy(organic[0])
    changed["canonical_smiles"] = "O"
    with pytest.raises(ValueError, match="content hash mismatch"):
        mechanism_for_candidate("electrode_electrolyte", changed)
    with pytest.raises(ValueError, match="wrong candidate family"):
        mechanism_for_candidate("electrode_electrolyte", oxide)
    with pytest.raises(ValueError, match="unregistered interface profile"):
        mechanism_for_candidate("invented", organic[0])


def test_catalog_eligibility_uses_chemical_probe_without_geometry(monkeypatch: Any) -> None:
    allchem = importlib.import_module("rdkit.Chem.AllChem")

    def unexpected(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("Eligibility must not generate coordinates or compute energy")

    monkeypatch.setattr(allchem, "EmbedMolecule", unexpected)
    for scaffold in candidate_catalog()["scaffolds"]:
        for profile in ("solid_liquid", "catalyst_reactant", "electrode_electrolyte"):
            result = mechanism_eligibility(profile, scaffold["smiles"])
            assert result["probe"] == "methyl_capped_scaffold"
            assert result["eligible"] is (scaffold["id"] == "catechol_amide")
            assert result["checked_smiles_hash"] == content_hash(scaffold["smiles"])


def test_complete_candidate_eligibility_matches_actual_recipe(
    organic: list[dict[str, Any]],
) -> None:
    for profile in ("solid_liquid", "catalyst_reactant", "electrode_electrolyte"):
        for candidate in organic:
            eligibility = mechanism_eligibility(profile, candidate["canonical_smiles"])
            assert eligibility["eligible"] is True
            assert eligibility["probe"] == "complete_candidate"
            assert (
                eligibility["recipe_id"] == mechanism_for_candidate(profile, candidate)["recipe_id"]
            )
    bad = organic_candidates({"fragments": ["[*:1]c1nccnc1"]})["candidates"][0]
    assert mechanism_eligibility("solid_liquid", bad["canonical_smiles"])["eligible"] is False


@pytest.mark.parametrize(
    "profile,smiles",
    [
        ("invented", "Oc1ccccc1O"),
        ("catalyst_reactant", "invalid smiles"),
        ("catalyst_reactant", "[*:2]Cc1ccc(O)c(O)c1"),
        ("catalyst_reactant", "Oc1ccc([*:1])c(O)c1[*:1]"),
    ],
)
def test_invalid_eligibility_inputs_do_not_claim_supported(profile: str, smiles: str) -> None:
    result = mechanism_eligibility(profile, smiles)
    assert result["eligible"] is False
    assert result["recipe_id"] is None
