"""Versioned scientific operators for the shared Proto/Chem workbench.

Protocol: one JSON {operator, input} on stdin, one JSON envelope on stdout.
This module never writes files, contacts a model, or executes supplied code.
Scientific source provenance and assumptions travel with every result.
"""
from __future__ import annotations

import contextlib
import copy
import hashlib
import importlib.metadata
import importlib.util
import json
import math
import os
import re
import sys
from collections import Counter
from pathlib import Path
from functools import lru_cache
from typing import Any

VERSION = "chem-science/1.7.0"
MAX_INPUT_BYTES = 2_000_000
GAS_CONSTANT = 8.31446261815324


class ScienceError(ValueError):
    def __init__(self, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.code, self.details = code, details


def fail(code: str, message: str, details: Any = None) -> None:
    raise ScienceError(code, message, details)


def number(value: Any, name: str, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        fail("INVALID_INPUT", f"{name} must be a finite number")
    if not low <= value <= high:
        fail("INVALID_INPUT", f"{name} must be between {low:g} and {high:g}")
    return float(value)


def integer(value: Any, name: str, low: int, high: int) -> int:
    if type(value) is not int or not low <= value <= high:
        fail("INVALID_INPUT", f"{name} must be an integer between {low} and {high}")
    return value


def text(value: Any, name: str, limit: int = 4096) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        fail("INVALID_INPUT", f"{name} must be nonempty text, at most {limit} characters")
    return value


def obj(value: Any, name: str, allowed: set[str] | None = None) -> dict:
    if not isinstance(value, dict) or any(not isinstance(k, str) for k in value):
        fail("INVALID_INPUT", f"{name} must be an object")
    if allowed is not None and set(value) - allowed:
        fail("INVALID_INPUT", f"Unknown {name} fields: {', '.join(sorted(set(value) - allowed))}")
    return value


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def dependencies() -> dict[str, str]:
    values = {"python": sys.version.split()[0]}
    for package in ("numpy", "scipy", "rdkit", "pymatgen", "ase", "sympy"):
        try:
            values[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            values[package] = "unavailable"
    return values


@lru_cache(maxsize=1)
def extensions() -> tuple:
    """Load fixed sibling implementations, including when imported by a test host."""
    modules = []
    for name in ("chem_analysis", "chem_data", "chem_physical", "chem_interfaces", "chem_reactions", "chem_coupled_reactions", "chem_driven_reactions", "chem_network_reactors"):
        spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        if name == "chem_reactions":
            module.bind_kernel(_prepare)
        modules.append(module)
    return tuple(modules)


def source_provenance() -> dict:
    files = {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
        for name in ("chem_science.py", "chem_analysis.py", "chem_data.py", "chem_physical.py", "chem_interfaces.py", "chem_reactions.py", "chem_coupled_reactions.py", "chem_driven_reactions.py", "chem_network_reactors.py")}
    return {"source_sha256": digest(files), "source_files_sha256": files}


def _parse_smiles(smiles: str):
    from rdkit import Chem
    parameters = Chem.SmilesParserParams()
    # Explicit mapped hydrogen identities are part of reaction input provenance.
    parameters.removeHs = False
    return Chem.MolFromSmiles(smiles, parameters)


def _molecule(smiles: str, geometry: bool = True) -> dict:
    from rdkit import Chem
    from rdkit.Chem import AllChem, Crippen, Descriptors, Lipinski, rdMolDescriptors

    smiles = text(smiles, "smiles", 2048)
    mol = _parse_smiles(smiles)
    if mol is None or mol.GetNumAtoms() < 1 or mol.GetNumAtoms() > 128:
        fail("INVALID_SMILES", "SMILES must describe 1–128 atoms before hydrogen expansion")
    if any(a.GetAtomicNum() == 0 for a in mol.GetAtoms()):
        fail("INVALID_SMILES", "Wildcard atoms do not define a molecular composition")
    expanded = Chem.AddHs(mol)
    if expanded.GetNumAtoms() > 384:
        fail("MOLECULE_LIMIT", "At most 384 atoms including hydrogens")
    composition = dict(Counter(a.GetSymbol() for a in expanded.GetAtoms()))
    result = {
        "smiles": Chem.MolToSmiles(mol), "formula": rdMolDescriptors.CalcMolFormula(mol),
        "composition": composition, "formal_charge": Chem.GetFormalCharge(mol),
        "descriptors": {"molecular_weight_g_mol": Descriptors.MolWt(mol), "exact_mass_da": Descriptors.ExactMolWt(mol),
            "logp": Crippen.MolLogP(mol), "tpsa_angstrom2": rdMolDescriptors.CalcTPSA(mol),
            "hydrogen_bond_donors": Lipinski.NumHDonors(mol), "hydrogen_bond_acceptors": Lipinski.NumHAcceptors(mol),
            "rotatable_bonds": Lipinski.NumRotatableBonds(mol), "ring_count": rdMolDescriptors.CalcNumRings(mol),
            "molar_refractivity": Crippen.MolMR(mol), "labute_asa_angstrom2": Descriptors.LabuteASA(mol),
            "heavy_atoms": Descriptors.HeavyAtomCount(mol), "heteroatoms": Descriptors.NumHeteroatoms(mol),
            "valence_electrons": Descriptors.NumValenceElectrons(mol),
            "aromatic_rings": Descriptors.NumAromaticRings(mol), "fraction_csp3": Descriptors.FractionCSP3(mol),
            "bertz_complexity": Descriptors.BertzCT(mol), "qed": Descriptors.qed(mol)},
        "atoms": [], "bonds": [], "geometry_method": "not_requested", "geometry_status": "not_requested",
    }
    if not geometry:
        return result
    params = AllChem.ETKDGv3()
    params.randomSeed = 20260919
    params.maxIterations = 200
    code = AllChem.EmbedMolecule(expanded, params)
    if code != 0:
        result.update(geometry_method="ETKDGv3", geometry_status="embedding_failed")
        return result
    status, method = "embedded", "RDKit ETKDGv3, seed 20260919"
    if AllChem.MMFFHasAllMoleculeParams(expanded):
        optimized = AllChem.MMFFOptimizeMolecule(expanded, maxIters=200)
        method += "; MMFF94 relaxation"
        status = "optimized" if optimized == 0 else "optimization_iteration_limit"
    elif AllChem.UFFHasAllMoleculeParams(expanded):
        optimized = AllChem.UFFOptimizeMolecule(expanded, maxIters=200)
        method += "; UFF relaxation"
        status = "optimized" if optimized == 0 else "optimization_iteration_limit"
    conf = expanded.GetConformer()
    result.update(geometry_method=method, geometry_status=status)
    for atom in expanded.GetAtoms():
        xyz = conf.GetAtomPosition(atom.GetIdx())
        result["atoms"].append({"element": atom.GetSymbol(), "x": xyz.x, "y": xyz.y, "z": xyz.z, "map_number": atom.GetAtomMapNum()})
    result["bonds"] = [{"start": b.GetBeginAtomIdx(), "end": b.GetEndAtomIdx(), "order": b.GetBondTypeAsDouble()} for b in expanded.GetBonds()]
    return result


def analyze_molecule(data: dict) -> dict:
    obj(data, "input", {"smiles"})
    molecule = _molecule(data.get("smiles"))
    d = molecule["descriptors"]
    rules = {"molecular_weight_at_most_500": d["molecular_weight_g_mol"] <= 500, "logp_at_most_5": d["logp"] <= 5,
        "h_donors_at_most_5": d["hydrogen_bond_donors"] <= 5, "h_acceptors_at_most_10": d["hydrogen_bond_acceptors"] <= 10}
    return {"molecule": molecule, "screening": {"lipinski_criteria": rules, "lipinski_violation_count": sum(not v for v in rules.values())}, "warnings": [
        "One generated and locally relaxed conformer; not an experimental structure or global energy minimum.",
        "QED and Lipinski criteria are descriptor-based screening heuristics, not evidence of efficacy or safety.",
        "Disconnected SMILES fragments have no physically calibrated relative position."]}


def compare_molecules(data: dict) -> dict:
    from rdkit import Chem, DataStructs
    from rdkit.Chem import rdFingerprintGenerator, rdFMCS
    from rdkit.Chem.Scaffolds import MurckoScaffold
    obj(data, "input", {"original_smiles", "proposed_smiles"})
    original = _molecule(data.get("original_smiles"), False)
    proposed = _molecule(data.get("proposed_smiles"), False)
    first, second = Chem.MolFromSmiles(original["smiles"]), Chem.MolFromSmiles(proposed["smiles"])
    generator = rdFingerprintGenerator.GetMorganGenerator(radius=2, fpSize=2048)
    similarity = DataStructs.TanimotoSimilarity(generator.GetFingerprint(first), generator.GetFingerprint(second))
    common = rdFMCS.FindMCS([first, second], timeout=3, ringMatchesRingOnly=True, completeRingsOnly=True)
    scaffolds = [Chem.MolToSmiles(MurckoScaffold.GetScaffoldForMol(mol)) for mol in [first, second]]
    return {"original": original, "proposed": proposed, "morgan_tanimoto": similarity,
        "fingerprint": {"algorithm": "Morgan", "radius": 2, "bits": 2048},
        "murcko_scaffolds": scaffolds, "same_murcko_scaffold": scaffolds[0] == scaffolds[1] if all(scaffolds) else None,
        "maximum_common_substructure": {"atoms": common.numAtoms, "bonds": common.numBonds, "smarts": common.smartsString, "timed_out": common.canceled},
        "descriptor_delta": {key: proposed["descriptors"][key] - value for key, value in original["descriptors"].items()},
        "warnings": ["Fingerprint similarity and scaffold matching do not establish biological activity or chemical reaction feasibility.",
            "For acyclic molecules, an empty Murcko scaffold does not establish scaffold preservation. MCS search is limited to three seconds."]}


def example_network(kind: str) -> dict:
    def species(key, label, initial, smiles=None, composition=None):
        value = {"id": key, "label": label, "initial_concentration": initial}
        if smiles:
            value["smiles"] = smiles
        if composition:
            value["composition"] = composition
        return value

    def reaction(key, reactants, products, rate, ea=25000):
        return {"id": key, "reactants": reactants, "products": products, "rate_constant": rate,
            "activation_energy_j_mol": ea, "reference_temperature_k": 298.15}

    a = species("A", "Isomer A (illustrative)", 1.0, "CCCO")
    b = species("B", "Isomer B (illustrative)", 0.0, "CC(O)C")
    c = species("C", "Isomer C (illustrative)", 0.0, "CCOC")
    if kind == "reversible":
        rows, steps = [a, b], [reaction("forward", {"A": 1}, {"B": 1}, .15), reaction("reverse", {"B": 1}, {"A": 1}, .05, 30000)]
    elif kind == "consecutive":
        rows, steps = [a, b, c], [reaction("A_to_B", {"A": 1}, {"B": 1}, .2), reaction("B_to_C", {"B": 1}, {"C": 1}, .08)]
    elif kind == "parallel":
        rows, steps = [a, b, c], [reaction("A_to_B", {"A": 1}, {"B": 1}, .12), reaction("A_to_C", {"A": 1}, {"C": 1}, .04, 40000)]
    elif kind in {"catalytic", "interface"}:
        # Abstract conserved moieties prevent fabricated molecular assignments to bound states.
        a.pop("smiles")
        b.pop("smiles")
        a.update(label="Free substrate", composition={"substrate": 1})
        b.update(label="Free product", composition={"substrate": 1})
        site = species("E", "Free catalyst" if kind == "catalytic" else "Vacant surface site", .25, composition={"site": 1})
        bound = species("EA", "Bound substrate", 0, composition={"substrate": 1, "site": 1})
        rows = [a, b, site, bound]
        steps = [reaction("binding", {"A": 1, "E": 1}, {"EA": 1}, .8), reaction("release", {"EA": 1}, {"A": 1, "E": 1}, .08)]
        if kind == "catalytic":
            steps.append(reaction("turnover", {"EA": 1}, {"B": 1, "E": 1}, .2, 45000))
        else:
            product_bound = species("EB", "Bound product", 0, composition={"substrate": 1, "site": 1})
            rows.append(product_bound)
            steps += [reaction("surface_conversion", {"EA": 1}, {"EB": 1}, .2), reaction("desorption", {"EB": 1}, {"B": 1, "E": 1}, .1)]
    else:
        fail("UNKNOWN_EXAMPLE", "Choose reversible, consecutive, parallel, catalytic or interface")
    return {"label": kind.capitalize() + " demonstration", "species": rows, "reactions": steps,
        "provenance": "Synthetic educational network and invented rate constants, not a measured chemical mechanism. Molecular isomers illustrate composition only."}


SIM_FIELDS = {"network", "example", "duration_s", "points", "temperature_k"}


def _prepare(data: dict, *, geometry: bool, allow_empty: bool = False):
    import numpy as np

    obj(data, "input", SIM_FIELDS)
    duration = number(data.get("duration_s", 30), "duration_s", 1e-9, 1e7)
    points = integer(data.get("points", 121), "points", 2, 1001)
    temperature = number(data.get("temperature_k", 298.15), "temperature_k", 1, 5000)
    if "network" in data and "example" in data:
        fail("INVALID_INPUT", "Choose either network or example, not both")
    network = copy.deepcopy(data["network"] if "network" in data else example_network(data.get("example", "reversible")))
    obj(network, "network", {"label", "species", "reactions", "provenance"})
    if "label" in network:
        text(network["label"], "network.label", 240)
    if "provenance" in network:
        text(network["provenance"], "network.provenance", 4096)
    species = network.get("species")
    reactions = network.get("reactions")
    if not isinstance(species, list) or not 1 <= len(species) <= 16:
        fail("INVALID_NETWORK", "Provide 1–16 species")
    if not isinstance(reactions, list) or not 1 <= len(reactions) <= 24:
        fail("INVALID_NETWORK", "Provide 1–24 reactions")
    ids, molecules, compositions, initial = [], {}, {}, []
    for row in species:
        obj(row, "species", {"id", "label", "smiles", "initial_concentration", "composition", "formal_charge"})
        sid = text(row.get("id"), "species.id", 48)
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", sid) or sid in ids:
            fail("INVALID_NETWORK", "Species IDs must be unique ASCII identifiers beginning with a letter")
        ids.append(sid)
        if "label" in row:
            text(row["label"], "species.label", 240)
        initial.append(number(row.get("initial_concentration"), sid + ".initial_concentration", 0, 1e6))
        if "smiles" in row:
            molecule = _molecule(row["smiles"], geometry)
            molecules[sid] = molecule
            compositions[sid] = {**molecule["composition"], "charge": molecule["formal_charge"]}
        if "composition" in row:
            comp = obj(row["composition"], sid + ".composition")
            if not comp or len(comp) > 32:
                fail("INVALID_NETWORK", "Composition requires 1–32 elements or declared conserved moieties")
            checked = {text(k, "composition key", 48): integer(v, "composition coefficient", 0, 10000) for k, v in comp.items()}
            checked["charge"] = integer(row.get("formal_charge", 0), "formal_charge", -100, 100)
            if sid in compositions and {k: v for k, v in checked.items() if v} != {k: v for k, v in compositions[sid].items() if v}:
                fail("COMPOSITION_MISMATCH", f"Declared composition disagrees with SMILES for {sid}")
            compositions[sid] = checked
        elif "formal_charge" in row:
            charge = integer(row["formal_charge"], "formal_charge", -100, 100)
            if sid in compositions and charge != compositions[sid]["charge"]:
                fail("COMPOSITION_MISMATCH", f"Declared charge disagrees with SMILES for {sid}")
    if not any(initial) and not allow_empty:
        fail("INVALID_NETWORK", "At least one initial concentration must be positive")
    index = {key: i for i, key in enumerate(ids)}
    stoich = np.zeros((len(ids), len(reactions)))
    orders = np.zeros_like(stoich)
    rate_constants, reaction_ids = [], set()
    for j, row in enumerate(reactions):
        obj(row, "reaction", {"id", "reactants", "products", "rate_constant", "activation_energy_j_mol", "reference_temperature_k"})
        rid = text(row.get("id"), "reaction.id", 80)
        if rid in reaction_ids:
            fail("INVALID_NETWORK", "Reaction IDs must be unique")
        reaction_ids.add(rid)
        for side, sign in (("reactants", -1), ("products", 1)):
            terms = obj(row.get(side), rid + "." + side)
            if not terms:
                fail("INVALID_NETWORK", "Closed-system reactions require reactants and products")
            for sid, value in terms.items():
                if sid not in index:
                    fail("UNKNOWN_SPECIES", f"Reaction {rid} references unknown species {sid}")
                coefficient = integer(value, "stoichiometric coefficient", 1, 6)
                stoich[index[sid], j] += sign * coefficient
                if sign < 0:
                    orders[index[sid], j] = coefficient
        if not np.any(stoich[:, j]):
            fail("INVALID_NETWORK", f"Reaction {rid} has no net stoichiometric change")
        if sum(row["reactants"].values()) > 6:
            fail("INVALID_NETWORK", "Mass-action order is limited to six")
        k = number(row.get("rate_constant"), rid + ".rate_constant", 0, 1e12)
        energy = number(row.get("activation_energy_j_mol", 0), rid + ".activation_energy_j_mol", -500000, 500000)
        reference = number(row.get("reference_temperature_k", 298.15), rid + ".reference_temperature_k", 1, 5000)
        exponent = -energy / GAS_CONSTANT * (1 / temperature - 1 / reference)
        if abs(exponent) > 100:
            fail("TEMPERATURE_RANGE", "Arrhenius extrapolation exceeds a numerically meaningful range")
        effective = k * math.exp(exponent)
        if not math.isfinite(effective) or effective > 1e15:
            fail("RATE_RANGE", "Temperature-adjusted rate constant exceeds numerical bounds")
        rate_constants.append(effective)
    residuals = []
    balanced = None
    if len(compositions) == len(ids):
        balanced = True
        keys = sorted(set().union(*(v.keys() for v in compositions.values())))
        for j, reaction in enumerate(reactions):
            for key in keys:
                residual = sum(compositions[sid].get(key, 0) * stoich[i, j] for i, sid in enumerate(ids))
                if abs(residual) > 1e-9:
                    residuals.append({"reaction": reaction["id"], "element": key, "residual": float(residual)})
        if residuals:
            fail("UNBALANCED_NETWORK", "Declared atoms, charge or conserved moieties are not balanced", residuals)
    return {"network": network, "ids": ids, "molecules": molecules, "compositions": compositions, "initial": np.array(initial),
        "stoich": stoich, "orders": orders, "k": np.array(rate_constants), "duration": duration, "points": points,
        "temperature": temperature, "balanced": balanced, "residuals": residuals}


def _solve(prepared: dict, times=None, rates=None):
    import numpy as np
    from scipy.integrate import solve_ivp

    grid = np.linspace(0, prepared["duration"], prepared["points"]) if times is None else np.asarray(times)
    constants = prepared["k"] if rates is None else np.asarray(rates)
    calls = 0

    def reaction_rates(y):
        with np.errstate(over="raise", invalid="raise"):
            return constants * np.prod(np.maximum(y, 0)[:, None] ** prepared["orders"], axis=0)

    def derivative(_, y):
        nonlocal calls
        calls += 1
        if calls > 100000:
            fail("SOLVER_BUDGET", "Reaction solver exceeded 100000 evaluations; simplify the model or time range")
        return prepared["stoich"] @ reaction_rates(y)

    try:
        solution = solve_ivp(derivative, (0, prepared["duration"]), prepared["initial"], method="LSODA", t_eval=grid, rtol=1e-8, atol=1e-11)
    except FloatingPointError:
        fail("SOLVER_RANGE", "Reaction rates exceeded numerical range")
    if not solution.success or solution.y.shape[1] != len(grid) or not np.isfinite(solution.y).all():
        fail("SOLVER_FAILED", str(solution.message))
    minimum = float(solution.y.min())
    tolerance = max(1e-8, float(prepared["initial"].max()) * 1e-7)
    if minimum < -tolerance:
        fail("NEGATIVE_CONCENTRATION", "Solver produced negative concentrations beyond numerical tolerance", {"minimum": minimum})
    concentrations = np.maximum(solution.y, 0)
    flux = np.stack([reaction_rates(y) for y in concentrations.T], axis=1)
    return grid, concentrations, flux, solution, minimum


def simulate_reaction_network(data: dict) -> dict:
    import numpy as np
    from scipy.linalg import null_space

    p = _prepare(data, geometry=True)
    times, values, flux, solution, minimum = _solve(p)
    ids = p["ids"]
    elements = []
    if p["balanced"]:
        for element in sorted(set().union(*(v.keys() for v in p["compositions"].values()))):
            weights = np.array([p["compositions"][sid].get(element, 0) for sid in ids])
            total = weights @ values
            drift = float(np.max(np.abs(total - total[0])))
            elements.append({"element": element, "values": total.tolist(), "max_absolute_drift": drift,
                "max_relative_drift": drift / max(abs(float(total[0])), 1e-12)})
    invariants = []
    for vector in null_space(p["stoich"].T).T:
        vector = vector / np.max(np.abs(vector))
        total = vector @ values
        invariants.append({"weights": dict(zip(ids, vector.tolist())), "values": total.tolist(),
            "max_absolute_drift": float(np.max(np.abs(total - total[0])))})
    rows = []
    for i, sid in enumerate(ids):
        row = {"id": sid, "label": p["network"]["species"][i].get("label", sid), "concentration": values[i].tolist(),
            "conversion": (1 - values[i] / p["initial"][i]).tolist() if p["initial"][i] else [None] * len(times)}
        if sid in p["molecules"]:
            row["molecule"] = p["molecules"][sid]
        rows.append(row)
    warnings = [
        "Well-mixed, isothermal, constant-volume mass-action model; rate constants and reaction steps are supplied assumptions.",
        "The 3D population scene is illustrative. Molecular conformers are independent of the ODE; no collision paths, transition states or molecular dynamics were computed.",
        "Conversion is (initial-current)/initial and can be negative for species that accumulate. It is undefined when the initial concentration is zero.",
    ]
    if "network" not in data:
        warnings.insert(0, p["network"]["provenance"])
    if p["balanced"] is None:
        warnings.append("Incomplete species compositions: only stoichiometric invariants, not elemental mass or charge balance, were checked.")
    if any("activation_energy_j_mol" not in r for r in p["network"]["reactions"]):
        warnings.append("Reactions without activation energy use temperature-independent rate constants.")
    return {"network": p["network"], "time_s": times.tolist(), "temperature_k": p["temperature"], "series": rows,
        "reaction_rates": [{"id": r["id"], "rate": flux[j].tolist(), "effective_rate_constant": float(p["k"][j]),
            "rate_constant_unit": "s^-1" if int(p["orders"][:, j].sum()) == 1 else f"(mol/L)^{1-int(p['orders'][:, j].sum())} s^-1"}
            for j, r in enumerate(p["network"]["reactions"])],
        "conservation": {"chemically_balanced": p["balanced"], "element_balance": elements, "invariants": invariants,
            "stoichiometric_residuals": p["residuals"], "minimum_raw_concentration": minimum},
        "scene": {"kind": "population-based", "description": "Population-scaled spatial illustration, not an atomistic trajectory. Each population is a concentration in mol/L.",
            "frames": [{"time_s": float(t), "populations": {sid: float(values[i, j]) for i, sid in enumerate(ids)}} for j, t in enumerate(times)]},
        "method": {"solver": "SciPy solve_ivp / LSODA", "rtol": 1e-8, "atol": 1e-11, "nfev": solution.nfev,
            "model": "dc/dt = S @ (k(T) * product(c_i ** stoichiometry_i))", "concentration_unit": "mol/L"}, "warnings": warnings}


def scan_reaction_temperature(data: dict) -> dict:
    obj(data, "input", SIM_FIELDS | {"temperatures_k"})
    temperatures = data.get("temperatures_k")
    if not isinstance(temperatures, list) or not 2 <= len(temperatures) <= 16:
        fail("INVALID_INPUT", "Provide 2–16 temperatures_k")
    if "temperature_k" in data:
        fail("INVALID_INPUT", "Use temperatures_k for a scan, not temperature_k")
    base = {key: value for key, value in data.items() if key != "temperatures_k"}
    runs = []
    for temperature in temperatures:
        p = _prepare({**base, "temperature_k": temperature}, geometry=False)
        times, values, flux, _, _ = _solve(p)
        runs.append({"temperature_k": p["temperature"], "time_s": times.tolist(),
            "series": [{"id": sid, "concentration": values[i].tolist()} for i, sid in enumerate(p["ids"])],
            "final_concentrations": {sid: float(values[i, -1]) for i, sid in enumerate(p["ids"])},
            "rate_constants": {r["id"]: float(p["k"][j]) for j, r in enumerate(p["network"]["reactions"])}})
    return {"runs": runs, "network": p["network"], "method": "Arrhenius k(T)=k_ref exp[-Ea/R(1/T-1/Tref)]; LSODA per temperature",
        "warnings": ["Extrapolates supplied activation energies; does not estimate new mechanisms or temperature-dependent thermodynamics.",
            "Reactions without activation energy remain temperature independent."]}


def fit_reaction_rates(data: dict) -> dict:
    import numpy as np
    from scipy.optimize import least_squares

    obj(data, "input", {"network", "example", "temperature_k", "observations", "fit_reaction_ids", "max_evaluations"})
    observations = obj(data.get("observations"), "observations", {"time_s", "concentrations"})
    times = observations.get("time_s")
    if not isinstance(times, list) or not 3 <= len(times) <= 201:
        fail("INVALID_INPUT", "observations.time_s requires 3–201 samples")
    times = [number(t, "time_s", 0, 1e7) for t in times]
    if times[0] != 0 or any(b <= a for a, b in zip(times, times[1:])):
        fail("INVALID_INPUT", "Observation times must start at zero and strictly increase")
    base = {k: v for k, v in data.items() if k in {"network", "example", "temperature_k"}}
    p = _prepare({**base, "duration_s": times[-1], "points": len(times)}, geometry=False)
    measured = obj(observations.get("concentrations"), "observations.concentrations")
    if not measured or set(measured) - set(p["ids"]):
        fail("INVALID_INPUT", "Observed concentrations must select existing species")
    measured_ids = list(measured)
    target = []
    for sid in measured_ids:
        row = measured[sid]
        if not isinstance(row, list) or len(row) != len(times):
            fail("INVALID_INPUT", "Each observed series must match time_s length")
        row = [number(v, sid + " observed concentration", 0, 1e6) for v in row]
        if abs(row[0] - p["initial"][p["ids"].index(sid)]) > 1e-6 * max(1, abs(row[0])):
            fail("INITIAL_CONDITION_MISMATCH", "Initial observations must agree with network initial conditions")
        target.append(row)
    target = np.asarray(target)
    reaction_ids = [r["id"] for r in p["network"]["reactions"]]
    selected = data.get("fit_reaction_ids", reaction_ids)
    if not isinstance(selected, list) or not 1 <= len(selected) <= 4 or len(set(selected)) != len(selected) or any(x not in reaction_ids for x in selected):
        fail("INVALID_INPUT", "Select 1–4 unique fit_reaction_ids")
    indexes = [reaction_ids.index(rid) for rid in selected]
    initial = p["k"][indexes]
    if np.any(initial <= 0) or np.any(initial > 1e8):
        fail("INVALID_INPUT", "Fitted initial rate constants must be positive and <= 1e8")
    evaluations = integer(data.get("max_evaluations", 80), "max_evaluations", 5, 200)
    scale = np.maximum(np.max(target, axis=1), 1e-6)[:, None]
    observed_indexes = [p["ids"].index(sid) for sid in measured_ids]

    def residual(log_rates):
        rates = p["k"].copy()
        rates[indexes] = np.exp(log_rates)
        _, values, _, _, _ = _solve(p, times=times, rates=rates)
        return ((values[observed_indexes] - target) / scale).ravel()

    fit = least_squares(residual, np.log(initial), bounds=(math.log(1e-12), math.log(1e8)), max_nfev=evaluations,
        xtol=1e-9, ftol=1e-9, gtol=1e-9)
    fitted = np.exp(fit.x)
    fitted_network = copy.deepcopy(p["network"])
    for j, value in zip(indexes, fitted):
        # Fitted constants are at the measurement temperature, made explicit.
        fitted_network["reactions"][j]["rate_constant"] = float(value)
        fitted_network["reactions"][j]["reference_temperature_k"] = p["temperature"]
    predicted = _prepare({"network": fitted_network, "duration_s": times[-1], "points": len(times), "temperature_k": p["temperature"]}, geometry=False)
    _, values, _, _, _ = _solve(predicted, times=times)
    errors = values[observed_indexes] - target
    # An optimizer's tiny finite-difference step can mistake ODE integration noise
    # for extra parameter information. Recompute sensitivity at a resolved step.
    sensitivity_step, rank_tolerance = 1e-3, 1e-4
    columns = []
    for j in range(len(indexes)):
        direction = np.zeros(len(indexes)); direction[j] = sensitivity_step
        columns.append((residual(fit.x + direction) - residual(fit.x - direction)) / (2 * sensitivity_step))
    sensitivity = np.stack(columns, axis=1)
    singular = np.linalg.svd(sensitivity, compute_uv=False)
    rank = int(np.sum(singular > max(singular[0] * rank_tolerance, 1e-12)))
    condition = float(singular[0] / singular[-1]) if singular[-1] > 1e-15 else None
    return {"fitted_network": fitted_network, "fitted_rate_constants": dict(zip(selected, fitted.tolist())), "temperature_k": p["temperature"],
        "time_s": times, "predicted": {sid: values[p["ids"].index(sid)].tolist() for sid in measured_ids}, "observations": observations,
        "diagnostics": {"converged": bool(fit.success), "message": fit.message, "evaluations": fit.nfev,
            "rmse_mol_l": float(np.sqrt(np.mean(errors ** 2))), "scaled_cost": float(fit.cost), "jacobian_rank": rank,
            "parameter_count": len(indexes), "jacobian_condition": condition, "sensitivity_step_log": sensitivity_step,
            "rank_relative_tolerance": rank_tolerance, "locally_identifiable": rank == len(indexes) and condition is not None and condition < 1 / rank_tolerance},
        "warnings": ["Numerical least-squares fit to supplied observations; validity depends on mechanism, noise and identifiability.",
            "No confidence intervals or global parameter-identifiability claim. A converged optimizer alone does not validate a mechanism."],
        "method": "SciPy least_squares, positive log-rate parameters, per-species scaled residuals, LSODA prediction"}


def inspect_reaction_smiles(data: dict) -> dict:
    from rdkit import Chem
    obj(data, "input", {"reaction_smiles"})
    source = text(data.get("reaction_smiles"), "reaction_smiles", 8192)
    pieces = source.split(">")
    if len(pieces) != 3 or not pieces[0] or not pieces[2]:
        fail("INVALID_REACTION_SMILES", "Use reactants>agents>products, or reactants>>products")
    sides, compositions, charges, maps, bond_maps = {}, {}, {}, {}, {}
    for key, segment in zip(("reactants", "agents", "products"), pieces):
        parts = segment.split(".") if segment else []
        if len(parts) > 16:
            fail("REACTION_LIMIT", "At most 16 fragments per reaction side")
        sides[key], compositions[key], charges[key], maps[key], bond_maps[key] = [], Counter(), 0, {}, {}
        for smiles in parts:
            molecule = _molecule(smiles)
            sides[key].append(molecule)
            compositions[key].update(molecule["composition"])
            charges[key] += molecule["formal_charge"]
            mol = _parse_smiles(smiles)
            for atom in mol.GetAtoms():
                mark = atom.GetAtomMapNum()
                if mark:
                    if mark in maps[key]:
                        fail("DUPLICATE_ATOM_MAP", f"Duplicate map {mark} in {key}")
                    maps[key][mark] = (atom.GetSymbol(), atom.GetIsotope())
            for bond in mol.GetBonds():
                start, end = bond.GetBeginAtom().GetAtomMapNum(), bond.GetEndAtom().GetAtomMapNum()
                if start and end:
                    bond_maps[key][tuple(sorted((start, end)))] = bond.GetBondTypeAsDouble()
    residuals = {element: compositions["products"][element] - compositions["reactants"][element]
        for element in sorted(compositions["products"].keys() | compositions["reactants"].keys())}
    residuals["charge"] = charges["products"] - charges["reactants"]
    missing_product = sorted(maps["reactants"].keys() - maps["products"].keys())
    missing_reactant = sorted(maps["products"].keys() - maps["reactants"].keys())
    changed_elements = [mark for mark in maps["reactants"].keys() & maps["products"].keys() if maps["reactants"][mark] != maps["products"][mark]]
    changes = []
    for pair in sorted(bond_maps["reactants"].keys() | bond_maps["products"].keys()):
        before, after = bond_maps["reactants"].get(pair, 0), bond_maps["products"].get(pair, 0)
        if before != after:
            changes.append({"atom_maps": list(pair), "before_order": before, "after_order": after})
    return {**sides, "balanced": not any(residuals.values()), "composition_residuals": residuals,
        "mapping": {"provided": bool(maps["reactants"] or maps["products"]), "missing_in_products": missing_product,
            "missing_in_reactants": missing_reactant, "element_or_isotope_changes": changed_elements,
            "consistent": not (missing_product or missing_reactant or changed_elements), "bond_changes": changes},
        "warnings": ["Only supplied atom maps are inspected; no atom-mapping prediction was performed.",
            "Agents in the middle field are excluded from the reactant/product balance. Geometry is generated independently on each side.",
            "Balanced composition and mapped bond changes do not establish a reaction mechanism, transition state or feasibility."]}


def parse_xyz_trajectory(data: dict) -> dict:
    from rdkit import Chem
    obj(data, "input", {"xyz", "frame_interval_fs"})
    source = text(data.get("xyz"), "xyz", 1_500_000)
    interval = number(data.get("frame_interval_fs", 1), "frame_interval_fs", 1e-9, 1e9)
    lines, position, frames, elements = source.splitlines(), 0, [], None
    table = Chem.GetPeriodicTable()
    known = {table.GetElementSymbol(i) for i in range(1, 119)}
    while position < len(lines):
        if not lines[position].strip():
            position += 1
            continue
        try:
            count = int(lines[position].strip())
        except ValueError:
            fail("INVALID_XYZ", f"Expected an atom count on line {position + 1}")
        integer(count, "atom count", 1, 500)
        if position + count + 2 > len(lines):
            fail("INVALID_XYZ", "Truncated XYZ frame")
        comment, atoms = lines[position + 1], []
        for line in lines[position + 2:position + count + 2]:
            fields = line.split()
            if len(fields) < 4 or fields[0] not in known:
                fail("INVALID_XYZ", "Each atom requires a valid element and three coordinates")
            try:
                xyz = [float(v) for v in fields[1:4]]
            except ValueError:
                fail("INVALID_XYZ", "XYZ coordinates must be numeric")
            xyz = [number(v, "coordinate in angstrom", -1e6, 1e6) for v in xyz]
            atoms.append(dict(zip(("element", "x", "y", "z"), [fields[0], *xyz])))
        current = [a["element"] for a in atoms]
        if elements is not None and current != elements:
            fail("XYZ_ATOM_IDENTITY", "Atom count, order and elements must remain the same across trajectory frames")
        elements = current
        frames.append({"index": len(frames), "time_fs": len(frames) * interval, "comment": comment, "atoms": atoms})
        if len(frames) > 500 or len(frames) * count > 100000:
            fail("TRAJECTORY_LIMIT", "Trajectory is limited to 500 frames and 100000 total atom records")
        position += count + 2
    if not frames:
        fail("INVALID_XYZ", "No complete XYZ frame found")
    return {"kind": "provided-xyz-trajectory", "frames": frames, "atom_count": len(elements), "frame_count": len(frames),
        "frame_interval_fs": interval, "composition": dict(Counter(elements)), "source_sha256": hashlib.sha256(source.encode()).hexdigest(),
        "warnings": ["Coordinates are preserved from the supplied file. The parser does not infer simulation method or validate physical dynamics.",
            "XYZ has no bond topology; a viewer may infer connectivity for display only. Time is assigned from the supplied frame interval."]}


def legacy_operator(operator: str, data: dict) -> dict:
    # The source snapshot remains immutable; only its public pure functions are used.
    source_root = Path(os.environ.get("CHEM_SCIENCE_SOURCE_ROOT", Path(__file__).resolve().parent.parent / "chem-workbench"))
    manifest_path = source_root / "snapshot-manifest.json"
    if not manifest_path.is_file():
        fail("SOURCE_UNAVAILABLE", "The original Chem source snapshot manifest is missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    for relative, entry in manifest["files"].items():
        component = source_root / relative
        if not component.is_file() or hashlib.sha256(component.read_bytes()).hexdigest() != entry["sha256"]:
            fail("SOURCE_INTEGRITY", "Original Chem source snapshot differs from its manifest", {"file": relative})
    from chem_workbench.design_candidates import organic_candidates, inorganic_candidates
    if operator == "organic_candidates":
        return organic_candidates(data)
    if operator == "inorganic_candidates":
        return inorganic_candidates(data)
    from chem_workbench.interface_simulation import illustrative_interface_spec, simulate_interface
    obj(data, "input", {"profile", "organic_spec", "inorganic_spec", "spec"})
    organic = organic_candidates(data.get("organic_spec", {"max_candidates": 1}))["candidates"]
    inorganic = inorganic_candidates(data.get("inorganic_spec", {"max_candidates": 1}))["candidates"]
    if not organic or not inorganic:
        fail("NO_CANDIDATE", "Interface calculations require at least one organic and inorganic candidate")
    spec = data.get("spec") or illustrative_interface_spec(data.get("profile", "electrode_electrolyte"), organic[0], inorganic[0])
    return simulate_interface(spec, organic[0], inorganic[0])


def catalog() -> dict:
    def schema(properties, required=()):
        return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}
    n = lambda low, high, description="": {"type": "number", "minimum": low, "maximum": high, "description": description}
    st = {"type": "string"}
    composition = {"type": "object", "additionalProperties": {"type": "integer", "minimum": 0, "maximum": 10000}}
    species = schema({"id": {"type": "string", "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"}, "label": st, "smiles": st,
        "initial_concentration": n(0, 1e6, "mol/L; bound sites use the same volume basis"), "composition": composition,
        "formal_charge": {"type": "integer", "minimum": -100, "maximum": 100}}, ["id", "initial_concentration"])
    terms = {"type": "object", "minProperties": 1, "additionalProperties": {"type": "integer", "minimum": 1, "maximum": 6}}
    reaction = schema({"id": st, "reactants": terms, "products": terms, "rate_constant": n(0, 1e12, "At reference temperature; unit (mol/L)^(1-order)/s"),
        "activation_energy_j_mol": n(-500000, 500000), "reference_temperature_k": n(1, 5000)}, ["id", "reactants", "products", "rate_constant"])
    network = schema({"label": st, "species": {"type": "array", "items": species, "minItems": 1, "maxItems": 16},
        "reactions": {"type": "array", "items": reaction, "minItems": 1, "maxItems": 24}, "provenance": st}, ["species", "reactions"])
    sim = {"network": network, "example": {"type": "string", "enum": ["reversible", "consecutive", "parallel", "catalytic", "interface"]},
        "duration_s": n(1e-9, 1e7), "points": {"type": "integer", "minimum": 2, "maximum": 1001}, "temperature_k": n(1, 5000)}
    observations = schema({"time_s": {"type": "array", "items": n(0, 1e7), "minItems": 3, "maxItems": 201},
        "concentrations": {"type": "object", "additionalProperties": {"type": "array", "items": n(0, 1e6)}}}, ["time_s", "concentrations"])
    organic = schema({"scaffold_id": {"type": "string", "enum": ["catechol_amide", "carboxylate_amide", "pyridyl_amide", "custom"]},
        "scaffold_smiles": st, "fragment_ids": {"type": "array", "items": st}, "fragments": {"type": "array", "items": st},
        "max_candidates": {"type": "integer", "minimum": 1, "maximum": 24}, "ranking": {"type": "string", "enum": ["balanced_polarity", "low_logp", "high_tpsa"]},
        "filters": {"type": "object", "additionalProperties": {"type": "number"}}, "source": st})
    inorganic = schema({"a_elements": {"type": "array", "items": {"enum": ["Ca", "Sr", "Ba"]}},
        "b_pairs": {"type": "array", "items": {"type": "array", "items": st, "minItems": 2, "maxItems": 2}},
        "max_candidates": {"type": "integer", "minimum": 1, "maximum": 24}, "tolerance_target": n(.8, 1.1), "source": st})
    operator_specs = [
        ("simulate_reaction_network", "Reaction network simulation", "kinetics", "Integrate an editable mass-action network; concentrations, rates, conversion, balance and a 3D population scene.", schema(sim), {"example": "reversible", "duration_s": 30, "points": 121}, "SciPy / RDKit", ["scipy", "rdkit"]),
        ("scan_reaction_temperature", "Temperature sweep", "kinetics", "Compare rate constants and concentration curves across supplied temperatures using declared activation energies.", schema({**{k:v for k,v in sim.items() if k != "temperature_k"}, "temperatures_k": {"type": "array", "items": n(1, 5000), "minItems": 2, "maxItems": 16}}, ["temperatures_k"]), {"example": "parallel", "temperatures_k": [288.15, 298.15, 308.15], "duration_s": 30}, "SciPy", ["scipy", "rdkit"]),
        ("fit_reaction_rates", "Fit kinetic rate constants", "kinetics", "Fit up to four positive rate constants to measured time-series; report residuals and local identifiability.", schema({**{k:v for k,v in sim.items() if k not in {"duration_s", "points"}}, "observations": observations,
            "fit_reaction_ids": {"type": "array", "items": st, "minItems": 1, "maxItems": 4}, "max_evaluations": {"type": "integer", "minimum": 5, "maximum": 200}}, ["observations"]),
            {"example": "reversible", "fit_reaction_ids": ["forward", "reverse"], "observations": {"time_s": [0, 5, 10, 20], "concentrations": {"A": [1, .525909581, .351501462, .263736729]}}}, "SciPy", ["scipy", "rdkit"]),
        ("analyze_molecule", "Molecule descriptors and 3D", "molecules", "Parse SMILES, calculate descriptors and generate a seeded ETKDG conformer with local force-field relaxation.", schema({"smiles": st}, ["smiles"]), {"smiles": "CC(=O)Oc1ccccc1C(=O)O"}, "RDKit", ["rdkit"]),
        ("compare_molecules", "Molecule similarity and changes", "molecules", "Compare Morgan fingerprints, Murcko scaffolds, maximum common substructure and descriptor changes.", schema({"original_smiles": st, "proposed_smiles": st}, ["original_smiles", "proposed_smiles"]), {"original_smiles": "c1ccccc1", "proposed_smiles": "Oc1ccccc1"}, "OpenScience procedure / RDKit", ["rdkit"]),
        ("inspect_reaction_smiles", "Reaction composition and mapping", "molecules", "Inspect supplied reaction SMILES atom maps, elemental/charge balance, bond changes and 3D structures on both sides.", schema({"reaction_smiles": st}, ["reaction_smiles"]), {"reaction_smiles": "[CH3:1][CH2:2][OH:3]>>[CH3:1][CH2:2][OH:3]"}, "RDKit", ["rdkit"]),
        ("parse_xyz_trajectory", "Import XYZ trajectory", "trajectories", "Parse a supplied multi-frame XYZ trajectory with stable atom identities; preserve coordinates and source hash.", schema({"xyz": st, "frame_interval_fs": n(1e-9, 1e9)}, ["xyz"]), {"xyz": "3\nwater frame 0\nO 0 0 0\nH 0.96 0 0\nH -0.24 0.93 0\n3\nwater frame 1\nO 0.01 0 0\nH 0.97 0 0\nH -0.23 0.93 0\n", "frame_interval_fs": 1}, "XYZ / RDKit element table", ["rdkit"]),
        ("organic_candidates", "Organic candidate screening", "molecules", "Reuse the original scaffold substitution, descriptors, filters and deterministic ranking.", organic, {"scaffold_id": "catechol_amide", "max_candidates": 4}, "Chem snapshot / RDKit", ["rdkit"]),
        ("inorganic_candidates", "Ordered oxide screening", "materials", "Reuse ordered A2BB'O6 construction, charge balance and ionic geometry screening.", inorganic, {"a_elements": ["Ca", "Sr"], "b_pairs": [["Mg", "W"]], "max_candidates": 2}, "Chem snapshot / pymatgen", ["pymatgen"]),
        ("simulate_interface", "Candidate-bound interface model", "interfaces", "Run one of the original electrode/electrolyte, catalyst/reactant or solid/liquid ODE models with candidate provenance.", schema({"profile": {"type": "string", "enum": ["electrode_electrolyte", "catalyst_reactant", "solid_liquid"]}, "organic_spec": organic, "inorganic_spec": inorganic, "spec": {"type": "object"}}), {"profile": "electrode_electrolyte"}, "Chem snapshot / SciPy", ["scipy", "rdkit", "pymatgen"]),
    ]
    for module in extensions():
        operator_specs.extend(module.operator_specs(sim) if module.__name__ in {"chem_reactions", "chem_coupled_reactions", "chem_network_reactors"} else module.operator_specs())
    installed = dependencies()
    operators = []
    for key, title, category, description, input_schema, example_input, source, required in operator_specs:
        missing = [name for name in required if installed.get(name) in (None, "unavailable")]
        workspace = "statistics" if category == "statistics" else "analysis" if category in {"analysis", "kinetics", "interfaces"} else "chemical-data"
        operators.append({"id": key, "title": title, "category": category, "description": description, "input_schema": input_schema,
            "example_input": example_input, "source": source, "available": not missing, "workspace": workspace,
            **({"unavailable_reason": "Missing Python packages: " + ", ".join(missing)} if missing else {})})
    return {"version": VERSION, "operators": operators,
        "examples": [{"id": key, "title": key.capitalize(), "input": {"network": example_network(key), "duration_s": 30, "points": 121, "temperature_k": 298.15}} for key in ["reversible", "consecutive", "parallel", "catalytic", "interface"]],
        "runtime": installed}


OPERATORS = {"analyze_molecule": analyze_molecule, "compare_molecules": compare_molecules, "simulate_reaction_network": simulate_reaction_network,
    "scan_reaction_temperature": scan_reaction_temperature, "fit_reaction_rates": fit_reaction_rates,
    "inspect_reaction_smiles": inspect_reaction_smiles, "parse_xyz_trajectory": parse_xyz_trajectory}


def execute(request: Any) -> dict:
    operator = request.get("operator", "") if isinstance(request, dict) else ""
    provenance = {"worker_version": VERSION, "dependencies": dependencies(), **source_provenance()}
    try:
        provenance["input_sha256"] = digest(request)
        obj(request, "request", {"operator", "input"})
        operator = text(request.get("operator"), "operator", 80)
        data = obj(request.get("input", {}), "input")
        if operator == "catalog":
            result = catalog()
        elif operator in OPERATORS:
            result = OPERATORS[operator](data)
        elif operator in {"organic_candidates", "inorganic_candidates", "simulate_interface"}:
            result = legacy_operator(operator, data)
        else:
            handler = next((module.OPERATORS[operator] for module in extensions() if operator in module.OPERATORS), None)
            if handler is None:
                fail("UNKNOWN_OPERATOR", "Unknown chemistry operator: " + operator)
            result = handler(data)
        provenance["result_sha256"] = digest(result)
        return {"ok": True, "operator": operator, "result": result, "provenance": provenance}
    except ScienceError as exc:
        return {"ok": False, "operator": operator, "error": {"code": exc.code, "message": str(exc), **({"details": exc.details} if exc.details is not None else {})}, "provenance": provenance}
    except (ImportError, ModuleNotFoundError) as exc:
        return {"ok": False, "operator": operator, "error": {"code": "DEPENDENCY_UNAVAILABLE", "message": str(exc)}, "provenance": provenance}
    except (ValueError, KeyError, TypeError, ArithmeticError, RuntimeError) as exc:
        return {"ok": False, "operator": operator, "error": {"code": getattr(exc, "code", "SCIENTIFIC_INPUT_ERROR"), "message": str(exc),
            **({"details": exc.details} if getattr(exc, "details", None) is not None else {})}, "provenance": provenance}


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    # Resolve only the packaged adjacent immutable source; callers may also set PYTHONPATH.
    source_root = Path(os.environ.get("CHEM_SCIENCE_SOURCE_ROOT", Path(__file__).resolve().parent.parent / "chem-workbench")) / "src"
    if source_root.is_dir():
        sys.path.insert(0, str(source_root))
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    try:
        if len(raw) > MAX_INPUT_BYTES:
            fail("INPUT_LIMIT", "Worker input exceeds 2 MB")
        request = json.loads(raw.decode("utf-8-sig"), parse_constant=lambda value: fail("INVALID_JSON", "Non-finite JSON values are forbidden"))
        # Legacy libraries may log on stdout; keep stdout reserved for the JSON envelope.
        with contextlib.redirect_stdout(sys.stderr):
            result = execute(request)
    except (ScienceError, UnicodeError, json.JSONDecodeError) as exc:
        result = {"ok": False, "operator": "", "error": {"code": getattr(exc, "code", "INVALID_JSON"), "message": str(exc)},
            "provenance": {"worker_version": VERSION, "input_sha256": hashlib.sha256(raw).hexdigest(), "dependencies": dependencies(),
                **source_provenance()}}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
