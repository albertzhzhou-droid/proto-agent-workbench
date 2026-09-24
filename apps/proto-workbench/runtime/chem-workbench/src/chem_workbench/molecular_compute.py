"""Bounded organic HF/STO-3G proposals with explicit state and generated geometry.

Proposal generation performs no energy calculation. The generated conformer is
an engineering input, never a replacement for missing measured coordinates.
"""

from __future__ import annotations

import copy
import importlib
import json
import math
from decimal import Decimal
from typing import Any

from chem_workbench.chemir.constraints import canonical_decimal
from chem_workbench.compiler import CompilationResult
from chem_workbench.visualization import content_hash, geometry_for_object

MOLECULAR_PROFILE = "qcengine.psi4.hf_sto3g.organic.v1"
MOLECULAR_ELEMENTS = frozenset({"H", "C", "N", "O", "F", "S", "Cl"})
# Verified against the installed QCEElemental conversion constant; bound into each plan.
ANGSTROM_TO_BOHR = "1.8897261254578281"
SCF_SETTINGS = {
    "reference": "rhf",
    "scf_type": "pk",
    "e_convergence": 1e-8,
    "d_convergence": 1e-8,
    "maxiter": 100,
    "fail_on_maxiter": True,
}
FEATURE_PATTERNS = {
    "carboxylic_acid": "[CX3](=O)[OX2H1]",
    "ester": "[CX3](=O)[OX2H0][#6]",
    "amide": "[#6X3](=[OX1])[#7]",
    "amine": "[NX3;!$(N-C=O);!$(N=*)]",
    "alcohol": "[CX4][OX2H1]",
    "phenol": "[c][OX2H1]",
    "ether": "[#6][OX2H0;!$(O-C=O)][#6]",
    "ketone": "[#6][CX3](=O)[#6]",
    "aldehyde": "[CX3H1](=O)[#6]",
    "nitrile": "[CX2]#[NX1]",
    "sulfone": "[SX4](=O)(=O)",
    "sulfoxide": "[SX3](=O)",
    "thiol": "[SX2H1]",
    "thioether": "[#6][SX2H0][#6]",
}


def _chemistry() -> Any:
    return importlib.import_module("rdkit.Chem")


def _molecule(smiles: str) -> Any:
    chemistry = _chemistry()
    molecule = chemistry.MolFromSmiles(smiles)
    if molecule is None or len(chemistry.GetMolFrags(molecule)) != 1:
        raise ValueError("UNSUPPORTED_PROFILE: one valid connected molecule is required")
    if any(a.GetSymbol() not in MOLECULAR_ELEMENTS for a in molecule.GetAtoms()):
        raise ValueError("UNSUPPORTED_PROFILE: organic profile admits H C N O F S Cl only")
    if not any(a.GetSymbol() == "C" for a in molecule.GetAtoms()):
        raise ValueError("UNSUPPORTED_PROFILE: this profile requires an organic molecule")
    if not 8 <= molecule.GetNumHeavyAtoms() <= 32:
        raise ValueError("UNSUPPORTED_PROFILE: organic profile requires 8-32 heavy atoms")
    if chemistry.GetFormalCharge(molecule) != 0 or any(
        a.GetNumRadicalElectrons() or a.GetIsotope() for a in molecule.GetAtoms()
    ):
        raise ValueError("UNSUPPORTED_PROFILE: neutral closed-shell, unlabeled atoms required")
    if any(
        info.specified == chemistry.StereoSpecified.Unspecified
        for info in chemistry.FindPotentialStereo(molecule)
    ):
        raise ValueError("NEEDS_INPUT: specify all potential molecular stereochemistry")
    expanded = chemistry.AddHs(molecule)
    if expanded.GetNumAtoms() > 120:
        raise ValueError("UNSUPPORTED_PROFILE: at most 120 atoms including hydrogen")
    if sum(a.GetAtomicNum() for a in expanded.GetAtoms()) % 2:
        raise ValueError("UNSUPPORTED_PROFILE: the closed-shell profile requires even electrons")
    return molecule


