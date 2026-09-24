"""Deterministic candidate construction and structural screening, without rate claims.

These pure functions produce DesignStudy records, not execution approvals. Organic
substitution preserves every non-dummy scaffold atom. Oxide cells use explicit
ordered sites and Shannon ionic radii; their score is not a formation energy.
"""

from __future__ import annotations

import copy
import importlib
import itertools
import json
import math
from importlib.metadata import version
from typing import Any

from chem_workbench.visualization import content_hash

SCAFFOLDS = {
    "catechol_amide": {
        "name": "Catechol amide",
        "purpose": "Retain a catechol group while varying the amide side chain.",
        "smiles": "O=C(NCC[*:1])c1cc(O)c(O)cc1",
    },
    "carboxylate_amide": {
        "name": "Carboxylic acid amide",
        "purpose": "Retain a neutral carboxylic acid; protonation must be modeled separately.",
        "smiles": "O=C(O)c1ccc(C(=O)NCC[*:1])cc1",
    },
    "pyridyl_amide": {
        "name": "Pyridyl amide",
        "purpose": "Retain an aromatic nitrogen and an amide for interface geometry studies.",
        "smiles": "O=C(NCC[*:1])c1ccncc1",
    },
}
FRAGMENTS = {
    "methyl": "[*:1]C",
    "ethyl": "[*:1]CC",
    "hydroxyethyl": "[*:1]CCO",
    "methoxyethyl": "[*:1]CCOC",
    "fluoroethyl": "[*:1]CCF",
    "aminocarbonyl": "[*:1]C(=O)N",
    "phenyl": "[*:1]c1ccccc1",
    "pyridyl": "[*:1]c1ccncc1",
}
A_ELEMENTS = ("Ca", "Sr", "Ba")
B_PAIRS = (("Mg", "W"), ("Mg", "Mo"), ("Zn", "W"), ("Sc", "Nb"), ("Y", "Ta"), ("Ti", "Zr"))
OXIDATION = {
    "Ca": 2,
    "Sr": 2,
    "Ba": 2,
    "Mg": 2,
    "Zn": 2,
    "W": 6,
    "Mo": 6,
    "Sc": 3,
    "Y": 3,
    "Nb": 5,
    "Ta": 5,
    "Ti": 4,
    "Zr": 4,
    "O": -2,
}
FEATURES = {
    "amide": "[CX3](=[OX1])[NX3]",
    "carboxylic_acid": "[CX3](=O)[OX2H1]",
    "hydroxyl": "[OX2H1;!$(O-C=O)]",
    "ether": "[#6][OX2H0][#6]",
    "amine": "[NX3;!$(N-C=O)]",
    "ketone_or_aldehyde": "[CX3;!$(C(=O)N);!$(C(=O)O)]=[OX1]",
    "ester": "[CX3](=O)[OX2H0][#6]",
    "nitrile": "[CX2]#[NX1]",
    "sulfone": "[SX4](=O)(=O)",
}


def candidate_catalog() -> dict[str, Any]:
    """Return fresh JSON data; catalog selection does not authorize any job."""
    return {
        "version": "design-candidate-catalog/v1",
        "scaffolds": [{"id": key, **value} for key, value in SCAFFOLDS.items()],
        "fragment_ids": list(FRAGMENTS),
        "fragments": [{"id": key, "smiles": value} for key, value in FRAGMENTS.items()],
        "a_elements": list(A_ELEMENTS),
        "b_pairs": [list(pair) for pair in B_PAIRS],
        "max_candidates": 24,
        "custom_scaffold": "One connected SMILES with exactly one terminal [*:1] dummy atom",
        "rankings": ["balanced_polarity", "low_logp", "high_tpsa"],
    }


