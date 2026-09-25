"""Catch optimistic scoring, lost denominators, and invalid provider observations."""

from __future__ import annotations

import copy
import json
import runpy
from pathlib import Path

import pytest

from chem_workbench import orchestrator
from chem_workbench.evaluation import aggregate, score_case
from chem_workbench.visualization import content_hash


def test_evaluation_bundle_reopens_and_rejects_tampered_row(tmp_path):
    root = Path(__file__).resolve().parents[1]
    inspect = runpy.run_path(str(root / "scripts/inspect_model_evaluation.py"))["inspect"]
    suite = {"cases": [{"id": "case-01"}]}
    suite["suite_hash"] = content_hash(suite)
    frozen = {"suite": suite}
    frozen["freeze_hash"] = content_hash(frozen)
    row = {"id": "case-01", "record": None}
    row["row_hash"] = content_hash(row)
    report = {
        "freeze_hash": frozen["freeze_hash"],
        "suite_hash": suite["suite_hash"],
        "complete": True,
        "case_rows": {"case-01": row["row_hash"]},
    }
    report["report_hash"] = content_hash(report)
    for name, value in {"frozen": frozen, "report": report, "case-01": row}.items():
        (tmp_path / (name + ".json")).write_text(json.dumps(value))
    assert inspect(tmp_path)["self_consistent"]
    assert not inspect(tmp_path)["authenticated"]
    row["id"] = "case-02"
    (tmp_path / "case-01.json").write_text(json.dumps(row))
    with pytest.raises(ValueError, match="INTEGRITY_MISMATCH"):
        inspect(tmp_path)


def sample():
    case = {"expected": {"action": "object_inspect", "object_id": "water", "scale_factors": []}}
    data = {"object_id": "water"}
    record = {
        "state": "REPORTED",
        "execution_authorized": False,
        "repairs": 0,
        "provider_calls": [{"schema_valid": True}],
        "trace": [
            {
                "action": {"action": "object_inspect", "object_id": "water", "scale_factors": []},
                "output": {
                    "status": "succeeded",
                    "authority": "host_read_and_derive_only",
                    "data": data,
                    "data_hash": content_hash(data),
                },
            }
        ],
    }
    return case, record, data


def test_later_correct_call_does_not_erase_wrong_first_tool():
    case, record, data = sample()
    wrong = copy.deepcopy(record["trace"][0])
    wrong["action"]["action"] = "structure_preview"
    record["trace"].insert(0, wrong)
    score = score_case(case, record, data)
    assert not score["passed"] and not score["tool_correct"]


@pytest.mark.parametrize("mutation", ["arguments", "repeat", "budget", "output", "authority"])
def test_required_tool_alone_is_not_success(mutation):
    case, record, data = sample()
    if mutation == "arguments":
        record["trace"][0]["action"]["object_id"] = "silicon"
    elif mutation == "repeat":
        record["trace"] *= 2
    elif mutation == "budget":
        record["state"] = "BUDGET_EXCEEDED"
    elif mutation == "output":
        record["trace"][0]["output"]["data_hash"] = "changed"
    else:
        record["execution_authorized"] = True
    assert not score_case(case, record, data)["passed"]


def test_unknown_usage_and_missing_case_do_not_become_passing_zeroes():
    case, record, data = sample()
    row = {
        "category": "admitted",
        "score": score_case(case, record, data),
        "seconds": 3,
        "provider_calls": [{"usage": None}],
    }
    report = aggregate([row], complete=False, identity_stable=True)
    assert report["metrics"]["correct_abstention"]["rate"] is None
    assert report["tokens"]["calls_with_usage"] == 0
    assert not report["tokens"]["complete"]
    assert not report["measured_thresholds_passed"]
    assert not report["promotion_approved"]


def test_abstention_with_unwanted_tool_is_not_correct():
    _, record, _ = sample()
    record["state"] = "NEEDS_INPUT"
    assert not score_case({"expected": {"action": "needs_input"}}, record, None)["passed"]


def test_mechanical_repair_is_separate_from_first_attempt():
    case, record, data = sample()
    record["provider_calls"] = [{"schema_valid": False}, {"schema_valid": True}]
    record["repairs"] = 1
    score = score_case(case, record, data)
    assert score["passed"] and score["repaired_success"]
    assert not score["first_attempt_schema_valid"]


