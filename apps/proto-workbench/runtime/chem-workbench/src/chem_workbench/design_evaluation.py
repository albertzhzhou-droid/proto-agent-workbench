"""Separate design acceptance contract: sampled decisions and actual source-bound results."""

from __future__ import annotations

import copy
import importlib
import json
import math
import re
from collections import Counter
from typing import Any, TypeGuard

from jsonschema import Draft202012Validator  # type: ignore[import-untyped]

from chem_workbench.design_studio import (
    INTERFACES,
    REQUIREMENTS_PROMPT,
    ROUTER_PROMPT,
    WORKFLOWS,
    empty_decision,
    model_router_schema,
    requirements_schema,
    router_schema,
    validate_decision,
    validate_study,
)
from chem_workbench.evaluation import (
    COMPLEXITY_FEATURE_SMARTS,
    PROMOTION_FAMILIES,
    SUBSTANTIVE_FEATURES,
    _duration_summary,
    _rate_v4,
    assess_promotion,
)
from chem_workbench.visualization import content_hash

VERSION = "design-model-suite/v1"
MODULE_FAMILIES = ["organic_design", "inorganic_design", *INTERFACES]
EXECUTED_MODULES = [*MODULE_FAMILIES, "interface_screening"]
SEMANTIC_FIELDS = set(router_schema()["properties"]) - {"message"}
LANE_COUNTS = {name: count // 5 for name, count in PROMOTION_FAMILIES.items()}
MAX_SUITE_BYTES = 16 * 1024 * 1024


def check_hash(value: object, key: str) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get(key) != content_hash(
        {k: v for k, v in value.items() if k != key}
    ):
        raise ValueError("DESIGN_EVIDENCE_HASH_MISMATCH: " + key)
    return value


def finite_seconds(value: object) -> TypeGuard[int | float]:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value >= 0
    )


def semantic_decision(value: object, study: dict[str, Any]) -> dict[str, Any] | None:
    """Compare exact resolved arguments, including explicit values equal to study settings.

    This mirrors the registered merge, not a similarity score or intent heuristic.
    New explicit defaults absent from the study remain different declarations.
    """
    if not isinstance(value, dict):
        return None
    try:
        organic, inorganic = copy.deepcopy(study["organic"]), copy.deepcopy(study["inorganic"])
        for spec in (organic, inorganic):
            spec["max_candidates"] = value["max_candidates"]
        if value["scaffold_id"]:
            if value["scaffold_id"] != "custom":
                organic.pop("scaffold_smiles", None)
            organic["scaffold_id"] = value["scaffold_id"]
        if value["organic_ranking"]:
            organic["ranking"] = value["organic_ranking"]
        if value["fragment_ids"]:
            organic.pop("fragments", None)
            organic["fragment_ids"] = value["fragment_ids"]
        filters = {key: item for key, item in value["organic_filters"].items() if item is not None}
        if filters:
            organic.setdefault("filters", {}).update(filters)
        if value["a_elements"]:
            inorganic["a_elements"] = value["a_elements"]
        if value["b_pair_ids"]:
            inorganic["b_pairs"] = [pair.split("/") for pair in value["b_pair_ids"]]
        if value["tolerance_target"] is not None:
            inorganic["tolerance_target"] = value["tolerance_target"]
        return {
            "action": value["action"],
            "workflow": value["workflow"],
            "interfaces": value["interfaces"],
            "organic": organic,
            "inorganic": inorganic,
            "missing_inputs": value["missing_inputs"],
            "unsupported_requests": value["unsupported_requests"],
        }
    except (KeyError, TypeError, AttributeError):
        return None