def _request(spec: object, allowed: set[str]) -> dict[str, Any]:
    if not isinstance(spec, dict) or any(not isinstance(k, str) for k in spec):
        raise ValueError("INVALID_DESIGN_SPEC: expected an object")
    if set(spec) - allowed:
        raise ValueError(
            "INVALID_DESIGN_SPEC: unknown fields: " + ", ".join(sorted(set(spec) - allowed))
        )
    result = copy.deepcopy(spec)
    source = result.get("source", "")
    if not isinstance(source, str) or len(source.encode()) > 200_000:
        raise ValueError("INVALID_DESIGN_SPEC: source must be text of at most 200 KB")
    limit = result.setdefault("max_candidates", 8)
    if type(limit) is not int or not 1 <= limit <= 24:
        raise ValueError("INVALID_DESIGN_SPEC: max_candidates must be an integer from 1 to 24")
    return result


def _number(value: object, name: str, low: float, high: float) -> float:
    if (
        not isinstance(value, (float, int))
        or isinstance(value, bool)
        or not math.isfinite(float(value))
    ):
        raise ValueError(f"INVALID_DESIGN_SPEC: {name} must be finite")
    number = float(value)
    if not low <= number <= high:
        raise ValueError(f"INVALID_DESIGN_SPEC: {name} must be in [{low}, {high}]")
    return number


def _finish(
    profile: str,
    request: dict[str, Any],
    candidates: list[dict[str, Any]],
    rejected: list[dict[str, Any]],
    ranking: dict[str, Any],
    limitations: list[str],
    attempted: int,
) -> dict[str, Any]:
    result = {
        "version": "design-candidates/v1",
        "profile": profile,
        "request": request,
        "request_hash": content_hash(request),
        "candidates": candidates,
        "rejected": rejected,
        "attempted_count": attempted,
        "candidate_count": len(candidates),
        "ranking": ranking,
        "limitations": limitations,
        "execution_authorized": False,
    }
    result["result_hash"] = content_hash(result)
    return result


def _dummy_molecule(smiles: object, label: str) -> tuple[Any, int, int]:
    chem = importlib.import_module("rdkit.Chem")
    if not isinstance(smiles, str) or not 1 <= len(smiles) <= 2048:
        raise ValueError(f"INVALID_DESIGN_SPEC: bounded {label} SMILES required")
    mol = chem.MolFromSmiles(smiles)
    if mol is None or len(chem.GetMolFrags(mol)) != 1 or mol.GetNumAtoms() > 48:
        raise ValueError(f"INVALID_DESIGN_SPEC: {label} must be one valid bounded molecule")
    dummy = [a for a in mol.GetAtoms() if a.GetAtomicNum() == 0]
    if len(dummy) != 1 or dummy[0].GetAtomMapNum() != 1 or dummy[0].GetDegree() != 1:
        raise ValueError(f"INVALID_DESIGN_SPEC: {label} requires one terminal [*:1]")
    if any(a.GetAtomMapNum() for a in mol.GetAtoms() if a.GetAtomicNum()):
        raise ValueError(f"INVALID_DESIGN_SPEC: {label} non-dummy atoms must have no map labels")
    if dummy[0].GetBonds()[0].GetBondType() != chem.BondType.SINGLE:
        raise ValueError(f"INVALID_DESIGN_SPEC: {label} attachment bond must be single")
    if any(
        a.GetSymbol() not in {"*", "H", "C", "N", "O", "F", "S", "Cl"}
        or a.GetIsotope()
        or a.GetNumRadicalElectrons()
        for a in mol.GetAtoms()
    ):
        raise ValueError(f"INVALID_DESIGN_SPEC: {label} has unsupported elements or atom state")
    if chem.GetFormalCharge(mol) != 0:
        raise ValueError(f"INVALID_DESIGN_SPEC: {label} must be neutral")
    return mol, dummy[0].GetIdx(), dummy[0].GetNeighbors()[0].GetIdx()


