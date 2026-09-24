"""Declared, graph-balanced catechol interface recipes with conditional kinetics.

Graph validation establishes identities and conservation, not feasibility, rates,
barriers, catalyst activity or an observed surface binding configuration.
"""

from __future__ import annotations

import copy
import importlib
from collections import Counter
from importlib.metadata import version
from typing import Any

from chem_workbench.visualization import content_hash

PROFILES = {"electrode_electrolyte", "catalyst_reactant", "solid_liquid"}
CATECHOL_PATTERN = "[OX2H1]-[c]1[c](-[OX2H1])[c][c][c][c]1"


def _candidate(value: object, family: str) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("family") != family:
        raise ValueError("INVALID_MECHANISM_CANDIDATE: wrong candidate family")
    candidate = copy.deepcopy(value)
    digest = candidate.pop("candidate_hash", None)
    if digest != content_hash(candidate):
        raise ValueError("INVALID_MECHANISM_CANDIDATE: candidate content hash mismatch")
    return value


def _catechol_states(smiles: str) -> tuple[Any, Any, Any, tuple[int, ...]]:
    chem = importlib.import_module("rdkit.Chem")
    parent = chem.MolFromSmiles(smiles)
    if parent is None or len(chem.GetMolFrags(parent)) != 1 or chem.GetFormalCharge(parent) != 0:
        raise ValueError("MECHANISM_REQUIRED: one neutral catechol-bearing molecule required")
    if not 8 <= parent.GetNumHeavyAtoms() <= 48 or any(
        atom.GetSymbol() not in {"H", "C", "N", "O", "F", "S", "Cl"} for atom in parent.GetAtoms()
    ):
        raise ValueError("MECHANISM_REQUIRED: bounded organic atom identities required")
    if any(atom.GetNumRadicalElectrons() or atom.GetIsotope() for atom in parent.GetAtoms()):
        raise ValueError("MECHANISM_REQUIRED: neutral closed-shell unlabeled parent required")
    if any(
        info.specified == chem.StereoSpecified.Unspecified
        for info in chem.FindPotentialStereo(parent)
    ):
        raise ValueError("MECHANISM_REQUIRED: complete stereochemistry required")
    matches = parent.GetSubstructMatches(chem.MolFromSmarts(CATECHOL_PATTERN), uniquify=False)
    groups: dict[tuple[int, int], list[tuple[int, ...]]] = {}
    for match in matches:
        ring = (match[1], match[2], *match[4:])
        if all(parent.GetRingInfo().NumAtomRings(index) == 1 for index in ring):
            key = tuple(sorted((match[0], match[3])))
            groups.setdefault((key[0], key[1]), []).append(match)
    if len(groups) != 1:
        raise ValueError(
            "MECHANISM_REQUIRED: exactly one non-fused catechol group is admitted; "
            "provide a separately registered mechanism for this scaffold"
        )
    match = min(next(iter(groups.values())))
    oxygen_a, oxygen_b = match[0], match[3]
    ring = (match[1], match[2], *match[4:])
    quinone = chem.RWMol(parent)
    for index in ring:
        quinone.GetAtomWithIdx(index).SetIsAromatic(False)
    # Declared ortho-quinone recipe: two carbonyls, two residual C=C bonds.
    for i in range(6):
        bond = quinone.GetBondBetweenAtoms(ring[i], ring[(i + 1) % 6])
        bond.SetIsAromatic(False)
        bond.SetBondType(chem.BondType.DOUBLE if i in {2, 4} else chem.BondType.SINGLE)
    for oxygen, carbon in ((oxygen_a, ring[0]), (oxygen_b, ring[1])):
        atom = quinone.GetAtomWithIdx(oxygen)
        atom.SetNumExplicitHs(0)
        atom.SetNoImplicit(True)
        quinone.GetBondBetweenAtoms(oxygen, carbon).SetBondType(chem.BondType.DOUBLE)
    oxidized = quinone.GetMol()
    chem.SanitizeMol(oxidized)
    semiquinone = chem.Mol(parent)
    for index in (oxygen_a, oxygen_b):
        atom = semiquinone.GetAtomWithIdx(index)
        atom.SetNumExplicitHs(0)
        atom.SetNoImplicit(True)
    semiquinone.GetAtomWithIdx(oxygen_a).SetFormalCharge(-1)
    semiquinone.GetAtomWithIdx(oxygen_b).SetNumRadicalElectrons(1)
    chem.SanitizeMol(semiquinone)
    if chem.GetFormalCharge(oxidized) != 0 or any(
        a.GetNumRadicalElectrons() for a in oxidized.GetAtoms()
    ):
        raise ValueError("INVALID_MECHANISM_GRAPH: ortho-quinone state failed validation")
    if (
        chem.GetFormalCharge(semiquinone) != -1
        or sum(a.GetNumRadicalElectrons() for a in semiquinone.GetAtoms()) != 1
    ):
        raise ValueError("INVALID_MECHANISM_GRAPH: one-electron radical anion failed validation")
    return parent, oxidized, semiquinone, match


