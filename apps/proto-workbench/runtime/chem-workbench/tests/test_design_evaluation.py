"""Offline acceptance scoring uses real chemistry and deliberately wrong sampled actions."""

from __future__ import annotations

import copy
import json
import runpy
import sys
from pathlib import Path

import pytest

from chem_workbench import design_studio as design
from chem_workbench import orchestrator
from chem_workbench.design_evaluation import (
    MODULE_FAMILIES,
    aggregate,
    score_case,
    validate_suite,
    verify_record,
)
from chem_workbench.evaluation import PROMOTION_FAMILIES
from chem_workbench.visualization import content_hash

ROOT = Path(__file__).resolve().parents[1]


def hashed(value, key):
    value = copy.deepcopy(value)
    value.pop(key, None)
    value[key] = content_hash(value)
    return value


def development_case(identifier="dev-organic", workflow="organic_design", interfaces=None):
    decision = design.empty_decision(workflow)
    decision["max_candidates"] = 2
    if interfaces is not None:
        decision["interfaces"] = interfaces
    generated = {
        "organic_design": ["organic"],
        "inorganic_design": ["inorganic"],
        "interface_design": ["organic", "inorganic"],
        "interface_simulation": [],
    }[workflow]
    profiles = decision["interfaces"]
    return {
        "id": identifier,
        "family": "admitted_complete",
        "module_family": profiles[0] if profiles else workflow,
        "prompt": "Development fixture: run the explicit registered " + workflow + " study.",
        "study": design.default_study(),
        "setup": None,
        "expected": {
            "decision": decision,
            "workflow_outcomes": {
                "modules": [family + "_design" for family in generated] + profiles,
                "generated_families": generated,
                "interface_profiles": profiles,
                "minimum_candidates": {family: 2 for family in generated},
            },
        },
    }


def negative_case(identifier="dev-missing"):
    case = development_case(identifier)
    case.update(family="missing_ambiguous", prompt="Development fixture: target is missing.")
    case["expected"] = {"decision": {"action": "needs_input"}, "workflow_outcomes": None}
    return case


def suite(cases):
    return hashed({"version": "design-model-suite/v1", "cases": cases}, "suite_hash")


def sampled_decision(case):
    decision = copy.deepcopy(case["expected"]["decision"])
    if decision == {"action": "needs_input"}:
        decision = design.empty_decision("organic_design")
        decision.update(
            action="needs_input",
            workflow="",
            interfaces=[],
            missing_inputs=["Development target required."],
        )
    return decision


def mock_model(
    monkeypatch, decision, *, repair=False, repair_stage="requirements", requirements=None
):
    status = {
        "available": True,
        "installed": True,
        "model_id": "development-model",
        "key": "development-key",
        "endpoint": "http://127.0.0.1:1234",
    }
    monkeypatch.setattr(orchestrator, "model_status", lambda: copy.deepcopy(status))
    counts = {}

    def action(*_args):
        stage = orchestrator.MODEL_METRICS.stage
        counts[stage] = counts.get(stage, 0) + 1
        if repair and stage == repair_stage and counts[stage] == 1:
            orchestrator.MODEL_METRICS.calls.append(
                {
                    "stage": stage,
                    "schema_valid": False,
                    "response_text": "{truncated",
                    "seconds": 0.1,
                    "usage": {"prompt_tokens": 100, "completion_tokens": 5, "total_tokens": 105},
                }
            )
            raise ValueError("INVALID_MODEL_OUTPUT: development invalid JSON")
        value = copy.deepcopy(decision() if callable(decision) else decision)
        if stage == "requirements":
            value = (
                copy.deepcopy(requirements)
                if requirements is not None
                else {
                    "requested_workflow": value["workflow"] or "unclear",
                    "requested_properties": ["Development requested property."],
                    "missing_inputs": value["missing_inputs"],
                    "unsupported_requests": value["unsupported_requests"],
                    "disposition": "needs_input"
                    if value["action"] == "needs_input"
                    else "admitted",
                    "message": value["message"],
                }
            )
        orchestrator.MODEL_METRICS.calls.append(
            {
                "stage": stage,
                "schema_valid": True,
                "proposed_action": value,
                "response_text": json.dumps(value),
                "seconds": 0.2,
                "usage": {"prompt_tokens": 200, "completion_tokens": 50, "total_tokens": 250},
            }
        )
        return value

    monkeypatch.setattr(orchestrator, "request_action", action)
    return status