def _organic_settings(spec: object) -> tuple[dict[str, Any], Any, list[tuple[str, str]]]:
    request = _request(
        spec,
        {
            "scaffold_id",
            "scaffold_smiles",
            "fragment_ids",
            "fragments",
            "max_candidates",
            "filters",
            "ranking",
            "source",
        },
    )
    scaffold_id = request.setdefault(
        "scaffold_id", "custom" if "scaffold_smiles" in request else "catechol_amide"
    )
    if scaffold_id == "custom":
        smiles = request.get("scaffold_smiles")
    elif isinstance(scaffold_id, str) and scaffold_id in SCAFFOLDS:
        smiles = SCAFFOLDS[scaffold_id]["smiles"]
        if "scaffold_smiles" in request and request["scaffold_smiles"] != smiles:
            raise ValueError("INVALID_DESIGN_SPEC: catalog and custom scaffold conflict")
    else:
        raise ValueError("INVALID_DESIGN_SPEC: unknown scaffold_id")
    scaffold, _, _ = _dummy_molecule(smiles, "scaffold")
    request["scaffold_smiles"] = smiles
    ids = request.get("fragment_ids", [] if "fragments" in request else list(FRAGMENTS))
    if (
        not isinstance(ids, list)
        or len(ids) > 24
        or any(not isinstance(x, str) or x not in FRAGMENTS for x in ids)
    ):
        raise ValueError("INVALID_DESIGN_SPEC: fragment_ids must select the bounded catalog")
    custom = request.get("fragments", [])
    if not isinstance(custom, list) or len(ids) + len(custom) > 24:
        raise ValueError("INVALID_DESIGN_SPEC: at most 24 total fragments")
    fragments = [(key, FRAGMENTS[key]) for key in ids]
    for i, fragment in enumerate(custom):
        _dummy_molecule(fragment, "fragment")
        fragments.append((f"custom-{i + 1}", fragment))
    if not fragments:
        raise ValueError("INVALID_DESIGN_SPEC: at least one fragment is required")
    request["fragment_ids"] = ids
    request["fragments"] = custom
    filters = request.setdefault("filters", {})
    bounds = {
        "mw_max": (100, 1000),
        "logp_min": (-10, 15),
        "logp_max": (-10, 15),
        "tpsa_min": (0, 500),
        "tpsa_max": (0, 500),
    }
    if not isinstance(filters, dict) or set(filters) - set(bounds):
        raise ValueError("INVALID_DESIGN_SPEC: unsupported descriptor filter")
    for key, value in filters.items():
        filters[key] = _number(value, key, *bounds[key])
    for field in ("logp", "tpsa"):
        if filters.get(field + "_min", -math.inf) > filters.get(field + "_max", math.inf):
            raise ValueError("INVALID_DESIGN_SPEC: filter minimum exceeds maximum")
    ranking = request.setdefault("ranking", "balanced_polarity")
    if not isinstance(ranking, str) or ranking not in {
        "balanced_polarity",
        "low_logp",
        "high_tpsa",
    }:
        raise ValueError("INVALID_DESIGN_SPEC: unknown organic ranking")
    return request, scaffold, fragments


def _join(scaffold: Any, fragment_smiles: str) -> tuple[Any, list[dict[str, int]], int]:
    chem = importlib.import_module("rdkit.Chem")
    parent = chem.Mol(scaffold)
    fragment, _, _ = _dummy_molecule(fragment_smiles, "fragment")
    dummy_parent = next(a.GetIdx() for a in parent.GetAtoms() if a.GetAtomicNum() == 0)
    neighbor_parent = parent.GetAtomWithIdx(dummy_parent).GetNeighbors()[0].GetIdx()
    for atom in parent.GetAtoms():
        if atom.GetAtomicNum():
            atom.SetAtomMapNum(1001 + atom.GetIdx())
    # molzip tracks stereo through the disappearing dummy atoms, including an
    # attachment adjacent to a stereocenter or a stereogenic double bond.
    molecule = chem.molzip(chem.CombineMols(parent, fragment))
    if molecule is None:
        raise ValueError("CANDIDATE_REJECTED: atom-mapped substitution failed")
    chem.SanitizeMol(molecule)
    chem.AssignStereochemistry(molecule, cleanIt=True, force=True)
    mappings = [
        {"source_atom_index": atom.GetAtomMapNum() - 1001, "candidate_atom_index": atom.GetIdx()}
        for atom in molecule.GetAtoms()
        if atom.GetAtomMapNum() >= 1001
    ]
    attachment = next(
        m["candidate_atom_index"] for m in mappings if m["source_atom_index"] == neighbor_parent
    )
    for atom in molecule.GetAtoms():
        atom.SetAtomMapNum(0)
    return molecule, mappings, attachment