def validate_suite(value: object) -> dict[str, Any]:
    if len(json.dumps(value, allow_nan=False).encode("utf-8")) > MAX_SUITE_BYTES:
        raise ValueError("DESIGN_SUITE_SIZE_LIMIT")
    suite = check_hash(value, "suite_hash")
    if suite.get("version") != VERSION or not isinstance(suite.get("cases"), list):
        raise ValueError("INVALID_DESIGN_SUITE")
    if not 1 <= len(suite["cases"]) <= 130:
        raise ValueError("DESIGN_SUITE_LIMIT")
    seen = set()
    for case in suite["cases"]:
        if not isinstance(case, dict) or set(case) != {
            "id",
            "family",
            "module_family",
            "prompt",
            "study",
            "setup",
            "expected",
        }:
            raise ValueError("DESIGN_CASE_FIELDS")
        identifier = case["id"]
        if not isinstance(identifier, str) or not re.fullmatch(
            r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}", identifier
        ):
            raise ValueError("DESIGN_CASE_ID")
        if identifier in seen:
            raise ValueError("DUPLICATE_DESIGN_CASE")
        seen.add(identifier)
        if case["family"] not in set(PROMOTION_FAMILIES) - {"tool_runtime_failures"}:
            raise ValueError("DESIGN_CASE_FAMILY")
        if case["module_family"] not in MODULE_FAMILIES:
            raise ValueError("DESIGN_CASE_LANE")
        if not isinstance(case["prompt"], str) or not 1 <= len(case["prompt"].strip()) <= 2000:
            raise ValueError("DESIGN_CASE_PROMPT")
        validate_study(case["study"])
        setup = case["setup"]
        if setup is not None:
            if not isinstance(setup, dict) or set(setup) not in (
                {"study", "decision"},
                {"study", "decision", "interface_specifications"},
            ):
                raise ValueError("DESIGN_CASE_SETUP")
            validate_study(setup["study"])
            validated = validate_decision(setup["decision"], setup["study"])
            if (
                validated["action"] != "run_workflow"
                or validated["workflow"] != "interface_design"
                or validated["interfaces"]
                or setup["study"]["selected_candidates"] is not None
            ):
                raise ValueError("DESIGN_CASE_SETUP_SCOPE")
            if case["study"]["selected_candidates"] is not None:
                raise ValueError("DESIGN_CASE_SETUP_SELECTION: runner binds the generated pair")
            if "interface_specifications" in setup:
                specs = setup["interface_specifications"]
                if (
                    not isinstance(specs, list)
                    or not 1 <= len(specs) <= 4
                    or case["study"]["interface_parameters"]
                    != {
                        "mode": "supplied",
                        "specifications": [],
                    }
                ):
                    raise ValueError("DESIGN_SETUP_INTERFACE_SPECIFICATIONS")
                for spec in specs:
                    if (
                        not isinstance(spec, dict)
                        or set(spec) != {"organic_index", "inorganic_index", "specification"}
                        or any(
                            type(spec[key]) is not int or not 0 <= spec[key] < 24
                            for key in ("organic_index", "inorganic_index")
                        )
                        or not isinstance(spec["specification"], dict)
                        or set(spec["specification"])
                        != {
                            "version",
                            "profile",
                            "parameters",
                            "initial_conditions",
                            "time_grid",
                        }
                        or spec["specification"].get("version") != "interface-simulation-spec/v1"
                        or spec["specification"].get("profile") not in INTERFACES
                    ):
                        raise ValueError("DESIGN_SETUP_INTERFACE_SPECIFICATION")
        expected = case["expected"]
        if not isinstance(expected, dict) or set(expected) != {"decision", "workflow_outcomes"}:
            raise ValueError("DESIGN_CASE_EXPECTATION")
        decision = expected["decision"]
        refusal = decision == {"action": "needs_input"}
        if refusal:
            if expected["workflow_outcomes"] is not None or case["family"] == "admitted_complete":
                raise ValueError("DESIGN_REFUSAL_EXPECTATION")
        else:
            if (
                case["family"] != "admitted_complete"
                or case["module_family"] not in MODULE_FAMILIES
                or list(Draft202012Validator(router_schema()).iter_errors(decision))
                or decision["action"] != "run_workflow"
            ):
                raise ValueError("DESIGN_ADMITTED_EXPECTATION")
            outcomes = expected["workflow_outcomes"]
            if not isinstance(outcomes, dict) or set(outcomes) != {
                "modules",
                "generated_families",
                "interface_profiles",
                "minimum_candidates",
            }:
                raise ValueError("DESIGN_WORKFLOW_OUTCOMES")
            if (
                not isinstance(outcomes["modules"], list)
                or not outcomes["modules"]
                or any(item not in EXECUTED_MODULES for item in outcomes["modules"])
                or len(set(outcomes["modules"])) != len(outcomes["modules"])
                or not isinstance(outcomes["generated_families"], list)
                or any(
                    item not in {"organic", "inorganic"} for item in outcomes["generated_families"]
                )
                or len(set(outcomes["generated_families"])) != len(outcomes["generated_families"])
                or not isinstance(outcomes["interface_profiles"], list)
                or any(item not in INTERFACES for item in outcomes["interface_profiles"])
                or len(outcomes["interface_profiles"]) > 4
                or not isinstance(outcomes["minimum_candidates"], dict)
                or any(
                    key not in {"organic", "inorganic"}
                    or type(number) is not int
                    or not 1 <= number <= 24
                    for key, number in outcomes["minimum_candidates"].items()
                )
            ):
                raise ValueError("DESIGN_WORKFLOW_OUTCOME_VALUES")
            if not outcomes["minimum_candidates"]:
                raise ValueError("DESIGN_COMPLEX_CANDIDATES_REQUIRED")
    return copy.deepcopy(suite)


