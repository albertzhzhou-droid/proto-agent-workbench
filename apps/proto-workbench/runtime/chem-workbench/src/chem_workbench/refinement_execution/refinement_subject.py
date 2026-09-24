"""Read-only retained Design-candidate closure for host refinement planning.

Graph parsing, source compilation and byte verification only. No conformer generation,
backend import, evaluation, settings choice, approval or execution occurs here.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
from collections import Counter
from importlib.metadata import version
from pathlib import Path
from typing import Any, cast

from chem_workbench.chemir.constraints import canonical_decimal
from chem_workbench.design_records import verify_design_record
from chem_workbench.execution_validation import digest_id, verify_hash
from chem_workbench.method_profiles import artifact_ref, closed
from chem_workbench.molecular_compute import _chemistry, _molecule
from chem_workbench.molecular_refinement import seal_refinement_geometry, validate_refinement_spec
from chem_workbench.visualization import compile_snapshot, content_hash

SUBJECT_VERSION = "refinement-design-subject/v1"
MAX_ARTIFACT_BYTES = 20 * 1024 * 1024


class _NumberToken(str):
    """Distinguish a raw JSON number token from a JSON string."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError("DESIGN_REFINEMENT_SUBJECT: " + message)


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        _require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def _invalid_constant(value: str) -> None:
    raise ValueError("DESIGN_REFINEMENT_SUBJECT: nonfinite JSON constant " + value)


def _load(raw: bytes, *, tokens: bool = False) -> Any:
    options: dict[str, Any] = {
        "object_pairs_hook": _pairs,
        "parse_constant": _invalid_constant,
    }
    if tokens:
        options.update(parse_float=_NumberToken, parse_int=_NumberToken)
    return json.loads(raw.decode("utf-8"), **options)


def _read_bound(root: Path, reference: object) -> bytes:
    """Validate every path component, then authenticate the same bytes used by the parser."""
    ref = artifact_ref(reference)
    path = root
    for part in ("", *ref["path"].split("/")):
        path = path / part if part else path
        info = path.lstat()
        _require(
            not path.is_symlink() and not getattr(info, "st_file_attributes", 0) & 0x400,
            "linked artifact component",
        )
    _require(path.resolve().is_relative_to(root.resolve()) and path.is_file(), "artifact escape")
    with path.open("rb") as stream:
        raw = stream.read(MAX_ARTIFACT_BYTES + 1)
    _require(len(raw) <= MAX_ARTIFACT_BYTES, "artifact exceeds 20 MiB")
    _require(hashlib.sha256(raw).hexdigest() == ref["sha256"], "artifact bytes changed")
    return raw


def _state(value: object) -> dict[str, int]:
    state = closed(value, {"charge", "multiplicity"}, "explicit refinement electronic state")
    _require(
        type(state["charge"]) is int
        and state["charge"] == 0
        and type(state["multiplicity"]) is int
        and state["multiplicity"] == 1,
        "explicit neutral singlet declaration required",
    )
    return copy.deepcopy(state)


def _graph(candidate: dict[str, Any]) -> dict[str, Any]:
    """Reconstruct bonds in retained atom order, never embed or infer bonds from distances."""
    chem = _chemistry()
    molecule = _molecule(candidate["canonical_smiles"])
    canonical = chem.MolToSmiles(molecule, canonical=True, isomericSmiles=True)
    _require(canonical == candidate["canonical_smiles"], "noncanonical candidate molecular graph")
    # The old display bond schema has no stereotags. This first bridge cannot prove
    # stereochemical correspondence of a specified chiral/E-Z graph to those atoms.
    _require(
        not list(chem.FindPotentialStereo(molecule)), "stereochemical atom mapping unsupported"
    )
    _require(
        all(atom.GetFormalCharge() == 0 for atom in molecule.GetAtoms()),
        "charged atom mapping unsupported",
    )
    atoms = candidate["geometry"]["atoms"]
    _require(
        Counter(atom.GetSymbol() for atom in chem.AddHs(molecule).GetAtoms())
        == Counter(atom["element"] for atom in atoms),
        "explicit hydrogen or element inventory differs from graph",
    )
    retained = chem.RWMol()
    for row in atoms:
        atom = chem.Atom(row["element"])
        atom.SetNoImplicit(True)
        retained.AddAtom(atom)
    bonds = candidate["geometry"]["bonds"]
    _require(isinstance(bonds, list) and len(bonds) <= 4 * len(atoms), "invalid bond inventory")
    types = {
        1: chem.BondType.SINGLE,
        1.5: chem.BondType.AROMATIC,
        2: chem.BondType.DOUBLE,
        3: chem.BondType.TRIPLE,
    }
    pairs: set[tuple[int, int]] = set()
    for bond in bonds:
        bond = closed(bond, {"a", "b", "order"}, "retained bond")
        a, b, order = bond["a"], bond["b"], bond["order"]
        _require(
            type(a) is int
            and type(b) is int
            and 0 <= a < len(atoms)
            and 0 <= b < len(atoms)
            and a != b
            and type(order) in (int, float)
            and math.isfinite(order)
            and order in types,
            "invalid bond endpoints or order",
        )
        pair = (min(a, b), max(a, b))
        _require(pair not in pairs, "duplicate retained bond")
        pairs.add(pair)
        retained.AddBond(a, b, types[order])
        if order == 1.5:
            retained.GetAtomWithIdx(a).SetIsAromatic(True)
            retained.GetAtomWithIdx(b).SetIsAromatic(True)
    actual = retained.GetMol()
    chem.SanitizeMol(actual)
    _require(len(chem.GetMolFrags(actual)) == 1, "retained graph is disconnected")
    _require(
        all(not atom.GetNumRadicalElectrons() for atom in actual.GetAtoms())
        and chem.MolToSmiles(chem.RemoveHs(actual), canonical=True, isomericSmiles=True)
        == canonical,
        "retained atom/bond graph differs from candidate SMILES",
    )
    return {
        "version": "refinement-subject-graph-check/v1",
        "rdkit_version": version("rdkit"),
        "canonical_isomeric_smiles": canonical,
        "heavy_atoms": molecule.GetNumHeavyAtoms(),
        "explicit_atoms": len(atoms),
        "retained_bond_hash": content_hash(bonds),
        "potential_stereoelements": 0,
        "scope": (
            "Connectivity and explicit atom/bond identity only; "
            "no coordinate optimization or physical-state measurement"
        ),
    }