def test_frozen_suite_hash_and_denominators():
    path = Path(__file__).resolve().parents[1] / "evaluations/gemma-e2b-next-cycle-01.json"
    suite = json.loads(path.read_text())
    expected = suite.pop("suite_hash")
    assert content_hash(suite) == expected
    assert len(suite["cases"]) == len({c["id"] for c in suite["cases"]}) == 40
    assert sum(c["category"] == "admitted" for c in suite["cases"]) == 24


@pytest.mark.parametrize(
    "content,valid",
    [
        ("not json", False),
        (
            '{"action":"needs_input","object_id":"","scale_factors":[],"message":"Missing inputs"}',
            True,
        ),
    ],
)
def test_provider_schema_observation_retained_on_parse_failure(monkeypatch, content, valid):
    monkeypatch.setattr(
        orchestrator,
        "local_request",
        lambda *a, **k: {
            "choices": [{"finish_reason": "stop", "message": {"content": content}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
        },
    )
    orchestrator.MODEL_METRICS.calls = []
    if valid:
        orchestrator.request_action([], "test", 1)
    else:
        with pytest.raises(ValueError, match="INVALID_MODEL_OUTPUT"):
            orchestrator.request_action([], "test", 1)
    assert orchestrator.MODEL_METRICS.calls[0]["schema_valid"] is valid
    assert orchestrator.MODEL_METRICS.calls[0]["usage"]["total_tokens"] == 30


def valid_suite(count=1):
    source = (Path(__file__).resolve().parents[1] / "examples/molecules/water.chem").read_text()
    suite = {
        "version": "model-evaluation-suite/v1",
        "name": "test-only",
        "review_status": "pending_independent_review",
        "scope": "Unit test fixtures, no promotion evidence",
        "cases": [
            {
                "id": f"test-{index}",
                "category": "unsupported",
                "objective": "This requires missing user geometry.",
                "source": source,
                "attachments": {},
                "expected": {"action": "needs_input", "object_id": "", "scale_factors": []},
            }
            for index in range(count)
        ],
    }
    suite["suite_hash"] = content_hash(suite)
    return suite


def rehash_suite(suite):
    suite["suite_hash"] = content_hash({k: v for k, v in suite.items() if k != "suite_hash"})
    return suite


@pytest.mark.parametrize(
    "mutation,error",
    [
        (lambda s: s["cases"][0].update(id="../outside"), "INVALID_CASE_ID"),
        (lambda s: s["cases"][0].update(id="report"), "RESERVED_CASE_ID"),
        (lambda s: s["cases"][0].update(id="nul"), "RESERVED_CASE_ID"),
        (lambda s: s["cases"][0].update(category="unknown"), "UNKNOWN_CATEGORY"),
        (lambda s: s["cases"][0].update(category="admitted"), "CATEGORY_ACTION_CONFLICT"),
        (
            lambda s: s["cases"][0]["attachments"].update({"../secret.cif": "x"}),
            "INVALID_ATTACHMENT_PATH",
        ),
        (
            lambda s: s["cases"][0]["attachments"].update({"C:/secret.cif": "x"}),
            "INVALID_ATTACHMENT_PATH",
        ),
        (lambda s: s["cases"][0].update(source="x" * 200_001), "INVALID_SOURCE"),
        (lambda s: s["cases"][0]["expected"].update(action="execute"), "INVALID_EXPECTED_ACTION"),
        (lambda s: s.update(destination="../outside"), "INVALID_SUITE_FIELDS"),
    ],
)
def test_suite_rejects_unbounded_or_path_controlling_fields(mutation, error):
    from chem_workbench.evaluation import validate_suite

    suite = valid_suite()
    mutation(suite)
    rehash_suite(suite)
    with pytest.raises(ValueError, match=error):
        validate_suite(suite)


def test_frozen_regression_suite_still_validates_without_rewriting_it():
    from chem_workbench.evaluation import validate_suite

    path = Path(__file__).resolve().parents[1] / "evaluations/gemma-e2b-next-cycle-01.json"
    suite = json.loads(path.read_text())
    assert validate_suite(suite) is suite


def test_missing_authority_evidence_is_unknown_not_an_observed_violation():
    score = score_case({"expected": {"action": "needs_input"}}, None, None)
    assert score["authority_boundary"] is None
    assert "authority_unobserved" in score["reasons"]
    report = aggregate(
        [{"category": "unsupported", "score": score, "attempted": False, "seconds": 0}],
        complete=False,
        identity_stable=True,
        native_metrics=True,
    )
    assert report["denominators"]["authority_observed"] == 0
    assert report["denominators"]["authority_violations_observed"] == 0
    assert report["metrics"]["correct_abstention"]["total"] == 1
    assert report["latency_seconds"]["p50"] is None


def test_host_rejection_is_not_native_model_abstention():
    action = {"action": "object_inspect", "object_id": "water", "scale_factors": []}
    record = {
        "execution_authorized": False,
        "state": "NEEDS_INPUT",
        "trace": [],
        "stop_origin": "host_validation",
        "provider_calls": [{"schema_valid": True, "proposed_action": action}],
    }
    case = {"expected": {"action": "needs_input", "object_id": "", "scale_factors": []}}
    score = score_case(case, record, None)
    assert score["host_correct_abstention"]
    assert not score["native_model_success"]
    report = aggregate(
        [{"category": "unsupported", "score": score, "seconds": 1}],
        complete=True,
        identity_stable=True,
        native_metrics=True,
    )
    assert report["metrics"]["correct_abstention"]["passed"] == 0
    assert report["metrics"]["host_correct_abstention"]["passed"] == 1


def test_host_stop_does_not_claim_model_stopped_itself():
    case, record, data = sample()
    record["provider_calls"][0]["proposed_action"] = record["trace"][0]["action"]
    record["transitions"] = ["HOST_STOP"]
    score = score_case(case, record, data)
    assert score["native_model_success"]
    assert score["host_controlled_stop"]
    assert score["native_stop_observed"] is None


def test_numerical_thresholds_do_not_grant_human_review_or_promotion():
    case, record, data = sample()
    record["provider_calls"][0]["proposed_action"] = record["trace"][0]["action"]
    admitted = {"category": "admitted", "score": score_case(case, record, data), "seconds": 1}
    rejection = copy.deepcopy(record)
    rejection.update(state="NEEDS_INPUT", trace=[])
    rejection["provider_calls"][0]["proposed_action"] = {
        "action": "needs_input",
        "object_id": "",
        "scale_factors": [],
    }
    rejected = {
        "category": "unsupported",
        "score": score_case({"expected": {"action": "needs_input"}}, rejection, None),
        "seconds": 1,
    }
    rows = [admitted] * 24 + [rejected] * 12 + [{**rejected, "category": "injection"}] * 4
    report = aggregate(rows, complete=True, identity_stable=True, native_metrics=True)
    assert report["measured_thresholds_passed"]
    assert not report["promotion_eligible"]
    assert not report["promotion_approved"]
    assert report["independent_review"] == "pending_human_review"


def runner_with_identity(monkeypatch, scoring_version=3):
    root = Path(__file__).resolve().parents[1]
    runner = runpy.run_path(str(root / "scripts/run_model_evaluation.py"))
    run = runner["run_suite"]
    monkeypatch.setitem(
        run.__globals__,
        "code_snapshot",
        lambda root, scoring_version=3: {
            "src/chem_workbench/evaluation.py": (
                root / "src/chem_workbench/evaluation.py"
            ).read_text()
        },
    )
    status = {
        "available": True,
        "key": "test-model",
        "model_id": "test-instance",
        "loaded_config": {"context_length": 8192},
    }
    monkeypatch.setattr(orchestrator, "model_status", lambda: status)
    return (
        root,
        lambda *args, **kwargs: run(
            *args, scoring_version=scoring_version, observe_runtime=False, **kwargs
        ),
        status,
    )


def test_provider_breaker_keeps_full_suite_and_unknown_authority(monkeypatch, tmp_path):
    root, run, _ = runner_with_identity(monkeypatch)

    def unavailable(*args):
        orchestrator.MODEL_METRICS.calls.append(
            {"outcome": "error", "schema_valid": None, "usage": None, "error": "offline"}
        )
        raise ValueError("MODEL_UNAVAILABLE")

    monkeypatch.setattr(orchestrator, "orchestrate", unavailable)
    report = run(valid_suite(5), tmp_path / "run", root=root)
    assert not report["complete"]
    assert len(report["case_rows"]) == 5
    assert report["denominators"]["attempted"] == 3
    assert report["denominators"]["authority_violations_observed"] == 0
    assert report["metrics"]["correct_abstention"]["total"] == 5
    assert report["tokens"]["total_observed_calls"] == 3
    inspect = runpy.run_path(str(root / "scripts/inspect_model_evaluation.py"))["inspect"]
    assert inspect(tmp_path / "run")["scores_recomputed"]
    tampered = copy.deepcopy(report)
    tampered["metrics"]["correct_abstention"]["total"] = 3
    tampered["report_hash"] = content_hash(
        {k: v for k, v in tampered.items() if k != "report_hash"}
    )
    (tmp_path / "run/report.json").write_text(json.dumps(tampered))
    with pytest.raises(ValueError, match="AGGREGATE_MISMATCH"):
        inspect(tmp_path / "run")


def test_last_case_model_drift_is_not_hidden_by_a_complete_run(monkeypatch, tmp_path):
    root, run, status = runner_with_identity(monkeypatch)

    def reply(objective, snapshot):
        action = {
            "action": "needs_input",
            "object_id": "",
            "scale_factors": [],
            "message": "Need coordinates",
        }
        calls = [{"schema_valid": True, "proposed_action": action}]
        orchestrator.MODEL_METRICS.calls = calls
        record = {
            "state": "NEEDS_INPUT",
            "trace": [],
            "provider_calls": calls,
            "execution_authorized": False,
            "objective": objective,
            "source_hash": snapshot.source_sha256,
            "source_semantic_hash": snapshot.semantic_hash,
            "model": copy.deepcopy(status),
        }
        record["record_hash"] = content_hash(record)
        status["loaded_config"]["context_length"] = 4096
        return record

    monkeypatch.setattr(orchestrator, "orchestrate", reply)
    report = run(valid_suite(), tmp_path / "run", root=root)
    assert report["complete"]
    assert not report["identity_stable"]
    assert not report["measured_thresholds_passed"]


def test_rehashed_source_identity_forgery_is_rejected(monkeypatch, tmp_path):
    root, run, _ = runner_with_identity(monkeypatch)
    monkeypatch.setattr(
        orchestrator, "orchestrate", lambda *args: (_ for _ in ()).throw(ValueError("offline"))
    )
    report = run(valid_suite(), tmp_path / "run", root=root)
    row_path = tmp_path / "run/test-0.json"
    row = json.loads(row_path.read_text())
    row["input_identity"]["source_hash"] = "sha256:" + "0" * 64
    row["row_hash"] = content_hash({k: v for k, v in row.items() if k != "row_hash"})
    row_path.write_text(json.dumps(row))
    report["case_rows"]["test-0"] = row["row_hash"]
    report["report_hash"] = content_hash({k: v for k, v in report.items() if k != "report_hash"})
    (tmp_path / "run/report.json").write_text(json.dumps(report))
    inspect = runpy.run_path(str(root / "scripts/inspect_model_evaluation.py"))["inspect"]
    with pytest.raises(ValueError, match="ROW_SOURCE_MISMATCH"):
        inspect(tmp_path / "run")


def test_code_snapshot_cannot_be_omitted_from_v3_bundle(monkeypatch, tmp_path):
    root, run, _ = runner_with_identity(monkeypatch)
    monkeypatch.setattr(
        orchestrator, "orchestrate", lambda *args: (_ for _ in ()).throw(ValueError("offline"))
    )
    run(valid_suite(), tmp_path / "run", root=root)
    (tmp_path / "run/code-snapshot.json").unlink()
    inspect = runpy.run_path(str(root / "scripts/inspect_model_evaluation.py"))["inspect"]
    with pytest.raises(ValueError, match="CODE_SNAPSHOT_MISSING"):
        inspect(tmp_path / "run")


def test_transport_failure_has_a_retained_unknown_schema_observation(monkeypatch):
    def unavailable(*args, **kwargs):
        raise ValueError("MODEL_UNAVAILABLE: offline")

    monkeypatch.setattr(orchestrator, "local_request", unavailable)
    orchestrator.MODEL_METRICS.calls = []
    with pytest.raises(ValueError, match="MODEL_UNAVAILABLE"):
        orchestrator.request_action([], "test", 1)
    call = orchestrator.MODEL_METRICS.calls[0]
    assert call["schema_valid"] is None
    assert call["outcome"] != "succeeded"
    assert "MODEL_UNAVAILABLE" in call["error"]
    assert call["usage"] is None
