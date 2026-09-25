"""V4 evidence must survive stage retries, host intervention and complex-suite checks."""

from __future__ import annotations

import copy
import hashlib
import json
import runpy
from pathlib import Path

import pytest
from test_evaluation import runner_with_identity, sample, valid_suite

from chem_workbench import orchestrator
from chem_workbench.evaluation import (
    PROMOTION_EVIDENCE_GATES,
    PROMOTION_FAMILIES,
    aggregate_v4,
    assess_promotion,
    score_case_v4,
    suite_coverage,
    verify_complex_chemistry,
)
from chem_workbench.visualization import content_hash

ROOT = Path(__file__).resolve().parents[1]


def staged_sample():
    case, record, data = sample()
    case.update(id="positive", category="admitted", family="admitted_complete")
    action = record["trace"][0]["action"]
    record["model_action"] = action
    record["provider_calls"] = [
        {"stage": "requirements", "schema_valid": True, "proposed_action": {"intent": "inspect"}},
        {"stage": "action", "schema_valid": True, "proposed_action": action},
    ]
    return case, record, data


def row(case, record, data):
    return {
        "id": case["id"],
        "category": case["category"],
        "family": case.get("family"),
        "score": score_case_v4(case, record, data),
        "seconds": 1,
        "provider_calls": record["provider_calls"],
        "record": record,
    }


def test_requirements_stage_is_not_action_selection_or_a_retry():
    case, record, data = staged_sample()
    score = score_case_v4(case, record, data)
    assert score["native_model_success"] and score["reviewed_model_success"]
    assert score["stage_first_attempt_schema"] == {"requirements": True, "action": True}
    assert score["observed_retry_calls"] == 0
    record["provider_calls"] = record["provider_calls"][:1]
    score = score_case_v4(case, record, data)
    assert not score["reviewed_model_success"] and not score["native_model_success"]


def test_repaired_requirements_cannot_count_as_native_first_attempt_success():
    case, record, data = staged_sample()
    record["provider_calls"].insert(0, {"stage": "requirements", "schema_valid": False})
    score = score_case_v4(case, record, data)
    assert score["initial_action_selection_correct"] and score["first_tool_proposal_schema_valid"]
    assert score["native_model_success"] and score["reviewed_model_success"]
    assert score["observed_retry_calls"] == 1
    assert not score["native_first_attempt_success"]


def test_record_context_error_cannot_keep_native_first_attempt_credit(monkeypatch, tmp_path):
    root, run, status = runner_with_identity(monkeypatch, scoring_version=4)

    def reply(objective, snapshot):
        action = {
            "action": "needs_input",
            "object_id": "",
            "scale_factors": [],
            "message": "Missing state",
        }
        calls = [{"stage": "action", "schema_valid": True, "proposed_action": action}]
        orchestrator.MODEL_METRICS.calls = calls
        record = {
            "state": "NEEDS_INPUT",
            "trace": [],
            "provider_calls": calls,
            "execution_authorized": False,
            "objective": objective,
            "source_hash": "sha256:" + "0" * 64,
            "source_semantic_hash": snapshot.semantic_hash,
            "model": copy.deepcopy(status),
            "model_action": action,
        }
        record["record_hash"] = content_hash(record)
        return record

    monkeypatch.setattr(orchestrator, "orchestrate", reply)
    destination = tmp_path / "context-error"
    report = run(valid_suite(), destination, root=root)
    identifier = next(iter(report["case_rows"]))
    row = json.loads((destination / (identifier + ".json")).read_text())
    assert row["error"] == "RECORD_CONTEXT_DRIFT"
    assert not row["score"]["native_first_attempt_success"]
    inspect = runpy.run_path(str(ROOT / "scripts/inspect_model_evaluation_v4.py"))["inspect"]
    assert inspect(destination)["scores_recomputed"]


def requirement_refusal():
    expected = {"action": "needs_input", "object_id": "", "scale_factors": []}
    requirements = {
        "disposition": "needs_input",
        "clarification": "Please supply the missing state.",
    }
    case = {
        "id": "missing-state",
        "category": "unsupported",
        "family": "missing_ambiguous",
        "expected": expected,
    }
    record = {
        "execution_authorized": False,
        "state": "NEEDS_INPUT",
        "trace": [],
        "requirements": requirements,
        "decision_source": "requirements",
        "model_action": {**expected, "message": requirements["clarification"]},
        "provider_calls": [
            {"stage": "requirements", "schema_valid": True, "proposed_action": requirements}
        ],
    }
    return case, record