def _species(
    identifier: str, role: str, mol: Any, sites: int = 0, special: str | None = None
) -> dict[str, Any]:
    chem = importlib.import_module("rdkit.Chem")
    descriptors = importlib.import_module("rdkit.Chem.rdMolDescriptors")
    species: dict[str, Any]
    if special:
        species = {
            "id": identifier,
            "role": role,
            "canonical_smiles": None,
            "formula": "e-" if special == "electron" else "site",
            "element_counts": {},
            "formal_charge": -1 if special == "electron" else 0,
            "radical_electrons": 0,
            "site_count": sites,
            "special_species": special,
            "atom_count": 0,
            "graph": {"atoms": [], "bonds": []},
        }
    else:
        canonical = chem.MolToSmiles(mol, canonical=True, isomericSmiles=True)
        parser = chem.SmilesParserParams()
        parser.removeHs = False
        normalized = chem.MolFromSmiles(canonical, parser)
        if normalized is None:
            raise ValueError("INVALID_MECHANISM_GRAPH: molecular graph cannot round-trip")
        chem.SanitizeMol(normalized)
        expanded = chem.AddHs(normalized)
        atoms = [
            {
                "index": atom.GetIdx(),
                "element": atom.GetSymbol(),
                "formal_charge": atom.GetFormalCharge(),
                "radical_electrons": atom.GetNumRadicalElectrons(),
            }
            for atom in expanded.GetAtoms()
        ]
        species = {
            "id": identifier,
            "role": role,
            "canonical_smiles": canonical,
            "formula": descriptors.CalcMolFormula(normalized),
            "element_counts": dict(
                sorted(Counter(a.GetSymbol() for a in expanded.GetAtoms()).items())
            ),
            "formal_charge": chem.GetFormalCharge(normalized),
            "radical_electrons": sum(a.GetNumRadicalElectrons() for a in normalized.GetAtoms()),
            "site_count": sites,
            "atom_count": expanded.GetNumAtoms(),
            "graph": {
                "atoms": atoms,
                "bonds": [
                    {
                        "a": b.GetBeginAtomIdx(),
                        "b": b.GetEndAtomIdx(),
                        "order": float(b.GetBondTypeAsDouble()),
                    }
                    for b in expanded.GetBonds()
                ],
            },
        }
    species["species_hash"] = content_hash(species)
    return species


def _step(
    identifier: str, reactants: dict[str, int], products: dict[str, int], assumption: str
) -> dict[str, Any]:
    return {
        "id": identifier,
        "reactants": reactants,
        "products": products,
        "reversible": True,
        "rate_assumption": assumption,
    }


