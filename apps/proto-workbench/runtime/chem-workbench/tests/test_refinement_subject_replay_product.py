"""Pure host admission and worker replay tests on the retained 34-atom subject."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from chem_workbench.molecular_refinement import seal_refinement_spec, validate_refinement_spec
from chem_workbench.refinement_execution import refinement_subject
from chem_workbench.refinement_execution import worker_subject_replay as replay
from chem_workbench.refinement_execution.host_subject_admission import build_host_admission

FIXTURES = Path(__file__).resolve().parent / "fixtures/refinement_execution_subject"


def ref(path, root):
    return {
        "path": path.relative_to(root).as_posix(),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")), encoding="utf-8")


def rehash(value, field):
    value[field] = replay.canonical_hash({key: item for key, item in value.items() if key != field})


@pytest.fixture(scope="session")
def portable_case(tmp_path_factory):
    # Original retained data; only the artifact paths and source closure are resealed
    # in a temporary portable test copy. No calculated energies or gradients exist.
    root = tmp_path_factory.mktemp("portable-design-subject")
    directory = root / "evidence"
    directory.mkdir()
    record_path, source_path = directory / "record.json", directory / "source.chem"
    record_path.write_bytes((FIXTURES / "design-record.original.json").read_bytes())
    source_path.write_bytes((FIXTURES / "candidate-source.original.chem").read_bytes())
    record = json.loads(record_path.read_bytes())
    candidate = record["organic"]["candidates"][2]
    subject = refinement_subject.prepare_design_candidate_subject(
        record,
        {"run_ref": record["record_hash"], "candidate_hash": candidate["candidate_hash"]},
        root=root,
        record_artifact=ref(record_path, root),
        source_artifact=ref(source_path, root),
        electronic_state={"charge": 0, "multiplicity": 1},
    )
    subject_path = directory / "subject.json"
    write(subject_path, subject)
    spec = json.loads((FIXTURES / "mass-bound-input.original.json").read_bytes())["spec"]
    assert spec["geometry"] == subject["geometry"]
    spec["source_binding"] = {
        "kind": "candidate_geometry",
        "source_hash": subject["source_snapshot"]["source_text_hash"],
        "candidate_hash": subject["candidate"]["candidate_hash"],
        "atom_identity_hash": subject["atom_identity_hash"],
        "geometry_hash": subject["geometry"]["geometry_hash"],
        "artifact": ref(subject_path, root),
    }
    spec = seal_refinement_spec({key: value for key, value in spec.items() if key != "spec_hash"})
    spec_path, admission_path = directory / "spec.json", directory / "host-admission.json"
    write(spec_path, spec)
    admission = build_host_admission(root=root, spec_ref=ref(spec_path, root))
    write(admission_path, admission)
    fixture = {"admission": ref(admission_path, root), "spec": ref(spec_path, root)}
    write(root / "fixture.json", fixture)
    return root, fixture


@pytest.fixture
def case(tmp_path, portable_case):
    root, fixture = portable_case
    admission = replay.load_json(replay.read_bound(root, fixture["admission"]))
    references = [fixture["admission"], *admission["artifacts"].values()]
    for reference in references:
        target = tmp_path / reference["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(replay.read_bound(root, reference))
    return {
        "root": tmp_path,
        "trusted_admission_ref": copy.deepcopy(fixture["admission"]),
        "expected_spec_ref": copy.deepcopy(fixture["spec"]),
        "request_spec": replay.load_json(replay.read_bound(root, fixture["spec"])),
        "validate_spec": validate_refinement_spec,
    }


def admission_of(case):
    return replay.load_json(replay.read_bound(case["root"], case["trusted_admission_ref"]))


def replace_admission_for_negative_test(case, admission):
    """TEST ONLY: emulate a bad externally admitted record to test inner checks."""
    rehash(admission, "binding_hash")
    path = case["root"] / case["trusted_admission_ref"]["path"]
    write(path, admission)
    case["trusted_admission_ref"] = ref(path, case["root"])


def replace_artifact_for_negative_test(case, role, mutate):
    admission = admission_of(case)
    path = case["root"] / admission["artifacts"][role]["path"]
    value = json.loads(path.read_bytes())
    mutate(value)
    hash_field = {"spec": "spec_hash", "subject": "subject_hash", "design_record": "record_hash"}[
        role
    ]
    rehash(value, hash_field)
    write(path, value)
    admission["artifacts"][role] = ref(path, case["root"])
    if role == "spec":
        case["expected_spec_ref"] = admission["artifacts"][role]
        case["request_spec"] = value
        admission["spec_hash"] = value["spec_hash"]
    replace_admission_for_negative_test(case, admission)


def rebind_subject_chain_for_negative_test(case, subject, record_ref=None):
    """TEST ONLY: re-sign outer hashes to exercise exact inner reconstruction."""
    admission = admission_of(case)
    if record_ref is not None:
        subject["design_record"]["artifact"] = record_ref
        admission["artifacts"]["design_record"] = record_ref
    rehash(subject, "subject_hash")
    subject_path = case["root"] / admission["artifacts"]["subject"]["path"]
    write(subject_path, subject)
    admission["artifacts"]["subject"] = ref(subject_path, case["root"])
    admission["subject_hash"] = subject["subject_hash"]
    spec_path = case["root"] / admission["artifacts"]["spec"]["path"]
    spec = json.loads(spec_path.read_bytes())
    spec["source_binding"]["artifact"] = admission["artifacts"]["subject"]
    rehash(spec, "spec_hash")
    write(spec_path, spec)
    admission["artifacts"]["spec"] = ref(spec_path, case["root"])
    admission["spec_hash"] = spec["spec_hash"]
    case["expected_spec_ref"] = admission["artifacts"]["spec"]
    case["request_spec"] = spec
    replace_admission_for_negative_test(case, admission)


def test_actual_34_atom_host_admission_and_worker_replay(case):
    rebuilt = build_host_admission(root=case["root"], spec_ref=case["expected_spec_ref"])
    assert rebuilt == admission_of(case)
    verifier = rebuilt["host_validation"]["verifier_artifact"]
    assert verifier["path"] == "chem_workbench/refinement_execution/refinement_subject.py"
    assert not (case["root"] / verifier["path"]).exists()
    assert (
        verifier["sha256"]
        == hashlib.sha256(Path(refinement_subject.__file__).read_bytes()).hexdigest()
    )
    result = replay.replay_host_admitted_subject(**case)
    subject = result["subject"]
    assert len(subject["geometry"]["atoms"]) == 34
    assert subject["graph_validation"]["heavy_atoms"] == 19
    assert subject["candidate"]["json_pointer"] == "/organic/candidates/2"
    assert (
        subject["source_snapshot"]["source_text_hash"]
        != subject["candidate"]["generation_request_hash"]
    )
    assert subject["subject_hash"] == admission_of(case)["subject_hash"]
    assert result["spec_hash"] == case["request_spec"]["spec_hash"]
    assert result["host_admission_replayed"] is True
    assert result["graph_revalidated_in_worker"] is False
    assert result["source_compiled_in_worker"] is False
    assert result["native_isotope_defaults_verified"] is False
    assert result["runtime_artifacts_verified"] is False
    assert result["computation_authorized"] is result["execution_authorized"] is False
    original = copy.deepcopy(result)
    result["subject"]["geometry"]["atoms"][0]["position"][0] = "99"
    assert replay.replay_host_admitted_subject(**case) == original


@pytest.mark.parametrize("role", ["spec", "subject", "design_record", "source", "admission"])
def test_any_original_bytes_change_or_disappear_fails(case, role):
    reference = (
        case["trusted_admission_ref"]
        if role == "admission"
        else admission_of(case)["artifacts"][role]
    )
    path = case["root"] / reference["path"]
    path.write_bytes(path.read_bytes() + b" ")
    with pytest.raises(ValueError, match="artifact bytes changed"):
        replay.replay_host_admitted_subject(**case)


def test_missing_source_fails(case):
    reference = admission_of(case)["artifacts"]["source"]
    (case["root"] / reference["path"]).unlink()
    with pytest.raises(FileNotFoundError):
        replay.replay_host_admitted_subject(**case)


def test_self_rehashed_admission_cannot_replace_external_pin(case):
    admission = admission_of(case)
    admission["host_validation"]["full_subject_spec_validation"] = True
    admission["computation_authorized"] = True
    rehash(admission, "binding_hash")
    write(case["root"] / case["trusted_admission_ref"]["path"], admission)
    with pytest.raises(ValueError, match="artifact bytes changed"):
        replay.replay_host_admitted_subject(**case)


def test_no_trust_anchor_default_or_request_fallback(case):
    del case["trusted_admission_ref"]
    with pytest.raises(TypeError):
        replay.replay_host_admitted_subject(**case)


def test_actual_request_spec_must_match_independently_admitted_bytes(case):
    spec = case["request_spec"]
    spec["resources"]["max_wall_seconds"] = 1
    rehash(spec, "spec_hash")
    with pytest.raises(ValueError, match="actual request spec differs"):
        replay.replay_host_admitted_subject(**case)


@pytest.mark.parametrize(
    "field,value",
    [
        ("computation_authorized", True),
        ("execution_authorized", 0),
        ("scope", "Worker verified itself"),
        ("version", "refinement-complex-cohort/v1"),
        ("spec_hash", "sha256:" + "0" * 64),
        ("subject_hash", "sha256:" + "0" * 64),
        ("runtime_binding_hash", "sha256:" + "0" * 64),
        ("isotope_binding_hash", "sha256:" + "0" * 64),
    ],
)
def test_even_externally_rebound_bad_admission_fields_fail(case, field, value):
    admission = admission_of(case)
    admission[field] = value
    replace_admission_for_negative_test(case, admission)
    with pytest.raises(ValueError):
        replay.replay_host_admitted_subject(**case)


@pytest.mark.parametrize(
    "change",
    [
        lambda spec: spec["geometry"].update(charge=False),
        lambda spec: spec["geometry"].update(multiplicity=True),
        lambda spec: spec["isotope_binding"]["atoms"][0].update(mass_dalton="18"),
        lambda spec: spec["isotope_binding"]["atoms"].reverse(),
        lambda spec: spec["source_binding"].update(
            source_hash=spec["source_binding"]["candidate_hash"]
        ),
        lambda spec: spec["source_binding"].update(kind="supplied_geometry"),
        lambda spec: spec["geometry"]["atoms"][0]["position"].__setitem__(0, "1"),
    ],
)
def test_spec_state_isotope_geometry_source_tamper_rejected(case, change):
    replace_artifact_for_negative_test(case, "spec", change)
    with pytest.raises(ValueError):
        replay.replay_host_admitted_subject(**case)


@pytest.mark.parametrize(
    "change",
    [
        lambda subject: subject["coordinate_tokens"][0]["position_tokens"].__setitem__(
            0, "-0.4392273642123769600001"
        ),
        lambda subject: subject["geometry_origin"].update(optimized=True),
        lambda subject: subject["selection"].update(run_ref="sha256:" + "0" * 64),
        lambda subject: subject["graph_validation"].update(potential_stereoelements=False),
        lambda subject: subject["source_snapshot"].update(semantic_hash="sha256:" + "0" * 64),
    ],
)
def test_rehashed_subject_still_cannot_change_spec_raw_closure(case, change):
    replace_artifact_for_negative_test(case, "subject", change)
    with pytest.raises(ValueError, match="raw artifact closure"):
        replay.replay_host_admitted_subject(**case)


@pytest.mark.parametrize(
    "change",
    [
        lambda value: value["coordinate_tokens"][0]["position_tokens"].__setitem__(0, "-0.43"),
        lambda value: value["geometry_origin"].update(rotated=True),
        lambda value: value["candidate"].update(json_pointer="/organic/candidates/0"),
        lambda value: value["source_snapshot"].update(text="different source"),
        lambda value: value["requested_electronic_state"].update(multiplicity=True),
    ],
)
def test_fully_rehashed_outer_chain_still_reconstructs_subject(case, change):
    reference = admission_of(case)["artifacts"]["subject"]
    subject = replay.load_json(replay.read_bound(case["root"], reference))
    change(subject)
    rebind_subject_chain_for_negative_test(case, subject)
    with pytest.raises(ValueError):
        replay.replay_host_admitted_subject(**case)


def test_binary64_identical_coordinate_token_change_is_rejected(case):
    admission = admission_of(case)
    record_path = case["root"] / admission["artifacts"]["design_record"]["path"]
    raw = record_path.read_bytes()
    old = b"-0.43922736421237696"
    new = b"-0.4392273642123769600001"
    assert float(old) == float(new) and old in raw
    changed = raw.replace(old, new)
    assert replay.canonical_hash(json.loads(raw)) == replay.canonical_hash(json.loads(changed))
    record_path.write_bytes(changed)
    subject = replay.load_json(replay.read_bound(case["root"], admission["artifacts"]["subject"]))
    rebind_subject_chain_for_negative_test(case, subject, ref(record_path, case["root"]))
    with pytest.raises(ValueError, match="exact spec geometry"):
        replay.replay_host_admitted_subject(**case)


@pytest.mark.parametrize(
    "field,value",
    [
        ("full_subject_spec_validation", 1),
        ("source_semantic_hash", "sha256:" + "0" * 64),
        ("molecule_object_hash", "sha256:" + "0" * 64),
    ],
)
def test_compiler_results_are_bound_host_outputs(case, field, value):
    admission = admission_of(case)
    admission["host_validation"][field] = value
    replace_admission_for_negative_test(case, admission)
    with pytest.raises(ValueError):
        replay.replay_host_admitted_subject(**case)


@pytest.mark.parametrize(
    "path",
    [
        "../escape",
        "C:/escape",
        "/absolute",
        "a\\b",
        "a//b",
        "a/./b",
        "a./b",
        "NUL",
        "a/COM1.json",
        "a/file?.json",
        "a/file*.json",
    ],
)
def test_unsafe_paths_fail(path):
    with pytest.raises(ValueError):
        replay.artifact_ref({"path": path, "sha256": "0" * 64})


def test_linked_component_fails(case, monkeypatch):
    original = Path.is_symlink
    target = case["root"] / "evidence"
    monkeypatch.setattr(Path, "is_symlink", lambda self: self == target or original(self))
    with pytest.raises(ValueError, match="linked"):
        replay.replay_host_admitted_subject(**case)


@pytest.mark.parametrize("raw", [b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":1e9999}', b"[]"])
def test_strict_json(raw):
    with pytest.raises(ValueError):
        replay.load_json(raw)


def test_worker_does_not_import_optional_runtime_or_host_graph_libraries(portable_case):
    script = """
import importlib.abc,json,sys
from pathlib import Path
class Block(importlib.abc.MetaPathFinder):
 def find_spec(self, fullname, path=None, target=None):
  if fullname.split('.')[0] in {'rdkit','psi4','qcengine','qcelemental','optking'}:
   raise AssertionError('Optional runtime import forbidden: ' + fullname)
sys.meta_path.insert(0,Block())
root=Path(sys.argv[1])
from chem_workbench.refinement_execution.worker_subject_replay import replay_host_admitted_subject
from chem_workbench.molecular_refinement import validate_refinement_spec
fixture=json.loads((root/'fixture.json').read_bytes())
request_spec=json.loads((root/fixture['spec']['path']).read_bytes())
result=replay_host_admitted_subject(root=root,trusted_admission_ref=fixture['admission'],expected_spec_ref=fixture['spec'],request_spec=request_spec,validate_spec=validate_refinement_spec)
assert len(result['subject']['geometry']['atoms'])==34
assert not result['computation_authorized']
print('Pure spec validator and replay: optional native/graph imports blocked')
"""
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    result = subprocess.run(
        [sys.executable, "-I", "-B", "-c", script, str(portable_case[0])],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "optional native/graph imports blocked" in result.stdout
