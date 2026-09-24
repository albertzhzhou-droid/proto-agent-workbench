"""Source-bound display geometry; never a scientific claim or execution permit."""

from __future__ import annotations

import hashlib
import importlib
import itertools
import json
import math
from typing import Any

from chem_workbench.compiler import CompilationResult, compile_source

MAX_ATOMS = 256
MAX_UI_SOURCE = 200_000


def content_hash(value: object) -> str:
    data = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    return "sha256:" + hashlib.sha256(data).hexdigest()


def compile_snapshot(source: str, attachments: object = None) -> CompilationResult:
    """Resolve only explicitly supplied bytes, never source-authored host paths."""
    if len(source.encode("utf-8")) > MAX_UI_SOURCE:
        raise ValueError("SOURCE_LIMIT: editor source exceeds 200 KB")
    if attachments is None:
        attachments = {}
    if not isinstance(attachments, dict) or len(attachments) > 8:
        raise ValueError("ATTACHMENT_LIMIT: at most eight named CIF attachments")
    if any(not isinstance(k, str) or not isinstance(v, str) for k, v in attachments.items()):
        raise ValueError("INVALID_ATTACHMENT: expected text file names and content")
    if sum(len(v.encode("utf-8")) for v in attachments.values()) > MAX_UI_SOURCE:
        raise ValueError("ATTACHMENT_LIMIT: attachment content exceeds 200 KB")
    byte_map = {k: v.encode("utf-8") for k, v in attachments.items()}
    return compile_source(
        source, "workbench.chem", import_resolver=byte_map.get if byte_map else None
    )


def _molecule(obj: dict[str, Any]) -> dict[str, Any]:
    chemistry = importlib.import_module("rdkit.Chem")
    conformers = importlib.import_module("rdkit.Chem.AllChem")
    rdkit = importlib.import_module("rdkit")
    representations = obj["payload"].get("representations", [])
    smiles = next((r["value"] for r in representations if r["format"] == "smiles"), None)
    if not isinstance(smiles, str) or len(smiles) > 2048:
        raise ValueError("VIEW_UNSUPPORTED: this molecular viewer requires bounded SMILES")
    molecule = chemistry.MolFromSmiles(smiles)
    if molecule is None:
        raise ValueError("INVALID_STRUCTURE: RDKit rejected the SMILES")
    if molecule.GetNumAtoms() > 64:
        raise ValueError("ATOM_LIMIT: molecular preview is limited to 64 heavy atoms")
    if len(chemistry.GetMolFrags(molecule)) != 1:
        raise ValueError("VIEW_UNSUPPORTED: disconnected fragments require separate geometry")
    molecule = chemistry.AddHs(molecule)
    if molecule.GetNumAtoms() > MAX_ATOMS:
        raise ValueError("ATOM_LIMIT: expanded geometry exceeds the viewer limit")
    settings = conformers.ETKDGv3()
    settings.randomSeed = 42
    settings.maxIterations = 200
    settings.numThreads = 1
    if conformers.EmbedMolecule(molecule, settings) != 0:
        raise ValueError("GEOMETRY_FAILED: no conformer generated within the iteration limit")
    atoms = []
    positions = molecule.GetConformer()
    for index, atom in enumerate(molecule.GetAtoms()):
        point = positions.GetAtomPosition(index)
        atoms.append(
            {
                "id": f"atom-{index + 1}",
                "element": atom.GetSymbol(),
                "position": [point.x, point.y, point.z],
            }
        )
    bonds = [
        {
            "a": bond.GetBeginAtomIdx(),
            "b": bond.GetEndAtomIdx(),
            "order": float(bond.GetBondTypeAsDouble()),
        }
        for bond in molecule.GetBonds()
    ]
    return {
        "atoms": atoms,
        "bonds": bonds,
        "cell": None,
        "unit_cell_atoms": len(atoms),
        "provenance": "tool_generated",
        "method": f"RDKit {rdkit.__version__} ETKDGv3",
        "description": "Seed 42 conformer with explicit hydrogens. Not experimental geometry; "
        "no energy optimization or electronic calculation was performed.",
    }


def _periodic(obj: dict[str, Any]) -> dict[str, Any]:
    payload = obj["payload"]
    if "lattice" not in payload or "sites" not in payload:
        raise ValueError("MISSING_COORDINATES: attach the referenced CIF and compile again")
    vectors = [[float(v) for v in row] for row in payload["lattice"]["vectors"]]
    sites = payload["sites"]
    if len(sites) * 8 > MAX_ATOMS:
        raise ValueError("ATOM_LIMIT: a 2 x 2 x 2 preview must contain at most 256 atoms")
    if any(site["occupancy"] != 1 for site in sites):
        raise ValueError("VIEW_UNSUPPORTED: partial occupancy cannot become explicit atoms")
    atoms = []
    for image in itertools.product(range(2), repeat=3):
        for site in sites:
            frac = [float(v) + offset for v, offset in zip(site["coordinates"], image, strict=True)]
            position = [sum(frac[k] * vectors[k][axis] for k in range(3)) for axis in range(3)]
            atoms.append(
                {
                    "id": f"{site['id']}@{''.join(map(str, image))}",
                    "element": site["element"],
                    "position": position,
                }
            )
    return {
        "atoms": atoms,
        "bonds": [],
        "cell": vectors,
        "unit_cell_atoms": len(sites),
        "provenance": "source_imported",
        "method": "Explicit-P1 CIF import / 2 x 2 x 2 display",
        "description": "Fractional sites converted to Cartesian angstrom coordinates. "
        "Repeated cells are display copies. No bonds, relaxation or energy are inferred.",
    }


def geometry_for_object(obj: dict[str, Any], source_hash: str) -> dict[str, Any]:
    if obj["kind"] == "Molecule":
        geometry = _molecule(obj)
    elif obj["kind"] == "PeriodicStructure":
        geometry = _periodic(obj)
    else:
        raise ValueError("VIEW_UNSUPPORTED: this declaration has no constructed coordinates")
    if any(not math.isfinite(x) for atom in geometry["atoms"] for x in atom["position"]):
        raise ValueError("INVALID_GEOMETRY: coordinates must be finite")
    geometry.update(
        {
            "version": "display-geometry/v1",
            "object_id": obj["id"],
            "kind": obj["kind"],
            "units": "angstrom",
            "source_hash": source_hash,
            "subject_hash": content_hash(obj),
            "source_references": obj["source_references"],
        }
    )
    geometry["geometry_hash"] = content_hash(geometry)
    return geometry


def scene_for_compilation(result: CompilationResult) -> dict[str, Any]:
    scenes: list[dict[str, Any]] = []
    unavailable: list[dict[str, str]] = []
    if not result.success or result.document is None:
        return {"structures": scenes, "unavailable": unavailable}
    for obj in result.document["objects"][:16]:
        if obj["kind"] in {
            "CalculationSpec",
            "ElectronicState",
            "InterfaceReactionStep",
            "ConditionSet",
        }:
            continue
        try:
            scenes.append(geometry_for_object(obj, result.source_sha256))
        except (ValueError, ImportError, RuntimeError) as error:
            unavailable.append({"object_id": obj["id"], "reason": str(error)})
    return {"structures": scenes, "unavailable": unavailable}