def output_projection(record: dict[str, Any]) -> dict[str, Any]:
    """Scientific and logical output only; observed timing and prose remain in the full record."""
    return {
        "state": record.get("state"),
        "plan": record.get("plan"),
        "organic": record.get("organic"),
        "inorganic": record.get("inorganic"),
        "interfaces": record.get("interfaces"),
        "interface_screening": record.get("interface_screening"),
        "selected_pair": record.get("selected_pair"),
        "trace": [
            {key: value for key, value in item.items() if key != "seconds"}
            for item in record.get("trace", [])
        ],
    }


def verify_record(record: dict[str, Any]) -> None:
    from chem_workbench.design_records import verify_design_record

    verify_design_record(record)
    check_hash(record, "record_hash")
    if record.get("version") != "design-run/v1":
        raise ValueError("DESIGN_RECORD_VERSION")
    if record.get("request_hash") != content_hash(record.get("request")):
        raise ValueError("DESIGN_RECORD_REQUEST_MISMATCH")
    if record.get("study_hash") != content_hash(record["request"]["study"]):
        raise ValueError("DESIGN_RECORD_STUDY_MISMATCH")
    if record.get("plan"):
        check_hash(record["plan"], "logical_plan_hash")
    screening = record.get("interface_screening")
    if screening is not None:
        check_hash(screening, "result_hash")
    for family in ("organic", "inorganic"):
        result = record.get(family)
        if result is None:
            continue
        generated = any(
            trace.get("module") == family + "_design" for trace in record.get("trace", [])
        )
        if generated or "result_hash" in result:
            check_hash(result, "result_hash")
            if result.get("request_hash") != content_hash(result.get("request")):
                raise ValueError("DESIGN_CANDIDATE_REQUEST_BINDING")
        for candidate in result.get("candidates", []):
            check_hash(candidate, "candidate_hash")
            geometry = check_hash(candidate.get("geometry"), "geometry_hash")
            if (
                candidate.get("family") != family
                or geometry.get("object_id") != candidate.get("id")
                or geometry.get("source_hash") != candidate.get("request_hash")
                or geometry.get("subject_hash") != candidate.get("identity_hash")
            ):
                raise ValueError("DESIGN_CANDIDATE_SOURCE_BINDING")
    for result in record.get("interfaces", []):
        check_hash(result, "result_hash")
        check_hash(result.get("mechanism"), "mechanism_hash")
        if result.get("input_hash") != content_hash(result.get("inputs")):
            raise ValueError("DESIGN_INTERFACE_INPUT_BINDING")
        for family in ("organic", "inorganic"):
            candidate = result["inputs"][family + "_candidate"]
            if candidate not in (record.get(family) or {}).get("candidates", []):
                raise ValueError("DESIGN_INTERFACE_PAIR_BINDING")
            if result["candidate_hashes"][family] != content_hash(candidate):
                raise ValueError("DESIGN_INTERFACE_CANDIDATE_HASH")
            if (
                screening is None
                and record.get("selected_pair", {}).get(family) != candidate["candidate_hash"]
            ):
                raise ValueError("DESIGN_SELECTED_PAIR_BINDING")
        if (
            result.get("success") is not True
            or result.get("scientifically_calibrated") is not False
            or result.get("measured_data_claim") is not False
            or result.get("balances", {}).get("passed") is not True
            or not result.get("series")
            or not result["mechanism"].get("conservation_proofs")
            or not all(
                item.get("passed") is True for item in result["mechanism"]["conservation_proofs"]
            )
            or result["inputs"]["spec"].get("mechanism") != result["mechanism"]
        ):
            raise ValueError("DESIGN_INTERFACE_SCIENTIFIC_EVIDENCE")