def _complexity(molecule: Any) -> dict[str, Any]:
    chemistry = _chemistry()
    substantive = sorted(
        name
        for name, pattern in FEATURE_PATTERNS.items()
        if molecule.HasSubstructMatch(chemistry.MolFromSmarts(pattern))
    )
    features = list(substantive)
    if any(a.GetIsAromatic() for a in molecule.GetAtoms()):
        features.append("aromatic_ring")
    if any(a.GetIsAromatic() and a.GetAtomicNum() not in {1, 6} for a in molecule.GetAtoms()):
        features.append("heteroaromatic_ring")
    if any(a.IsInRing() and not a.GetIsAromatic() for a in molecule.GetAtoms()):
        features.append("aliphatic_ring")
    if any(a.GetSymbol() in {"F", "Cl"} for a in molecule.GetAtoms()):
        features.append("organic_halide")
    scaffold = importlib.import_module("rdkit.Chem.Scaffolds.MurckoScaffold")
    scaffold_smiles = scaffold.MurckoScaffoldSmiles(mol=molecule, includeChirality=True)
    return {
        "heavy_atoms": molecule.GetNumHeavyAtoms(),
        "total_atoms": chemistry.AddHs(molecule).GetNumAtoms(),
        "structural_feature_classes": sorted(set(features)),
        "substantive_functional_groups": substantive,
        "murcko_scaffold_smiles": scaffold_smiles,
        "promotion_complexity_eligible": bool(len(set(features)) >= 2 and substantive),
        "scope": "Per-molecule rubric only; a dataset needs separate scaffold-family review",
    }


def molecular_preflight(snapshot: CompilationResult, object_id: str) -> dict[str, Any]:
    """Cheap chemical/state checks for model context, without conformer or energy work."""
    if not snapshot.success or snapshot.document is None:
        raise ValueError("NEEDS_INPUT: compile valid source before molecular planning")
    objects = snapshot.document["objects"]
    obj = next((item for item in objects if item["id"] == object_id), None)
    if obj is None or obj["kind"] != "Molecule":
        raise ValueError("UNSUPPORTED_PROFILE: select one compiled molecular object")
    representations = obj["payload"].get("representations", [])
    if (
        len(representations) != 1
        or representations[0].get("format") != "smiles"
        or not isinstance(representations[0].get("value"), str)
    ):
        raise ValueError("NEEDS_INPUT: exactly one explicit SMILES representation is required")
    smiles = representations[0]["value"]
    molecule = _molecule(smiles)
    linked = [x for x in objects if x["payload"].get("target_reference") == object_id]
    grouped = {
        kind: [x for x in linked if x["kind"] == kind]
        for kind in ("ElectronicState", "ConditionSet", "CalculationSpec")
    }
    if any(len(items) != 1 for items in grouped.values()):
        raise ValueError(
            "NEEDS_INPUT: exactly one explicit electronic state, condition set "
            "and calculation required"
        )
    state, conditions, calculation = (grouped[k][0] for k in grouped)
    if state["payload"] != {
        "target_reference": object_id,
        "model": "finite",
        "charge": 0,
        "multiplicity": 1,
    }:
        raise ValueError("UNSUPPORTED_PROFILE: finite neutral singlet state required")
    if conditions["payload"] != {
        "target_reference": object_id,
        "phase": "gas",
        "temperature": {"value": 0, "unit": "kelvin"},
    }:
        raise ValueError(
            "UNSUPPORTED_PROFILE: only the isolated gas-phase zero-kelvin profile is admitted"
        )
    payload = calculation["payload"]
    normalized = copy.deepcopy(payload)
    for key in ("method", "basis"):
        named = normalized.get(key)
        if isinstance(named, dict) and isinstance(named.get("name"), str):
            named["name"] = named["name"].lower()
    if normalized != {
        "target_reference": object_id,
        "task": "single_point",
        "properties": ["energy"],
        "method": {"name": "hf"},
        "basis": {"name": "sto-3g"},
        "electronic_state_reference": state["id"],
        "conditions_reference": conditions["id"],
    }:
        raise ValueError(
            "UNSUPPORTED_PROFILE: explicitly linked HF/STO-3G single-point energy required"
        )
    bound_objects = [copy.deepcopy(x) for x in (obj, state, conditions, calculation)]
    if any("source:" + snapshot.source_sha256 not in x["source_references"] for x in bound_objects):
        raise ValueError("SOURCE_MISMATCH: molecular declarations do not share source provenance")
    declared = {
        "electronic_state": copy.deepcopy(state["payload"]),
        "conditions": copy.deepcopy(conditions["payload"]),
        "calculation": copy.deepcopy(payload),
    }
    return {
        "object_id": object_id,
        "subject_ref": object_id,
        "subject_hash": content_hash(obj),
        "source_hash": snapshot.source_sha256,
        "source_semantic_hash": snapshot.semantic_hash,
        "source_objects": bound_objects,
        "smiles": smiles,
        "canonical_smiles": _chemistry().MolToSmiles(molecule, isomericSmiles=True),
        "declared_state": declared,
        "linked_state_hash": content_hash(bound_objects[1:]),
        "complexity": _complexity(molecule),
        "method_profile_id": MOLECULAR_PROFILE,
    }