def _protonated_site(parent: Any, catechol_match: tuple[int, ...]) -> tuple[Any, dict[str, Any]]:
    chem = importlib.import_module("rdkit.Chem")
    # An N-substituted pyrrole is also [nH0;+0], but its degree-three N is
    # pyrrolic. This recipe selects only degree-two, pyridine-type aromatic N.
    pyridyl = parent.GetSubstructMatches(chem.MolFromSmarts("[nH0;+0;D2]"))
    if len(pyridyl) == 1:
        index = pyridyl[0][0]
        kind = "pyridyl_nitrogen"
    elif len(pyridyl) > 1:
        raise ValueError(
            "MECHANISM_REQUIRED: multiple basic aromatic nitrogens require site selection"
        )
    else:
        ring = {catechol_match[1], catechol_match[2], *catechol_match[4:]}
        amides = parent.GetSubstructMatches(chem.MolFromSmarts("[OX1]=[CX3]-[NX3]"))
        sites = {
            match[0]
            for match in amides
            if any(atom.GetIdx() in ring for atom in parent.GetAtomWithIdx(match[1]).GetNeighbors())
        }
        if len(sites) != 1:
            raise ValueError(
                "MECHANISM_REQUIRED: one ring-linked amide carbonyl protonation site required"
            )
        index = next(iter(sites))
        kind = "scaffold_amide_carbonyl_oxygen"
    protonated = chem.Mol(parent)
    atom = protonated.GetAtomWithIdx(index)
    atom.SetFormalCharge(1)
    atom.SetNumExplicitHs(1)
    atom.SetNoImplicit(True)
    chem.SanitizeMol(protonated)
    if chem.GetFormalCharge(protonated) != 1 or any(
        a.GetNumRadicalElectrons() for a in protonated.GetAtoms()
    ):
        raise ValueError("INVALID_MECHANISM_GRAPH: protonated molecular site failed validation")
    return protonated, {
        "source_atom_index": index,
        "element": atom.GetSymbol(),
        "site_type": kind,
        "index_space": "RDKit parsed source_canonical_smiles",
        "selection_rule": "Unique degree-two pyridine-type aromatic N; "
        "otherwise unique ring-linked amide carbonyl O",
    }


def mechanism_eligibility(profile: str, smiles: str) -> dict[str, Any]:
    """Cheap graph-only admission; a methyl-capped catalog probe is explicitly conditional."""
    result: dict[str, Any] = {
        "profile": profile,
        "eligible": False,
        "recipe_id": None,
        "reason": "No registered mechanism",
        "probe": "complete_candidate",
        "checked_smiles_hash": content_hash(smiles),
    }
    try:
        if not isinstance(profile, str) or profile not in PROFILES:
            raise ValueError("MECHANISM_REQUIRED: unregistered profile")
        if not isinstance(smiles, str) or not 1 <= len(smiles) <= 2048:
            raise ValueError("MECHANISM_REQUIRED: bounded molecular SMILES required")
        chem = importlib.import_module("rdkit.Chem")
        molecule = chem.MolFromSmiles(smiles)
        if molecule is None:
            raise ValueError("MECHANISM_REQUIRED: invalid molecular SMILES")
        dummies = [a for a in molecule.GetAtoms() if a.GetAtomicNum() == 0]
        if dummies:
            if len(dummies) != 1 or dummies[0].GetAtomMapNum() != 1 or dummies[0].GetDegree() != 1:
                raise ValueError("MECHANISM_REQUIRED: one mapped scaffold attachment required")
            molecule = chem.molzip(chem.CombineMols(molecule, chem.MolFromSmiles("[*:1]C")))
            if molecule is None:
                raise ValueError("MECHANISM_REQUIRED: scaffold probe construction failed")
            smiles = chem.MolToSmiles(molecule, canonical=True, isomericSmiles=True)
            result["probe"] = "methyl_capped_scaffold"
        parent, _, _, match = _catechol_states(smiles)
        if profile == "solid_liquid":
            _protonated_site(parent, match)
        result.update(
            eligible=True,
            recipe_id="catechol." + profile + ".v1",
            reason="Registered molecular graph recipe is applicable; "
            "complete generated candidates require the same check.",
        )
    except (ValueError, RuntimeError) as error:
        result["reason"] = str(error)
    return result