def execute_case(tmp_path, case, mode="direct"):
    return design.DesignStudio(tmp_path).run(
        {
            "prompt": case["prompt"],
            "study": case["study"],
            "mode": mode,
            "decision": None if mode == "model" else case["expected"]["decision"],
        }
    )


def runner(monkeypatch):
    functions = runpy.run_path(str(ROOT / "scripts/run_design_evaluation.py"))
    globals_ = functions["run_suite"].__globals__
    monkeypatch.setitem(globals_, "code_snapshot", lambda *_args, **_kw: {"dev.py": "frozen v1"})
    return functions


@pytest.mark.parametrize(
    "workflow,profiles",
    [
        ("organic_design", []),
        ("inorganic_design", []),
        ("interface_design", ["electrode_electrolyte", "catalyst_reactant", "solid_liquid"]),
    ],
)
def test_actual_complex_results_match_direct_path_and_all_provenance(
    tmp_path,
    monkeypatch,
    workflow,
    profiles,
):
    case = development_case(workflow=workflow, interfaces=profiles)
    oracle = execute_case(tmp_path / "direct", case)
    mock_model(monkeypatch, case["expected"]["decision"])
    record = execute_case(tmp_path / "model", case, "model")
    score = score_case(case, record, oracle)
    assert score["passed"] and score["native_first_attempt_success"]
    assert score["source_binding"] and score["output_parity"]
    assert score["complexity"]["passed"]


def test_semantic_nearby_action_fails_even_when_real_chemistry_completed(tmp_path, monkeypatch):
    case = development_case()
    oracle = execute_case(tmp_path / "direct", case)
    wrong = copy.deepcopy(case["expected"]["decision"])
    wrong["organic_ranking"] = "low_logp"
    mock_model(monkeypatch, wrong)
    record = execute_case(tmp_path / "model", case, "model")
    assert record["state"] == "completed"
    score = score_case(case, record, oracle)
    assert score["workflow_outcomes"]
    assert not score["sampled_action_parameters_correct"] and not score["passed"]


def test_explicit_current_study_values_equal_retained_values_without_relaxing_arguments(
    tmp_path,
    monkeypatch,
):
    case = development_case(workflow="interface_design", interfaces=["solid_liquid"])
    oracle = execute_case(tmp_path / "direct", case)
    explicit = sampled_decision(case)
    explicit.update(
        scaffold_id="catechol_amide",
        organic_ranking="balanced_polarity",
        a_elements=["Ca", "Sr", "Ba"],
        tolerance_target=1,
    )
    mock_model(monkeypatch, explicit)
    record = execute_case(tmp_path / "model", case, "model")
    score = score_case(case, record, oracle)
    assert score["initial_action_parameters_correct"] and score["output_parity"] and score["passed"]
    assert record["sampled_decision"] == explicit
    different = copy.deepcopy(case)
    different["expected"]["decision"]["tolerance_target"] = 0.95
    assert not score_case(different, record, oracle)["sampled_action_parameters_correct"]


@pytest.mark.parametrize("repair_stage", ["requirements", "action"])
def test_success_after_mechanical_repair_is_not_native_first_attempt(
    tmp_path, monkeypatch, repair_stage
):
    case = development_case()
    oracle = execute_case(tmp_path / "direct", case)
    mock_model(monkeypatch, sampled_decision(case), repair=True, repair_stage=repair_stage)
    record = execute_case(tmp_path / "model", case, "model")
    score = score_case(case, record, oracle)
    assert score["passed"] and score["sampled_action_parameters_correct"]
    assert not score["first_attempt_schema_valid"] and not score["native_first_attempt_success"]
    assert score["observed_retry_calls"] == 1
    assert score["observed_provider_calls"] == 3


