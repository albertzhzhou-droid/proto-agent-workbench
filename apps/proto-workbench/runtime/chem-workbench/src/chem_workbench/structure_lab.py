"""Versioned molecular import, explicit geometry revisions and Cu(111) construction."""

from __future__ import annotations

import importlib
import json
import math
from collections import Counter
from pathlib import Path
from typing import Any

from chem_workbench.execution import ExecutionStore
from chem_workbench.execution_validation import digest_id, verify_hash
from chem_workbench.tool_gateway import object_from_snapshot
from chem_workbench.visualization import compile_snapshot, content_hash


class StructureLab:
    def __init__(self, root: Path) -> None:
        self.store = ExecutionStore(root)
        self.directory = self.store.root / "structures"
        self.directory.mkdir(exist_ok=True)

    def save(self, geometry: dict[str, Any]) -> dict[str, Any]:
        geometry["geometry_hash"] = content_hash(geometry)
        self.store._write(
            self.directory / (digest_id(geometry["geometry_hash"]) + ".json"), geometry
        )
        return geometry

    def read(self, reference: str) -> dict[str, Any]:
        path = self.directory / (digest_id(reference) + ".json")
        if not path.is_file():
            raise ValueError("STRUCTURE_NOT_FOUND")
        geometry = self.store._read(path)
        verify_hash(geometry, "geometry_hash")
        return geometry

    def import_molecule(self, content: str, format_name: str) -> dict[str, Any]:
        if not isinstance(content, str) or not 1 <= len(content) <= 200_000:
            raise ValueError("INPUT_LIMIT: molecular input must contain 1-200000 characters")
        chemistry = importlib.import_module("rdkit.Chem")
        rdkit = importlib.import_module("rdkit")
        if format_name == "sdf":
            records = [r for r in content.split("$$$$") if r.strip()]
            if len(records) != 1:
                raise ValueError("UNSUPPORTED_PROFILE: import exactly one SDF record")
            molecule = chemistry.MolFromMolBlock(
                records[0], sanitize=True, removeHs=False, strictParsing=True
            )
        elif format_name == "smiles":
            if len(content) > 2048:
                raise ValueError("INPUT_LIMIT: SMILES exceeds 2048 characters")
            molecule = chemistry.MolFromSmiles(content.strip())
        else:
            raise ValueError("UNSUPPORTED_PROFILE: supported molecular formats are SDF and SMILES")
        if molecule is None or not 1 <= molecule.GetNumAtoms() <= 64:
            raise ValueError("INVALID_STRUCTURE: toolkit rejected molecule or atom limit exceeded")
        if len(chemistry.GetMolFrags(molecule)) != 1:
            raise ValueError(
                "UNSUPPORTED_PROFILE: disconnected structures require separate records"
            )
        if any(
            a.GetAtomicNum() not in {1, 5, 6, 7, 8, 9, 14, 15, 16, 17, 35, 53}
            for a in molecule.GetAtoms()
        ):
            raise ValueError(
                "UNSUPPORTED_PROFILE: coordination and metal chemistry require another importer"
            )
        isomeric = chemistry.MolToSmiles(molecule, isomericSmiles=True)
        generated = format_name == "smiles"
        if generated:
            molecule = chemistry.AddHs(molecule)
            conformers = importlib.import_module("rdkit.Chem.AllChem")
            settings = conformers.ETKDGv3()
            settings.randomSeed, settings.maxIterations, settings.numThreads = 42, 200, 1
            if conformers.EmbedMolecule(molecule, settings) != 0:
                raise ValueError("GEOMETRY_FAILED: bounded conformer generation failed")
        if molecule.GetNumConformers() != 1:
            raise ValueError("NEEDS_INPUT: one coordinate conformer is required")
        conformer = molecule.GetConformer()
        atoms = [
            {
                "id": f"atom-{i + 1}",
                "element": a.GetSymbol(),
                "position": list(conformer.GetAtomPosition(i)),
            }
            for i, a in enumerate(molecule.GetAtoms())
        ]
        if any(not math.isfinite(v) or abs(v) > 10000 for a in atoms for v in a["position"]):
            raise ValueError("INVALID_GEOMETRY: non-finite or excessive coordinates")
        return self.save(
            {
                "version": "display-geometry/v1",
                "object_id": "imported_molecule",
                "kind": "Molecule",
                "units": "angstrom",
                "atoms": atoms,
                "bonds": [
                    {
                        "a": b.GetBeginAtomIdx(),
                        "b": b.GetEndAtomIdx(),
                        "order": float(b.GetBondTypeAsDouble()),
                    }
                    for b in molecule.GetBonds()
                ],
                "cell": None,
                "unit_cell_atoms": len(atoms),
                "provenance": "tool_generated" if generated else "source_imported",
                "method": f"RDKit {rdkit.__version__} / {format_name}",
                "isomeric_smiles": isomeric,
                "source_content": content,
                "source_hash": content_hash({"format": format_name, "content": content}),
                "description": "Seed 42 conformer; generated coordinates, no energy."
                if generated
                else "Supplied SDF coordinates preserved; not scientific validation.",
                "loss_report": {
                    "source_retained": True,
                    "stereo": "isomeric SMILES and original source retained",
                    "dimensionality": "3D" if conformer.Is3D() else "2D",
                    "added_hydrogens": generated,
                },
                "execution_authorized": False,
            }
        )

    def edit(self, reference: str, positions: object) -> dict[str, Any]:
        original = self.read(reference)
        if not isinstance(positions, list) or len(positions) != len(original["atoms"]):
            raise ValueError("INVALID_ARGUMENT: one position per existing atom is required")
        for row in positions:
            if (
                not isinstance(row, list)
                or len(row) != 3
                or any(
                    type(v) not in {int, float} or not math.isfinite(v) or abs(v) > 10000
                    for v in row
                )
            ):
                raise ValueError("INVALID_ARGUMENT: positions must be finite bounded triples")
        geometry = json.loads(json.dumps(original))
        geometry.pop("geometry_hash")
        geometry["parent_geometry_hash"] = reference
        geometry["provenance"] = "user_edited"
        geometry["description"] = (
            "Explicit coordinate revision. Composition and atom IDs retained; "
            "chemistry requires review. Previous approvals do not apply."
        )
        for atom, row in zip(geometry["atoms"], positions, strict=True):
            atom["position"] = row
        return self.save(geometry)

    def construct_copper(
        self, source: str, attachments: object, object_id: str, site: str
    ) -> dict[str, Any]:
        if site not in {"none", "ontop", "fcc"}:
            raise ValueError("UNSUPPORTED_PROFILE: choose bare Cu(111), ontop Cu or fcc Cu")
        obj = object_from_snapshot(compile_snapshot(source, attachments), object_id)
        payload = obj["payload"]
        if obj["kind"] != "PeriodicStructure" or "lattice" not in payload or "sites" not in payload:
            raise ValueError("UNSUPPORTED_PROFILE: explicit conventional FCC copper required")
        sites = payload["sites"]
        coords = {tuple(float(v) for v in s["coordinates"]) for s in sites}
        cell = [[float(v) for v in row] for row in payload["lattice"]["vectors"]]
        lattice = cell[0][0]
        if (
            len(sites) != 4
            or any(s["element"] != "Cu" or s["occupancy"] != 1 for s in sites)
            or coords != {(0, 0, 0), (0.5, 0.5, 0), (0.5, 0, 0.5), (0, 0.5, 0.5)}
            or not 3 <= lattice <= 4.5
            or any(
                abs(cell[i][j] - (lattice if i == j else 0)) > 1e-8
                for i in range(3)
                for j in range(3)
            )
        ):
            raise ValueError("UNSUPPORTED_PROFILE: conventional cubic FCC Cu parent required")
        ase = importlib.import_module("ase")
        build = importlib.import_module("ase.build")
        slab = build.fcc111("Cu", size=(2, 2, 4), a=lattice, vacuum=10, orthogonal=True)
        if site != "none":
            build.add_adsorbate(slab, "Cu", 2.0, site)
        atoms = [
            {
                "id": f"site-{i + 1}",
                "element": atom.symbol,
                "position": list(map(float, atom.position)),
            }
            for i, atom in enumerate(slab)
        ]
        return self.save(
            {
                "version": "display-geometry/v1",
                "object_id": "cu111_" + site,
                "kind": "SurfaceSlab" if site == "none" else "AdsorptionComplex",
                "units": "angstrom",
                "atoms": atoms,
                "bonds": [],
                "cell": slab.cell.array.tolist(),
                "display_repeats": 1,
                "unit_cell_atoms": len(atoms),
                "provenance": "tool_constructed",
                "method": f"ASE {ase.__version__} fcc111 / add_adsorbate",
                "parent_subject_hash": content_hash(obj),
                "source_hash": content_hash({"source": source, "attachments": attachments}),
                "settings": {
                    "size": [2, 2, 4],
                    "vacuum_angstrom": 10,
                    "site": site,
                    "height_angstrom": 2,
                    "pbc": [True, True, False],
                },
                "description": (
                    "Constructed Cu(111) geometry, fixed atoms, no relaxation or energy. "
                    "Surface convergence and scientific review remain required."
                ),
                "execution_authorized": False,
            }
        )

    def compare(self, left: str, right: str) -> dict[str, Any]:
        a, b = self.read(left), self.read(right)
        if Counter(x["element"] for x in a["atoms"]) != Counter(x["element"] for x in b["atoms"]):
            raise ValueError("INCOMPARABLE: composition differs")
        if [(x["id"], x["element"]) for x in a["atoms"]] != [
            (x["id"], x["element"]) for x in b["atoms"]
        ]:
            raise ValueError("INCOMPARABLE: explicit atom correspondence required")
        squared = [
            sum((x - y) ** 2 for x, y in zip(p["position"], q["position"], strict=True))
            for p, q in zip(a["atoms"], b["atoms"], strict=True)
        ]
        result = {
            "version": "geometry-comparison/v1",
            "left": left,
            "right": right,
            "rms_displacement_angstrom": math.sqrt(sum(squared) / len(squared)),
            "maximum_displacement_angstrom": math.sqrt(max(squared)),
            "scope": (
                "Atom-ID Cartesian correspondence; no alignment, periodic remapping, "
                "energy or stability claim"
            ),
        }
        result["comparison_hash"] = content_hash(result)
        return result