def molecular_proposal(snapshot: CompilationResult, object_id: str) -> dict[str, Any]:
    """Generate one deterministic conformer for explicit review, never a computed energy."""
    metadata = molecular_preflight(snapshot, object_id)
    scene = geometry_for_object(metadata["source_objects"][0], snapshot.source_sha256)
    geometry = {
        "atoms": [
            [atom["element"], *(canonical_decimal(str(x)) for x in atom["position"])]
            for atom in scene["atoms"]
        ],
        "charge": 0,
        "multiplicity": 1,
        "units": "angstrom",
    }
    proposal = {
        "version": "molecular-proposal/v1",
        "status": "draft_not_executable",
        **metadata,
        "geometry": geometry,
        "geometry_hash": content_hash(geometry),
        "geometry_provenance": {
            "kind": "tool_generated",
            "method": scene["method"],
            "seed": 42,
            "source_hash": snapshot.source_sha256,
            "subject_hash": metadata["subject_hash"],
            "measured": False,
            "optimized": False,
        },
        "execution_authorized": False,
        "limitations": [
            "Generated conformer, not measured coordinates; review geometry before approval.",
            "Fixed-geometry RHF/STO-3G energy only; no geometry optimization or solvent.",
            "SCF convergence is not proof of physical accuracy, a stable state or suitability.",
        ],
    }
    proposal["logical_plan_hash"] = content_hash(proposal)
    return proposal


def validate_molecular_proposal(proposal: Any) -> None:
    """Reconstruct all metadata and generated coordinates before admitting execution."""
    if not isinstance(proposal, dict) or proposal.get("version") != "molecular-proposal/v1":
        raise ValueError("INVALID_ARGUMENT: expected a molecular-proposal/v1 record")
    try:
        snapshot = CompilationResult(
            document={"objects": proposal["source_objects"]},
            diagnostics=(),
            source_sha256=proposal["source_hash"],
            semantic_hash=proposal["source_semantic_hash"],
            artifact_bytes=None,
        )
        expected = molecular_proposal(snapshot, proposal["object_id"])
    except (KeyError, TypeError, AttributeError, IndexError) as error:
        raise ValueError("INVALID_ARGUMENT: malformed molecular source binding") from error
    if proposal != expected:
        raise ValueError("APPROVAL_STALE: molecular geometry, state or source binding changed")


def _validate_qc_molecule(molecule: Any, geometry: dict[str, Any]) -> None:
    if not isinstance(molecule, dict) or (
        molecule.get("symbols") != [a[0] for a in geometry["atoms"]]
        or type(molecule.get("molecular_charge")) not in {int, float}
        or molecule["molecular_charge"] != 0
        or type(molecule.get("molecular_multiplicity")) is not int
        or molecule["molecular_multiplicity"] != 1
        or molecule.get("fix_com") is not True
        or molecule.get("fix_orientation") is not True
    ):
        raise ValueError("INVALID_TOOL_OUTPUT: QCSchema molecular identity or state differs")
    actual = molecule.get("geometry")
    expected = [float(c) * float(ANGSTROM_TO_BOHR) for atom in geometry["atoms"] for c in atom[1:]]
    if (
        not isinstance(actual, list)
        or len(actual) != len(expected)
        or any(
            type(value) not in {int, float}
            or not math.isfinite(value)
            or abs(value - wanted) > 1e-7
            for value, wanted in zip(actual, expected, strict=True)
        )
    ):
        raise ValueError("INVALID_TOOL_OUTPUT: computed coordinates differ from the approved input")