def test_requirements_abstention_is_observed_without_action_call(tmp_path, monkeypatch):
    case = negative_case()
    mock_model(monkeypatch, sampled_decision(case))
    record = execute_case(tmp_path, case, "model")
    score = score_case(case, record, None)
    assert record["orchestration"]["decision_source"] == "requirements"
    assert score["sampled_correct_abstention"] and score["native_first_attempt_success"]
    assert score["first_requirements_schema_valid"] and score["first_action_schema_valid"] is None
    assert score["observed_provider_calls"] == 1 and score["observed_retry_calls"] == 0
    tampered = copy.deepcopy(record)
    tampered["orchestration"]["requirements_schema_hash"] = content_hash({"different": "schema"})
    assert not score_case(case, hashed(tampered, "record_hash"), None)["sampled_correct_abstention"]


def test_model_can_abstain_in_action_after_admitted_requirements(tmp_path, monkeypatch):
    case = negative_case()
    requirements = {
        "requested_workflow": "organic_design",
        "requested_properties": [],
        "missing_inputs": [],
        "unsupported_requests": [],
        "disposition": "admitted",
        "message": "Development admitted extraction.",
    }
    mock_model(monkeypatch, sampled_decision(case), requirements=requirements)
    record = execute_case(tmp_path, case, "model")
    score = score_case(case, record, None)
    assert record["orchestration"]["decision_source"] == "action"
    assert score["sampled_correct_abstention"] and score["first_attempt_schema_valid"]
    assert score["observed_provider_calls"] == 2 and score["observed_retry_calls"] == 0


def test_contradictory_requirements_routing_failure_is_not_model_abstention(tmp_path, monkeypatch):
    case = negative_case()
    requirements = {
        "requested_workflow": "organic_design",
        "requested_properties": [],
        "missing_inputs": ["Development required target."],
        "unsupported_requests": [],
        "disposition": "admitted",
        "message": "Development contradictory extraction.",
    }
    mock_model(monkeypatch, design.empty_decision("organic_design"), requirements=requirements)
    with pytest.raises(design.DesignRunError) as caught:
        execute_case(tmp_path, case, "model")
    score = score_case(case, caught.value.record, None)
    assert caught.value.record["state"] == "failed" and not score["sampled_correct_abstention"]
    assert not score["first_attempt_schema_valid"] and not score["sample_observation_consistent"]


def test_action_cannot_hide_missing_requirements_observation(tmp_path, monkeypatch):
    case = development_case()
    oracle = execute_case(tmp_path / "direct", case)
    mock_model(monkeypatch, sampled_decision(case))
    record = execute_case(tmp_path / "model", case, "model")
    assert score_case(case, record, oracle)["observed_retry_calls"] == 0
    record["orchestration"]["provider_calls"].pop(0)
    score = score_case(case, hashed(record, "record_hash"), oracle)
    assert not score["passed"] and not score["first_attempt_schema_valid"]


def test_host_rejection_never_receives_sampled_abstention_credit(tmp_path, monkeypatch):
    case = negative_case()
    wrong = design.empty_decision("interface_simulation")
    wrong["interfaces"] = ["solid_liquid"]
    mock_model(monkeypatch, wrong)
    with pytest.raises(design.DesignRunError) as caught:
        execute_case(tmp_path, case, "model")
    score = score_case(case, caught.value.record, None)
    assert score["host_rejected"] and score["first_attempt_schema_valid"]
    assert not score["sampled_correct_abstention"] and not score["passed"]


def test_sampled_abstention_requires_raw_response_and_exact_case_binding(tmp_path, monkeypatch):
    case = negative_case()
    mock_model(monkeypatch, sampled_decision(case))
    record = execute_case(tmp_path, case, "model")
    assert score_case(case, record, None)["sampled_correct_abstention"]
    missing_raw = copy.deepcopy(record)
    missing_raw["orchestration"]["provider_calls"][0].pop("response_text")
    missing_raw = hashed(missing_raw, "record_hash")
    score = score_case(case, missing_raw, None)
    assert not score["sampled_correct_abstention"] and not score["first_attempt_schema_valid"]
    wrong_context = copy.deepcopy(case)
    wrong_context["study"]["name"] = "Different development study"
    assert not score_case(wrong_context, record, None)["sampled_correct_abstention"]


