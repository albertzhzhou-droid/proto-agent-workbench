"""Bounded Chemical Data operators; optional scientific imports occur at execution.

The host persists inputs/results. This module has no filesystem, network or code
execution interface. See docs/chem-data-methods.md for definitions and provenance.
"""
from __future__ import annotations

from collections import Counter
import json
import math
import re
from typing import Any

VERSION = "chem-data/1.0.0"
ELECTRON_MASS_DA = 0.000548579909065


class DataError(ValueError):
    def __init__(self, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.code, self.details = code, details


def fail(code, message, details=None):
    raise DataError(code, message, details)


def obj(value, name, allowed=None):
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        fail("INVALID_INPUT", f"{name} must be an object")
    if allowed is not None and set(value) - allowed:
        fail("INVALID_INPUT", f"Unknown {name} fields: {', '.join(sorted(set(value) - allowed))}")
    return value


def text(value, name, limit=2048):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        fail("INVALID_INPUT", f"{name} must be nonempty text of at most {limit} characters")
    return value.strip()


def number(value, name, low=0, high=1e12, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        fail("INVALID_INPUT", f"{name} must be a finite number")
    if not low <= value <= high or (positive and value <= 0):
        fail("INVALID_INPUT", f"{name} is outside the supported range")
    return float(value)


def integer(value, name, low, high):
    if type(value) is not int or not low <= value <= high:
        fail("INVALID_INPUT", f"{name} must be an integer from {low} to {high}")
    return value


def boolean(value, name):
    if type(value) is not bool:
        fail("INVALID_INPUT", f"{name} must be a boolean")
    return value


def table(identifier, title, rows):
    return {"id": identifier, "title": title, "rows": rows}


def _records(data):
    records = data.get("records")
    if not isinstance(records, list) or not 1 <= len(records) <= 256:
        fail("INVALID_INPUT", "records must contain 1–256 records")
    result, identifiers = [], set()
    for index, raw in enumerate(records):
        row = obj(raw, f"records[{index}]", {"id", "smiles"})
        identifier = text(row.get("id"), f"records[{index}].id", 128)
        if identifier in identifiers:
            fail("DUPLICATE_ID", "Record identifiers must be unique", {"id": identifier})
        identifiers.add(identifier)
        # Empty SMILES is a retained invalid row, not a silently lost observation.
        smiles = row.get("smiles")
        if not isinstance(smiles, str) or len(smiles) > 2048:
            fail("INVALID_INPUT", f"records[{index}].smiles must be text of at most 2048 characters")
        result.append({"id": identifier, "smiles": smiles})
    return result


def _molecules(data):
    from rdkit import Chem, rdBase
    from rdkit.Chem import Descriptors
    policy = data.get("salt_policy", "preserve")
    if not isinstance(policy, str) or policy not in {"preserve", "largest_fragment", "reject_multicomponent"}:
        fail("INVALID_INPUT", "Unknown salt_policy")
    rows, molecules = [], []
    parameters = Chem.SmilesParserParams()
    parameters.parseName = False
    parameters.allowCXSMILES = False
    for record in _records(data):
        row = {"id": record["id"], "input_smiles": record["smiles"], "valid": False,
               "canonical_smiles": None, "fragment_count": None, "removed_fragments": "", "error": None}
        with rdBase.BlockLogs():
            mol = Chem.MolFromSmiles(record["smiles"], parameters)
        if mol is None or mol.GetNumAtoms() == 0:
            row["error"] = "INVALID_SMILES"
        elif mol.GetNumAtoms() > 256 or any(a.GetAtomicNum() == 0 for a in mol.GetAtoms()):
            row["error"] = "SMILES requires 1–256 specified atoms; wildcard atoms are unsupported"
        else:
            # Atom maps are labels, not a distinct chemical identity. The original
            # mapped SMILES is retained above; stereo/isotope/charge remain intact.
            for atom in mol.GetAtoms():
                atom.SetAtomMapNum(0)
            fragments = Chem.GetMolFrags(mol, asMols=True, sanitizeFrags=True)
            row["fragment_count"] = len(fragments)
            if len(fragments) > 1 and policy == "reject_multicomponent":
                row["error"] = "MULTICOMPONENT_REJECTED"
            else:
                if len(fragments) > 1 and policy == "largest_fragment":
                    ordered = sorted(fragments, key=lambda f: (-f.GetNumHeavyAtoms(), -Descriptors.MolWt(f), Chem.MolToSmiles(f)))
                    mol = ordered[0]
                    row["removed_fragments"] = "; ".join(Chem.MolToSmiles(f) for f in ordered[1:])
                canonical = Chem.MolToSmiles(mol, canonical=True, isomericSmiles=True)
                # Search atom indices are defined on this returned canonical graph.
                mol = Chem.MolFromSmiles(canonical, parameters)
                row.update(valid=True, canonical_smiles=canonical)
        rows.append(row)
        molecules.append(mol if row["valid"] else None)
    return rows, molecules, policy


def _dataset_method(policy):
    import rdkit
    return {"library": "RDKit", "version": rdkit.__version__, "salt_policy": policy,
            "canonicalization": "Canonical isomeric SMILES; atom-map labels removed for identity only",
            "stereo_isotopes_charge": "preserved", "tautomer_canonicalization": False, "neutralization": False,
            "largest_fragment_order": "heavy atom count, molecular weight, canonical SMILES"}


def prepare_molecular_dataset(data):
    from rdkit import Chem
    from rdkit.Chem import Descriptors, Lipinski, rdMolDescriptors
    obj(data, "input", {"records", "salt_policy"})
    rows, molecules, policy = _molecules(data)
    identities = {}
    for row, mol in zip(rows, molecules):
        if mol is None:
            continue
        row.update(formula=rdMolDescriptors.CalcMolFormula(mol), formal_charge=Chem.GetFormalCharge(mol),
                   molecular_weight_g_mol=Descriptors.MolWt(mol), exact_mass_da=Descriptors.ExactMolWt(mol),
                   logp=Descriptors.MolLogP(mol), tpsa_angstrom2=rdMolDescriptors.CalcTPSA(mol, includeSandP=False),
                   hydrogen_bond_donors=Lipinski.NumHDonors(mol), hydrogen_bond_acceptors=Lipinski.NumHAcceptors(mol),
                   rotatable_bonds=Lipinski.NumRotatableBonds(mol), heavy_atoms=mol.GetNumHeavyAtoms())
        identities.setdefault(row["canonical_smiles"], []).append(row["id"])
    duplicates = [{"canonical_smiles": key, "count": len(ids), "record_ids": "; ".join(ids)}
                  for key, ids in identities.items() if len(ids) > 1]
    valid = sum(row["valid"] for row in rows)
    return {"records": rows, "summary": {"input_count": len(rows), "valid_count": valid,
            "invalid_count": len(rows) - valid, "unique_identity_count": len(identities), "duplicate_group_count": len(duplicates)},
            "tables": [table("molecules", "Molecular data", rows), table("duplicates", "Canonical identity duplicates", duplicates)],
            "method": {**_dataset_method(policy), "tpsa": "RDKit CalcTPSA(includeSandP=False)",
                       "donor_acceptor_definition": "Lipinski.NumHDonors / NumHAcceptors"},
            "warnings": (["Invalid molecular rows are retained and excluded from calculations."] if valid < len(rows) else []) +
            (["Largest-fragment selection changes multicomponent identities; removed fragments are reported and no charge neutralization is performed."] if policy == "largest_fragment" else [])}


def search_substructures(data):
    from rdkit import Chem, rdBase
    obj(data, "input", {"records", "salt_policy", "smarts", "use_chirality", "max_matches"})
    smarts = text(data.get("smarts"), "smarts", 1024)
    with rdBase.BlockLogs():
        query = Chem.MolFromSmarts(smarts)
    if query is None or not 1 <= query.GetNumAtoms() <= 64:
        fail("INVALID_SMARTS", "SMARTS must contain 1–64 valid query atoms")
    chirality = boolean(data.get("use_chirality", False), "use_chirality")
    maximum = integer(data.get("max_matches", 32), "max_matches", 1, 128)
    rows, molecules, policy = _molecules(data)
    matches, match_rows = [], []
    for row, mol in zip(rows, molecules):
        if mol is None:
            row.update(matched=None, match_count=0, truncated=False)
            continue
        indices = mol.GetSubstructMatches(query, uniquify=True, useChirality=chirality, maxMatches=maximum + 1)
        truncated = len(indices) > maximum
        indices = indices[:maximum]
        row.update(matched=bool(indices), match_count=len(indices), truncated=truncated)
        matches.append({"id": row["id"], "canonical_smiles": row["canonical_smiles"], "atom_indices": [list(i) for i in indices], "truncated": truncated})
        match_rows.extend({"id": row["id"], "match": index + 1, "atom_indices_zero_based": json.dumps(list(atoms))}
                          for index, atoms in enumerate(indices))
    return {"smarts": smarts, "matches": matches, "records": rows,
            "summary": {"input_count": len(rows), "matched_count": sum(row.get("matched") is True for row in rows),
                        "invalid_count": sum(not row["valid"] for row in rows)},
            "tables": [table("search", "Substructure screening", rows), table("matches", "Matched atom indices", match_rows)],
            "method": {**_dataset_method(policy), "algorithm": "RDKit GetSubstructMatches", "use_chirality": chirality,
                       "uniquify": True, "max_matches_per_record": maximum,
                       "atom_index_basis": "zero-based atoms obtained by parsing the returned canonical_smiles; query atom order"},
            "warnings": ["A truncated match list is a lower bound, not the total number of matches."] if any(row["truncated"] for row in rows) else []}


def cluster_molecules(data):
    from rdkit import DataStructs
    from rdkit.Chem import rdFingerprintGenerator
    from rdkit.ML.Cluster import Butina
    obj(data, "input", {"records", "salt_policy", "similarity_threshold", "radius", "fp_size", "use_chirality"})
    threshold = number(data.get("similarity_threshold", .55), "similarity_threshold", 0, 1)
    radius = integer(data.get("radius", 2), "radius", 1, 4)
    size = integer(data.get("fp_size", 2048), "fp_size", 128, 8192)
    chirality = boolean(data.get("use_chirality", True), "use_chirality")
    rows, molecules, policy = _molecules(data)
    valid = [(row, mol) for row, mol in zip(rows, molecules) if mol is not None]
    if not valid:
        fail("NO_VALID_MOLECULES", "At least one valid molecule is required", {"records": rows})
    generator = rdFingerprintGenerator.GetMorganGenerator(radius=radius, fpSize=size, includeChirality=chirality)
    fingerprints = [generator.GetFingerprint(mol) for _, mol in valid]
    distances = [1 - DataStructs.TanimotoSimilarity(fingerprints[i], fingerprints[j])
                 for i in range(len(fingerprints)) for j in range(i)]
    clusters = Butina.ClusterData(distances, len(fingerprints), 1 - threshold, isDistData=True, reordering=True)
    summaries, representatives = [], []
    for index, members in enumerate(clusters):
        cluster_id = f"cluster_{index + 1}"
        centroid = members[0]
        center = valid[centroid][0]
        representatives.append(center["id"])
        summaries.append({"cluster_id": cluster_id, "size": len(members), "representative_id": center["id"],
                          "representative_smiles": center["canonical_smiles"], "member_ids": "; ".join(valid[i][0]["id"] for i in members)})
        for member in members:
            valid[member][0].update(cluster_id=cluster_id, representative=member == centroid,
                                   representative_id=center["id"], similarity_to_representative=DataStructs.TanimotoSimilarity(fingerprints[member], fingerprints[centroid]))
    return {"records": rows, "clusters": summaries, "representative_ids": representatives,
            "summary": {"input_count": len(rows), "valid_count": len(valid), "cluster_count": len(clusters)},
            "tables": [table("clusters", "Molecular clusters", summaries), table("membership", "Cluster membership", rows)],
            "method": {**_dataset_method(policy), "algorithm": "RDKit Butina ClusterData(reordering=True)",
                       "fingerprint": "Morgan bit fingerprint", "radius": radius, "fp_size": size,
                       "use_chirality": chirality, "similarity": "Tanimoto", "similarity_threshold": threshold,
                       "distance_threshold": 1 - threshold, "representative_selection": "Butina centroid (first cluster member)"},
            "warnings": ["Fingerprint similarity is structural similarity, not measured chemical activity. Cluster members need not all meet the threshold with each other; the threshold is relative to the centroid."]}


def _composition(formula):
    """Strict integer molecular formula grammar, including hydrates and isotopes."""
    from rdkit import Chem
    formula = text(formula, "formula", 512)
    if re.search(r"\s", formula) or re.search(r"[+\-]", formula):
        fail("INVALID_FORMULA", "Use a formula without whitespace or charge suffixes; supply charge separately")
    periodic = Chem.GetPeriodicTable()
    known = {periodic.GetElementSymbol(i) for i in range(1, 119)}
    total = Counter()
    for component in re.split(r"[.·]", formula):
        if not component:
            fail("INVALID_FORMULA", "Empty hydrate/formula component")
        prefix = re.match(r"[1-9][0-9]*", component)
        multiplier = int(prefix[0]) if prefix else 1
        body = component[len(prefix[0]):] if prefix else component
        if multiplier > 1000000 or not body:
            fail("INVALID_FORMULA", "Invalid component multiplier")
        tokens = re.findall(r"\[[1-9][0-9]*[A-Z][a-z]?\]|[A-Z][a-z]?|[0-9]+|[()\[\]]", body)
        if "".join(tokens) != body:
            fail("INVALID_FORMULA", "Unsupported formula syntax; integer formulas, parentheses, hydrates and [13C]-style isotopes are supported")
        position = 0

        def count():
            nonlocal position
            value = 1
            if position < len(tokens) and tokens[position].isdigit():
                token = tokens[position]
                value = int(token)
                position += 1
                if token.startswith("0") or not 1 <= value <= 1000000:
                    fail("INVALID_FORMULA", "Element/group counts must be positive integers without leading zeroes")
            return value

        def group(closing=None, depth=0):
            nonlocal position
            if depth > 12:
                fail("INVALID_FORMULA", "Formula nesting exceeds 12 groups")
            result = Counter()
            while position < len(tokens):
                token = tokens[position]
                if token in {")", "]"}:
                    if token != closing:
                        fail("INVALID_FORMULA", "Unmatched formula bracket")
                    position += 1
                    if not result:
                        fail("INVALID_FORMULA", "Empty formula group")
                    return result
                position += 1
                if token in {"(", "["}:
                    part = group(")" if token == "(" else "]", depth + 1)
                else:
                    isotope_match = re.fullmatch(r"\[([1-9][0-9]*)([A-Z][a-z]?)\]", token)
                    element = isotope_match[2] if isotope_match else token
                    if element not in known:
                        fail("INVALID_FORMULA", f"Unknown element or token: {token}")
                    isotope = int(isotope_match[1]) if isotope_match else 0
                    if isotope and (isotope > 400 or periodic.GetMassForIsotope(element, isotope) <= 0):
                        fail("INVALID_ISOTOPE", f"No isotope mass is available for {token}")
                    part = Counter({(element, isotope): 1})
                factor = count()
                for key, value in part.items():
                    result[key] += value * factor
                    if result[key] > 1000000:
                        fail("FORMULA_LIMIT", "Formula contains more than 1,000,000 atoms of one isotope/element")
            if closing is not None:
                fail("INVALID_FORMULA", "Unclosed formula bracket")
            if not result:
                fail("INVALID_FORMULA", "Empty formula")
            return result

        for key, value in group().items():
            total[key] += value * multiplier
    if sum(total.values()) > 1000000:
        fail("FORMULA_LIMIT", "Formula exceeds 1,000,000 atoms")
    return total


def formula_properties(data):
    from rdkit import Chem
    obj(data, "input", {"formula", "charge"})
    formula = text(data.get("formula"), "formula", 512)
    charge = integer(data.get("charge", 0), "charge", -100, 100)
    composition = _composition(formula)
    periodic = Chem.GetPeriodicTable()
    rows, elements, average, exact = [], Counter(), 0., 0.
    for (element, isotope), count in sorted(composition.items()):
        mass = periodic.GetMassForIsotope(element, isotope) if isotope else periodic.GetAtomicWeight(element)
        exact_atom = periodic.GetMassForIsotope(element, isotope) if isotope else periodic.GetMostCommonIsotopeMass(element)
        average += mass * count
        exact += exact_atom * count
        elements[element] += count
        rows.append({"element": element, "isotope": isotope or None, "count": count,
                     "atomic_mass_g_mol": mass, "mass_contribution_g_mol": mass * count})
    for row in rows:
        row["mass_fraction"] = row["mass_contribution_g_mol"] / average
    if sum(periodic.GetAtomicNumber(e) * n for e, n in elements.items()) - charge < 0:
        fail("INVALID_CHARGE", "Charge implies a negative number of electrons")
    result = {"formula": formula, "formal_charge": charge, "composition": dict(elements), "atom_count": sum(elements.values()),
              "molar_mass_g_mol": average, "exact_mass_da": exact - charge * ELECTRON_MASS_DA,
              "neutral_atomic_mass_da": exact, "mass_to_charge_da": (exact - charge * ELECTRON_MASS_DA) / abs(charge) if charge else None,
              "tables": [table("composition", "Elemental composition", rows)],
              "method": {"algorithm": "Strict integer formula parser with RDKit periodic-table masses",
                         "molar_mass_basis": "Natural-abundance average atomic weights, except explicitly specified isotopes; electron mass omitted",
                         "exact_mass_basis": "Most abundant isotope for unspecified elements; explicit isotopes retained; formal_charge × electron mass subtracted",
                         "electron_mass_da": ELECTRON_MASS_DA},
              "warnings": ["Formula mass does not identify molecular connectivity, phase, purity or experimental isotope abundances."]}
    result["tables"].insert(0, table("properties", "Formula properties", [{key: result[key] for key in ("formula", "formal_charge", "atom_count", "molar_mass_g_mol", "exact_mass_da", "mass_to_charge_da")}]))
    return result


def balance_equation(data):
    from sympy import Matrix, ilcm
    obj(data, "input", {"reactants", "products"})
    species, compositions, seen = [], [], set()
    for side in ("reactants", "products"):
        values = data.get(side)
        if not isinstance(values, list) or not 1 <= len(values) <= 12:
            fail("INVALID_INPUT", f"{side} must contain 1–12 formula/charge objects")
        for raw in values:
            entry = obj(raw, side, {"formula", "charge"})
            formula = text(entry.get("formula"), "formula", 512)
            charge = integer(entry.get("charge", 0), "charge", -100, 100)
            if formula == "e":
                if charge != -1:
                    fail("INVALID_CHARGE", "An electron must be written {formula:'e', charge:-1}")
                composition = Counter()
            else:
                composition = _composition(formula)
            identity = (tuple(sorted(composition.items())), charge)
            if identity in seen:
                fail("AMBIGUOUS_EQUATION", "Duplicate species/compositions or spectator species must be removed before balancing")
            seen.add(identity)
            species.append({"side": side, "formula": formula, "charge": charge})
            compositions.append(composition)
    elements = sorted({key[0] for composition in compositions for key in composition})
    isotope_keys = sorted({key for composition in compositions for key in composition if key[1]})
    labels = elements + [f"[{i}{e}]" for e, i in isotope_keys] + ["charge"]
    matrix = []
    for label in labels:
        values = []
        for entry, composition in zip(species, compositions):
            if label == "charge":
                value = entry["charge"]
            elif label.startswith("["):
                match = re.fullmatch(r"\[([0-9]+)([A-Z][a-z]?)\]", label)
                value = composition[(match[2], int(match[1]))]
            else:
                value = sum(n for (e, _), n in composition.items() if e == label)
            values.append(value if entry["side"] == "reactants" else -value)
        matrix.append(values)
    basis = Matrix(matrix).nullspace()
    if len(basis) != 1:
        fail("AMBIGUOUS_EQUATION" if basis else "UNBALANCEABLE_EQUATION",
             "Equation requires one unique positive balance; add missing species or remove underdetermination", {"nullity": len(basis)})
    vector = basis[0]
    denominator = int(ilcm(*[value.q for value in vector]))
    coefficients = [int(value * denominator) for value in vector]
    if all(value < 0 for value in coefficients):
        coefficients = [-value for value in coefficients]
    if any(value <= 0 for value in coefficients):
        fail("UNBALANCEABLE_EQUATION", "No balance uses every declared species with a positive coefficient on its specified side")
    divisor = math.gcd(*coefficients)
    coefficients = [value // divisor for value in coefficients]
    if max(coefficients) > 1000000:
        fail("EQUATION_LIMIT", "Balanced coefficient exceeds 1,000,000")
    for entry, coefficient in zip(species, coefficients):
        entry["coefficient"] = coefficient
    residuals = [{"conserved_quantity": label, "reactants": sum(max(value, 0) * coefficient for value, coefficient in zip(row, coefficients)),
                  "products": sum(max(-value, 0) * coefficient for value, coefficient in zip(row, coefficients)),
                  "residual": sum(value * coefficient for value, coefficient in zip(row, coefficients))} for label, row in zip(labels, matrix)]
    # Charge totals retain their signs, unlike elemental nonnegative counts.
    charge_row = residuals[-1]
    charge_row["reactants"] = sum(e["charge"] * e["coefficient"] for e in species if e["side"] == "reactants")
    charge_row["products"] = sum(e["charge"] * e["coefficient"] for e in species if e["side"] == "products")
    def render(entry):
        charge = entry["charge"]
        suffix = (f"^{abs(charge) if abs(charge) != 1 else ''}{'+' if charge > 0 else '-'}") if charge else ""
        return (str(entry["coefficient"]) + " " if entry["coefficient"] != 1 else "") + entry["formula"] + suffix
    equation = " + ".join(render(e) for e in species if e["side"] == "reactants") + " → " + " + ".join(render(e) for e in species if e["side"] == "products")
    return {"equation": equation, "species": species, "balanced": True, "tables": [table("coefficients", "Balanced coefficients", species), table("conservation", "Exact conservation", residuals)],
            "method": {"algorithm": "SymPy rational matrix nullspace; primitive positive integer vector", "conserved": labels, "nullity": 1},
            "warnings": ["Atom and charge balance alone does not establish thermodynamic favorability, mechanism or reaction feasibility."]}


UNITS = {"mass": {"g": 1., "mg": .001, "ug": 1e-6, "kg": 1000.},
         "volume": {"L": 1., "mL": .001, "uL": 1e-6},
         "moles": {"mol": 1., "mmol": .001, "umol": 1e-6, "nmol": 1e-9},
         "concentration": {"mol/L": 1., "mmol/L": .001, "umol/L": 1e-6, "nmol/L": 1e-9}}


def _quantity(value, kind, name, positive=False):
    value = obj(value, name, {"value", "unit"})
    unit = value.get("unit")
    if not isinstance(unit, str) or unit not in UNITS[kind]:
        fail("INVALID_UNIT", f"{name}.unit must be one of {', '.join(UNITS[kind])}")
    supplied = number(value.get("value"), name + ".value", positive=positive)
    converted = supplied * UNITS[kind][unit]
    if supplied > 0 and converted < 1e-24:
        fail("QUANTITY_LIMIT", f"{name} is below the supported numerical range (1e-24 in canonical units)")
    return converted


def solution_calculator(data):
    obj(data, "input", {"mode", "formula", "mass", "moles", "concentration", "volume", "stock_concentration", "target_concentration", "final_volume"})
    mode = data.get("mode", "amount")
    if mode == "amount":
        if any(key in data for key in ("stock_concentration", "target_concentration", "final_volume")):
            fail("INVALID_INPUT", "Dilution quantities cannot be used in amount mode")
        supplied = [key for key in ("mass", "moles", "concentration") if key in data]
        if len(supplied) != 1:
            fail("INVALID_INPUT", "Supply exactly one of mass, moles or concentration")
        properties = formula_properties({"formula": data.get("formula")})
        molar_mass = properties["molar_mass_g_mol"]
        volume = _quantity(data["volume"], "volume", "volume", positive=True) if "volume" in data else None
        quantity = supplied[0]
        amount = _quantity(data[quantity], quantity, quantity)
        if quantity == "concentration" and volume is None:
            fail("INVALID_INPUT", "Concentration input requires a positive volume")
        moles = amount / molar_mass if quantity == "mass" else amount * volume if quantity == "concentration" else amount
        row = {"formula": properties["formula"], "molar_mass_g_mol": molar_mass, "mass_g": moles * molar_mass,
               "amount_mol": moles, "volume_L": volume, "concentration_mol_L": moles / volume if volume else None}
        return {"mode": mode, **row, "input_quantities": data, "tables": [table("solution", "Amount and concentration", [row])],
                "method": {"equations": ["n = m / M", "c = n / V"], "volume_basis": "final solution volume", "molar_mass_basis": properties["method"]["molar_mass_basis"]},
                "warnings": ["Calculated quantities assume the declared formula and pure solute; density, activity, dissociation and volume change are not modeled."]}
    if mode != "dilution":
        fail("INVALID_INPUT", "mode must be amount or dilution")
    if any(key in data for key in ("formula", "mass", "moles", "concentration", "volume")):
        fail("INVALID_INPUT", "Amount quantities cannot be used in dilution mode")
    stock = _quantity(data.get("stock_concentration"), "concentration", "stock_concentration", positive=True)
    target = _quantity(data.get("target_concentration"), "concentration", "target_concentration", positive=True)
    final_volume = _quantity(data.get("final_volume"), "volume", "final_volume", positive=True)
    if target > stock:
        fail("INVALID_DILUTION", "Target concentration cannot exceed stock concentration for dilution")
    stock_volume = target * final_volume / stock
    row = {"stock_concentration_mol_L": stock, "target_concentration_mol_L": target, "final_volume_L": final_volume,
           "stock_volume_L": stock_volume, "dilution_factor": stock / target, "conserved_amount_mol": target * final_volume}
    return {"mode": mode, **row, "input_quantities": data, "tables": [table("dilution", "Dilution calculation", [row])],
            "method": {"equations": ["c1 V1 = c2 V2", "V1 = c2 V2 / c1"], "volume_basis": "final solution volume; no solvent-volume additivity assumed"},
            "warnings": ["This is a material-balance calculation; it does not model nonideal mixing or provide a preparation procedure."]}


def operator_specs():
    def schema(properties, required=()):
        return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}
    st = {"type": "string", "minLength": 1, "maxLength": 512}
    records = {"type": "array", "minItems": 1, "maxItems": 256, "items": schema({"id": {"type": "string", "minLength": 1, "maxLength": 128}, "smiles": {"type": "string", "maxLength": 2048}}, ["id", "smiles"])}
    common = {"records": records, "salt_policy": {"type": "string", "enum": ["preserve", "largest_fragment", "reject_multicomponent"], "default": "preserve"}}
    examples = [{"id": "ethanol", "smiles": "CCO"}, {"id": "phenol", "smiles": "Oc1ccccc1"}, {"id": "acetic_acid", "smiles": "CC(=O)O"}, {"id": "benzene", "smiles": "c1ccccc1"}]
    charge = {"type": "integer", "minimum": -100, "maximum": 100, "default": 0}
    species = {"type": "array", "minItems": 1, "maxItems": 12, "items": schema({"formula": st, "charge": charge}, ["formula"])}
    def quantity(kind):
        return schema({"value": {"type": "number", "minimum": 0, "maximum": 1e12}, "unit": {"type": "string", "enum": list(UNITS[kind])}}, ["value", "unit"])
    solution = schema({"mode": {"type": "string", "enum": ["amount", "dilution"], "default": "amount"}, "formula": st,
                       **{key: quantity(key) for key in ("mass", "moles", "concentration", "volume")},
                       "stock_concentration": quantity("concentration"), "target_concentration": quantity("concentration"), "final_volume": quantity("volume")})
    solution["oneOf"] = [
        {"properties": {"mode": {"const": "amount"}}, "required": ["formula"],
         "oneOf": [{"required": [key] + (["volume"] if key == "concentration" else []),
                    "not": {"anyOf": [{"required": [other]} for other in ("mass", "moles", "concentration") if other != key]}}
                   for key in ("mass", "moles", "concentration")],
         "not": {"anyOf": [{"required": [key]} for key in ("stock_concentration", "target_concentration", "final_volume")]}},
        {"properties": {"mode": {"const": "dilution"}}, "required": ["mode", "stock_concentration", "target_concentration", "final_volume"], "not": {"anyOf": [{"required": [key]} for key in ("formula", "mass", "moles", "concentration", "volume")]}}]
    return [
        ("prepare_molecular_dataset", "Prepare molecular dataset", "chemical-data", "Canonicalize a SMILES batch with explicit salt policy, preserved invalid rows, descriptors and duplicate identity report.", schema(common, ["records"]), {"records": examples + [{"id": "ethanol_duplicate", "smiles": "OCC"}, {"id": "invalid", "smiles": "not-a-smiles"}], "salt_policy": "preserve"}, "OpenScience RDKit procedure / RDKit", ["rdkit"]),
        ("search_substructures", "SMARTS substructure search", "chemical-data", "Screen molecular records against a SMARTS pattern and report exact matching atom indices on canonical graphs.", schema({**common, "smarts": {"type": "string", "minLength": 1, "maxLength": 1024}, "use_chirality": {"type": "boolean", "default": False}, "max_matches": {"type": "integer", "minimum": 1, "maximum": 128, "default": 32}}, ["records", "smarts"]), {"records": examples, "smarts": "[OX2H]", "use_chirality": False}, "RDKit", ["rdkit"]),
        ("cluster_molecules", "Molecular clustering and representatives", "chemical-data", "Group Morgan fingerprints by Tanimoto distance using Butina clustering and select one actual centroid per cluster.", schema({**common, "similarity_threshold": {"type": "number", "minimum": 0, "maximum": 1, "default": .55}, "radius": {"type": "integer", "minimum": 1, "maximum": 4, "default": 2}, "fp_size": {"type": "integer", "minimum": 128, "maximum": 8192, "default": 2048}, "use_chirality": {"type": "boolean", "default": True}}, ["records"]), {"records": examples, "similarity_threshold": .55, "radius": 2, "fp_size": 2048}, "RDKit Morgan / Butina", ["rdkit"]),
        ("formula_properties", "Formula composition and mass", "chemical-data", "Parse integer formulas, hydrates and explicit isotope labels; calculate elemental composition, average molar mass and charge-corrected exact mass.", schema({"formula": st, "charge": charge}, ["formula"]), {"formula": "CuSO4·5H2O", "charge": 0}, "RDKit periodic table / local formula parser", ["rdkit"]),
        ("balance_equation", "Balance chemical equation", "chemical-data", "Find a unique primitive integer balance preserving elements, explicit isotope labels and charge; reject ambiguous equations.", schema({"reactants": species, "products": species}, ["reactants", "products"]), {"reactants": [{"formula": "Fe"}, {"formula": "O2"}], "products": [{"formula": "Fe2O3"}]}, "SymPy exact rational nullspace / RDKit elements", ["rdkit", "sympy"]),
        ("solution_calculator", "Amount, concentration and dilution", "chemical-data", "Convert declared mass, amount and volume units; calculate molarity or conserved-solute dilution with explicit equations.", solution, {"mode": "amount", "formula": "NaCl", "mass": {"value": 5.844, "unit": "g"}, "volume": {"value": 1, "unit": "L"}}, "Dimensional material balance / RDKit formula masses", ["rdkit"]),
    ]


OPERATORS = {function.__name__: function for function in (prepare_molecular_dataset, search_substructures, cluster_molecules, formula_properties, balance_equation, solution_calculator)}
