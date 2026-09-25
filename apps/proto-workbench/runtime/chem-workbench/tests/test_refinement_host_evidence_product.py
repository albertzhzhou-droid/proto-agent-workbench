"""Host filesystem tests using an existing explicitly synthetic 34-atom run.

No observer is executed. Copied old traces must never certify a new run.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import stat
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from refinement_evidence_fixtures import FIXTURES, materialize_bound_artifacts

from chem_workbench import molecular_refinement as records
from chem_workbench.refinement_execution import contract_result_evidence as evidence
from chem_workbench.refinement_execution import execution_contract
from chem_workbench.refinement_execution.host_evidence import ContainedReader, HostEvidenceSession

RETAINED = FIXTURES / "past_run"
SPEC = FIXTURES / "input.json"


def put(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = body if type(body) is bytes else json.dumps(body, allow_nan=False).encode()
    with path.open("xb") as stream:
        stream.write(raw)


class Fixture:
    def __init__(self, tmp_path, **overrides):
        self.root = tmp_path
        materialize_bound_artifacts(self.root)
        self.path = tmp_path / "synthetic-run"
        self.path.mkdir()
        self.run = self.path.relative_to(self.root).as_posix()
        self.source_path = tmp_path / "synthetic-host-source.txt"
        put(self.source_path, b"synthetic identity fixture, not product source\n")
        self.spec = json.loads(SPEC.read_bytes())["spec"]
        self.contract = execution_contract.seal_execution_contract(self.spec, "gradient")
        self.worker = {"kind": "psi4_refinement", "synthetic_test_only": True}
        self.quiescence_calls = 0
        self.config = {
            "ncores": self.spec["resources"]["threads"],
            "memory": self.spec["resources"]["memory_bytes"] / 1024**3 * 0.6,
            "retries": 0,
            "scratch_directory": str(self.path / "scratch"),
        }
        kwargs = dict(
            root=self.root,
            run_directory=self.run,
            run_id="new-synthetic-host-fixture",
            run_nonce="c" * 32,
            spec=self.spec,
            contract=self.contract,
            mode="gradient",
            worker_identity=self.worker,
            source_paths=[self.source_path.relative_to(self.root).as_posix()],
            native_task_config=self.config,
            native_dispersion_version="1.6.0",
            validate_spec=records.validate_refinement_spec,
            validate_contract=execution_contract.validate_execution_contract,
            validate_result=records.validate_refinement_result,
            observe_worker_identity=lambda: copy.deepcopy(self.worker),
            assert_quiescent=self.quiescent,
            auxiliary_names=["worker-lifecycle-events.jsonl"],
        )
        kwargs.update(overrides)
        self.session = HostEvidenceSession(**kwargs)

    def quiescent(self):
        self.quiescence_calls += 1

    def emit_retained(self):
        """Copy old mock bytes only; update outer ownership for assembler tests."""
        for source in (RETAINED / "evaluation-0000-dispatch").rglob("*"):
            if source.is_file():
                put(self.path / source.relative_to(RETAINED), source.read_bytes())
        self.result = json.loads((RETAINED / "synthetic-scientific-result.json").read_bytes())
        assert len(self.result["trajectory"][0]["geometry"]["atoms"]) == 34
        records.validate_refinement_result(self.spec, self.result)
        put(self.path / "worker-result.json", self.result)
        start_path = self.path / "evaluation-0000-dispatch/outer-start.json"
        start = json.loads(start_path.read_bytes())
        start.update(
            run_id="new-synthetic-host-fixture",
            run_nonce="c" * 32,
            monotonic_seconds=time.monotonic(),
        )
        start["task_config"]["scratch_directory"] = str(self.path / "scratch/evaluation-0000")
        start_path.write_text(json.dumps(start), encoding="utf-8")
        put(
            self.path / "worker-lifecycle.json",
            {
                "synthetic_test_only": True,
                "execution_evidence_admission": "unassessed",
                "dispatch_directories": ["worker-picked-false-reference-is-ignored"],
            },
        )
        return self

    def read_diagnostic(self, finalized):
        return json.loads(self.session.reader(finalized.diagnostics_reference))


def test_independent_inventory_assembles_bytes_without_claiming_coverage(tmp_path):
    fixture = Fixture(tmp_path)
    before_inputs = copy.deepcopy((fixture.spec, fixture.contract, fixture.config))
    fixture.session.begin()
    fixture.emit_retained()
    out = fixture.session.finalize()
    assert out.evidence_reference is not None and out.host_context is not None
    assert out.scientific_result == fixture.result
    assert fixture.result["state"] == "incomplete"
    body = json.loads(fixture.session.reader(out.evidence_reference))
    assert body["evaluations"][0]["frame_hash"] == fixture.result["trajectory"][0]["frame_hash"]
    after = json.loads(fixture.session.reader(out.after_reference))
    assert len(after["call_artifacts"]) == len(
        [p for p in (fixture.path / "evaluation-0000-dispatch").rglob("*") if p.is_file()]
    )
    assert any(r["path"].endswith("native-controls-after.json") for r in after["call_artifacts"])
    assert fixture.read_diagnostic(out)["execution_evidence_admission"] == "unassessed"
    assert (fixture.spec, fixture.contract, fixture.config) == before_inputs
    assert not {"psi4", "qcengine", "qcelemental", "optking", "dftd3"} & sys.modules.keys()


def test_old_retained_trace_is_not_retroactively_certified(tmp_path):
    fixture = Fixture(tmp_path)
    fixture.session.begin()
    fixture.emit_retained()
    out = fixture.session.finalize()
    assessment = evidence.assess_contract_result(
        fixture.contract,
        fixture.spec,
        "gradient",
        fixture.result,
        evidence_ref=out.evidence_reference,
        host_context=out.host_context,
        read_artifact=fixture.session.reader,
        validate_contract=execution_contract.validate_execution_contract,
        validate_scientific_result=records.validate_refinement_result,
        validate_optimizer_evidence=None,
    )
    assert assessment["complete"] is False and assessment["errors"]
    assert assessment["scientific_accuracy_validated"] is False


@pytest.mark.parametrize(
    "missing",
    [
        "outer-result.json",
        "outer-start.json",
        "dispatch-observation.json",
        "nested/summary.json",
        "nested/inner-0001-return.json",
    ],
)
def test_missing_returns_and_metadata_stay_missing(tmp_path, missing):
    fixture = Fixture(tmp_path)
    fixture.session.begin()
    fixture.emit_retained()
    (fixture.path / "evaluation-0000-dispatch" / missing).unlink()
    out = fixture.session.finalize()
    assert not (fixture.path / "evaluation-0000-dispatch" / missing).exists()
    assert out.scientific_result == fixture.result
    if missing in {"outer-start.json", "dispatch-observation.json"}:
        assert out.evidence_reference is None
    elif missing == "outer-result.json":
        body = json.loads(fixture.session.reader(out.evidence_reference))
        assert body["evaluations"][0]["outer_return"] is None
        assert body["evaluations"][0]["frame_hash"] is None
    assert fixture.read_diagnostic(out)["execution_evidence_admission"] == "unassessed"


def test_initialization_failure_retains_host_bracket_without_fabricated_result(tmp_path):
    fixture = Fixture(tmp_path)
    fixture.session.begin()
    put(fixture.path / "worker-lifecycle.json", {"initialization_failed": True})
    put(fixture.path / "worker-lifecycle-events.jsonl", b'{"phase":"initialization-failed"}\n')
    out = fixture.session.finalize()
    assert out.after_reference is not None
    assert out.evidence_reference is out.result_reference is out.scientific_result is None
    inventory = json.loads(fixture.session.reader(out.inventory_reference))
    assert len(inventory["files"]) == 2


def test_unknown_call_file_is_included_for_actual_validator(tmp_path):
    fixture = Fixture(tmp_path)
    fixture.session.begin()
    fixture.emit_retained()
    put(fixture.path / "evaluation-0000-dispatch/unreported-call.json", {"synthetic": True})
    out = fixture.session.finalize()
    after = json.loads(fixture.session.reader(out.after_reference))
    assert any(r["path"].endswith("unreported-call.json") for r in after["call_artifacts"])


@pytest.mark.parametrize("where", ["unclassified.json", "unclassified-directory/raw.json"])
def test_unclassified_root_content_prevents_envelope(tmp_path, where):
    fixture = Fixture(tmp_path)
    fixture.session.begin()
    fixture.emit_retained()
    put(fixture.path / where, {"unclassified": True})
    out = fixture.session.finalize()
    assert out.evidence_reference is None
    inventory = json.loads(fixture.session.reader(out.inventory_reference))
    assert inventory["unknown_paths"]


@pytest.mark.parametrize("drift", ["source", "worker", "before"])
def test_bound_identity_or_before_tamper_prevents_envelope(tmp_path, drift):
    fixture = Fixture(tmp_path)
    before = fixture.session.begin()
    fixture.emit_retained()
    if drift == "source":
        fixture.source_path.write_text("changed", encoding="utf-8")
    elif drift == "worker":
        fixture.worker["changed"] = True
    else:
        (fixture.root / before["path"]).write_bytes(b"{}")
    out = fixture.session.finalize()
    assert out.host_context is out.evidence_reference is None
    assert fixture.read_diagnostic(out)["errors"]


def test_raw_result_tamper_retains_reference_and_rejects_scientific_result(tmp_path):
    fixture = Fixture(tmp_path)
    fixture.session.begin()
    fixture.emit_retained()
    (fixture.path / "worker-result.json").write_bytes(b'{"tampered":true}')
    out = fixture.session.finalize()
    assert out.result_reference is not None
    assert out.scientific_result is out.evidence_reference is None


def test_added_file_between_inventory_passes_is_not_certified(tmp_path, monkeypatch):
    fixture = Fixture(tmp_path)
    fixture.session.begin()
    fixture.emit_retained()
    original = fixture.session._inventory
    count = 0

    def changed():
        nonlocal count
        inventory = original()
        count += 1
        if count == 1:
            put(fixture.path / "evaluation-0000-dispatch/late.json", {})
        return inventory

    monkeypatch.setattr(fixture.session, "_inventory", changed)
    out = fixture.session.finalize()
    assert out.evidence_reference is None
    assert any("double host inventory" in e for e in fixture.read_diagnostic(out)["errors"])


def test_quiescence_is_required_at_terminal_boundary(tmp_path):
    fixture = Fixture(tmp_path)
    fixture.session.begin()
    fixture.emit_retained()

    def live():
        raise RuntimeError("owned process still live")

    fixture.session._quiescent = live
    out = fixture.session.finalize()
    assert out.evidence_reference is None and out.after_reference is None


def test_worker_cannot_hide_unknown_file_in_host_namespace(tmp_path):
    fixture = Fixture(tmp_path)
    fixture.session.begin()
    put(fixture.path / "host-evidence/untrusted.json", {})
    out = fixture.session.finalize()
    assert out.evidence_reference is None
    assert any("unexpected file in host" in e for e in fixture.read_diagnostic(out)["errors"])


def test_exclusive_begin_and_single_finalization(tmp_path):
    fixture = Fixture(tmp_path)
    first = fixture.session.begin()
    with pytest.raises(ValueError, match="single use"):
        fixture.session.begin()
    fixture.session.finalize()
    with pytest.raises(ValueError, match="once"):
        fixture.session.finalize()
    assert fixture.session.reader(first)


def test_existing_dispatch_cannot_be_bracketed(tmp_path):
    fixture = Fixture(tmp_path)
    fixture.emit_retained()
    with pytest.raises(ValueError, match="preexisting"):
        fixture.session.begin()


def test_quiescence_boolean_is_not_a_host_verification(tmp_path):
    fixture = Fixture(tmp_path, assert_quiescent=lambda: True)
    with pytest.raises(ValueError, match="return None or raise"):
        fixture.session.begin()


@pytest.mark.parametrize(
    "relative",
    [
        "../escape",
        "/absolute",
        "C:/absolute",
        "a/../b",
        "a\\b",
        "name.",
        "name ",
        "NUL",
        "a:stream",
    ],
)
def test_path_alias_and_escape_rejected(tmp_path, relative):
    reader = ContainedReader(tmp_path)
    with pytest.raises((ValueError, OSError)):
        reader.raw(relative)


def test_hardlink_rejected_by_fresh_path_stat(tmp_path):
    put(tmp_path / "original", b"bounded bytes")
    os.link(tmp_path / "original", tmp_path / "alias")
    with pytest.raises(ValueError, match="single-link"):
        ContainedReader(tmp_path).raw("alias")


def test_reparse_attribute_rejected(tmp_path, monkeypatch):
    path = tmp_path / "reparse"
    put(path, b"not followed")
    original = Path.lstat

    def marked(candidate):
        if candidate == path:
            return SimpleNamespace(st_mode=stat.S_IFREG, st_file_attributes=0x400)
        return original(candidate)

    monkeypatch.setattr(Path, "lstat", marked)
    with pytest.raises(ValueError, match="reparse"):
        ContainedReader(tmp_path).raw("reparse")


def test_file_replaced_between_stat_and_open_rejected(tmp_path, monkeypatch):
    path = tmp_path / "raw"
    put(path, b"before")
    original = Path.open

    def replaced(candidate, *args, **kwargs):
        if candidate == path and args == ("rb",):
            candidate.write_bytes(b"changed-longer")
        return original(candidate, *args, **kwargs)

    monkeypatch.setattr(Path, "open", replaced)
    with pytest.raises(ValueError, match="replaced"):
        ContainedReader(tmp_path).raw("raw")


def test_atomic_publication_never_overwrites_or_leaves_pending(tmp_path):
    reader = ContainedReader(tmp_path)
    (tmp_path / "host").mkdir()
    first = reader.publish("host", "record.json", {"initial": True})
    with pytest.raises(FileExistsError):
        reader.publish("host", "record.json", {"overwrite": True})
    assert reader(first) == (tmp_path / "host/record.json").read_bytes()
    assert not list((tmp_path / "host").glob(".pending-*"))


def test_reader_verifies_bound_hash(tmp_path):
    put(tmp_path / "raw", b"original")
    reader = ContainedReader(tmp_path)
    ref = reader.ref("raw")
    (tmp_path / "raw").write_bytes(b"mutated")
    with pytest.raises(ValueError, match="hash changed"):
        reader(ref)
    assert ref["sha256"] == hashlib.sha256(b"original").hexdigest()


@pytest.mark.parametrize("limit", ["entries", "depth"])
def test_empty_directories_are_bounded_and_partial_inventory_is_retained(tmp_path, limit):
    limits = {"max_inventory_entries": 3} if limit == "entries" else {"max_inventory_depth": 1}
    fixture = Fixture(tmp_path, **limits)
    fixture.session.begin()
    dispatch = fixture.path / "evaluation-0000-dispatch"
    if limit == "entries":
        for index in range(5):
            (dispatch / str(index)).mkdir(parents=True)
    else:
        (dispatch / "nested/deeper").mkdir(parents=True)
    out = fixture.session.finalize()
    assert out.evidence_reference is None
    inventory = json.loads(fixture.session.reader(out.inventory_reference))
    assert inventory["inventory_observed"] is True and inventory["complete_scan"] is False
    assert inventory["directories"]
    assert any(
        "budget" in error or "depth" in error for error in fixture.read_diagnostic(out)["errors"]
    )


def test_scratch_is_metadata_only_and_large_native_file_is_not_a_call(tmp_path):
    fixture = Fixture(tmp_path)
    fixture.session.begin()
    (fixture.path / "scratch").mkdir()
    with (fixture.path / "scratch/native-large.dat").open("xb") as stream:
        stream.seek(21 * 1024**2)
        stream.write(b"0")
    out = fixture.session.finalize()
    inventory = json.loads(fixture.session.reader(out.inventory_reference))
    assert inventory["stable_observation"] is True
    assert inventory["files"] == inventory["call_artifacts"] == []
    assert any(item["path"].endswith("/scratch") for item in inventory["excluded_subtree_metadata"])


def test_repeated_identical_bytes_are_bound_by_actual_evaluation_index(tmp_path):
    fixture = Fixture(tmp_path)
    fixture.session.begin()
    fixture.emit_retained()
    # Exercise association only; this mutated record is NOT a sealed science result.
    result = copy.deepcopy(fixture.result)
    repeated = copy.deepcopy(result["trajectory"][0])
    repeated.update(
        evaluation_index=1,
        raw_input_artifact_id="evaluation-0001-input",
        raw_result_artifact_id="evaluation-0001-result",
        frame_hash="sha256:" + "b" * 64,
    )
    result["trajectory"].append(repeated)
    errors = []
    entries = fixture.session._entries(fixture.session._inventory(), result, errors)
    assert not errors
    assert entries[0]["frame_hash"] == result["trajectory"][0]["frame_hash"]


@pytest.mark.parametrize(
    "field,value",
    [
        ("retries", True),
        ("retries", 1),
        ("ncores", True),
        ("memory", True),
        ("memory", float("inf")),
        ("scratch_directory", "C:\\outside"),
    ],
)
def test_resource_and_scratch_mismatch_rejected(tmp_path, field, value):
    spec = json.loads(SPEC.read_bytes())["spec"]
    config = {
        "ncores": spec["resources"]["threads"],
        "retries": 0,
        "memory": 1,
        "scratch_directory": str(tmp_path / "synthetic-run/scratch"),
    }
    config[field] = value
    with pytest.raises(ValueError):
        Fixture(tmp_path, native_task_config=config)