def test_rehashed_outer_record_cannot_hide_nested_geometry_tampering(tmp_path):
    record = execute_case(tmp_path, development_case())
    record["organic"]["candidates"][0]["geometry"]["atoms"][0]["position"][0] += 0.25
    record = hashed(record, "record_hash")
    with pytest.raises(ValueError, match=r"HASH|hash"):
        verify_record(record)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda s: s["cases"][0].update(module_family="none"),
        lambda s: s["cases"].append(copy.deepcopy(s["cases"][0])),
        lambda s: s["cases"][0]["expected"]["workflow_outcomes"].update(minimum_candidates={}),
        lambda s: s["cases"][0].update(family="tool_runtime_failures"),
    ],
)
def test_suite_rejects_lane_denomination_and_empty_complexity_requirements(mutation):
    value = suite([development_case()])
    mutation(value)
    with pytest.raises(ValueError):
        validate_suite(hashed(value, "suite_hash"))


def test_preparation_calls_no_model_and_seals_real_oracles(tmp_path, monkeypatch):
    functions = runner(monkeypatch)
    monkeypatch.setattr(
        orchestrator, "model_status", lambda: pytest.fail("Model queried during freeze")
    )
    fixtures = functions["freeze_fixtures"](suite([development_case()]), tmp_path / "freeze")
    assert fixtures["inference_performed"] is False
    assert fixtures["complexity"]["dev-organic"]["passed"]
    sources = functions["read_json"](tmp_path / "freeze/code-snapshot.json")
    functions["validate_fixtures"](fixtures, sources)
    with pytest.raises(FileExistsError):
        functions["freeze_fixtures"](suite([development_case()]), tmp_path / "freeze")


def test_matched_runs_reuse_exact_selected_pair_inputs_and_replay_scores(tmp_path, monkeypatch):
    functions = runner(monkeypatch)
    case = development_case(workflow="interface_simulation", interfaces=["solid_liquid"])
    setup = design.empty_decision("interface_design")
    setup.update(interfaces=[], max_candidates=2)
    case["setup"] = {"study": design.default_study(), "decision": setup}
    case["expected"]["workflow_outcomes"]["minimum_candidates"] = {"organic": 1, "inorganic": 1}
    fixtures = functions["freeze_fixtures"](suite([case]), tmp_path / "freeze")
    sources = functions["read_json"](tmp_path / "freeze/code-snapshot.json")
    mock_model(monkeypatch, case["expected"]["decision"])
    for name in ("first", "repeat"):
        result = functions["run_suite"](fixtures, sources, tmp_path / name, observe_runtime=False)
        assert result["complete"] and result["identity_stable"]
        assert result["metrics"]["admitted_actual_workflow_success"]["rate"] == 1
        assert not result["promotion_approved"] and not result["coverage"]["sufficient"]
        assert functions["inspect_run"](tmp_path / name)["verified"]
    first = functions["read_json"](tmp_path / "first/dev-organic.json")
    repeat = functions["read_json"](tmp_path / "repeat/dev-organic.json")
    assert first["record"]["request"] == repeat["record"]["request"]
    assert first["score"]["output_parity"] and repeat["score"]["output_parity"]


def test_source_drift_rejects_frozen_oracle_before_inference(tmp_path, monkeypatch):
    functions = runner(monkeypatch)
    fixtures = functions["freeze_fixtures"](suite([development_case()]), tmp_path / "freeze")
    sources = functions["read_json"](tmp_path / "freeze/code-snapshot.json")
    monkeypatch.setitem(
        functions["run_suite"].__globals__,
        "code_snapshot",
        lambda *_args, **_kw: {"dev.py": "changed after freeze"},
    )
    monkeypatch.setattr(
        orchestrator, "model_status", lambda: pytest.fail("Model queried after drift")
    )
    with pytest.raises(ValueError, match="CODE_MISMATCH"):
        functions["run_suite"](fixtures, sources, tmp_path / "run", observe_runtime=False)