def _organic_candidate(
    mol: Any,
    mapping: list[dict[str, int]],
    attachment: int,
    request: dict[str, Any],
    fragment_id: str,
    fragment_smiles: str,
) -> dict[str, Any]:
    chem = importlib.import_module("rdkit.Chem")
    allchem = importlib.import_module("rdkit.Chem.AllChem")
    descriptors = importlib.import_module("rdkit.Chem.Descriptors")
    rdmd = importlib.import_module("rdkit.Chem.rdMolDescriptors")
    if not 8 <= mol.GetNumHeavyAtoms() <= 48 or chem.GetFormalCharge(mol) != 0:
        raise ValueError("CANDIDATE_REJECTED: expected 8-48 heavy atoms and neutral charge")
    if any(s.specified == chem.StereoSpecified.Unspecified for s in chem.FindPotentialStereo(mol)):
        raise ValueError("NEEDS_INPUT: candidate has unspecified stereochemistry")
    groups = sorted(
        name
        for name, pattern in FEATURES.items()
        if mol.HasSubstructMatch(chem.MolFromSmarts(pattern))
    )
    classes = groups + (["aromatic_ring"] if any(a.GetIsAromatic() for a in mol.GetAtoms()) else [])
    if any(a.IsInRing() and not a.GetIsAromatic() for a in mol.GetAtoms()):
        classes.append("aliphatic_ring")
    if any(a.GetIsAromatic() and a.GetSymbol() != "C" for a in mol.GetAtoms()):
        classes.append("heteroaromatic_ring")
    if len(classes) < 2 or not groups:
        raise ValueError("CANDIDATE_REJECTED: at least two feature classes and a functional group")
    metrics = {
        "molecular_weight": float(descriptors.MolWt(mol)),
        "logp": float(descriptors.MolLogP(mol)),
        "tpsa": float(rdmd.CalcTPSA(mol)),
        "h_bond_donors": int(rdmd.CalcNumHBD(mol)),
        "h_bond_acceptors": int(rdmd.CalcNumHBA(mol)),
        "rotatable_bonds": int(rdmd.CalcNumRotatableBonds(mol)),
        "formal_charge": int(chem.GetFormalCharge(mol)),
    }
    for key, bound in request["filters"].items():
        field, direction = key.rsplit("_", 1)
        actual = metrics["molecular_weight" if field == "mw" else field]
        if (direction == "min" and actual < bound) or (direction == "max" and actual > bound):
            raise ValueError(f"FILTER_REJECTED: {key}")
    smiles = chem.MolToSmiles(mol, canonical=True, isomericSmiles=True)
    identity = content_hash({"canonical_smiles": smiles})
    object_id = "organic_" + identity.split(":")[1][:16]
    hydrogenated = chem.AddHs(mol)
    if hydrogenated.GetNumAtoms() > 120:
        raise ValueError("CANDIDATE_REJECTED: at most 120 atoms including hydrogens")
    settings = allchem.ETKDGv3()
    settings.randomSeed, settings.numThreads, settings.maxIterations = 42, 1, 200
    if allchem.EmbedMolecule(hydrogenated, settings) != 0:
        raise ValueError("GEOMETRY_FAILED: deterministic conformer generation failed")
    conformer = hydrogenated.GetConformer()
    geometry = {
        "version": "display-geometry/v1",
        "object_id": object_id,
        "kind": "Molecule",
        "units": "angstrom",
        "atoms": [
            {
                "id": f"atom-{i + 1}",
                "element": atom.GetSymbol(),
                "position": [float(v) for v in conformer.GetAtomPosition(i)],
            }
            for i, atom in enumerate(hydrogenated.GetAtoms())
        ],
        "bonds": [
            {
                "a": b.GetBeginAtomIdx(),
                "b": b.GetEndAtomIdx(),
                "order": float(b.GetBondTypeAsDouble()),
            }
            for b in hydrogenated.GetBonds()
        ],
        "cell": None,
        "display_repeats": 1,
        "unit_cell_atoms": hydrogenated.GetNumAtoms(),
        "source_hash": content_hash(request),
        "subject_hash": identity,
        "provenance": "tool_generated",
        "method": f"RDKit {version('rdkit')} ETKDGv3 seed 42",
        "description": "Generated conformer with explicit hydrogens; no measured coordinates, "
        "energy optimization, interface binding or kinetics are inferred.",
    }
    geometry["geometry_hash"] = content_hash(geometry)
    score = {
        "low_logp": metrics["logp"],
        "high_tpsa": -metrics["tpsa"],
        "balanced_polarity": abs(metrics["logp"] - 1.5) + abs(metrics["tpsa"] - 75) / 50,
    }[request["ranking"]]
    retained = {m["candidate_atom_index"] for m in mapping}
    anchors = sorted(
        {
            i
            for pattern in ("[OX2H1]", "[nX2]", "[OX1]=[CX3]")
            for match in mol.GetSubstructMatches(chem.MolFromSmarts(pattern))
            for i in match[:1]
            if i in retained
        }
    )
    candidate = {
        "id": object_id,
        "family": "organic",
        "canonical_smiles": smiles,
        "identity_hash": identity,
        "request_hash": content_hash(request),
        "source": f"chem 0.1\nmolecule {object_id} {{ structure smiles {json.dumps(smiles)} }}\n",
        "generation": {
            "scaffold_smiles": request["scaffold_smiles"],
            "fragment_id": fragment_id,
            "fragment_smiles": fragment_smiles,
            "scaffold_atom_mapping": mapping,
            "attachment_atom_index": attachment,
            "anchor_atom_indices": anchors,
            "anchor_scope": "Retained potential donor atoms, not proven binding sites",
        },
        "descriptors": metrics,
        "complexity": {
            "heavy_atoms": mol.GetNumHeavyAtoms(),
            "structural_feature_classes": sorted(set(classes)),
            "substantive_functional_groups": groups,
        },
        "score": float(score),
        "score_scope": "Descriptor objective only; lower is preferred",
        "geometry": geometry,
    }
    candidate["candidate_hash"] = content_hash(candidate)
    return candidate