def _proofs(species: list[dict[str, Any]], steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    chem = importlib.import_module("rdkit.Chem")
    periodic = chem.GetPeriodicTable()
    records = {s["id"]: s for s in species}
    proofs = []
    for step in steps:
        elements: Counter[str] = Counter()
        charge = sites = electrons = 0
        for sign, side in ((-1, "reactants"), (1, "products")):
            for identifier, coefficient in step[side].items():
                if type(coefficient) is not int or coefficient <= 0 or identifier not in records:
                    raise ValueError("INVALID_MECHANISM_STOICHIOMETRY")
                item = records[identifier]
                for element, count in item["element_counts"].items():
                    elements[element] += sign * coefficient * count
                charge += sign * coefficient * item["formal_charge"]
                sites += sign * coefficient * item["site_count"]
                electrons += (
                    sign
                    * coefficient
                    * (
                        sum(
                            periodic.GetAtomicNumber(e) * n
                            for e, n in item["element_counts"].items()
                        )
                        - item["formal_charge"]
                    )
                )
        passed = not any(elements.values()) and charge == sites == electrons == 0
        if not passed:
            raise ValueError("INVALID_MECHANISM_BALANCE: " + step["id"])
        proofs.append(
            {
                "reaction_id": step["id"],
                "element_balance": dict(sorted(elements.items())),
                "charge_balance": charge,
                "site_balance": sites,
                "electron_balance": electrons,
                "passed": True,
            }
        )
    return proofs


def mechanism_for_candidate(
    profile: str, candidate: dict[str, Any], inorganic_candidate: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Return a declared recipe for the exact candidate; unsupported structures fail closed."""
    if profile not in PROFILES:
        raise ValueError("MECHANISM_REQUIRED: unregistered interface profile")
    candidate = _candidate(candidate, "organic")
    if inorganic_candidate is not None:
        inorganic_candidate = _candidate(inorganic_candidate, "inorganic")
    smiles = candidate.get("canonical_smiles")
    if not isinstance(smiles, str) or not 1 <= len(smiles) <= 2048:
        raise ValueError("MECHANISM_REQUIRED: bounded molecular identity required")
    chem = importlib.import_module("rdkit.Chem")
    parent, quinone, semiquinone, match = _catechol_states(smiles)
    source_hash = content_hash(candidate)
    species: list[dict[str, Any]]
    steps: list[dict[str, Any]]
    chemostats: list[dict[str, Any]] = []
    site_recipe: dict[str, Any] | None = None
    if profile == "catalyst_reactant":
        species = [
            _species("vacant_site", "unoccupied support site", None, 1, "site"),
            _species("reactant", "selected catechol molecule in solution", parent),
            _species("reactant_adsorbed", "adsorbed catechol molecule", parent, 1),
            _species("product_adsorbed", "adsorbed derived ortho-quinone", quinone, 1),
            _species("product", "derived ortho-quinone in solution", quinone),
            _species("hydrogen", "molecular hydrogen reservoir", chem.MolFromSmiles("[H][H]")),
        ]
        steps = [
            _step(
                "catechol_adsorption",
                {"reactant": 1, "vacant_site": 1},
                {"reactant_adsorbed": 1},
                "Declared reversible adsorption constants.",
            ),
            _step(
                "catechol_dehydrogenation",
                {"reactant_adsorbed": 1},
                {"product_adsorbed": 1, "hydrogen": 1},
                "Formal net dehydrogenation, not an elementary pathway. Reverse rate equals "
                "k_reverse_s * hydrogen_activity * theta_product at fixed H2 activity.",
            ),
            _step(
                "quinone_desorption",
                {"product_adsorbed": 1},
                {"product": 1, "vacant_site": 1},
                "Declared reversible desorption constants.",
            ),
        ]
        state_species = {
            "theta_reactant": "reactant_adsorbed",
            "theta_product": "product_adsorbed",
            "concentration_reactant_mol_m3": "reactant",
            "concentration_product_pool_mol_m3": "product",
        }
        chemostats = [
            {
                "species_id": "hydrogen",
                "activity_binding": "parameters.hydrogen_activity",
                "activity_unit": "dimensionless",
                "exchange_tracking": "explicit mol/m^2",
                "scope": "H2 at fixed externally supplied activity; no gas evolution prediction",
            }
        ]
        description = (
            "Declared catechol / ortho-quinone net dehydrogenation with a hydrogen reservoir."
        )
    elif profile == "electrode_electrolyte":
        species = [
            _species("vacant_site", "unoccupied electrode site", None, 1, "site"),
            _species("oxidized", "derived ortho-quinone in solution", quinone),
            _species("reduced_adsorbed", "adsorbed semiquinone radical anion", semiquinone, 1),
            _species("electron", "external electrode electron", None, special="electron"),
        ]
        steps = [
            _step(
                "quinone_one_electron_reduction",
                {"oxidized": 1, "electron": 1, "vacant_site": 1},
                {"reduced_adsorbed": 1},
                "Conditional one-electron adsorption-coupled Butler-Volmer pair; "
                "formal reference potential and kinetic constant require supplied calibration.",
            )
        ]
        state_species = {
            "theta_reduced": "reduced_adsorbed",
            "concentration_oxidized_mol_m3": "oxidized",
        }
        description = (
            "One-electron reduction of the derived ortho-quinone to a semiquinone radical anion."
        )
    else:
        protonated, protonation_site = _protonated_site(parent, match)
        parser = chem.SmilesParserParams()
        parser.removeHs = False
        proton = chem.MolFromSmiles("[H+]", parser)
        association = chem.CombineMols(parent, parent)
        species = [
            _species("vacant_site", "declared immobilized selected-organic site L", parent, 1),
            _species("adsorbate", "selected organic adsorbate in solution", parent),
            _species(
                "adsorbed_complex", "noncovalent L.L association occupying one site", association, 1
            ),
            _species("protonated_site", "protonated immobilized molecular site LH+", protonated, 1),
            _species("proton", "solution proton", proton),
        ]
        steps = [
            _step(
                "noncovalent_association",
                {"vacant_site": 1, "adsorbate": 1},
                {"adsorbed_complex": 1},
                "Declared reversible association, with no new covalent bond.",
            ),
            _step(
                "molecular_site_protonation",
                {"vacant_site": 1, "proton": 1},
                {"protonated_site": 1},
                "Conditional protonation at the recorded basic atom; "
                "constants require explicit calibration for this site and environment.",
            ),
        ]
        state_species = {
            "theta_adsorbed": "adsorbed_complex",
            "theta_protonated": "protonated_site",
            "concentration_adsorbate_mol_m3": "adsorbate",
            "concentration_proton_mol_m3": "proton",
        }
        site_recipe = {
            "kind": "declared_immobilized_organic_site",
            "organic_units_per_vacant_site": 1,
            "organic_units_per_adsorbed_complex": 2,
            "protonation_site": protonation_site,
            "support_candidate_hash": content_hash(inorganic_candidate)
            if inorganic_candidate is not None
            else None,
            "immobilization": (
                "Selected organic molecule assumed immobilized on the selected support; "
                "no covalent support bond or atomic termination is constructed."
            ),
            "association": "Disconnected molecular graph encodes noncovalent association only.",
            "site_density": (
                "Explicit simulation quantity, independent of bulk unit-cell atom count."
            ),
        }
        description = (
            "Competitive noncovalent association and explicit protonation "
            "of a declared molecular surface site."
        )
    result = {
        "version": "interface-mechanism/v1",
        "profile": profile,
        "recipe_id": "catechol." + profile + ".v1",
        "description": description,
        "source_candidate_hash": source_hash,
        "candidate_hashes": {
            "organic": source_hash,
            "inorganic": content_hash(inorganic_candidate)
            if inorganic_candidate is not None
            else None,
        },
        "source_canonical_smiles": smiles,
        "selection": {
            "catechol_oxygen_indices": [match[0], match[3]],
            "index_space": "RDKit parsed source_canonical_smiles; not display atom indices",
        },
        "species": species,
        "steps": steps,
        "state_species": state_species,
        "vacant_site": "vacant_site",
        "chemostats": chemostats,
        "site_recipe": site_recipe,
        "conservation_proofs": _proofs(species, steps),
        "graph_engine": "RDKit " + version("rdkit"),
        "mechanism_status": "declared_recipe_not_predicted_or_experimentally_validated",
        "limitations": [
            "A balanced graph is not evidence of reaction feasibility or an elementary pathway.",
            "Rate constants and reference conditions are supplied; no barriers are inferred.",
            "Surface attachment is a site-occupancy assumption; "
            "no covalent support bond is inferred.",
            "The semiquinone graph is one resonance representation, "
            "not a spin-density calculation.",
            "No selectivity, side-reaction exclusion or synthesis-yield claim is established.",
        ],
    }
    result["mechanism_hash"] = content_hash(result)
    return result
