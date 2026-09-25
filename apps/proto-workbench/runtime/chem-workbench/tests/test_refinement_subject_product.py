"""Pure retained-record, graph and tamper tests. No embedding or scientific calculation."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import pytest

from chem_workbench.chemir.constraints import canonical_decimal
from chem_workbench.molecular_refinement import seal_refinement_geometry, seal_refinement_spec
from chem_workbench.refinement_execution import refinement_subject as subject
from chem_workbench.visualization import content_hash

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
FIXTURES = HERE / "fixtures/refinement_execution_subject"
RUN = "sha256:73400285dd71e0c244504cd0d5818cff0a67f61bea9a6b250f57e2bad9831c68"
CANDIDATE = "sha256:c312a810cbbe0b8cb300d3941a403649e2a16a0701a3f7eaeb58a82421f538b3"
ORIGINAL_RAW = (FIXTURES / "design-record.original.json").read_bytes()
SOURCE_RAW = (FIXTURES / "candidate-source.original.chem").read_bytes()


def ref(path: Path, root: Path) -> dict:
    return {
        "path": path.relative_to(root).as_posix(),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def rehash(value, key):
    value[key] = content_hash({k: v for k, v in value.items() if k != key})


@pytest.fixture
def retained(tmp_path):
    (tmp_path / "record.json").write_bytes(ORIGINAL_RAW)
    (tmp_path / "source.chem").write_bytes(SOURCE_RAW)
    return {
        "record": json.loads(ORIGINAL_RAW),
        "selection": {"run_ref": RUN, "candidate_hash": CANDIDATE},
        "root": tmp_path,
        "record_artifact": ref(tmp_path / "record.json", tmp_path),
        "source_artifact": ref(tmp_path / "source.chem", tmp_path),
        "electronic_state": {"charge": 0, "multiplicity": 1},
    }


def prepare(arguments):
    return subject.prepare_design_candidate_subject(**arguments)


def changed_record(arguments, mutate):
    record = arguments["record"]
    mutate(record)
    for candidate in record["organic"]["candidates"]:
        rehash(candidate["geometry"], "geometry_hash")
        rehash(candidate, "candidate_hash")
    rehash(record["organic"], "result_hash")
    rehash(record, "record_hash")
    path = arguments["root"] / "record.json"
    path.write_text(json.dumps(record, allow_nan=False), encoding="utf-8")
    arguments["record_artifact"] = ref(path, arguments["root"])
    arguments["selection"] = {
        "run_ref": record["record_hash"],
        "candidate_hash": record["organic"]["candidates"][2]["candidate_hash"],
    }


def test_actual_record_preserves_all_34_atoms_hashes_and_separate_source_identities(retained):
    assert (
        hashlib.sha256(ORIGINAL_RAW).hexdigest()
        == "01cbb4531ed64109c692216ad33d190def6b46961ac9faebd5831180c4eae9f3"
    )
    result = prepare(retained)
    assert result["version"] == subject.SUBJECT_VERSION
    assert result["selection"] == {"run_ref": RUN, "candidate_hash": CANDIDATE}
    assert result["candidate"]["json_pointer"] == "/organic/candidates/2"
    assert len(result["geometry"]["atoms"]) == len(result["coordinate_tokens"]) == 34
    assert result["graph_validation"]["heavy_atoms"] == 19
    exact = json.loads(ORIGINAL_RAW, parse_float=Decimal)["organic"]["candidates"][2]
    for actual, original in zip(
        result["geometry"]["atoms"], exact["geometry"]["atoms"], strict=True
    ):
        assert actual == {
            "id": original["id"],
            "element": original["element"],
            "position": [canonical_decimal(str(value)) for value in original["position"]],
        }
    assert (
        result["source_snapshot"]["source_text_hash"]
        == "sha256:" + hashlib.sha256(SOURCE_RAW).hexdigest()
    )
    assert (
        result["source_snapshot"]["source_text_hash"]
        != result["candidate"]["generation_request_hash"]
    )
    assert (
        result["geometry_origin"]["source_hash"] == result["candidate"]["generation_request_hash"]
    )
    assert result["design_record"]["request_hash"] != result["candidate"]["generation_request_hash"]
    assert result["computation_authorized"] is result["execution_authorized"] is False
    assert subject.validate_design_candidate_subject(result, root=retained["root"]) == result
    result["geometry"]["atoms"][0]["position"][0] = "999"
    assert (
        retained["record"]["organic"]["candidates"][2]["geometry"]["atoms"][0]["position"][0] != 999
    )


@pytest.mark.parametrize(
    "field,value",
    [
        ("run_ref", "sha256:" + "0" * 64),
        ("candidate_hash", "sha256:" + "0" * 64),
        ("candidate_hash", False),
    ],
)
def test_selection_must_bind_exact_run_and_unique_candidate(retained, field, value):
    retained["selection"][field] = value
    with pytest.raises(ValueError):
        prepare(retained)


@pytest.mark.parametrize(
    "state",
    [
        {"charge": False, "multiplicity": 1},
        {"charge": 0, "multiplicity": True},
        {"charge": 0, "multiplicity": 3},
        {"charge": 1, "multiplicity": 1},
        {},
        {"charge": 0, "multiplicity": 1, "temperature": 0},
    ],
)
def test_state_is_explicit_and_never_inferred_or_type_coerced(retained, state):
    retained["electronic_state"] = state
    with pytest.raises(ValueError):
        prepare(retained)


def test_supplied_record_cannot_replace_original_bytes_even_when_rehashed(retained):
    retained["record"]["seconds"] += 1
    rehash(retained["record"], "record_hash")
    with pytest.raises(ValueError, match="differs from original artifact"):
        prepare(retained)


@pytest.mark.parametrize("key", ["request_hash", "identity_hash"])
def test_rehashed_candidate_cannot_change_request_or_graph_identity(retained, key):
    changed_record(
        retained,
        lambda record: record["organic"]["candidates"][2].__setitem__(key, "sha256:" + "0" * 64),
    )
    with pytest.raises(ValueError):
        prepare(retained)


def test_generation_request_body_requires_its_own_hash(retained):
    changed_record(
        retained, lambda record: record["organic"]["request"].__setitem__("max_candidates", 2)
    )
    with pytest.raises(ValueError, match="generation request"):
        prepare(retained)


def test_duplicate_matching_candidate_is_not_silently_selected(retained):
    changed_record(
        retained,
        lambda record: record["organic"]["candidates"].append(
            copy.deepcopy(record["organic"]["candidates"][2])
        ),
    )
    with pytest.raises(ValueError, match="not uniquely"):
        prepare(retained)


@pytest.mark.parametrize("replacement", [True, "1.25", None])
def test_coordinate_tokens_must_be_json_numbers(retained, replacement):
    changed_record(
        retained,
        lambda record: record["organic"]["candidates"][2]["geometry"]["atoms"][0][
            "position"
        ].__setitem__(0, replacement),
    )
    with pytest.raises(ValueError, match="raw JSON numbers"):
        prepare(retained)


def test_original_number_lexeme_and_exact_decimal_value_survive_without_binary64_roundtrip(
    retained,
):
    token = str(
        retained["record"]["organic"]["candidates"][2]["geometry"]["atoms"][0]["position"][0]
    )
    exact_token = token + "000000000000000001"
    assert float(exact_token) == float(token)
    raw = ORIGINAL_RAW.replace(token.encode(), exact_token.encode())
    path = retained["root"] / "record.json"
    path.write_bytes(raw)
    retained["record_artifact"] = ref(path, retained["root"])
    result = prepare(retained)
    assert result["coordinate_tokens"][0]["position_tokens"][0] == exact_token
    assert result["geometry"]["atoms"][0]["position"][0] == canonical_decimal(exact_token)
    assert result["candidate"]["candidate_hash"] == CANDIDATE
    assert result["design_record"]["artifact"]["sha256"] != hashlib.sha256(ORIGINAL_RAW).hexdigest()


@pytest.mark.parametrize(
    "mutation",
    [
        lambda c: c["geometry"]["atoms"].reverse(),
        lambda c: c["geometry"]["atoms"][1].__setitem__("id", c["geometry"]["atoms"][0]["id"]),
        lambda c: c["geometry"]["bonds"][0].__setitem__("a", False),
        lambda c: c["geometry"]["bonds"][0].__setitem__("order", True),
        lambda c: c["geometry"]["bonds"].append(copy.deepcopy(c["geometry"]["bonds"][0])),
        lambda c: c["geometry"]["bonds"].pop(),
        lambda c: c["geometry"]["atoms"][-1].__setitem__("element", "F"),
    ],
)
def test_rehashed_inconsistent_graph_atom_order_and_types_rejected(retained, mutation):
    changed_record(retained, lambda record: mutation(record["organic"]["candidates"][2]))
    with pytest.raises(ValueError):
        prepare(retained)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda v: v.__setitem__("execution_authorized", True),
        lambda v: v.__setitem__("computation_authorized", 0),
        lambda v: v["geometry_origin"].__setitem__("reembedded", 0),
        lambda v: v["coordinate_tokens"][0]["position_tokens"].__setitem__(0, "999"),
        lambda v: v["source_snapshot"].__setitem__(
            "source_text_hash", v["candidate"]["generation_request_hash"]
        ),
        lambda v: v["candidate"].__setitem__("json_pointer", "/organic/candidates/0"),
        lambda v: v["graph_validation"].__setitem__("heavy_atoms", 8),
        lambda v: v.__setitem__("evaluation_row", {}),
    ],
)
def test_rehashed_closure_tampering_is_rebuilt_from_actual_artifacts(retained, mutation):
    value = prepare(retained)
    mutation(value)
    rehash(value, "subject_hash")
    with pytest.raises(ValueError, match="closure differs"):
        subject.validate_design_candidate_subject(value, root=retained["root"])


@pytest.mark.parametrize("name", ["record.json", "source.chem"])
def test_changed_artifact_bytes_fail_even_when_semantics_could_match(retained, name):
    result = prepare(retained)
    with (retained["root"] / name).open("ab") as stream:
        stream.write(b" ")
    with pytest.raises(ValueError, match="artifact bytes changed"):
        subject.validate_design_candidate_subject(result, root=retained["root"])


def test_source_snapshot_must_match_candidate_and_compile_to_same_single_molecule(retained):
    path = retained["root"] / "source.chem"
    path.write_bytes(SOURCE_RAW + b"\n")
    retained["source_artifact"] = ref(path, retained["root"])
    with pytest.raises(ValueError, match="source snapshot differs"):
        prepare(retained)
    changed_record(
        retained,
        lambda record: record["organic"]["candidates"][2].__setitem__(
            "source", 'chem 0.1\nmolecule wrong { structure smiles "CCCCCCCC" }\n'
        ),
    )
    path.write_bytes(retained["record"]["organic"]["candidates"][2]["source"].encode("utf-8"))
    retained["source_artifact"] = ref(path, retained["root"])
    with pytest.raises(ValueError, match="source molecule differs"):
        prepare(retained)


@pytest.mark.parametrize(
    "path", ["../record.json", "/record.json", "a/../record.json", "a\\record.json"]
)
def test_unsafe_artifact_paths_rejected(retained, path):
    retained["record_artifact"]["path"] = path
    with pytest.raises(ValueError):
        prepare(retained)


def test_duplicate_json_keys_are_rejected_before_record_validation(retained):
    path = retained["root"] / "record.json"
    path.write_bytes(ORIGINAL_RAW.replace(b"{", b'{"version":"design-run/v1",', 1))
    retained["record_artifact"] = ref(path, retained["root"])
    with pytest.raises(ValueError, match="duplicate JSON key"):
        prepare(retained)


def test_full_spec_subject_bridge_preserves_old_schema_and_rejects_rebound_geometry(retained):
    result = prepare(retained)
    spec_file = importlib.util.spec_from_file_location(
        "refinement_test_fixture", ROOT / "tests/test_molecular_refinement.py"
    )
    helper = importlib.util.module_from_spec(spec_file)
    spec_file.loader.exec_module(helper)
    body = helper._spec(result["geometry"])
    del body["spec_hash"]
    closure_path = retained["root"] / "subject.json"
    closure_path.write_text(json.dumps(result), encoding="utf-8")
    body["source_binding"].update(
        source_hash=result["source_snapshot"]["source_text_hash"],
        candidate_hash=CANDIDATE,
        artifact=ref(closure_path, retained["root"]),
    )
    spec = seal_refinement_spec(body)
    assert subject.verify_design_subject_for_spec(spec, retained["root"]) == result
    changed = copy.deepcopy(body)
    geometry = copy.deepcopy(changed["geometry"])
    del geometry["geometry_hash"]
    geometry["atoms"][0]["position"][0] = "0.125"
    changed["geometry"] = seal_refinement_geometry(geometry)
    changed["source_binding"]["geometry_hash"] = changed["geometry"]["geometry_hash"]
    with pytest.raises(ValueError, match="spec source or geometry differs"):
        subject.verify_design_subject_for_spec(seal_refinement_spec(changed), retained["root"])
    changed = copy.deepcopy(body)
    changed["source_binding"]["source_hash"] = result["candidate"]["generation_request_hash"]
    with pytest.raises(ValueError, match="spec source or geometry differs"):
        subject.verify_design_subject_for_spec(seal_refinement_spec(changed), retained["root"])


@pytest.mark.parametrize("link_type", ["symlink", "reparse"])
def test_linked_directory_components_fail_closed_without_reading_target(
    retained, monkeypatch, link_type
):
    directory = retained["root"] / "nested"
    directory.mkdir()
    (directory / "record.json").write_bytes(ORIGINAL_RAW)
    retained["record_artifact"] = ref(directory / "record.json", retained["root"])
    original_lstat = Path.lstat
    original_symlink = Path.is_symlink
    if link_type == "symlink":
        monkeypatch.setattr(
            Path, "is_symlink", lambda path: path == directory or original_symlink(path)
        )
    else:
        monkeypatch.setattr(
            Path,
            "lstat",
            lambda path: (
                SimpleNamespace(st_file_attributes=0x400, st_mode=original_lstat(path).st_mode)
                if path == directory
                else original_lstat(path)
            ),
        )
    with pytest.raises(ValueError, match="linked artifact component"):
        prepare(retained)


def test_existing_subject_cannot_accept_atom_reordering_even_with_equivalent_graph(retained):
    result = prepare(retained)
    result["geometry"]["atoms"].reverse()
    result["coordinate_tokens"].reverse()
    rehash(result["geometry"], "geometry_hash")
    result["atom_identity_hash"] = content_hash(
        [[a["id"], a["element"]] for a in result["geometry"]["atoms"]]
    )
    rehash(result, "subject_hash")
    with pytest.raises(ValueError, match="closure differs"):
        subject.validate_design_candidate_subject(result, root=retained["root"])


def test_bridge_does_not_call_candidate_generation_embedding_or_backends(retained, monkeypatch):
    from chem_workbench import design_candidates, visualization

    def forbidden(*args, **kwargs):
        raise AssertionError("generation or backend dispatch is forbidden in subject preparation")

    original_import = importlib.import_module

    def bounded_import(name, *args, **kwargs):
        if (
            name.split(".")[0] in {"psi4", "qcengine", "qcelemental", "optking"}
            or name == "rdkit.Chem.AllChem"
        ):
            forbidden()
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(design_candidates, "organic_candidates", forbidden)
    monkeypatch.setattr(visualization, "geometry_for_object", forbidden)
    monkeypatch.setattr(importlib, "import_module", bounded_import)
    assert len(prepare(retained)["geometry"]["atoms"]) == 34


def test_graph_with_potential_stereochemistry_is_explicitly_unsupported(retained):
    # This altered graph is a rejection fixture only, never a newly generated candidate.
    candidate = copy.deepcopy(retained["record"]["organic"]["candidates"][2])
    chemistry = subject._chemistry()
    molecule = chemistry.MolFromSmiles("CC[C@H](O)CCCCC")
    candidate["canonical_smiles"] = chemistry.MolToSmiles(
        molecule, canonical=True, isomericSmiles=True
    )
    with pytest.raises(ValueError, match="stereochemical atom mapping unsupported"):
        subject._graph(candidate)