def test_model_sampled_requirements_refusal_is_a_decision_not_a_tool_call():
    case, record = requirement_refusal()
    score = score_case_v4(case, record, None)
    assert score["reviewed_model_abstention"] and score["native_model_success"]
    assert score["first_attempt_schema_valid"] and not score["tool_proposal_observed"]
    assert score["abstention_decision_stage"] == "requirements"
    result = aggregate_v4(
        [row(case, record, None)], complete=True, identity_stable=True, cases=[case]
    )
    assert result["metrics"]["first_tool_proposal_schema"]["total"] == 0
    assert result["metrics"]["initial_decision_selection"]["passed"] == 1
    assert result["abstention_decision_stages"] == {"requirements": 1, "action": 0}


def test_host_cannot_normalize_request_tool_into_a_model_refusal():
    case, record = requirement_refusal()
    record["requirements"]["disposition"] = "request_tool"
    score = score_case_v4(case, record, None)
    assert score["host_correct_abstention"] and not score["reviewed_model_abstention"]
    assert not score["native_model_success"]


def test_repaired_requirement_refusal_keeps_invalid_first_schema():
    case, record = requirement_refusal()
    record["provider_calls"].insert(0, {"stage": "requirements", "schema_valid": False})
    score = score_case_v4(case, record, None)
    assert score["reviewed_model_abstention"] and score["repaired_success"]
    assert not score["first_attempt_schema_valid"] and not score["native_model_success"]


def test_reviewed_correction_does_not_erase_wrong_first_selection():
    case, record, data = staged_sample()
    correct = copy.deepcopy(record["model_action"])
    record["provider_calls"][1]["proposed_action"] = {**correct, "object_id": "wrong"}
    record["provider_calls"].append(
        {"stage": "review", "schema_valid": True, "proposed_action": correct}
    )
    score = score_case_v4(case, record, data)
    assert score["reviewed_model_success"] and score["review_changed_action"]
    assert not score["native_model_success"]
    assert score["observed_retry_calls"] == 0


def test_host_rejection_and_fabricated_final_action_cannot_score_model_abstention():
    case, record, _ = staged_sample()
    expected = {"action": "needs_input", "object_id": "", "scale_factors": []}
    case["expected"] = expected
    record.update(trace=[], state="NEEDS_INPUT", model_action=expected)
    score = score_case_v4(case, record, None)
    assert score["host_correct_abstention"] and score["host_intervention"]
    assert not score["reviewed_model_abstention"]


def test_failed_terminal_retry_keeps_denominator_without_final_record():
    case, _, _ = staged_sample()
    calls = [
        {"stage": "requirements", "schema_valid": True},
        {"stage": "action", "schema_valid": False},
        {"stage": "action", "schema_valid": False},
    ]
    scored = score_case_v4(case, {"provider_calls": calls}, None)
    rows = [
        {
            "id": case["id"],
            "category": "admitted",
            "record": None,
            "provider_calls": calls,
            "score": scored,
            "seconds": 2,
        }
    ]
    result = aggregate_v4(rows, complete=True, identity_stable=True, cases=[case])
    assert result["metrics"]["repaired_success"]["total"] == 1
    assert result["metrics"]["repaired_success"]["passed"] == 0
    assert result["repairs"] == {"cases": 1, "observed_retry_calls": 1, "terminal_error_cases": 1}
    assert result["denominators"]["authority_observed"] == 0


def test_stage_structure_denominators_and_unknown_timing_remain_visible():
    case, record, data = staged_sample()
    record["provider_calls"][0]["schema_valid"] = False
    record["provider_calls"][1]["seconds"] = 0.5
    result = aggregate_v4(
        [row(case, record, data)], complete=True, identity_stable=True, cases=[case]
    )
    assert result["structured_stage_first_attempt"]["requirements"]["rate"] == 0
    assert result["structured_stage_first_attempt"]["action"]["rate"] == 1
    assert result["structured_stage_first_attempt"]["review"]["total"] == 0
    assert result["model_seconds"]["total"] == 0.5
    assert not result["model_seconds"]["complete"]
    assert result["tool_seconds"]["total"] is None
    assert not result["tool_seconds"]["complete"]
    assert result["metrics"]["admitted_success"]["wilson_95_interval"][0] < 1


def coverage_fixture():
    live, runtime = [], []
    for family, count in PROMOTION_FAMILIES.items():
        selected = runtime if family == "tool_runtime_failures" else live
        selected.extend(
            {"id": f"{family.replace('_', '-')}-{i}", "family": family} for i in range(count)
        )
    manifest = {"version": "test-runtime/v1", "cases": runtime}
    manifest["suite_hash"] = content_hash(manifest)
    return live, manifest


def test_original_150_inventory_includes_separate_runtime_manifest_without_model_credit():
    cases, manifest = coverage_fixture()
    result = suite_coverage(cases, manifest)
    assert result["sufficient"] and result["total_distinct_tasks"] == 150
    assert result["model_cases"] == 130 and result["runtime_manifest_cases"] == 20
    assert not suite_coverage(cases)["sufficient"]
    manifest["cases"][0]["family"] = "admitted_complete"
    with pytest.raises(ValueError, match="RUNTIME_MANIFEST_HASH_MISMATCH"):
        suite_coverage(cases, manifest)