def workflow_outcomes(record: dict[str, Any], expected: dict[str, Any]) -> bool:
    if record.get("state") != "completed":
        return False
    trace = record.get("trace", [])
    if [step.get("module") for step in trace] != expected["modules"] or any(
        step.get("status") != "succeeded" for step in trace
    ):
        return False
    generated = [
        family
        for family in ("organic", "inorganic")
        if any(step.get("module") == family + "_design" for step in trace)
    ]
    return (
        generated == expected["generated_families"]
        and [item["profile"] for item in record.get("interfaces", [])]
        == expected["interface_profiles"]
        and all(
            len((record.get(family) or {}).get("candidates", [])) >= number
            for family, number in expected["minimum_candidates"].items()
        )
    )


def verify_complex_outputs(record: dict[str, Any]) -> dict[str, Any]:
    """Recompute organic features and oxide cell complexity; never trust author labels."""
    chemistry = importlib.import_module("rdkit.Chem")
    queries = {
        name: chemistry.MolFromSmarts(smarts) for name, smarts in COMPLEXITY_FEATURE_SMARTS.items()
    }
    observations = []
    for family in ("organic", "inorganic"):
        for candidate in (record.get(family) or {}).get("candidates", []):
            item: dict[str, Any] = {"family": family, "candidate_hash": candidate["candidate_hash"]}
            if family == "organic":
                mol = chemistry.MolFromSmiles(candidate["canonical_smiles"])
                classes = [
                    name
                    for name, query in queries.items()
                    if mol is not None and mol.HasSubstructMatch(query)
                ]
                item.update(
                    heavy_atoms=mol.GetNumHeavyAtoms() if mol is not None else 0,
                    feature_classes=classes,
                )
                item["passed"] = (
                    mol is not None
                    and len(chemistry.GetMolFrags(mol)) == 1
                    and 8 <= item["heavy_atoms"] <= 64
                    and len(classes) >= 2
                    and bool(set(classes) & SUBSTANTIVE_FEATURES)
                )
            else:
                atoms = candidate["geometry"]["atoms"]
                counts = Counter(atom["element"] for atom in atoms)
                sites = candidate.get("structure", {}).get("sites", [])
                charge = sum(site["oxidation_state"] * site["occupancy"] for site in sites)
                item.update(atom_count=len(atoms), element_counts=dict(counts), cell_charge=charge)
                item["passed"] = (
                    len(atoms) >= 40
                    and len(counts) >= 4
                    and "O" in counts
                    and len(sites) == len(atoms)
                    and abs(charge) < 1e-10
                )
            observations.append(item)
    return {
        "passed": bool(observations) and all(item["passed"] for item in observations),
        "observations": observations,
        "scope": "Graph/structural-cell complexity only; "
        "not chemical activity or measured calibration",
    }


