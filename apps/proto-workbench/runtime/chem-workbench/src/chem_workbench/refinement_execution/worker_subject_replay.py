"""Stdlib-only replay of an externally pinned host-admitted Design subject.

The trusted admission reference MUST come from the authenticated host launch
context, never the untrusted worker request. Hashes do not authenticate a host.
This module has no authority, compiler, graph parser, runtime or scientific calls.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
from collections.abc import Callable
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, NoReturn, cast

Record = dict[str, Any]

ADMISSION_VERSION = "refinement-design-host-admission/v1"
REPLAY_VERSION = "refinement-design-worker-replay/v1"
MAX_BYTES = 20 * 1024 * 1024
ELEMENTS = {"H": 1, "C": 6, "N": 7, "O": 8, "F": 9, "S": 16, "Cl": 17}
HOST_SCOPE = "Host graph and source compilation admission; no execution authority"
SUBJECT_SCOPE = (
    "Retained candidate subject only; no method/runtime admission, "
    "optimization, minimum or accuracy evidence"
)
STATE_ORIGIN = (
    "Explicit requested refinement neutral singlet; not a measured state "
    "or an added field in the retained Design candidate"
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError("DESIGN_SUBJECT_REPLAY: " + message)


def canonical_hash(value: object) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def same(left: object, right: object) -> bool:
    """Use canonical JSON type distinctions, including bool versus int/float."""
    return canonical_hash(left) == canonical_hash(right)


def closed(value: object, fields: set[str], label: str) -> Record:
    require(type(value) is dict and set(value) == fields, label + " fields")
    return cast(Record, value)


def verify_hash(value: object, field: str) -> Record:
    require(type(value) is dict and field in value, field + " absent")
    value = cast(Record, value)
    require(
        value[field] == canonical_hash({key: item for key, item in value.items() if key != field}),
        field + " mismatch",
    )
    return value


def artifact_ref(value: object) -> Record:
    ref = closed(value, {"path", "sha256"}, "artifact")
    path, digest = ref["path"], ref["sha256"]
    require(type(path) is str and 1 <= len(path) <= 512, "artifact path")
    require(
        not any(ord(char) < 32 for char in path)
        and not any(char in path for char in '\\:*?"<>|')
        and all(part not in {"", ".", ".."} for part in path.split("/"))
        and all(not part.endswith((".", " ")) for part in path.split("/")),
        "unsafe artifact path",
    )
    reserved = {"CON", "PRN", "AUX", "NUL"} | {
        prefix + str(index) for prefix in ("COM", "LPT") for index in range(1, 10)
    }
    require(
        not any(part.split(".", 1)[0].upper() in reserved for part in path.split("/")),
        "reserved device path",
    )
    require(type(digest) is str and re.fullmatch(r"[0-9a-f]{64}", digest) is not None, "raw hash")
    return copy.deepcopy(ref)


def read_bound(root: Path, reference: object) -> bytes:
    ref = artifact_ref(reference)
    path = root
    for component in ("", *ref["path"].split("/")):
        path = path / component if component else path
        info = path.lstat()
        require(
            not path.is_symlink() and not getattr(info, "st_file_attributes", 0) & 0x400,
            "linked artifact component",
        )
    require(path.is_file() and path.resolve().is_relative_to(root.resolve()), "artifact escape")
    with path.open("rb") as handle:
        raw = handle.read(MAX_BYTES + 1)
    require(len(raw) <= MAX_BYTES, "artifact size limit")
    require(hashlib.sha256(raw).hexdigest() == ref["sha256"], "artifact bytes changed")
    return raw


class NumberToken(str):
    """An exact original JSON numeric token, distinct from a string value."""


def _pairs(items: list[tuple[str, Any]]) -> Record:
    result: Record = {}
    for key, value in items:
        require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def _constant(value: str) -> NoReturn:
    raise ValueError("DESIGN_SUBJECT_REPLAY: nonfinite JSON " + value)


def load_json(raw: bytes, *, tokens: bool = False) -> Record:
    require(type(raw) is bytes and len(raw) <= MAX_BYTES, "JSON byte limit")
    options: dict[str, Any] = {"object_pairs_hook": _pairs, "parse_constant": _constant}
    if tokens:
        options.update(parse_int=NumberToken, parse_float=NumberToken)
    try:
        value = json.loads(raw.decode("utf-8"), **options)
        require(type(value) is dict, "JSON object required")
        # Reject overflowing numeric JSON, as well as the named NaN/Infinity constants.
        if not tokens:
            canonical_hash(value)
        return cast(Record, value)
    except (UnicodeError, RecursionError, OverflowError) as error:
        raise ValueError("DESIGN_SUBJECT_REPLAY: invalid bounded JSON") from error


def _canonical_coordinate(token: object) -> str:
    require(type(token) is NumberToken and len(token) <= 64, "numeric coordinate token")
    try:
        value = Decimal(cast(NumberToken, token))
    except InvalidOperation as error:
        raise ValueError("DESIGN_SUBJECT_REPLAY: invalid decimal") from error
    require(value.is_finite() and value.copy_abs() <= 1000, "coordinate bound")
    if value == 0:
        return "0"
    # Avoid allocating an unbounded fixed-point exponent before checking its size.
    require(cast(int, value.as_tuple().exponent) >= -64, "coordinate precision limit")
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    if rendered in {"", "-", "-0"}:
        rendered = "0"
    require(len(rendered) <= 64, "canonical coordinate length")
    return rendered


def _state(value: object) -> Record:
    result = closed(value, {"charge", "multiplicity"}, "electronic state")
    require(
        type(result["charge"]) is int
        and result["charge"] == 0
        and type(result["multiplicity"]) is int
        and result["multiplicity"] == 1,
        "explicit neutral singlet required",
    )
    return result


def _isotopes(spec: Record, geometry: Record) -> Record:
    binding = verify_hash(spec["isotope_binding"], "binding_hash")
    closed(
        binding,
        {
            "version",
            "policy",
            "geometry_hash",
            "runtime_binding_hash",
            "atoms",
            "artifact",
            "binding_hash",
        },
        "isotope binding",
    )
    require(
        binding["version"] == "refinement-isotope-binding/v1"
        and binding["policy"] == "runtime_default_isotopes",
        "isotope policy",
    )
    require(
        binding["geometry_hash"] == geometry["geometry_hash"]
        and binding["runtime_binding_hash"] == spec["runtime_binding"]["binding_hash"],
        "isotope geometry/runtime context",
    )
    artifact_ref(binding["artifact"])
    require(
        type(binding["atoms"]) is list and len(binding["atoms"]) == len(geometry["atoms"]),
        "isotope inventory",
    )
    for atom, row in zip(geometry["atoms"], binding["atoms"], strict=True):
        closed(
            row,
            {"atom_id", "element", "atomic_number", "mass_number", "mass_dalton"},
            "isotope row",
        )
        require(
            row["atom_id"] == atom["id"] and row["element"] == atom["element"], "isotope atom order"
        )
        require(
            type(row["atomic_number"]) is int and row["atomic_number"] == ELEMENTS[atom["element"]],
            "isotope atomic number",
        )
        require(
            type(row["mass_number"]) is int and row["atomic_number"] <= row["mass_number"] <= 300,
            "isotope mass number",
        )
        mass = row["mass_dalton"]
        require(type(mass) is str and len(mass) <= 64, "isotope mass type")
        require(
            _canonical_coordinate(NumberToken(mass)) == mass
            and Decimal(0) < Decimal(mass) <= Decimal(300),
            "isotope mass",
        )
    return binding


def replay_closure(
    spec: Record, subject: Record, record_raw: bytes, source_raw: bytes, host_validation: Record
) -> Record:
    """Internal consistency only. Public callers must first authenticate admission bytes."""
    verify_hash(spec, "spec_hash")
    require(spec["version"] == "molecular-refinement-spec/v2", "mass-bound spec v2 required")
    verify_hash(subject, "subject_hash")
    require(subject["version"] == "refinement-design-subject/v1", "Design subject branch only")
    record = verify_hash(load_json(record_raw), "record_hash")
    require(record["version"] == "design-run/v1", "Design record version")
    require(
        record["request_hash"] == canonical_hash(record["request"])
        and record["study_hash"] == canonical_hash(record["request"]["study"]),
        "record request/study",
    )
    selection = closed(subject["selection"], {"run_ref", "candidate_hash"}, "selection")
    require(selection["run_ref"] == record["record_hash"], "selected run")
    library = verify_hash(record["organic"], "result_hash")
    require(
        library["version"] == "design-candidates/v1"
        and library["profile"] == "rdkit.scaffold-rgroup.interface.v1"
        and library["execution_authorized"] is False
        and library["request_hash"] == canonical_hash(library["request"]),
        "library binding",
    )
    candidates = library["candidates"]
    require(type(candidates) is list and 1 <= len(candidates) <= 24, "candidate inventory")
    matches = [
        (i, item)
        for i, item in enumerate(candidates)
        if item["candidate_hash"] == selection["candidate_hash"]
    ]
    require(len(matches) == 1, "nonunique selected candidate")
    index, candidate = matches[0]
    verify_hash(candidate, "candidate_hash")
    scene = verify_hash(candidate["geometry"], "geometry_hash")
    require(
        candidate["family"] == "organic"
        and candidate["request_hash"] == library["request_hash"]
        and candidate["identity_hash"]
        == canonical_hash({"canonical_smiles": candidate["canonical_smiles"]})
        and scene["version"] == "display-geometry/v1"
        and scene["kind"] == "Molecule"
        and scene["object_id"] == candidate["id"]
        and scene["units"] == "angstrom"
        and scene["cell"] is None
        and scene["provenance"] == "tool_generated"
        and scene["source_hash"] == library["request_hash"]
        and scene["subject_hash"] == candidate["identity_hash"],
        "candidate geometry binding",
    )
    require(
        type(candidate["descriptors"]["formal_charge"]) is int
        and candidate["descriptors"]["formal_charge"] == 0,
        "neutral candidate",
    )
    state = _state(subject["requested_electronic_state"])
    exact = load_json(record_raw, tokens=True)["organic"]["candidates"][index]
    atoms, tokens = [], []
    for atom in exact["geometry"]["atoms"]:
        xyz = atom["position"]
        require(type(xyz) is list and len(xyz) == 3, "XYZ shape")
        atoms.append(
            {
                "id": atom["id"],
                "element": atom["element"],
                "position": [_canonical_coordinate(value) for value in xyz],
            }
        )
        tokens.append(
            {
                "id": atom["id"],
                "element": atom["element"],
                "position_tokens": [str(value) for value in xyz],
            }
        )
    require(
        8 <= len(atoms) <= 120 and len({atom["id"] for atom in atoms}) == len(atoms),
        "atom inventory/identity",
    )
    require(all(atom["element"] in ELEMENTS for atom in atoms), "organic element scope")
    heavy = sum(atom["element"] != "H" for atom in atoms)
    require(8 <= heavy <= 32 and any(atom["element"] == "C" for atom in atoms), "organic scope")
    geometry = {"version": "refinement-geometry/v1", "units": "angstrom", **state, "atoms": atoms}
    geometry["geometry_hash"] = canonical_hash(geometry)
    require(same(geometry, spec["geometry"]), "exact spec geometry")
    isotope = _isotopes(spec, geometry)
    require(
        len(source_raw) <= 200_000 and source_raw == candidate["source"].encode("utf-8"),
        "exact source snapshot",
    )
    source_hash = "sha256:" + hashlib.sha256(source_raw).hexdigest()
    graph = host_validation["graph_validation"]
    require(
        type(graph["potential_stereoelements"]) is int
        and graph["potential_stereoelements"] == 0
        and type(graph["explicit_atoms"]) is int
        and graph["explicit_atoms"] == len(atoms)
        and type(graph["heavy_atoms"]) is int
        and graph["heavy_atoms"] == heavy
        and graph["canonical_isomeric_smiles"] == candidate["canonical_smiles"]
        and graph["retained_bond_hash"] == canonical_hash(scene["bonds"]),
        "host graph statement differs from retained graph",
    )
    body = {
        "version": "refinement-design-subject/v1",
        "selection": selection,
        "design_record": {
            "artifact": subject["design_record"]["artifact"],
            **{key: record[key] for key in ("record_hash", "request_hash", "study_hash")},
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
        "generation_request": library["request"],
        "source_snapshot": {
            "artifact": subject["source_snapshot"]["artifact"],
            "text": candidate["source"],
            "source_text_hash": source_hash,
            "semantic_hash": host_validation["source_semantic_hash"],
            "molecule_object_hash": host_validation["molecule_object_hash"],
        },
        "requested_electronic_state": state,
        "state_origin": STATE_ORIGIN,
        "geometry": geometry,
        "atom_identity_hash": canonical_hash([[atom["id"], atom["element"]] for atom in atoms]),
        "coordinate_tokens": tokens,
        "geometry_origin": {
            "source_units": "angstrom",
            "target_units": "angstrom",
            "operation": "Canonical decimal encoding of exact original JSON numeric tokens",
            **{key: scene[key] for key in ("source_hash", "provenance", "method", "description")},
            "reembedded": False,
            "rotated": False,
            "recentered": False,
            "optimized": False,
        },
        "graph_validation": graph,
        "computation_authorized": False,
        "execution_authorized": False,
        "scope": SUBJECT_SCOPE,
    }
    expected = {**body, "subject_hash": canonical_hash(body)}
    require(same(subject, expected), "subject reconstruction differs")
    expected_source = {
        "kind": "candidate_geometry",
        "source_hash": source_hash,
        "candidate_hash": candidate["candidate_hash"],
        "atom_identity_hash": expected["atom_identity_hash"],
        "geometry_hash": geometry["geometry_hash"],
        "artifact": spec["source_binding"]["artifact"],
    }
    require(same(spec["source_binding"], expected_source), "spec source binding")
    return {"subject": expected, "isotope_binding_hash": isotope["binding_hash"]}


def replay_host_admitted_subject(
    *,
    root: Path,
    trusted_admission_ref: object,
    expected_spec_ref: object,
    request_spec: object,
    validate_spec: Callable[[object], Record],
) -> Record:
    """Replay from an EXTERNALLY authenticated host admission reference.

    No fallback derives trust from a request, spec or self-reported admission hash.
    ``validate_spec`` is the existing worker's pure full-spec validator; the caller
    still performs native isotope/default, runtime/basis/options, approval and budget checks.
    """
    require(callable(validate_spec), "existing pure spec validator required")
    anchor = artifact_ref(trusted_admission_ref)
    expected_spec_ref = artifact_ref(expected_spec_ref)
    admission = verify_hash(load_json(read_bound(root, anchor)), "binding_hash")
    closed(
        admission,
        {
            "version",
            "scope",
            "artifacts",
            "spec_hash",
            "subject_hash",
            "geometry_hash",
            "runtime_binding_hash",
            "isotope_binding_hash",
            "host_validation",
            "computation_authorized",
            "execution_authorized",
            "binding_hash",
        },
        "host admission",
    )
    require(
        admission["version"] == ADMISSION_VERSION
        and admission["scope"] == HOST_SCOPE
        and admission["computation_authorized"] is False
        and admission["execution_authorized"] is False,
        "host admission scope",
    )
    refs = closed(
        admission["artifacts"], {"spec", "subject", "design_record", "source"}, "admitted artifacts"
    )
    require(same(refs["spec"], expected_spec_ref), "expected spec artifact differs")
    raw = {role: read_bound(root, ref) for role, ref in refs.items()}
    spec = load_json(raw["spec"])
    require(same(request_spec, spec), "actual request spec differs from admitted bytes")
    require(same(validate_spec(copy.deepcopy(spec)), spec), "spec validator changed input")
    subject = load_json(raw["subject"])
    require(
        same(spec["source_binding"]["artifact"], refs["subject"])
        and same(subject["design_record"]["artifact"], refs["design_record"])
        and same(subject["source_snapshot"]["artifact"], refs["source"]),
        "raw artifact closure",
    )
    host = closed(
        admission["host_validation"],
        {
            "verifier_artifact",
            "graph_validation",
            "source_semantic_hash",
            "molecule_object_hash",
            "full_subject_spec_validation",
        },
        "host validation",
    )
    artifact_ref(host["verifier_artifact"])
    require(host["full_subject_spec_validation"] is True, "host full validation absent")
    # This is trusted host output, not re-execution of RDKit or the source compiler.
    result = replay_closure(spec, subject, raw["design_record"], raw["source"], host)
    for field, expected in {
        "spec_hash": spec["spec_hash"],
        "subject_hash": subject["subject_hash"],
        "geometry_hash": spec["geometry"]["geometry_hash"],
        "runtime_binding_hash": spec["runtime_binding"]["binding_hash"],
        "isotope_binding_hash": result["isotope_binding_hash"],
    }.items():
        require(admission[field] == expected, "admission " + field)
    body = {
        "version": REPLAY_VERSION,
        "admission_artifact": anchor,
        "admission_binding_hash": admission["binding_hash"],
        "artifacts": refs,
        "spec_hash": spec["spec_hash"],
        "subject": result["subject"],
        "isotope_binding_hash": result["isotope_binding_hash"],
        "runtime_binding_hash": spec["runtime_binding"]["binding_hash"],
        "host_admission_replayed": True,
        "graph_revalidated_in_worker": False,
        "source_compiled_in_worker": False,
        "native_isotope_defaults_verified": False,
        "runtime_artifacts_verified": False,
        "computation_authorized": False,
        "execution_authorized": False,
    }
    return copy.deepcopy({**body, "replay_hash": canonical_hash(body)})