def validate_molecular_result(plan: dict[str, Any], response: dict[str, Any]) -> dict[str, Any]:
    """Verify input/state/energy agreement; preserve backend nonconvergence as failure."""
    from chem_workbench.execution_validation import number

    if (
        response.get("input_binding_hash") != plan["prepared_input_hash"]
        or response.get("geometry_hash") != plan["subject"]["geometry_hash"]
    ):
        raise ValueError("INVALID_TOOL_OUTPUT: molecular input provenance differs")
    try:
        raw_input = json.loads(response["raw_input"])
        raw_result = json.loads(response["raw_result"])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("INVALID_TOOL_OUTPUT: missing molecular QCSchema evidence") from error
    if not isinstance(raw_input, dict) or not isinstance(raw_result, dict):
        raise ValueError("INVALID_TOOL_OUTPUT: malformed molecular QCSchema evidence")
    if (
        raw_input.get("driver") != "energy"
        or raw_input.get("model") != {"method": "hf", "basis": "sto-3g"}
        or raw_input.get("keywords") != SCF_SETTINGS
    ):
        raise ValueError("INVALID_TOOL_OUTPUT: molecular calculation settings differ")
    geometry = plan["subject"]["proposal"]["geometry"]
    _validate_qc_molecule(raw_input.get("molecule"), geometry)
    if response.get("success") is False:
        if (
            raw_result.get("success") is not False
            or response.get("energy_hartree") is not None
            or response.get("convergence") not in {"not_converged", "failed"}
            or not isinstance(response.get("error"), dict)
        ):
            raise ValueError("INVALID_TOOL_OUTPUT: contradictory molecular failure record")
        return {
            "execution_status": "failed",
            "evidence_eligible": False,
            "property": "energy_hartree",
            "success": False,
            "convergence": response["convergence"],
            "error": response["error"],
            "summary": "Molecular SCF did not produce an accepted converged energy",
        }
    if (
        response.get("success") is not True
        or response.get("convergence") != "converged"
        or raw_result.get("success") is not True
        or raw_result.get("model") != raw_input["model"]
        or raw_result.get("driver") != "energy"
        or raw_result.get("keywords") != SCF_SETTINGS
        or response.get("error") is not None
    ):
        raise ValueError("INVALID_TOOL_OUTPUT: molecular convergence or method is inconsistent")
    _validate_qc_molecule(raw_result.get("molecule"), geometry)
    energy = response.get("energy_hartree")
    value = number(energy, "100000")
    assert isinstance(energy, str)
    if value >= 0 or canonical_decimal(energy) != energy:
        raise ValueError("INVALID_TOOL_OUTPUT: canonical finite negative molecular energy required")
    for raw_energy in (
        raw_result.get("return_result"),
        raw_result.get("properties", {}).get("return_energy"),
    ):
        if (
            isinstance(raw_energy, bool)
            or not isinstance(raw_energy, (int, float))
            or not math.isfinite(raw_energy)
            or abs(Decimal(str(raw_energy)) - value) > Decimal("1e-9")
        ):
            raise ValueError(
                "INVALID_TOOL_OUTPUT: QCSchema and reported molecular energies disagree"
            )
    return {
        "property": "energy_hartree",
        "energy_hartree": energy,
        "success": True,
        "convergence": "converged",
        "geometry_provenance": plan["subject"]["proposal"]["geometry_provenance"],
        "scientific_scope": (
            "Generated-geometry RHF/STO-3G single point; no optimization or accuracy claim"
        ),
    }