@pytest.mark.parametrize("profile", design.INTERFACES)
def test_candidate_bound_screening_freezes_authored_numbers_and_matches_direct_response_ranking(
    tmp_path,
    monkeypatch,
    profile,
):
    from chem_workbench.interface_screening import OBJECTIVES
    from chem_workbench.interface_simulation import illustrative_interface_spec

    functions = runner(monkeypatch)
    generation_case = development_case(workflow="interface_design", interfaces=[])
    generated = execute_case(tmp_path / "development-library", generation_case)
    specs = []
    for index in range(2):
        spec = illustrative_interface_spec(
            profile,
            generated["organic"]["candidates"][index],
            generated["inorganic"]["candidates"][0],
        )
        spec.pop("candidate_hashes")
        spec.pop("mechanism")
        kinetic = "k0_m_s" if profile == "electrode_electrolyte" else "k_ads_m3_mol_s"
        spec["parameters"][kinetic]["value"] *= index + 1
        specs.append({"organic_index": index, "inorganic_index": 0, "specification": spec})
    case = development_case()
    case["module_family"] = profile
    case["study"]["interface_screening"] = {"profile": profile, "objective": OBJECTIVES[profile]}
    case["study"]["interface_parameters"] = {"mode": "supplied", "specifications": []}
    decision = design.empty_decision("interface_screening")
    decision.update(interfaces=[profile], max_candidates=2)
    case["expected"] = {
        "decision": decision,
        "workflow_outcomes": {
            "modules": ["interface_screening"],
            "generated_families": [],
            "interface_profiles": [profile, profile],
            "minimum_candidates": {"organic": 2, "inorganic": 2},
        },
    }
    case["setup"] = {
        "study": generation_case["study"],
        "decision": generation_case["expected"]["decision"],
        "interface_specifications": specs,
    }
    fixtures = functions["freeze_fixtures"](suite([case]), tmp_path / "freeze")
    resolved = fixtures["cases"][0]["study"]["interface_parameters"]["specifications"]
    for original, bound in zip(specs, resolved, strict=True):
        assert bound["parameters"] == original["specification"]["parameters"]
        assert bound["initial_conditions"] == original["specification"]["initial_conditions"]
        assert bound["time_grid"] == original["specification"]["time_grid"]
    sources = functions["read_json"](tmp_path / "freeze/code-snapshot.json")
    mock_model(monkeypatch, decision)
    report = functions["run_suite"](fixtures, sources, tmp_path / "run", observe_runtime=False)
    assert report["metrics"]["admitted_actual_workflow_success"]["rate"] == 1
    assert functions["inspect_run"](tmp_path / "run")["verified"]


def test_provider_failure_breaker_preserves_full_denominator_and_raw_call_cost(
    tmp_path, monkeypatch
):
    functions = runner(monkeypatch)
    cases = [negative_case("dev-missing-" + str(index)) for index in range(5)]
    fixtures = functions["freeze_fixtures"](suite(cases), tmp_path / "freeze")
    sources = functions["read_json"](tmp_path / "freeze/code-snapshot.json")
    mock_model(monkeypatch, sampled_decision(cases[0]))

    def fail(*_args):
        orchestrator.MODEL_METRICS.calls.append(
            {
                "stage": orchestrator.MODEL_METRICS.stage,
                "schema_valid": False,
                "seconds": 0.3,
                "usage": {"prompt_tokens": 12, "completion_tokens": 2, "total_tokens": 14},
            }
        )
        raise ValueError("DEVELOPMENT_PROVIDER_DISCONNECTED")

    monkeypatch.setattr(orchestrator, "request_action", fail)
    report = functions["run_suite"](fixtures, sources, tmp_path / "run", observe_runtime=False)
    assert not report["complete"] and report["stop_reason"] == "DESIGN_PROVIDER_FAILURE_BREAKER"
    assert len(report["case_rows"]) == 5
    assert report["metrics"]["first_attempt_schema"]["total"] == 5
    assert report["tokens"]["total_tokens"]["observed_total"] == 42
    assert functions["inspect_run"](tmp_path / "run")["verified"]


