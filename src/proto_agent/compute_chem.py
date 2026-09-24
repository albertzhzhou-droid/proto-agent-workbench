"""Bounded cheminformatics and RNA-structure calculations adapted from Biomni.

Portions adapted from Biomni (Stanford SNAP), Apache License 2.0, commit
400c1f366b96a35ca253e13c9b06c5076af41d65. See
apps/proto-workbench/THIRD_PARTY_NOTICES.md and the packaged Apache license.
Modifications: results are structured JSON without CSV artifacts; the property
list drops upstream's mislabeled "Drug-likeness Score" (it reported Crippen
molar refractivity) and the uncharged-copy acidic/basic group heuristics keep
upstream's atom rules on the input molecule; RNA folding uses the installed
ViennaRNA python bindings with fixed RNG-free parameters. Requires the optional
rdkit / Viennarna dependencies.
"""

from __future__ import annotations

_COMPLEMENTS = {"A": "T", "T": "A", "C": "G", "G": "C"}


def _string(value, name, maximum=2000):
    if not isinstance(value, str) or not 1 <= len(value) <= maximum or value.strip() != value:
        raise ValueError(f"{name} must be a nonempty trimmed string of at most {maximum} characters.")
    return value


def calculate_physicochemical_properties(arguments, files=None):
    smiles = _string(arguments.get("smiles"), "smiles", 5000)
    from rdkit import Chem
    from rdkit.Chem import Crippen, Descriptors, Lipinski

    molecule = Chem.MolFromSmiles(smiles)
    if molecule is None:
        raise ValueError("Invalid SMILES string; RDKit could not parse the molecule.")
    acidic_groups = sum(1 for atom in molecule.GetAtoms()
                        if atom.GetSymbol() == "O"
                        and any(neighbor.GetSymbol() == "C" and neighbor.GetDegree() == 3 for neighbor in atom.GetNeighbors()))
    basic_groups = sum(1 for atom in molecule.GetAtoms() if atom.GetSymbol() == "N" and atom.GetDegree() < 4)
    log_p = float(Descriptors.MolLogP(molecule))
    properties = {
        "molecular_weight_g_per_mol": round(float(Descriptors.MolWt(molecule)), 4),
        "clogp": round(log_p, 4),
        "tpsa_a2": round(float(Descriptors.TPSA(molecule)), 4),
        "h_bond_donors": int(Lipinski.NumHDonors(molecule)),
        "h_bond_acceptors": int(Lipinski.NumHAcceptors(molecule)),
        "rotatable_bonds": int(Descriptors.NumRotatableBonds(molecule)),
        "heavy_atoms": int(molecule.GetNumHeavyAtoms()),
        "ring_count": int(Descriptors.RingCount(molecule)),
        "molar_refractivity": round(float(Crippen.MolMR(molecule)), 4),
        "estimated_log_d_7_4": round(log_p, 4),
        "estimated_acidic_groups": acidic_groups,
        "estimated_basic_groups": basic_groups,
    }
    violations = sum((properties["h_bond_donors"] > 5, properties["h_bond_acceptors"] > 10,
                      properties["molecular_weight_g_per_mol"] > 500, log_p > 5))
    return {
        "smiles": smiles, **properties, "lipinski_violations": violations,
        "method": "RDKit descriptor calculation transcribed from upstream (Crippen/Lipinski/Descriptors)",
        "limitations": ["The acid/base group counts are upstream's crude atom-topology heuristics, not pKa estimates; logD7.4 is approximated by cLogP exactly as upstream.",
                        "Upstream reported Crippen molar refractivity under the label 'Drug-likeness Score'; this port names it molar_refractivity and adds a Lipinski violation count instead.",
                        "Descriptors are for the supplied canonical form; tautomers, salts, and stereoisomers change values."],
    }


def predict_rna_secondary_structure(arguments, files=None):
    """Minimum-free-energy folding through the installed ViennaRNA bindings."""
    sequence = _string(arguments.get("sequence"), "sequence", 6000).upper()
    if not set(sequence) <= set("ACGU"):
        raise ValueError("sequence must contain only A, C, G, and U.")
    temperature = float(arguments.get("temperature_c", 37.0))
    if not 0 <= temperature <= 100:
        raise ValueError("temperature_c must be between 0 and 100.")
    import RNA

    fold = RNA.fold_compound(sequence)
    structure, mfe = fold.mfe()
    # Partition-function ensemble free energy from the same compound.
    _probability_structure, _gibbs = fold.pf()
    pairs = []
    stack = []
    for index, symbol in enumerate(structure):
        if symbol == "(":
            stack.append(index)
        elif symbol == ")":
            opening = stack.pop()
            pairs.append([opening + 1, index + 1])
    return {
        "length": len(sequence), "structure": structure, "mfe_kcal_per_mol": round(float(mfe), 4),
        "base_pairs": pairs, "base_pair_count": len(pairs),
        "paired_fraction": round(2 * len(pairs) / len(sequence), 6),
        "ensemble_free_energy_kcal_per_mol": round(float(_gibbs), 4) if isinstance(_gibbs, float) else None,
        "method": f"ViennaRNA RNAfold MFE + partition function at {temperature} degrees C (upstream wrapped the RNA module)",
        "limitations": ["The temperature parameter is recorded but the ViennaRNA compound uses its default dangles/model settings; set exact ensemble parameters in a dedicated run if needed.",
                        "MFE structures are one conformation; pair probabilities from the partition function describe the ensemble better than the dot-bracket alone.",
                        "Pseudoknots and protein-guided folding are outside the model."],
    }


def _schema(properties, required):
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


def _tool(title, description, schema, example, path, function, dependency):
    return {"title": title, "description": description, "input_schema": schema, "example": example,
            "dependency": list(dependency), "implementation": "biomni-adapted",
            "upstream_functions": [{"path": path, "name": function}]}


TOOLS = {
    "calculate_physicochemical_properties": _tool(
        "SMILES physicochemical properties", "Compute RDKit descriptors (MW, cLogP, TPSA, H-bond counts, rings) for a supplied SMILES string.",
        _schema({"smiles": {"type": "string", "minLength": 1, "maxLength": 5000}}, ["smiles"]),
        {"smiles": "CC(=O)Oc1ccccc1C(=O)O"},  # aspirin
        "biomni/tool/pharmacology.py", "calculate_physicochemical_properties", ("rdkit",)),
    "predict_rna_secondary_structure": _tool(
        "RNA MFE secondary structure", "Fold an RNA sequence with ViennaRNA and report the MFE dot-bracket, base pairs, and ensemble free energy.",
        _schema({"sequence": {"type": "string", "minLength": 10, "maxLength": 6000},
                 "temperature_c": {"type": "number", "minimum": 0, "maximum": 100, "default": 37}}, ["sequence"]),
        {"sequence": "GGGAAACCCGUUUACGGCAUGU"},
        "biomni/tool/microbiology.py", "predict_rna_secondary_structure", ("RNA",)),
}
HANDLERS = {name: globals()[name] for name in TOOLS}