def organic_candidates(spec: object) -> dict[str, Any]:
    """Enumerate R-group substitutions, validate molecules and generate real 3D conformers."""
    request, scaffold, fragments = _organic_settings(spec)
    candidates, rejected, seen = [], [], set()
    for fragment_id, fragment_smiles in fragments:
        try:
            mol, mapping, attachment = _join(scaffold, fragment_smiles)
            candidate = _organic_candidate(
                mol, mapping, attachment, request, fragment_id, fragment_smiles
            )
            if candidate["identity_hash"] in seen:
                raise ValueError("DUPLICATE_CANDIDATE: canonical structure already generated")
            seen.add(candidate["identity_hash"])
            candidates.append(candidate)
        except (ValueError, RuntimeError) as error:
            rejected.append(
                {
                    "fragment_id": fragment_id,
                    "fragment_smiles": fragment_smiles,
                    "reason": str(error),
                }
            )
    candidates.sort(key=lambda c: (c["score"], c["canonical_smiles"]))
    selected = candidates[: request["max_candidates"]]
    rejected.extend(
        {"candidate_hash": c["candidate_hash"], "reason": "RANKING_LIMIT"}
        for c in candidates[request["max_candidates"] :]
    )
    return _finish(
        "rdkit.scaffold-rgroup.interface.v1",
        request,
        selected,
        rejected,
        {
            "objective": request["ranking"],
            "direction": "ascending",
            "descriptor_engine": f"RDKit {version('rdkit')}",
            "balanced_polarity_formula": "abs(logP - 1.5) + abs(TPSA - 75) / 50",
        },
        [
            "Generated structures are not demonstrated synthesis routes.",
            "Descriptor scores do not establish adsorption, catalysis or toxicity.",
            "Neutral state only; interface protonation requires an explicit model.",
            "No electronic energy calculation or experimental validation is performed.",
        ],
        len(fragments),
    )