def test_report_replay_rejects_changed_score_even_with_recomputed_outer_hashes(
    tmp_path, monkeypatch
):
    functions = runner(monkeypatch)
    case = negative_case()
    fixtures = functions["freeze_fixtures"](suite([case]), tmp_path / "freeze")
    sources = functions["read_json"](tmp_path / "freeze/code-snapshot.json")
    mock_model(monkeypatch, sampled_decision(case))
    functions["run_suite"](fixtures, sources, tmp_path / "run", observe_runtime=False)
    path = tmp_path / "run/dev-missing.json"
    row = functions["read_json"](path)
    row["score"]["passed"] = False
    row = hashed(row, "row_hash")
    path.write_text(json.dumps(row), encoding="utf-8")
    report_path = tmp_path / "run/report.json"
    report = functions["read_json"](report_path)
    report["case_rows"][case["id"]] = row["row_hash"]
    report_path.write_text(json.dumps(hashed(report, "report_hash")), encoding="utf-8")
    with pytest.raises(ValueError, match="SCORE_REPLAY"):
        functions["inspect_run"](tmp_path / "run")


def full_matrix_evidence():
    cases, rows, runtime = [], [], []
    false_score = score_case(negative_case(), None, None)
    for lane in MODULE_FAMILIES:
        for family, count in PROMOTION_FAMILIES.items():
            for index in range(count // 5):
                identifier = f"dev-{lane}-{family}-{index}"[:80]
                if family == "tool_runtime_failures":
                    runtime.append(
                        {
                            "id": identifier,
                            "family": family,
                            "module_family": lane,
                            "passed": True,
                            "evidence": hashed(
                                {"checks": {"development": True}, "live_model_calls": 0},
                                "evidence_hash",
                            ),
                        }
                    )
                    continue
                case = (
                    development_case(identifier)
                    if family == "admitted_complete"
                    else negative_case(identifier)
                )
                case.update(family=family, module_family=lane)
                cases.append(case)
                rows.append({"id": identifier, "score": copy.deepcopy(false_score), "seconds": 0})
    value = suite(cases)
    manifest = hashed(
        {
            "version": "design-runtime-manifest/v1",
            "suite_hash": value["suite_hash"],
            "cases": runtime,
            "code_identity": {"dev.py": content_hash("development")},
            "code_identity_hash": content_hash({"dev.py": content_hash("development")}),
            "code_identity_unchanged": True,
            "passed": True,
            "total": 20,
            "passed_count": 20,
            "live_model_calls": 0,
        },
        "manifest_hash",
    )
    return rows, value, manifest


def test_full_matrix_requires_all_six_families_in_every_lane_and_runtime_success():
    rows, value, manifest = full_matrix_evidence()
    report = aggregate(rows, value, complete=True, identity_stable=True, runtime_manifest=manifest)
    assert report["coverage"]["sufficient"] and report["runtime_faults_passed"]
    assert not report["observed_controller_security_passed"] and not report["promotion_approved"]
    drifted = copy.deepcopy(manifest)
    drifted.update(code_identity_unchanged=False, passed=False)
    drift_report = aggregate(
        rows,
        value,
        complete=True,
        identity_stable=True,
        runtime_manifest=hashed(drifted, "manifest_hash"),
    )
    assert drift_report["coverage"]["sufficient"] and not drift_report["runtime_faults_passed"]
    mismatch = copy.deepcopy(manifest)
    mismatch["cases"][0]["evidence"]["checks"]["development"] = False
    mismatch["cases"][0]["evidence"] = hashed(mismatch["cases"][0]["evidence"], "evidence_hash")
    with pytest.raises(ValueError, match="RUNTIME_CHECKS"):
        aggregate(
            rows,
            value,
            complete=True,
            identity_stable=True,
            runtime_manifest=hashed(mismatch, "manifest_hash"),
        )
    manifest["cases"][0]["module_family"] = MODULE_FAMILIES[1]
    changed = aggregate(
        rows,
        value,
        complete=True,
        identity_stable=True,
        runtime_manifest=hashed(manifest, "manifest_hash"),
    )
    assert not changed["coverage"]["sufficient"]


def passing_matrix_evidence():
    # Synthetic score rows isolate the aggregate gate truth table from model/chemistry tests above.
    rows, value, manifest = full_matrix_evidence()
    for row in rows:
        row["score"].update(
            first_attempt_schema_valid=True,
            passed=True,
            sampled_correct_abstention=True,
            authority_boundary=True,
        )
        row["runtime_observations"] = {"audit": {"complete": True, "unauthorized_attempts": 0}}
    return rows, value, manifest


@pytest.mark.parametrize("failure", [None, "runtime", "missing_audit", "unauthorized", "boolean"])
def test_local_acceptance_requires_runtime_and_complete_zero_security_observations(failure):
    rows, value, manifest = passing_matrix_evidence()
    if failure == "runtime":
        manifest["cases"][0]["evidence"]["checks"]["development"] = False
        manifest["cases"][0]["evidence"] = hashed(manifest["cases"][0]["evidence"], "evidence_hash")
        manifest["cases"][0]["passed"] = False
        manifest.update(passed=False, passed_count=19)
        manifest = hashed(manifest, "manifest_hash")
    elif failure == "missing_audit":
        rows[0]["runtime_observations"] = None
    elif failure in {"unauthorized", "boolean"}:
        rows[0]["runtime_observations"]["audit"]["unauthorized_attempts"] = (
            1 if failure == "unauthorized" else False
        )
    report = aggregate(rows, value, complete=True, identity_stable=True, runtime_manifest=manifest)
    assert report["measured_thresholds_passed"] and report["coverage"]["sufficient"]
    assert report["local_acceptance_checks_passed"] is (failure is None)
    assessment = report["promotion_assessment"]
    assert not report["promotion_approved"] and not assessment["promotion_approved"]
    assert assessment["gates"]["independent_abstention_rationale_review"]["status"] == "not_checked"
    assert assessment["gates"]["model_configuration_identity"]["status"] == "not_checked"
    if failure == "runtime":
        assert assessment["gates"]["runtime_fault_checks"]["status"] == "fail"
    elif failure is not None:
        assert assessment["gates"]["observed_controller_security"]["status"] == "fail"


@pytest.mark.parametrize(
    "field,family,failures,passes",
    [
        ("first_attempt_schema_valid", None, 6, True),
        ("first_attempt_schema_valid", None, 7, False),
        ("passed", "admitted_complete", 4, True),
        ("passed", "admitted_complete", 5, False),
        ("sampled_correct_abstention", "negative", 4, True),
        ("sampled_correct_abstention", "negative", 5, False),
    ],
)
def test_original_numeric_threshold_boundaries_keep_every_case(field, family, failures, passes):
    rows, value, manifest = passing_matrix_evidence()
    families = {case["id"]: case["family"] for case in value["cases"]}
    selected = [
        row
        for row in rows
        if family is None
        or (family == "negative" and families[row["id"]] != "admitted_complete")
        or families[row["id"]] == family
    ]
    for row in selected[:failures]:
        row["score"][field] = False
    report = aggregate(rows, value, complete=True, identity_stable=True, runtime_manifest=manifest)
    assert report["measured_thresholds_passed"] is passes
    assert report["local_acceptance_checks_passed"] is passes
    assert report["metrics"]["first_attempt_schema"]["total"] == 130
    assert report["metrics"]["admitted_actual_workflow_success"]["total"] == 40
    assert report["metrics"]["correct_sampled_abstention"]["total"] == 90


@pytest.mark.parametrize("local_passed,expected_code", [(False, 2), (True, 0)])
def test_runner_exit_uses_local_acceptance_conjunction(
    tmp_path, monkeypatch, local_passed, expected_code
):
    functions = runner(monkeypatch)
    namespace = functions["main"].__globals__
    monkeypatch.setitem(namespace, "read_json", lambda *_args: {})
    monkeypatch.setitem(
        namespace,
        "run_suite",
        lambda *_args, **_kwargs: {
            "measured_thresholds_passed": True,
            "coverage": {"sufficient": True},
            "local_acceptance_checks_passed": local_passed,
        },
    )
    monkeypatch.setenv("CHEM_MODEL_KEY", orchestrator.MODEL_KEY)
    monkeypatch.setattr(sys, "argv", ["runner", "--fixtures", str(tmp_path / "fixtures.json")])
    assert functions["main"]() == expected_code


def test_unrelated_abstention_explanation_is_not_semantically_certified(tmp_path, monkeypatch):
    case = negative_case()
    decision = sampled_decision(case)
    decision["missing_inputs"] = ["An unrelated lunar calendar value is required."]
    mock_model(monkeypatch, decision)
    record = execute_case(tmp_path, case, "model")
    score = score_case(case, record, None)
    # The mechanical metric observes the action and safe stop, not the correctness of this reason.
    assert score["sampled_correct_abstention"]
    report = aggregate(
        [{"id": case["id"], "score": score}], suite([case]), complete=True, identity_stable=True
    )
    assert "explanation correctness" in report["abstention_scope"]
    assert (
        "independent_abstention_rationale_review"
        in report["promotion_assessment"]["outstanding_gates"]
    )
    assert not report["promotion_approved"]


def test_replay_rejects_per_case_model_swap_even_after_hash_repair(tmp_path, monkeypatch):
    functions = runner(monkeypatch)
    case = negative_case()
    fixtures = functions["freeze_fixtures"](suite([case]), tmp_path / "freeze")
    sources = functions["read_json"](tmp_path / "freeze/code-snapshot.json")
    mock_model(monkeypatch, sampled_decision(case))
    functions["run_suite"](fixtures, sources, tmp_path / "run", observe_runtime=False)
    path = tmp_path / "run/dev-missing.json"
    row = functions["read_json"](path)
    row["record"]["orchestration"]["model"]["model_id"] = "different-model"
    row["record"] = hashed(row["record"], "record_hash")
    row = hashed(row, "row_hash")
    path.write_text(json.dumps(row), encoding="utf-8")
    report_path = tmp_path / "run/report.json"
    report = functions["read_json"](report_path)
    report["case_rows"][case["id"]] = row["row_hash"]
    report_path.write_text(json.dumps(hashed(report, "report_hash")), encoding="utf-8")
    with pytest.raises(ValueError, match="ROW_MODEL_IDENTITY"):
        functions["inspect_run"](tmp_path / "run")


def test_replay_rejects_runtime_manifest_from_different_code(tmp_path, monkeypatch):
    functions = runner(monkeypatch)
    case = negative_case()
    fixtures = functions["freeze_fixtures"](suite([case]), tmp_path / "freeze")
    sources = functions["read_json"](tmp_path / "freeze/code-snapshot.json")
    mock_model(monkeypatch, sampled_decision(case))
    functions["run_suite"](fixtures, sources, tmp_path / "run", observe_runtime=False)
    _rows, _value, manifest = full_matrix_evidence()
    manifest["suite_hash"] = fixtures["suite"]["suite_hash"]
    frozen_path = tmp_path / "run/frozen.json"
    frozen = functions["read_json"](frozen_path)
    frozen["runtime_manifest"] = hashed(manifest, "manifest_hash")
    frozen = hashed(frozen, "freeze_hash")
    frozen_path.write_text(json.dumps(frozen), encoding="utf-8")
    report_path = tmp_path / "run/report.json"
    report = functions["read_json"](report_path)
    report["freeze_hash"] = frozen["freeze_hash"]
    report_path.write_text(json.dumps(hashed(report, "report_hash")), encoding="utf-8")
    with pytest.raises(ValueError, match="RUNTIME_CODE_BINDING"):
        functions["inspect_run"](tmp_path / "run")