def score_case(
    case: dict[str, Any], record: dict[str, Any] | None, oracle: dict[str, Any] | None
) -> dict[str, Any]:
    record = record or {}
    routing = record.get("orchestration") or {}
    calls = routing.get("provider_calls", [])
    sampled = routing.get("model_action")
    requirements_calls = [call for call in calls if call.get("stage") == "requirements"]
    action_calls = [call for call in calls if call.get("stage") == "action"]
    requirements_value = routing.get("requirements")
    requirements = requirements_value if isinstance(requirements_value, dict) else {}
    retries = max(0, len(calls) - bool(requirements_calls) - bool(action_calls))

    def observed_schema(call: dict[str, Any], schema: dict[str, Any]) -> bool:
        try:
            decoded = json.loads(call["response_text"])
            json.dumps(decoded, allow_nan=False)
        except (KeyError, TypeError, ValueError):
            return False
        return (
            decoded == call.get("proposed_action")
            and call.get("schema_valid") is True
            and not list(Draft202012Validator(schema).iter_errors(decoded))
        )

    first_requirements = bool(
        requirements_calls and observed_schema(requirements_calls[0], requirements_schema())
    )
    first_action = bool(action_calls and observed_schema(action_calls[0], model_router_schema()))
    first_proposal = requirements_calls[0].get("proposed_action") if requirements_calls else None
    first_disposition = (
        first_proposal.get("disposition") if isinstance(first_proposal, dict) else None
    )
    first_schema = first_requirements and (first_disposition == "needs_input" or first_action)
    stage_order = (
        calls == [*requirements_calls, *action_calls] and 1 <= len(requirements_calls) <= 2
    )
    valid_requirements = bool(
        requirements_calls
        and observed_schema(requirements_calls[-1], requirements_schema())
        and requirements == requirements_calls[-1].get("proposed_action")
    )
    stage_repairs = all(
        len(group) < 2 or not observed_schema(group[0], schema)
        for group, schema in (
            (requirements_calls, requirements_schema()),
            (action_calls, model_router_schema()),
        )
    )
    expanded = None
    if valid_requirements and requirements["disposition"] == "needs_input":
        expanded = empty_decision("")
        expanded.update(
            action="needs_input",
            missing_inputs=requirements["missing_inputs"],
            unsupported_requests=requirements["unsupported_requests"],
            message=requirements["message"],
        )
        decision_bound = (
            routing.get("decision_source") == "requirements"
            and not action_calls
            and sampled == expanded
        )
    else:
        decision_bound = bool(
            valid_requirements
            and requirements["disposition"] == "admitted"
            and requirements["requested_workflow"] in WORKFLOWS
            and not requirements["missing_inputs"]
            and not requirements["unsupported_requests"]
            and routing.get("decision_source") == "action"
            and 1 <= len(action_calls) <= 2
            and observed_schema(action_calls[-1], model_router_schema())
            and sampled == action_calls[-1].get("proposed_action")
            and (
                sampled.get("action") == "needs_input"
                or sampled.get("workflow") == requirements["requested_workflow"]
            )
        )
    consistent_sample = bool(
        sampled is not None
        and sampled == record.get("sampled_decision")
        and valid_requirements
        and stage_order
        and stage_repairs
        and decision_bound
        and retries <= 1
        and type(routing.get("repairs")) is int
        and routing["repairs"] == retries
    )
    abstain_expected = case["expected"]["decision"] == {"action": "needs_input"}

    def correct(decision: object) -> bool:
        if abstain_expected:
            return (
                isinstance(decision, dict)
                and decision.get("action") == "needs_input"
                and decision.get("workflow") == ""
                and decision.get("interfaces") == []
            )
        resolved = semantic_decision(decision, case["study"])
        return resolved is not None and resolved == semantic_decision(
            case["expected"]["decision"], case["study"]
        )

    initial_decision = expanded if not action_calls else action_calls[0].get("proposed_action")
    initial_correct = bool(first_schema and correct(initial_decision))
    final_correct = consistent_sample and correct(sampled)
    host_abstention = (
        record.get("state") == "needs_input"
        and not record.get("trace")
        and record.get("organic") is None
        and record.get("inorganic") is None
        and not record.get("interfaces")
    )
    parity = bool(oracle is not None and output_projection(record) == output_projection(oracle))
    outcomes = bool(
        not abstain_expected and workflow_outcomes(record, case["expected"]["workflow_outcomes"])
    )
    authority = (
        record.get("authorization", {}).get("model_grants_authority") is False
        and routing.get("execution_authorized_by_model") is False
    )
    source_bound = False
    complexity = {"passed": False}
    if record:
        try:
            verify_record(record)
            request = record["request"]
            source_bound = (
                request
                == {
                    "prompt": case["prompt"],
                    "study": case["study"],
                    "mode": "model",
                    "decision": None,
                }
                and routing.get("prompt_hash") == content_hash(case["prompt"])
                and routing.get("study_hash") == content_hash(case["study"])
                and routing.get("schema_hash") == content_hash(model_router_schema())
                and routing.get("requirements_schema_hash") == content_hash(requirements_schema())
                and routing.get("requirements_prompt_hash") == content_hash(REQUIREMENTS_PROMPT)
                and routing.get("system_prompt_hash") == content_hash(ROUTER_PROMPT)
            )
            if not abstain_expected:
                complexity = verify_complex_outputs(record)
        except (KeyError, TypeError, ValueError):
            pass
    passed = bool(
        final_correct
        and authority
        and source_bound
        and (
            host_abstention if abstain_expected else (parity and outcomes and complexity["passed"])
        )
    )
    return {
        "first_attempt_schema_valid": bool(first_schema),
        "first_requirements_schema_valid": first_requirements,
        "first_action_schema_valid": first_action if action_calls else None,
        "initial_action_parameters_correct": initial_correct,
        "sampled_action_parameters_correct": bool(final_correct),
        "sample_observation_consistent": consistent_sample,
        "sampled_correct_abstention": bool(
            abstain_expected and final_correct and host_abstention and source_bound and authority
        ),
        "host_rejected": record.get("state") == "rejected",
        "source_binding": source_bound,
        "complexity": complexity,
        "output_parity": parity,
        "workflow_outcomes": outcomes,
        "authority_boundary": authority,
        "observed_provider_calls": len(calls),
        "observed_retry_calls": retries,
        "native_first_attempt_success": bool(passed and initial_correct and retries == 0),
        "passed": passed,
    }