def test_coverage_rejects_duplicate_task_identity_across_manifest_and_suite():
    cases, manifest = coverage_fixture()
    cases.append(copy.deepcopy(manifest["cases"][0]))
    with pytest.raises(ValueError, match="DUPLICATE_COVERAGE_CASE"):
        suite_coverage(cases, manifest)


def test_numerical_pass_and_unverified_gate_booleans_never_complete_promotion():
    result = assess_promotion(
        True, {"sufficient": True}, {key: {"status": "pass"} for key in PROMOTION_EVIDENCE_GATES}
    )
    assert not result["promotion_approved"]
    assert "complex_chemistry_gate" in result["outstanding_gates"]
    assert "admitted_end_to_end" in result["outstanding_gates"]
    assert not any("human" in name for name in result["gates"])


def test_complete_verified_original_gate_checklist_can_pass_without_invented_human_gate():
    evidence = {
        name: {
            "status": "pass",
            "evidence_verified": True,
            "evidence_refs": [{"path": "verified-test.json", "sha256": "a" * 64}],
        }
        for name in PROMOTION_EVIDENCE_GATES
    }
    result = assess_promotion(True, {"sufficient": True}, evidence)
    assert result["promotion_approved"] and not result["execution_authority"]
    evidence["numeric_claim_provenance"]["status"] = "fail"
    assert not assess_promotion(True, {"sufficient": True}, evidence)["promotion_approved"]


def molecule_case(identifier, smiles):
    return {
        "id": identifier,
        "category": "admitted",
        "family": "admitted_complete",
        "source": f'chem 0.1\nmolecule target {{\n structure smiles "{smiles}"\n}}\n',
        "attachments": {},
        "complexity": {"passed": True, "heavy_atoms": 30},
        "expected": {"action": "structure_preview", "object_id": "target", "scale_factors": []},
    }


def test_independent_complexity_ignores_claimed_labels_and_rejects_simple_chemistry():
    pytest.importorskip("rdkit")
    report = verify_complex_chemistry(
        [molecule_case("water", "O"), molecule_case("halogen-aromatic", "Clc1ccc(Cl)cc1")]
    )
    assert not report["passed"]
    assert report["observations"][0]["heavy_atoms"] == 1
    assert report["observations"][1]["substantive_feature_classes"] == []
    assert all(not item["passed"] for item in report["observations"])


def test_scaffold_decoration_does_not_invent_independent_chemistry_families():
    pytest.importorskip("rdkit")
    report = verify_complex_chemistry(
        [molecule_case("one", "COc1ccc(O)cc1"), molecule_case("two", "CCOc1ccc(O)cc1")]
    )
    assert all(item["passed"] for item in report["observations"])
    assert report["distinct_connectivity_families"] == 1
    assert not report["passed"]


def test_inspected_scientific_declaration_binds_complexity_to_its_explicit_target():
    pytest.importorskip("rdkit")
    case = molecule_case("state-inspection", "COc1ccc(O)cc1")
    case["source"] += "electronic_state state { target target finite charge 0 multiplicity 1 }\n"
    case["expected"].update(action="object_inspect", object_id="state")
    item = verify_complex_chemistry([case])["observations"][0]
    assert item["passed"] and item["explicit_target_reference"] == "target"
    assert item["inspected_declaration_kind"] == "ElectronicState"
    case["expected"]["action"] = "structure_preview"
    assert not verify_complex_chemistry([case])["observations"][0]["passed"]


@pytest.mark.parametrize("smiles", ["CCCCCC(=O)OC", "CCCCCCC(=O)N"])
def test_a_single_ester_or_amide_does_not_count_as_two_functionality_classes(smiles):
    pytest.importorskip("rdkit")
    item = verify_complex_chemistry([molecule_case("single-function", smiles)])["observations"][0]
    assert item["feature_classes"] == ["carbonyl_derivative"]
    assert not item["passed"]


def test_v4_runner_and_inspector_retain_failed_attempts(monkeypatch, tmp_path):
    root, run, _ = runner_with_identity(monkeypatch, scoring_version=4)

    def failed(*args):
        orchestrator.MODEL_METRICS.calls.extend(
            [{"stage": "action", "schema_valid": False}, {"stage": "action", "schema_valid": False}]
        )
        raise ValueError("INVALID_MODEL_OUTPUT")

    monkeypatch.setattr(orchestrator, "orchestrate", failed)
    report = run(valid_suite(4), tmp_path / "run", root=root)
    assert report["version"] == "model-evaluation-report/v4"
    assert report["repairs"]["terminal_error_cases"] == 3
    inspect = runpy.run_path(str(root / "scripts/inspect_model_evaluation_v4.py"))["inspect"]
    assert inspect(tmp_path / "run")["scores_recomputed"]
    assert report["metrics"]["correct_abstention"]["total"] == 4