def prepare_design_candidate_subject(
    record: object,
    selection: object,
    *,
    root: Path,
    record_artifact: object,
    source_artifact: object,
    electronic_state: object,
) -> dict[str, Any]:
    """Bind DesignStudio.read(run_ref) to original saved bytes and a retained .chem snapshot.

    The caller retains the source snapshot before calling; this function writes nothing.
    Explicit state is a requested refinement state, not a field invented in the Design run.
    """
    selected = closed(selection, {"run_ref", "candidate_hash"}, "selected Design candidate")
    digest_id(selected["run_ref"])
    digest_id(selected["candidate_hash"])
    state = _state(electronic_state)
    raw = _read_bound(root, record_artifact)
    original = _load(raw)
    verify_design_record(record)
    verify_design_record(original)
    _require(
        content_hash(record) == content_hash(original)
        and original["record_hash"] == selected["run_ref"],
        "selected run or supplied record differs from original artifact",
    )
    library = original.get("organic")
    _require(isinstance(library, dict), "retained organic library required")
    verify_hash(library, "result_hash")
    _require(
        library.get("version") == "design-candidates/v1"
        and library.get("profile") == "rdkit.scaffold-rgroup.interface.v1"
        and isinstance(library.get("request"), dict)
        and library.get("request_hash") == content_hash(library["request"])
        and library.get("execution_authorized") is False,
        "generation request or library provenance mismatch",
    )
    matches = [
        (i, c)
        for i, c in enumerate(library["candidates"])
        if c["candidate_hash"] == selected["candidate_hash"]
    ]
    _require(len(matches) == 1, "candidate is not uniquely present in the selected run")
    index, candidate = matches[0]
    verify_hash(candidate, "candidate_hash")
    scene = candidate["geometry"]
    verify_hash(scene, "geometry_hash")
    _require(
        candidate["request_hash"] == library["request_hash"]
        and candidate["identity_hash"]
        == content_hash({"canonical_smiles": candidate["canonical_smiles"]})
        and scene.get("version") == "display-geometry/v1"
        and scene.get("kind") == "Molecule"
        and scene.get("units") == "angstrom"
        and scene.get("cell") is None
        and scene.get("provenance") == "tool_generated"
        and scene["source_hash"] == library["request_hash"]
        and scene["subject_hash"] == candidate["identity_hash"],
        "candidate graph, generation request or retained geometry binding mismatch",
    )
    _require(
        type(candidate.get("descriptors", {}).get("formal_charge")) is int
        and candidate["descriptors"]["formal_charge"] == 0,
        "candidate does not retain a neutral graph",
    )
    exact = _load(raw, tokens=True)["organic"]["candidates"][index]
    token_rows, atoms = [], []
    for atom in exact["geometry"]["atoms"]:
        coordinates = atom.get("position")
        _require(
            isinstance(coordinates, list)
            and len(coordinates) == 3
            and all(type(value) is _NumberToken for value in coordinates),
            "coordinates must be raw JSON numbers, not strings or booleans",
        )
        rendered = [canonical_decimal(str(value)) for value in coordinates]
        _require(all(value is not None for value in rendered), "nonfinite retained coordinate")
        atoms.append({"id": atom["id"], "element": atom["element"], "position": rendered})
        token_rows.append(
            {
                "id": atom["id"],
                "element": atom["element"],
                "position_tokens": [str(value) for value in coordinates],
            }
        )
    geometry = seal_refinement_geometry(
        {"version": "refinement-geometry/v1", "units": "angstrom", **state, "atoms": atoms}
    )
    graph = _graph(candidate)
    source_raw = _read_bound(root, source_artifact)
    _require(len(source_raw) <= 200_000, "candidate source snapshot exceeds 200 KB")
    _require(
        isinstance(candidate.get("source"), str)
        and source_raw == candidate["source"].encode("utf-8"),
        "source snapshot differs from retained candidate source",
    )
    snapshot = compile_snapshot(candidate["source"])
    _require(snapshot.success and snapshot.document is not None, "candidate source did not compile")
    objects = cast(dict[str, Any], snapshot.document)["objects"]
    _require(
        len(objects) == 1
        and objects[0]["kind"] == "Molecule"
        and objects[0]["id"] == candidate["id"]
        and objects[0]["payload"].get("representations")
        == [{"format": "smiles", "role": "original", "value": candidate["canonical_smiles"]}],
        "source molecule differs from candidate graph or contains extra declarations",
    )
    source_hash = "sha256:" + hashlib.sha256(source_raw).hexdigest()
    body = {
        "version": SUBJECT_VERSION,
        "selection": copy.deepcopy(selected),
        "design_record": {
            "artifact": copy.deepcopy(artifact_ref(record_artifact)),
            "record_hash": original["record_hash"],
            "request_hash": original["request_hash"],
            "study_hash": original["study_hash"],
        },
        "candidate": {
            "json_pointer": f"/organic/candidates/{index}",
            "id": candidate["id"],
            "candidate_hash": candidate["candidate_hash"],
            "identity_hash": candidate["identity_hash"],
            "display_geometry_hash": scene["geometry_hash"],
            "generation_request_hash": library["request_hash"],
            "library_result_hash": library["result_hash"],
        },
        "generation_request": copy.deepcopy(library["request"]),
        "source_snapshot": {
            "artifact": copy.deepcopy(artifact_ref(source_artifact)),
            "text": candidate["source"],
            "source_text_hash": source_hash,
            "semantic_hash": snapshot.semantic_hash,
            "molecule_object_hash": content_hash(objects[0]),
        },
        "requested_electronic_state": state,
        "state_origin": (
            "Explicit requested refinement neutral singlet; not a measured state "
            "or an added field in the retained Design candidate"
        ),
        "geometry": geometry,
        "atom_identity_hash": content_hash([[atom["id"], atom["element"]] for atom in atoms]),
        "coordinate_tokens": token_rows,
        "geometry_origin": {
            "source_units": "angstrom",
            "target_units": "angstrom",
            "operation": "Canonical decimal encoding of exact original JSON numeric tokens",
            "source_hash": scene["source_hash"],
            "provenance": scene["provenance"],
            "method": scene["method"],
            "description": scene["description"],
            "reembedded": False,
            "rotated": False,
            "recentered": False,
            "optimized": False,
        },
        "graph_validation": graph,
        "computation_authorized": False,
        "execution_authorized": False,
        "scope": (
            "Retained candidate subject only; no method/runtime admission, "
            "optimization, minimum or accuracy evidence"
        ),
    }
    return {**body, "subject_hash": content_hash(body)}