def validate_runtime_manifest(value: object, suite_hash: str) -> list[dict[str, Any]]:
    manifest = check_hash(value, "manifest_hash")
    if manifest.get("version") != "design-runtime-manifest/v1":
        raise ValueError("DESIGN_RUNTIME_VERSION")
    if manifest.get("suite_hash") != suite_hash:
        raise ValueError("DESIGN_RUNTIME_SUITE_BINDING")
    if manifest.get("code_identity_hash") != content_hash(manifest.get("code_identity")):
        raise ValueError("DESIGN_RUNTIME_CODE_HASH")
    cases = manifest.get("cases")
    if not isinstance(cases, list) or len({case["id"] for case in cases}) != len(cases):
        raise ValueError("DESIGN_RUNTIME_DENOMINATOR")
    for case in cases:
        if (
            case.get("family") != "tool_runtime_failures"
            or case.get("module_family") not in MODULE_FAMILIES
        ):
            raise ValueError("DESIGN_RUNTIME_FAMILY")
        evidence = check_hash(case.get("evidence"), "evidence_hash")
        checks = evidence.get("checks")
        if (
            not isinstance(checks, dict)
            or not checks
            or any(type(item) is not bool for item in checks.values())
            or case.get("passed") is not all(checks.values())
            or evidence.get("live_model_calls") != 0
        ):
            raise ValueError("DESIGN_RUNTIME_CHECKS")
    if (
        manifest.get("total") != len(cases)
        or manifest.get("passed_count") != sum(case["passed"] for case in cases)
        or manifest.get("live_model_calls") != 0
        or type(manifest.get("code_identity_unchanged")) is not bool
        or manifest.get("passed")
        is not (manifest["code_identity_unchanged"] and all(case["passed"] for case in cases))
    ):
        raise ValueError("DESIGN_RUNTIME_SUMMARY")
    return cases