def _oxide_candidate(a: str, b: str, bp: str, request: dict[str, Any]) -> dict[str, Any]:
    core = importlib.import_module("pymatgen.core")
    radii = {
        element: float(
            core.Species(element, OXIDATION[element]).get_shannon_radius(
                "XII" if element == a else "VI"
            )
        )
        for element in (a, b, bp, "O")
    }
    average_b = (radii[b] + radii[bp]) / 2
    primitive_a = 2 * (average_b + radii["O"])
    symbols, positions, labels = [], [], []
    for i, j, k in itertools.product(range(2), repeat=3):
        for element, local, label in (
            (a, (0, 0, 0), "A"),
            (
                b if (i + j + k) % 2 == 0 else bp,
                (0.5, 0.5, 0.5),
                "B" if (i + j + k) % 2 == 0 else "B_prime",
            ),
            ("O", (0.5, 0.5, 0), "O"),
            ("O", (0.5, 0, 0.5), "O"),
            ("O", (0, 0.5, 0.5), "O"),
        ):
            symbols.append(core.Species(element, OXIDATION[element]))
            positions.append([(i + local[0]) / 2, (j + local[1]) / 2, (k + local[2]) / 2])
            labels.append(label)
    structure = core.Structure(
        core.Lattice.cubic(primitive_a * 2),
        symbols,
        positions,
        site_properties={"sublattice": labels},
    )
    charge = float(structure.charge)
    if abs(charge) > 1e-12 or not structure.is_ordered or len(structure) != 40:
        raise ValueError("INVALID_OXIDE: ordered 40-atom charge-neutral structure required")
    distances = structure.distance_matrix
    minimum = min(float(distances[i, j]) for i in range(40) for j in range(i))
    if minimum < 1.0:
        raise ValueError("INVALID_OXIDE: overlapping periodic sites")
    coordination = []
    for index, site in enumerate(structure):
        if labels[index] == "O":
            continue
        expected = 12 if labels[index] == "A" else 6
        radius = primitive_a / math.sqrt(2) if expected == 12 else primitive_a / 2
        oxygen_neighbors = sum(
            n.specie.symbol == "O" for n in structure.get_neighbors(site, radius + 1e-6)
        )
        if oxygen_neighbors != expected:
            raise ValueError("INVALID_OXIDE: prototype coordination check failed")
        coordination.append(
            {
                "site_index": index,
                "sublattice": labels[index],
                "oxygen_coordination": oxygen_neighbors,
            }
        )
    tolerance = (radii[a] + radii["O"]) / (math.sqrt(2) * (average_b + radii["O"]))
    formula = f"{a}2{b}{bp}O6"
    identity_data = {
        "formula": formula,
        "lattice": structure.lattice.matrix.tolist(),
        "sites": [
            {
                "element": s.specie.symbol,
                "oxidation_state": float(s.specie.oxi_state),
                "fractional_coordinates": [float(x) for x in s.frac_coords],
                "occupancy": 1,
                "sublattice": labels[i],
            }
            for i, s in enumerate(structure)
        ],
    }
    identity = content_hash(identity_data)
    object_id = "oxide_" + identity.split(":")[1][:16]
    geometry = {
        "version": "display-geometry/v1",
        "object_id": object_id,
        "kind": "PeriodicStructure",
        "units": "angstrom",
        "atoms": [
            {
                "id": f"site-{i + 1}",
                "element": s.specie.symbol,
                "position": [float(x) for x in s.coords],
                "oxidation_state": float(s.specie.oxi_state),
                "sublattice": labels[i],
            }
            for i, s in enumerate(structure)
        ],
        "bonds": [],
        "cell": structure.lattice.matrix.tolist(),
        "display_repeats": 1,
        "unit_cell_atoms": 40,
        "pbc": [True, True, True],
        "source_hash": content_hash(request),
        "subject_hash": identity,
        "provenance": "tool_constructed",
        "method": "pymatgen ordered double-perovskite / Shannon radii",
        "description": "Ideal rock-salt B-site ordered A2BB'O6 prototype; ionic-radius lattice. "
        "Not a relaxed, experimentally observed or stability-certified material.",
    }
    geometry["geometry_hash"] = content_hash(geometry)
    candidate = {
        "id": object_id,
        "family": "inorganic",
        "formula": formula,
        "identity_hash": identity,
        "request_hash": content_hash(request),
        "structure": identity_data,
        "geometry": geometry,
        "generation": {
            "prototype": "A2BBprimeO6.ordered-rocksalt.2x2x2/v1",
            "a_element": a,
            "b_pair": [b, bp],
            "pymatgen_version": version("pymatgen"),
            "pymatgen_core_version": version("pymatgen-core"),
            "radius_source": "pymatgen Species.get_shannon_radius / ionic radius",
            "radii_angstrom": radii,
            "a_coordination": "XII",
            "b_and_oxygen_coordination": "VI",
        },
        "validation": {
            "net_formal_charge": charge,
            "ordered": True,
            "atom_count": 40,
            "formula_units": 4,
            "minimum_periodic_distance_angstrom": minimum,
            "site_coordination": coordination,
        },
        "descriptors": {
            "tolerance_factor": tolerance,
            "octahedral_radius_ratio": average_b / radii["O"],
            "b_radius_mismatch_angstrom": abs(radii[b] - radii[bp]),
            "lattice_parameter_angstrom": primitive_a * 2,
        },
        "score": abs(tolerance - request["tolerance_target"]),
        "score_scope": "Distance to requested tolerance factor; structural screening only",
    }
    candidate["candidate_hash"] = content_hash(candidate)
    return candidate