def validate_design_candidate_subject(value: object, *, root: Path) -> dict[str, Any]:
    """Authenticate closure and transitive artifacts anew; reject extra or changed fields."""
    _require(isinstance(value, dict), "expected a subject closure")
    value = cast(dict[str, Any], value)
    verify_hash(value, "subject_hash")
    _require(value.get("version") == SUBJECT_VERSION, "unsupported subject version")
    original = _load(_read_bound(root, value["design_record"]["artifact"]))
    expected = prepare_design_candidate_subject(
        original,
        value["selection"],
        root=root,
        record_artifact=value["design_record"]["artifact"],
        source_artifact=value["source_snapshot"]["artifact"],
        electronic_state=value["requested_electronic_state"],
    )
    _require(
        content_hash(value) == content_hash(expected),
        "subject closure differs from bound artifacts",
    )
    return copy.deepcopy(expected)


def verify_design_subject_for_spec(spec: object, root: Path) -> dict[str, Any]:
    """Design source branch only; caller still verifies settings/runtime/basis/isotopes."""
    validated = validate_refinement_spec(spec)
    source = validated["source_binding"]
    subject = validate_design_candidate_subject(
        _load(_read_bound(root, source["artifact"])), root=root
    )
    _require(
        source["kind"] == "candidate_geometry"
        and source["candidate_hash"] == subject["candidate"]["candidate_hash"]
        and source["source_hash"] == subject["source_snapshot"]["source_text_hash"]
        and source["atom_identity_hash"] == subject["atom_identity_hash"]
        and source["geometry_hash"] == subject["geometry"]["geometry_hash"]
        and content_hash(validated["geometry"]) == content_hash(subject["geometry"]),
        "spec source or geometry differs from retained Design subject",
    )
    return subject
