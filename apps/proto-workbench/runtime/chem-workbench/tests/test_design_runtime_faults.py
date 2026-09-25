"""Twenty observed runtime faults plus verifier tamper and instrumentation checks."""

from __future__ import annotations

import copy
import importlib.util
import json
import socket
import subprocess
import sys
from collections import Counter
from pathlib import Path

import pytest

from chem_workbench.visualization import content_hash

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/verify_design_runtime_faults.py"
SPEC = importlib.util.spec_from_file_location("design_runtime_faults_tests", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
HARNESS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HARNESS)


@pytest.mark.parametrize("case", HARNESS.cases(), ids=lambda case: case["id"])
def test_real_host_fault_retains_evidence_and_stops_at_observed_boundary(tmp_path, case):
    row = HARNESS.run_case(case, tmp_path / case["id"])
    evidence = row["evidence"]
    assert row["passed"], evidence["checks"]
    assert all(evidence["source_provenance_checks"].values())
    assert evidence["record"]["state"] == "failed"
    assert evidence["exception"]["type"] == "DesignRunError"
    assert evidence["live_model_calls"] == 0
    assert evidence["evidence_hash"] == content_hash(
        {key: value for key, value in evidence.items() if key != "evidence_hash"}
    )
    if case["slot"] == "storage":
        assert evidence["record"]["persistence"]["saved"] is False
        assert not evidence["persisted_record_files"]
        assert evidence["record"]["trace"][-1]["status"] == "succeeded"
    elif case["slot"] == "module":
        assert evidence["record"]["trace"][-1]["status"] == "failed"
        assert case["module_family"] in evidence["record"]["trace"][-1]["error"]["message"]
    else:
        assert not evidence["module_dispatches"]
        assert not evidence["record"]["trace"]
        if case["slot"] == "parser":
            calls = evidence["record"]["orchestration"]["provider_calls"]
            assert len(calls) == 2 and all(call["schema_valid"] is False for call in calls)
            assert all(call["response_text"] for call in calls)


def test_matrix_has_four_distinct_fault_boundaries_per_design_lane():
    matrix = HARNESS.cases()
    assert len(matrix) == len({case["id"] for case in matrix}) == 20
    assert Counter(case["module_family"] for case in matrix) == dict.fromkeys(HARNESS.LANES, 4)
    for lane in HARNESS.LANES:
        assert {case["slot"] for case in matrix if case["module_family"] == lane} == {
            "provider",
            "parser",
            "module",
            "storage",
        }


def test_guard_denies_real_python_network_and_child_process_attempts_before_effect():
    guard = HARNESS.NoExternalEffects()
    with guard:
        with (
            socket.socket() as connection,
            pytest.raises(PermissionError, match="EXTERNAL_EFFECT_DENIED"),
        ):
            connection.connect(("127.0.0.1", 9))
        with pytest.raises(PermissionError, match="EXTERNAL_EFFECT_DENIED"):
            subprocess.Popen([sys.executable, "-c", "raise SystemExit(0)"])
    assert [event["event"] for event in guard.events] == ["socket.connect", "subprocess.Popen"]
    assert all(event["outcome"] == "denied_before_effect" for event in guard.events)
    assert not guard.active


def test_changed_source_record_fails_verifier_instead_of_trusting_success_boolean(
    tmp_path, monkeypatch
):
    original = HARNESS.design_studio.DesignStudio.run

    def altered(studio, request):
        try:
            return original(studio, request)
        except HARNESS.design_studio.DesignRunError as error:
            record = copy.deepcopy(error.record)
            record["request"]["study"]["organic"]["source"] = "Tampered provenance"
            record["record_hash"] = content_hash(
                {key: value for key, value in record.items() if key != "record_hash"}
            )
            raise HARNESS.design_studio.DesignRunError(str(error), record) from error

    monkeypatch.setattr(HARNESS.design_studio.DesignStudio, "run", altered)
    row = HARNESS.run_case(HARNESS.cases()[0], tmp_path / "tampered")
    assert not row["passed"]
    assert not row["evidence"]["checks"]["source_provenance"]
    assert not row["evidence"]["checks"]["honest_persistence_outcome"]


