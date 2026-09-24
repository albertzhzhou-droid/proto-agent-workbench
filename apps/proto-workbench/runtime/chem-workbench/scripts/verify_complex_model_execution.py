"""Complete frozen complex-molecule tasks using host-approved real scientific jobs.

No model inference occurs here. Failed model selections remain failed cases.
Only this explicit acceptance harness grants the independent execution approvals.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import runpy
import time
from contextlib import suppress
from pathlib import Path
from typing import Any

from chem_workbench.molecular_compute import MOLECULAR_PROFILE, validate_molecular_result
from chem_workbench.tool_gateway import invoke_tool
from chem_workbench.visualization import compile_snapshot, content_hash
from chem_workbench.workflows import WorkflowService

ROOT = Path(__file__).resolve().parents[1]
HARNESS_KEY = "scripts/verify_complex_model_execution.py"
ADMITTED_READ_TOOLS = frozenset({"object_inspect", "structure_preview"})


def write_new(path: Path, value: Any) -> None:
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, sort_keys=True, allow_nan=False)
        stream.write("\n")


def file_hash(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def current_code_identity() -> dict[str, str]:
    runner = runpy.run_path(str(ROOT / "scripts/run_model_evaluation.py"))
    return {key: content_hash(value) for key, value in runner["code_snapshot"](ROOT).items()}


def _wait_for_job(service: WorkflowService, reference: str, timeout_seconds: int) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        record = service.read(reference)
        if record["state"] in {
            "succeeded",
            "failed",
            "timeout",
            "cancelled",
            "interrupted",
            "output_limit",
        }:
            return record
        time.sleep(0.1)
    service.cancel(reference)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        record = service.read(reference)
        if record["state"] not in {"running", "queued", "approved"}:
            break
        time.sleep(0.1)
    raise ValueError(
        f"ACCEPTANCE_TIMEOUT: governed job exceeded the {timeout_seconds}-second acceptance budget"
    )


def complete_case(
    case: dict[str, Any],
    row: dict[str, Any],
    oracle: dict[str, Any],
    destination: Path,
    *,
    timeout_seconds: int = 360,
) -> dict[str, Any]:
    """One positive case, preserving failed model choices without a repaired substitution."""
    result: dict[str, Any] = {
        "id": case["id"],
        "family": case.get("family"),
        "expected_action": case["expected"]["action"],
        "evaluation_row_hash": row["row_hash"],
        "model_selection_passed": False,
        "passed": False,
        "real_job_launched": False,
        "job_submission_requested": False,
        "cached_result_reused": False,
        "host_approval_actor": None,
        "model_execution_authorized": False,
    }
    service: WorkflowService | None = None
    submitted_reference: str | None = None
    try:
        if case.get("family") != "admitted_complete" or case["expected"]["action"] == "needs_input":
            raise ValueError("DENOMINATOR_SCOPE: only positive admitted_complete cases belong here")
        if row.get("score", {}).get("reviewed_model_success") is not True:
            result["failure"] = "MODEL_CASE_FAILED: no host substitution or recovery execution"
            return result
        result["model_selection_passed"] = True
        action = case["expected"]["action"]
        if action not in ADMITTED_READ_TOOLS | {"plan_molecular_single_point"}:
            raise ValueError("DENOMINATOR_SCOPE: water, copper and unrelated tools cannot count")
        snapshot = compile_snapshot(case["source"], case["attachments"])
        if not snapshot.success:
            raise ValueError("SOURCE_INVALID")
        direct = invoke_tool(action, {"object_id": case["expected"]["object_id"]}, snapshot)
        record = row["record"]
        trace = record.get("trace", [])
        if len(trace) != 1 or record.get("execution_authorized") is not False:
            raise ValueError("ORCHESTRATION_AUTHORITY_OR_TRACE_MISMATCH")
        observed = trace[0]["output"]
        if (
            direct["data"] != oracle
            or observed.get("data") != oracle
            or observed.get("data_hash") != content_hash(oracle)
            or observed.get("source_hash") != snapshot.source_sha256
            or record.get("source_hash") != snapshot.source_sha256
            or record.get("source_semantic_hash") != snapshot.semantic_hash
        ):
            raise ValueError("DIRECT_ORACLE_OR_SOURCE_PARITY_FAILED")
        destination.mkdir(parents=True, exist_ok=False)
        (destination / "source.chem").write_text(case["source"], encoding="utf-8")
        write_new(destination / "attachments.json", case["attachments"])
        result.update(
            source_hash=snapshot.source_sha256,
            source_semantic_hash=snapshot.semantic_hash,
            orchestration_ref=record["record_hash"],
            direct_data_hash=content_hash(oracle),
            source_file=str((destination / "source.chem").resolve()),
            direct_tool_parity=True,
        )
        if action in ADMITTED_READ_TOOLS:
            write_new(destination / "source-bound-result.json", oracle)
            result.update(
                passed=True, completion_scope="source-bound inspection or coordinate preview"
            )
            return result
        proposal = oracle
        if (
            proposal.get("method_profile_id") != MOLECULAR_PROFILE
            or proposal.get("execution_authorized") is not False
        ):
            raise ValueError("MOLECULAR_PROFILE_OR_AUTHORITY_MISMATCH")
        service = WorkflowService(destination / "workspace")
        orchestration_dir = service.store.root / "orchestrations"
        orchestration_dir.mkdir()
        write_new(orchestration_dir / (record["record_hash"][7:] + ".json"), record)
        request = {
            "source": case["source"],
            "attachments": case["attachments"],
            "profile": "molecular",
            "object_id": case["expected"]["object_id"],
            "proposal": proposal,
        }
        model_workflow = service.prepare({**request, "orchestration_ref": record["record_hash"]})
        direct_workflow = service.prepare(request)
        model_plan, direct_plan = model_workflow["plan"], direct_workflow["plan"]
        logical_parity = (
            model_plan["logical_plan_hash"]
            == direct_plan["logical_plan_hash"]
            == proposal["logical_plan_hash"]
        )
        resolved_parity = model_plan["resolved_plan_hash"] == direct_plan["resolved_plan_hash"]
        if (
            not logical_parity
            or not resolved_parity
            or model_workflow["reference"] == direct_workflow["reference"]
        ):
            raise ValueError("LOGICAL_RESOLVED_OR_APPROVAL_CONTEXT_PARITY_FAILED")
        result.update(
            logical_parity=True,
            resolved_parity=True,
            logical_plan_hash=model_plan["logical_plan_hash"],
            resolved_plan_hash=model_plan["resolved_plan_hash"],
            geometry_hash=proposal["geometry_hash"],
            linked_state_hash=proposal["linked_state_hash"],
            geometry_provenance=proposal["geometry_provenance"],
            model_workflow_ref=model_workflow["reference"],
            direct_workflow_ref=direct_workflow["reference"],
        )
        service.approve(model_workflow["reference"], case["source"], case["attachments"])
        if service.read(direct_workflow["reference"])["state"] != "prepared":
            raise ValueError("DIRECT_APPROVAL_CONTEXT_NOT_ISOLATED")
        result["host_approval_actor"] = getpass.getuser()
        submitted_reference = model_workflow["reference"]
        result["job_submission_requested"] = True
        # Submission and observation are distinct: a read failure cannot establish
        # that no worker ran after the host requested its launch.
        result["real_job_launched"] = None
        service.submit(submitted_reference)
        completed = _wait_for_job(service, submitted_reference, timeout_seconds)
        write_new(destination / "completed-workflow.json", completed)
        if isinstance(completed.get("result", {}).get("execution"), dict):
            result["real_job_launched"] = True
        result["job_id"] = completed.get("job", {}).get("job_id")
        if (
            completed["state"] != "succeeded"
            or completed.get("job", {}).get("evidence_eligible") is not True
        ):
            raise ValueError("COMPUTE_DID_NOT_CONVERGE_OR_PASS: " + completed["state"])
        job, numerical = completed["job"], completed["result"]
        run_dir = service.store.runs / job["job_id"]
        raw_output = json.loads((run_dir / "output.json").read_text(encoding="utf-8"))
        validated = validate_molecular_result(model_plan, raw_output)
        if (
            validated.get("success") is not True
            or validated.get("convergence") != "converged"
            or numerical.get("energy_hartree") != validated["energy_hartree"]
            or numerical.get("worker") != model_plan["worker"]
            or numerical.get("resolved_plan_hash") != model_plan["resolved_plan_hash"]
            or job.get("result_hash") != content_hash(numerical)
            or numerical.get("input_sha256") != file_hash(run_dir / "input.json")
            or numerical.get("output_sha256") != file_hash(run_dir / "output.json")
            or completed.get("orchestration_ref") != record["record_hash"]
        ):
            raise ValueError("NUMERICAL_PROVENANCE_OR_RESULT_PARITY_FAILED")
        if service.read(direct_workflow["reference"]).get("job") is not None:
            raise ValueError("DIRECT_CONTEXT_INHERITED_MODEL_EXECUTION")
        result.update(
            passed=True,
            completion_scope="new host-approved real molecular RHF/STO-3G single point",
            job_id=job["job_id"],
            result_hash=job["result_hash"],
            energy_hartree=numerical["energy_hartree"],
            convergence=numerical["convergence"],
            input_sha256=numerical["input_sha256"],
            output_sha256=numerical["output_sha256"],
            result_file=str((run_dir / "result.json").resolve()),
            qcschema_input_result_verified=True,
            numeric_provenance_complete=True,
            direct_approval_isolated=True,
            source_geometry_state_bound=True,
        )
    except Exception as error:
        result["failure"] = f"{type(error).__name__}: {error}"[:1600]
        if service is not None and submitted_reference is not None:
            with suppress(ValueError, KeyError, OSError):
                service.cancel(submitted_reference)
    return result


def run(evaluation: Path, output: Path, *, timeout_seconds: int = 360) -> dict[str, Any]:
    if type(timeout_seconds) is not int or not 1 <= timeout_seconds <= 360:
        raise ValueError("ACCEPTANCE_BUDGET: timeout must be 1-360 seconds")
    evaluation, output = evaluation.resolve(), output.resolve()
    if output.exists():
        raise ValueError("OUTPUT_EXISTS: choose a new evidence path")
    inspector = runpy.run_path(str(ROOT / "scripts/inspect_model_evaluation_v4.py"))
    verification = inspector["inspect"](evaluation)
    frozen = inspector["checked"](evaluation / "frozen.json", "freeze_hash")
    model_report = inspector["checked"](evaluation / "report.json", "report_hash")
    if (
        frozen.get("version") != "model-evaluation-freeze/v4"
        or model_report.get("version") != "model-evaluation-report/v4"
        or not verification.get("self_consistent")
        or not verification.get("scores_recomputed")
        or not model_report.get("complete")
        or not model_report.get("identity_stable")
    ):
        raise ValueError("INELIGIBLE_EVALUATION: complete, stable, recomputed V4 evidence required")
    code = current_code_identity()
    if code != frozen["code_identity"] or code.get(HARNESS_KEY) != content_hash(
        Path(__file__).read_text(encoding="utf-8")
    ):
        raise ValueError("EXECUTION_HARNESS_OR_CODE_NOT_FROZEN")
    if frozen.get("complexity_verification", {}).get("passed") is not True:
        raise ValueError("COMPLEX_CHEMISTRY_GATE_NOT_PASSED")
    cases = [case for case in frozen["suite"]["cases"] if case.get("family") == "admitted_complete"]
    if len(cases) != 40 or any(case["expected"]["action"] == "needs_input" for case in cases):
        raise ValueError(
            "DENOMINATOR_MISMATCH: exactly 40 positive admitted_complete cases required"
        )
    artifact_root = output.with_suffix("")
    artifact_root.mkdir(parents=True, exist_ok=False)
    rows = []
    for case in cases:
        row = inspector["checked"](evaluation / (case["id"] + ".json"), "row_hash")
        if current_code_identity() != code:
            result = {"id": case["id"], "passed": False, "failure": "CODE_IDENTITY_CHANGED"}
        else:
            result = complete_case(
                case,
                row,
                frozen["oracles"][case["id"]],
                artifact_root / case["id"],
                timeout_seconds=timeout_seconds,
            )
        result["completion_hash"] = content_hash(result)
        write_new(artifact_root / (case["id"] + ".json"), result)
        rows.append(result)
        print(
            json.dumps(
                {
                    "id": case["id"],
                    "passed": result["passed"],
                    "scope": result.get("completion_scope"),
                    "failure": result.get("failure"),
                }
            ),
            flush=True,
        )
    comparisons = []
    for case in frozen["suite"]["cases"]:
        if case.get("family") != "evidence_comparison":
            continue
        row = inspector["checked"](evaluation / (case["id"] + ".json"), "row_hash")
        comparisons.append(
            {
                "id": case["id"],
                "expected_action": case["expected"]["action"],
                "positive_task": case["expected"]["action"] != "needs_input",
                "reviewed_model_success": row["score"].get("reviewed_model_success") is True,
                "evaluation_row_hash": row["row_hash"],
                "counts_toward_admitted_completion": False,
            }
        )
    passed = sum(row["passed"] is True for row in rows)
    stable = current_code_identity() == code
    summary = {
        "version": "complex-model-execution-acceptance/v1",
        "evaluation_directory": str(evaluation),
        "evaluation_report_hash": model_report["report_hash"],
        "evaluation_freeze_hash": frozen["freeze_hash"],
        "suite_hash": frozen["suite"]["suite_hash"],
        "model_identity": frozen["model_identity"],
        "code_identity": code,
        "code_identity_stable": stable,
        "bundle_verification": verification,
        "admitted_end_to_end": {
            "passed": passed,
            "total": 40,
            "rate": passed / 40,
            "threshold": 0.9,
            "met": stable and passed >= 36,
        },
        "rows": rows,
        "evidence_comparison": comparisons,
        "accounting": {
            "new_real_molecular_jobs": sum(row.get("real_job_launched") is True for row in rows),
            "unobserved_molecular_launches": sum(
                row.get("job_submission_requested") is True and row.get("real_job_launched") is None
                for row in rows
            ),
            "molecular_job_submissions_requested": sum(
                row.get("job_submission_requested") is True for row in rows
            ),
            "cached_results_reused": 0,
            "prior_jobs_reused": 0,
            "direct_plan_comparisons": sum(row.get("resolved_parity") is True for row in rows),
            "direct_backend_energy_reproductions": 0,
            "read_preview_completions": sum(
                row["passed"] and row.get("expected_action") in ADMITTED_READ_TOOLS for row in rows
            ),
        },
        "execution_approval": (
            "Host acceptance harness approves each exact molecular plan; model grants none"
        ),
        "promotion_approved": False,
        "scope": (
            "40 declared task scopes; new molecular jobs for planner cases and source-bound "
            "read/preview parity for other positives. No water/copper, cached energy "
            "or comparison-only cases enter this denominator."
        ),
    }
    summary["acceptance_hash"] = content_hash(summary)
    write_new(output, summary)
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evaluation", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    report = run(args.evaluation, args.output)
    print(json.dumps({"output": str(args.output), **report["admitted_end_to_end"]}), flush=True)
    return 0 if report["admitted_end_to_end"]["met"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