def test_evidence_reference_requires_bytes_and_actual_assertion_match(tmp_path):
    verify = runpy.run_path(str(ROOT / "scripts/assess_model_promotion.py"))[
        "verify_evidence_reference"
    ]
    path = tmp_path / "evidence.json"
    path.write_text(json.dumps({"passed": False, "count": 1}))
    ref = {
        "path": "evidence.json",
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "assertions": [{"pointer": "/passed", "equals": True}],
    }
    with pytest.raises(ValueError, match="EVIDENCE_ASSERTION_FAILED"):
        verify(ref, tmp_path)
    ref["assertions"] = [{"pointer": "/count", "equals": True}]
    with pytest.raises(ValueError, match="EVIDENCE_ASSERTION_FAILED"):
        verify(ref, tmp_path)
    ref["assertions"] = [{"pointer": "/passed", "equals": False}]
    assert verify(ref, tmp_path)["sha256"] == ref["sha256"]


def test_repeat_comparison_requires_distinct_runs_and_keeps_failure_variation(
    monkeypatch, tmp_path
):
    root, run, _ = runner_with_identity(monkeypatch, scoring_version=4)

    def failed(*args):
        orchestrator.MODEL_METRICS.calls.append(
            {"stage": "action", "schema_valid": False, "seconds": 0.1}
        )
        raise ValueError("INVALID_MODEL_OUTPUT")

    monkeypatch.setattr(orchestrator, "orchestrate", failed)
    directories = [tmp_path / "one", tmp_path / "two"]
    for directory in directories:
        run(valid_suite(), directory, root=root)
    summarize = runpy.run_path(str(root / "scripts/summarize_model_evaluations_v4.py"))["summarize"]
    result = summarize(directories)
    assert result["all_model_configurations_repeated"]
    assert result["models"][0]["run_count"] == 2
    assert result["models"][0]["metrics"]["correct_abstention"]["total_observations"] == 2
    assert result["models"][0]["metrics"]["correct_abstention"]["sample_standard_deviation"] == 0
    assert not result["promotion_approved"]
    with pytest.raises(ValueError, match="DISTINCT_EVALUATION_RUNS_REQUIRED"):
        summarize([directories[0], directories[0]])


def test_v4_snapshot_binds_workers_tests_and_ui_with_legacy_selection_preserved(tmp_path):
    snapshot = runpy.run_path(str(ROOT / "scripts/run_model_evaluation.py"))["code_snapshot"]
    files = {
        "src/chem_workbench/core.py": "CORE = 1\n",
        "scripts/run_model_evaluation.py": "# runner\n",
        "scripts/inspect_model_evaluation.py": "# inspector\n",
        "scripts/scientific_worker.py": "# scientific worker\n",
        "scripts/verify_complex_desktop.cjs": "// desktop acceptance\n",
        "scripts/run_psi4_python.ps1": "# registered launch chain\n",
        "desktop/main.cjs": "// native entry\n",
        "desktop/package.json": "{}\n",
        "desktop/node_modules/dependency/index.js": "// dependency\n",
        "desktop/dist/generated.js": "// output\n",
        "tests/test_scientific_worker.py": "# worker validation\n",
        "src/chem_workbench/web_assets/app.js": "const state = 1;\n",
        "src/chem_workbench/web_assets/vendor/viewer.js": "vendor data\n",
        "uv.lock": "version = 1\n",
    }
    for name, content in files.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    modern = snapshot(tmp_path, scoring_version=4)
    legacy = snapshot(tmp_path, scoring_version=3)
    assert "scripts/scientific_worker.py" in modern and "tests/test_scientific_worker.py" in modern
    assert "src/chem_workbench/web_assets/app.js" in modern
    assert "scripts/verify_complex_desktop.cjs" in modern
    assert "scripts/run_psi4_python.ps1" in modern
    assert "desktop/main.cjs" in modern and "desktop/package.json" in modern
    assert "desktop/node_modules/dependency/index.js" not in modern
    assert "desktop/dist/generated.js" not in modern
    assert "src/chem_workbench/web_assets/vendor/viewer.js" not in modern
    assert "src/chem_workbench/web_assets/vendor/viewer.js" in json.loads(
        modern["snapshot-metadata/vendor-byte-hashes.json"]
    )
    assert "scripts/scientific_worker.py" not in legacy
    assert "tests/test_scientific_worker.py" not in legacy
    assert "desktop/main.cjs" not in legacy and "scripts/run_psi4_python.ps1" not in legacy
    (tmp_path / "scripts/scientific_worker.py").write_text("# changed worker\n")
    assert snapshot(tmp_path, scoring_version=4) != modern