def test_manifest_binds_current_code_and_preserves_failed_denominator(tmp_path, monkeypatch):
    identity = {"source.py": content_hash("Frozen source")}
    monkeypatch.setattr(HARNESS, "code_identity", lambda root: identity)
    case = HARNESS.cases()[0]
    monkeypatch.setattr(HARNESS, "cases", lambda: [case])
    monkeypatch.setattr(
        HARNESS,
        "run_case",
        lambda case, root: {
            **case,
            "passed": False,
            "evidence": {"scope": "Verifier aggregation unit fixture"},
        },
    )
    target = tmp_path / "manifest.json"
    manifest = HARNESS.run_manifest(
        content_hash("Frozen suite"),
        target,
        expected_code_identity=identity,
    )
    assert manifest["code_identity"] == identity
    assert manifest["code_identity_hash"] == content_hash(identity)
    assert manifest["total"] == 1 and manifest["passed_count"] == 0
    assert not manifest["passed"] and not manifest["cases"][0]["passed"]
    assert json.loads(target.read_text()) == manifest
    assert manifest["manifest_hash"] == content_hash(
        {key: value for key, value in manifest.items() if key != "manifest_hash"}
    )
    with pytest.raises(FileExistsError):
        HARNESS.run_manifest(content_hash("Frozen suite"), target)
    with pytest.raises(ValueError, match="CODE_FREEZE_MISMATCH"):
        HARNESS.run_manifest(
            content_hash("Frozen suite"),
            tmp_path / "mismatch.json",
            expected_code_identity={"changed": "wrong"},
        )


def test_code_change_during_fault_run_cannot_claim_frozen_acceptance(tmp_path, monkeypatch):
    calls = iter([{"module": "before"}, {"module": "after"}])
    monkeypatch.setattr(HARNESS, "code_identity", lambda root: next(calls))
    monkeypatch.setattr(HARNESS, "cases", lambda: [])
    result = HARNESS.run_manifest(content_hash("Frozen suite"), tmp_path / "drift.json")
    assert not result["code_identity_unchanged"] and not result["passed"]


def test_frozen_fixture_identity_uses_embedded_suite_and_rejects_tampering(tmp_path):
    suite = {"version": "unit-fixture-suite"}
    suite["suite_hash"] = content_hash(suite)
    fixture = {
        "version": "design-model-fixtures/v1",
        "suite": suite,
        "code_identity": {"example.py": content_hash("Frozen unit fixture")},
    }
    fixture["fixtures_hash"] = content_hash(fixture)
    path = tmp_path / "fixtures.json"
    path.write_text(json.dumps(fixture), encoding="utf-8")
    assert HARNESS.fixture_identity(path, suite["suite_hash"]) == fixture["code_identity"]
    with pytest.raises(ValueError, match="SUITE_FREEZE_MISMATCH"):
        HARNESS.fixture_identity(path, content_hash("Different suite"))
    fixture["code_identity"]["example.py"] = "Tampered"
    path.write_text(json.dumps(fixture), encoding="utf-8")
    with pytest.raises(ValueError, match="FIXTURES_HASH_MISMATCH"):
        HARNESS.fixture_identity(path, suite["suite_hash"])


@pytest.mark.parametrize("digest", ["", "sha256:bad", "sha256:" + "g" * 64])
def test_invalid_suite_hash_is_rejected_before_creating_artifacts(tmp_path, digest):
    target = tmp_path / "rejected.json"
    with pytest.raises(ValueError, match="SUITE_HASH_REQUIRED"):
        HARNESS.run_manifest(digest, target)
    assert not target.exists() and not target.with_suffix(".evidence").exists()