def inorganic_candidates(spec: object) -> dict[str, Any]:
    """Construct charge-neutral, fully ordered multication oxide prototype candidates."""
    request = _request(
        spec, {"a_elements", "b_pairs", "max_candidates", "source", "tolerance_target"}
    )
    a_elements = request.setdefault("a_elements", list(A_ELEMENTS))
    pairs = request.setdefault("b_pairs", [list(pair) for pair in B_PAIRS])
    if (
        not isinstance(a_elements, list)
        or not 1 <= len(a_elements) <= 3
        or any(not isinstance(a, str) or a not in A_ELEMENTS for a in a_elements)
        or len(set(a_elements)) != len(a_elements)
    ):
        raise ValueError("INVALID_DESIGN_SPEC: unique Ca, Sr or Ba A-site elements required")
    if (
        not isinstance(pairs, list)
        or not 1 <= len(pairs) <= 8
        or any(
            not isinstance(pair, list) or len(pair) != 2 or tuple(pair) not in B_PAIRS
            for pair in pairs
        )
    ):
        raise ValueError("INVALID_DESIGN_SPEC: b_pairs must select catalog oxidation-state pairs")
    if len({tuple(pair) for pair in pairs}) != len(pairs) or len(pairs) * len(a_elements) > 24:
        raise ValueError("INVALID_DESIGN_SPEC: at most 24 unique oxide combinations")
    request["tolerance_target"] = _number(
        request.get("tolerance_target", 1.0), "tolerance_target", 0.8, 1.1
    )
    candidates = [_oxide_candidate(a, b, bp, request) for a in a_elements for b, bp in pairs]
    candidates.sort(key=lambda c: (c["score"], c["formula"]))
    selected = candidates[: request["max_candidates"]]
    rejected = [
        {"candidate_hash": c["candidate_hash"], "formula": c["formula"], "reason": "RANKING_LIMIT"}
        for c in candidates[request["max_candidates"] :]
    ]
    return _finish(
        "pymatgen.ordered-double-perovskite.v1",
        request,
        selected,
        rejected,
        {
            "objective": "tolerance_factor_distance",
            "target": request["tolerance_target"],
            "direction": "ascending",
            "formula": "abs(tolerance_factor - target)",
        },
        [
            "Ideal ordered prototype generation, not a prediction of phase stability.",
            "Shannon-radius tolerance factor is a geometric screen, not an energy or rate.",
            "No defect, magnetic, electronic, band-gap or catalytic-property calculation.",
            "Different compositions are not ranked by raw total energy.",
        ],
        len(candidates),
    )
