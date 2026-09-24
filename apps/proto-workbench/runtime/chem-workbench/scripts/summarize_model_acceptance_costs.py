"""Derive observed costs from frozen evaluation, real execution and contention evidence.

No model, calculator or evidence file is executed. Missing measurements remain unknown.
Phase sums describe separately measured work, not a simultaneous end-to-end stopwatch.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import runpy
from pathlib import Path

from chem_workbench.visualization import content_hash

ROOT = Path(__file__).resolve().parents[1]
INSPECTOR = runpy.run_path(str(ROOT / "scripts/inspect_model_evaluation_v4.py"))


def read_bound(path, root, *, expected_sha256=None, parse_json=True):
    path = path.resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("COST_EVIDENCE_PATH_ESCAPE")
    with path.open("rb") as stream:
        raw = stream.read(32 * 1024 * 1024 + 1)
    if len(raw) > 32 * 1024 * 1024:
        raise ValueError("COST_EVIDENCE_SIZE_LIMIT")
    sha = hashlib.sha256(raw).hexdigest()
    if expected_sha256 is not None and sha != expected_sha256:
        raise ValueError("COST_EVIDENCE_FILE_HASH_MISMATCH")
    return json.loads(raw) if parse_json else None, {"path": str(path), "sha256": sha}


def number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def duration_summary(values):
    observed = sorted(value for value in values if number(value))
    return {
        "observations": len(observed),
        "expected_observations": len(values),
        "complete": len(observed) == len(values),
        "observed_total_seconds": sum(observed),
        "p50_seconds": observed[math.ceil(len(observed) * 0.5) - 1] if observed else None,
        "p95_seconds": observed[math.ceil(len(observed) * 0.95) - 1] if observed else None,
        "quantile_method": "nearest-rank on observed values",
    }


def token_summary(calls):
    totals = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    observed = 0
    for call in calls:
        usage = call.get("usage")
        if (
            isinstance(usage, dict)
            and all(type(usage.get(key)) is int and usage[key] >= 0 for key in totals)
            and usage["total_tokens"] == usage["prompt_tokens"] + usage["completion_tokens"]
        ):
            observed += 1
            for key in totals:
                totals[key] += usage[key]
    return {
        "observed_totals": totals,
        "observed_calls": observed,
        "expected_calls": len(calls),
        "complete": observed == len(calls),
    }


def phase_costs(rows, completed_ids, calculator_durations, submitted_ids):
    """Charge all observed attempts to the verified completion denominator."""
    identifiers = {row["id"] for row in rows}
    if (
        len(identifiers) != len(rows)
        or not completed_ids <= identifiers
        or not submitted_ids <= identifiers
        or calculator_durations.keys() - submitted_ids
    ):
        raise ValueError("COST_DENOMINATOR_MISMATCH")
    calls = [call for row in rows for call in row.get("provider_calls", [])]
    tools = [step for row in rows for step in (row.get("record") or {}).get("trace", [])]
    model = duration_summary([call.get("seconds") for call in calls])
    tool = duration_summary([step.get("seconds") for step in tools])
    calculator = duration_summary([calculator_durations.get(key) for key in sorted(submitted_ids)])
    observed_total = sum(part["observed_total_seconds"] for part in (model, tool, calculator))
    complete = all(part["complete"] for part in (model, tool, calculator))
    tokens = token_summary(calls)
    controller_cpu = duration_summary(
        [
            row.get("runtime_observations", {})
            .get("resources", {})
            .get("controller_cpu_seconds_delta")
            for row in rows
        ]
    )
    combined = []
    for row in rows:
        if row["id"] in completed_ids:
            compute = calculator_durations.get(row["id"]) if row["id"] in submitted_ids else 0
            combined.append(
                row["seconds"] + compute if number(row.get("seconds")) and number(compute) else None
            )
    return {
        "attempted_tasks": len(rows),
        "verified_completed_tasks": len(completed_ids),
        "tasks_without_verified_admitted_completion": len(rows) - len(completed_ids),
        "provider_calls": len(calls),
        "read_derive_tool_calls": len(tools),
        "calculator_submissions": len(submitted_ids),
        "model_time": model,
        "read_derive_tool_time": tool,
        "calculator_time": calculator,
        "observed_phase_work_seconds": observed_total,
        "phase_work_complete": complete,
        "phase_work_seconds_per_verified_completion": observed_total / len(completed_ids)
        if complete and completed_ids
        else None,
        "tokens": tokens,
        "total_tokens_per_verified_completion": tokens["observed_totals"]["total_tokens"]
        / len(completed_ids)
        if tokens["complete"] and completed_ids
        else None,
        "controller_observed_cpu_time": controller_cpu,
        "completed_model_path_plus_calculator_phase_elapsed": duration_summary(combined),
        "model_path_elapsed": duration_summary([row.get("seconds") for row in rows]),
        "repair_calls": sum(row["score"].get("observed_retry_calls", 0) for row in rows),
        "blocked_read_derive_calls": sum(
            step.get("output", {}).get("status") in {"blocked", "rejected"} for step in tools
        ),
        "cpu_scope": "Controller CPU deltas are sampled during inference/controller work. "
        "Provider process samples are a name heuristic. Formal calculator CPU was not recorded.",
        "calculator_cpu_seconds": None,
        "cost_scope": "Observed failed attempts remain charged. Model/tool/compute phase sums "
        "exclude unmeasured preparation, approval and inter-phase waiting; "
        "they are not one wall-clock run.",
    }


def verify_calculator_result(completion, artifact_root, refs):
    if not completion.get("result_file") or not completion.get("result_hash"):
        return None
    path = Path(completion["result_file"])
    result, reference = read_bound(path, artifact_root)
    refs.append(reference)
    if (
        content_hash(result) != completion["result_hash"]
        or result.get("job_id") != completion.get("job_id")
        or result.get("resolved_plan_hash") != completion.get("resolved_plan_hash")
        or result.get("execution_status") != "succeeded"
        or result.get("evidence_eligible") is not True
    ):
        raise ValueError("COST_EXECUTION_RESULT_MISMATCH")
    for filename, field in (("input.json", "input_sha256"), ("output.json", "output_sha256")):
        if result.get(field) != completion.get(field):
            raise ValueError("COST_EXECUTION_SOURCE_HASH_MISMATCH")
        _, reference = read_bound(
            path.parent / filename, artifact_root, expected_sha256=result[field]
        )
        refs.append(reference)
    duration = result.get("execution", {}).get("duration_ms")
    return duration / 1000 if number(duration) else None


def summarize(evaluation, execution_path, contention_path, root=ROOT):
    verification = INSPECTOR["inspect"](evaluation)
    if not verification.get("scores_recomputed") or not verification.get("complete"):
        raise ValueError("COST_REQUIRES_RECOMPUTED_COMPLETE_V4")
    frozen = INSPECTOR["checked"](evaluation / "frozen.json", "freeze_hash")
    report = INSPECTOR["checked"](evaluation / "report.json", "report_hash")
    if report["version"] != "model-evaluation-report/v4" or not report["identity_stable"]:
        raise ValueError("COST_REQUIRES_STABLE_V4")
    current = runpy.run_path(str(ROOT / "scripts/run_model_evaluation.py"))["code_snapshot"](ROOT)
    if {key: content_hash(value) for key, value in current.items()} != frozen["code_identity"]:
        raise ValueError("COST_ACCOUNTING_CODE_NOT_FROZEN")
    refs = []
    for path in (evaluation / "frozen.json", evaluation / "report.json"):
        _, reference = read_bound(path, root)
        refs.append(reference)
    execution, reference = read_bound(execution_path, root)
    refs.append(reference)
    if (
        execution.get("acceptance_hash")
        != content_hash(
            {key: value for key, value in execution.items() if key != "acceptance_hash"}
        )
        or execution.get("version") != "complex-model-execution-acceptance/v1"
        or execution.get("evaluation_report_hash") != report["report_hash"]
        or execution.get("evaluation_freeze_hash") != frozen["freeze_hash"]
        or execution.get("suite_hash") != report["suite_hash"]
        or execution.get("model_identity") != frozen["model_identity"]
        or execution.get("code_identity") != frozen["code_identity"]
        or execution.get("code_identity_stable") is not True
    ):
        raise ValueError("COST_EXECUTION_CONTEXT_MISMATCH")
    cases = {case["id"]: case for case in frozen["suite"]["cases"]}
    admitted = {key for key, case in cases.items() if case.get("family") == "admitted_complete"}
    completed = execution["rows"]
    if len(completed) != 40 or len(admitted) != 40 or {row["id"] for row in completed} != admitted:
        raise ValueError("COST_ADMITTED_DENOMINATOR_MISMATCH")
    rows = []
    for identifier in cases:
        row = INSPECTOR["checked"](evaluation / (identifier + ".json"), "row_hash")
        if row["row_hash"] != report["case_rows"][identifier]:
            raise ValueError("COST_EVALUATION_ROW_MISMATCH")
        rows.append(row)
    submitted, completed_ids, durations = set(), set(), {}
    for completion in completed:
        identifier = completion["id"]
        if (
            completion.get("completion_hash")
            != content_hash(
                {key: value for key, value in completion.items() if key != "completion_hash"}
            )
            or completion.get("evaluation_row_hash") != report["case_rows"][identifier]
        ):
            raise ValueError("COST_COMPLETION_ROW_MISMATCH")
        if completion.get("passed") is True:
            if (
                completion.get("source_hash")
                != frozen["source_snapshots"][identifier]["source_hash"]
                or completion.get("model_selection_passed") is not True
            ):
                raise ValueError("COST_COMPLETION_SOURCE_MISMATCH")
            completed_ids.add(identifier)
        if completion.get("job_submission_requested") is True:
            submitted.add(identifier)
            durations[identifier] = verify_calculator_result(
                completion, execution_path.with_suffix(""), refs
            )
    expected_completion = execution["admitted_end_to_end"]
    if (
        expected_completion.get("passed") != len(completed_ids)
        or expected_completion.get("total") != 40
        or expected_completion.get("rate") != len(completed_ids) / 40
    ):
        raise ValueError("COST_COMPLETION_TOTAL_MISMATCH")
    contention, reference = read_bound(contention_path, root)
    refs.append(reference)
    if (
        contention.get("contention_hash")
        != content_hash(
            {key: value for key, value in contention.items() if key != "contention_hash"}
        )
        or contention.get("version") != "model-compute-contention/v1"
        or contention.get("model_identity") != frozen["model_identity"]
    ):
        raise ValueError("COST_CONTENTION_CONTEXT_MISMATCH")
    artifacts = {}
    for name, digest in contention["artifact_hashes"].items():
        if Path(name).name != name:
            raise ValueError("COST_CONTENTION_ARTIFACT_NAME")
        artifacts[name], reference = read_bound(
            contention_path.with_suffix("") / name,
            root,
            expected_sha256=digest,
            parse_json=name.endswith(".json"),
        )
        refs.append(reference)
    if (
        artifacts.get("contention-input.json", {}).get("code_identity") != frozen["code_identity"]
        or artifacts.get("contention-input.json", {}).get("model_identity")
        != frozen["model_identity"]
    ):
        raise ValueError("COST_CONTENTION_CODE_MISMATCH")
    admitted_costs = phase_costs(
        [row for row in rows if row["id"] in admitted], completed_ids, durations, submitted
    )
    all_task_costs = phase_costs(rows, completed_ids, durations, submitted)
    resource = report["runtime_observations"]
    complete = (
        admitted_costs["phase_work_complete"]
        and all_task_costs["phase_work_complete"]
        and all_task_costs["tokens"]["complete"]
        and contention.get("passed") is True
        and contention.get("resource_assessment", {}).get("passed") is True
        and contention.get("provider_request_count") == 1
        and contention.get("host_compute_submission_count") == 1
        and contention.get("owned_child_stopped") is True
        and contention.get("provider_thread_stopped") is True
        and contention.get("model_execution_authorized") is False
        and resource["observed_cases"] == resource["total_cases"]
        and resource["cases_with_resource_errors"] == 0
    )
    document = {
        "version": "model-acceptance-cost-accounting/v1",
        "suite_hash": report["suite_hash"],
        "evaluation_report_hash": report["report_hash"],
        "execution_acceptance_hash": execution["acceptance_hash"],
        "contention_hash": contention["contention_hash"],
        "model_identity": frozen["model_identity"],
        "code_identity": frozen["code_identity"],
        "evidence_refs": refs,
        "observed_cost_accounting_complete": complete,
        "admitted_workflows": admitted_costs,
        "completeness_scope": "Model/tool/calculator duration and token accounting, "
        "per-case resources, and separate functional contention evidence. "
        "CPU sampling limitations and unmeasured prices remain explicit.",
        "all_evaluation_tasks_charged_to_admitted_completions": all_task_costs,
        "sampled_evaluation_resource_peaks": resource["sampled_resource_peaks"],
        "contention_resources": contention.get("resource_assessment"),
        "contention_scope": "Separate one-job development contention check; "
        "its work is excluded from held-out cost totals.",
        "monetary_cost": {"status": "not_measured", "value": None, "currency": None},
        "electricity_consumption": {"status": "not_measured", "value": None, "unit": "kWh"},
        "promotion_approved": False,
    }
    document["cost_accounting_hash"] = content_hash(document)
    return document


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evaluation", type=Path, required=True)
    parser.add_argument("--execution", type=Path, required=True)
    parser.add_argument("--contention", type=Path, required=True)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    protected = (args.evaluation, args.execution.with_suffix(""), args.contention.with_suffix(""))
    if args.output.exists() or any(
        args.output.resolve().is_relative_to(path.resolve()) for path in protected
    ):
        raise ValueError("COST_OUTPUT_MUST_BE_NEW_AND_OUTSIDE_EVIDENCE")
    result = summarize(args.evaluation, args.execution, args.contention, args.root)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, indent=2, allow_nan=False)
        stream.write("\n")
    print(
        json.dumps(
            {"output": str(args.output), "complete": result["observed_cost_accounting_complete"]}
        )
    )