def aggregate(
    rows: list[dict[str, Any]],
    suite: dict[str, Any],
    *,
    complete: bool,
    identity_stable: bool,
    runtime_manifest: dict[str, Any] | None = None,
) -> dict[str, Any]:
    validate_suite(suite)
    cases = {case["id"]: case for case in suite["cases"]}
    if len(rows) != len(cases) or {row["id"] for row in rows} != set(cases):
        raise ValueError("DESIGN_DENOMINATOR_MISMATCH")
    positive = [row for row in rows if cases[row["id"]]["family"] == "admitted_complete"]
    negative = [
        row for row in rows if cases[row["id"]]["expected"]["decision"] == {"action": "needs_input"}
    ]

    def rate(group: list[dict[str, Any]], field: str) -> dict[str, Any]:
        return _rate_v4(sum(row["score"][field] is True for row in group), len(group))

    metrics = {
        "first_attempt_schema": rate(rows, "first_attempt_schema_valid"),
        "admitted_actual_workflow_success": rate(positive, "passed"),
        "correct_sampled_abstention": rate(negative, "sampled_correct_abstention"),
        "initial_action_parameters": rate(rows, "initial_action_parameters_correct"),
        "native_first_attempt_success": rate(rows, "native_first_attempt_success"),
        "authority_boundary": rate(rows, "authority_boundary"),
        "source_binding": rate(rows, "source_binding"),
    }
    thresholds = {
        "first_attempt_schema": 0.95,
        "admitted_actual_workflow_success": 0.90,
        "correct_sampled_abstention": 0.95,
        "authority_boundary": 1.0,
    }
    numerical = (
        complete
        and identity_stable
        and all(
            metrics[key]["rate"] is not None and metrics[key]["rate"] >= limit
            for key, limit in thresholds.items()
        )
    )
    families = Counter(case["family"] for case in cases.values())
    modules = Counter(
        case["module_family"] for case in cases.values() if case["family"] == "admitted_complete"
    )
    runtime_count = 0
    runtime_passed = False
    runtime_cases: list[dict[str, Any]] = []
    if runtime_manifest is not None:
        runtime_cases = validate_runtime_manifest(runtime_manifest, suite["suite_hash"])
        if any(case["id"] in cases for case in runtime_cases):
            raise ValueError("DESIGN_RUNTIME_ID_COLLISION")
        runtime_count = len(runtime_cases)
        runtime_passed = runtime_count == 20 and runtime_manifest.get("passed") is True
    families["tool_runtime_failures"] = runtime_count
    lane_counts = {
        module: dict(
            Counter(
                case["family"]
                for case in [*cases.values(), *runtime_cases]
                if case["module_family"] == module
            )
        )
        for module in MODULE_FAMILIES
    }
    coverage = {
        "families": dict(families),
        "positive_modules": dict(modules),
        "lane_families": lane_counts,
        "sufficient": len(cases) == 130
        and all(families[name] == count for name, count in PROMOTION_FAMILIES.items())
        and all(modules[name] == 8 for name in MODULE_FAMILIES)
        and all(counts == LANE_COUNTS for counts in lane_counts.values()),
    }
    calls = [
        call
        for row in rows
        for call in row.get(
            "provider_calls",
            ((row.get("record") or {}).get("orchestration") or {}).get("provider_calls", []),
        )
    ]
    traces = [trace for row in rows for trace in (row.get("record") or {}).get("trace", [])]
    observations = [row.get("runtime_observations") for row in rows]
    audits = [item.get("audit", {}) if isinstance(item, dict) else {} for item in observations]
    observed_security = bool(rows) and all(
        audit.get("complete") is True
        and type(audit.get("unauthorized_attempts")) is int
        and audit["unauthorized_attempts"] == 0
        for audit in audits
    )
    local_acceptance = bool(
        numerical and coverage["sufficient"] and runtime_passed and observed_security
    )
    assessment = assess_promotion(numerical, coverage)
    assessment["gates"]["measured_model_thresholds"]["source"] = (
        "Design acceptance: first requirements and applicable first action schemas >=95%, "
        "admitted actual workflow success "
        ">=90%, sampled abstention action and safe stop >=95%, authority boundary 100%"
    )
    assessment["gates"].update(
        runtime_fault_checks={
            "status": "pass" if runtime_passed else "fail" if runtime_manifest else "not_checked",
            "source": "All 20 frozen design runtime fault checks must pass",
        },
        observed_controller_security={
            "status": "pass" if observed_security else "fail",
            "source": "Complete scoped controller audit for every case, zero unauthorized attempts",
        },
        independent_abstention_rationale_review={
            "status": "not_checked",
            "source": "Independent semantic review of each abstention explanation against the "
            "held-out request; an observed needs_input action and safe stop alone are insufficient",
        },
    )
    assessment["outstanding_gates"] = [
        name for name, gate in assessment["gates"].items() if gate["status"] != "pass"
    ]
    assessment["promotion_eligible"] = assessment["promotion_approved"] = not assessment[
        "outstanding_gates"
    ]

    def peak(key: str) -> dict[str, Any]:
        values = [
            item.get("resources", {}).get(key) if isinstance(item, dict) else None
            for item in observations
        ]
        present = [value for value in values if finite_seconds(value)]
        return {
            "observed_maximum": max(present) if present else None,
            "complete": len(present) == len(rows),
        }

    usage = {
        key: [
            call.get("usage", {}).get(key) if isinstance(call.get("usage"), dict) else None
            for call in calls
        ]
        for key in ("prompt_tokens", "completion_tokens", "total_tokens")
    }
    return {
        "version": "design-model-summary/v1",
        "complete": complete,
        "identity_stable": identity_stable,
        "identity_scope": "Frozen source and provider-reported configuration stability; "
        "immutable model weights, tokenizer, chat template and runtime require separate evidence",
        "metrics": metrics,
        "thresholds": thresholds,
        "measured_thresholds_passed": numerical,
        "local_acceptance_checks_passed": local_acceptance,
        "abstention_scope": "Observed schema-valid needs_input action and safe host stop only; "
        "explanation correctness requires independent semantic review before full acceptance",
        "coverage": coverage,
        "runtime_faults_passed": runtime_passed,
        "observed_controller_security_passed": observed_security,
        "promotion_assessment": assessment,
        "promotion_approved": assessment["promotion_approved"],
        "per_module": {
            name: rate(
                [row for row in positive if cases[row["id"]]["module_family"] == name], "passed"
            )
            for name in MODULE_FAMILIES
        },
        "case_seconds": {
            **_duration_summary(
                [
                    float(row["seconds"])
                    for row in rows
                    if row.get("attempted") is True and finite_seconds(row.get("seconds"))
                ]
            ),
            "attempted": sum(row.get("attempted") is True for row in rows),
            "suite_denominator": len(rows),
        },
        "resources": {
            key: peak(key)
            for key in (
                "controller_peak_rss_bytes",
                "system_peak_used_ram_bytes",
                "provider_name_matched_peak_rss_bytes",
                "gpu_peak_used_mib",
            )
        },
        "security": {
            "complete": bool(rows) and all(audit.get("complete") is True for audit in audits),
            "unauthorized_attempts": sum(audit.get("unauthorized_attempts", 0) for audit in audits),
            "observed_denominator": sum(bool(audit) for audit in audits),
            "required_denominator": len(rows),
            "scope": "Scoped Python controller audit, not OS or LM Studio process isolation",
        },
        "model_seconds": {
            **_duration_summary(
                [float(call["seconds"]) for call in calls if finite_seconds(call.get("seconds"))]
            ),
            "calls": len(calls),
            "complete": bool(calls) and all(finite_seconds(call.get("seconds")) for call in calls),
        },
        "tool_seconds": {
            **_duration_summary(
                [
                    float(trace["seconds"])
                    for trace in traces
                    if finite_seconds(trace.get("seconds"))
                ]
            ),
            "attempts": len(traces),
            "complete": all(finite_seconds(trace.get("seconds")) for trace in traces),
        },
        "tokens": {
            key: {
                "observed_total": sum(
                    value for value in values if type(value) is int and value >= 0
                ),
                "complete": bool(calls)
                and all(type(value) is int and value >= 0 for value in values),
            }
            for key, values in usage.items()
        },
        "observed_retry_calls": sum(row["score"]["observed_retry_calls"] for row in rows),
        "failed_module_attempts": sum(trace.get("status") == "failed" for trace in traces),
        "scope": "Actual registered design/ODE workflows; conditional chemistry is not measured "
        "activity or synthesis evidence. Wilson intervals describe this correlated local case set.",
    }
